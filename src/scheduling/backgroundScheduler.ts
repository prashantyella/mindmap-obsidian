import { EngineError } from "../engine/errors";

/**
 * Checkpoint 8's OPTIONAL background adapter: a macOS-only LaunchAgent that
 * wakes/opens the target Obsidian vault on the schedules' configured
 * cadence, so `CoreScheduler` (running inside that opened Obsidian process)
 * gets a chance to catch up. This module is fully isolated from
 * `src/jobs`/`src/index`/`../engine/contracts` and from any vault-content
 * seam -- it never imports a job kind, a job payload shape, a provider
 * interface, or a note/vault-content module (`backgroundIsolation.test.ts`
 * enforces this at the source level). If Community Plugin review later
 * rejects LaunchAgent management outright, deleting this one file (and its
 * test) changes zero behavior in `coreScheduler.ts`/`scheduleStore.ts` --
 * neither imports anything from here. Nothing in this file is wired into
 * `main.ts` yet; it is a free-standing adapter a future checkpoint may
 * choose to invoke.
 *
 * The LaunchAgent plist this module writes contains exactly two
 * caller-meaningful pieces of information: a fixed `/usr/bin/open <argv>`
 * program array (the ONE encoded `obsidian://open?vault=...` URL string
 * that opens/wakes the target vault) and a launchd wake-cadence descriptor
 * (`StartCalendarInterval` entries -- bare hour/minute/weekday numbers,
 * carrying no job kind, argument, provider data, credential, or IPC
 * endpoint of any kind). It never claims a job succeeded and never touches
 * `ScheduleStore`/schedule state -- `CoreScheduler`, running after the
 * vault opens, remains the sole authority for what is actually due.
 *
 * Ownership is per-vault (`installationId`-derived `Label`), never a single
 * global label -- two enabled vaults each own their own plist/service and
 * can never overwrite or unload each other's.
 */

const OWNERSHIP_MARKER_KEY = "MindmapObsidianLaunchAgentOwner";
const OWNERSHIP_MARKER_VALUE = "mindmap-obsidian-launch-agent-v1";
const LABEL_PREFIX = "com.mindmap-obsidian.vault-wake";
const LAUNCHCTL_PATH = "/bin/launchctl";
const OPEN_PATH = "/usr/bin/open";

const MAX_VAULT_NAME_LENGTH = 200;
const MAX_PLIST_BYTES = 64 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_LAUNCH_AGENTS_DIR_LENGTH = 1024;
const LAUNCH_AGENTS_DIR_SUFFIX = "/Library/LaunchAgents";

/** Codepoint check (never a regex literal containing an actual control byte) -- mirrors `src/jobs/jobTypes.ts`'s `hasControlOrNulCharacter`, duplicated locally rather than imported so this module stays fully decoupled from `src/jobs` (see this file's own isolation doc comment). */
function hasControlOrNulCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Bounded, lowercase-alphanumeric token -- the one thing every per-vault `Label` is derived from. Injected by the caller (a stable per-vault installation id), never a display name or filesystem path, so a vault rename never changes ownership identity. */
const INSTALLATION_ID_PATTERN = /^[a-z0-9]{8,64}$/;

export function assertValidInstallationId(installationId: unknown): asserts installationId is string {
  if (typeof installationId !== "string" || !INSTALLATION_ID_PATTERN.test(installationId)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "installationId must be a bounded lowercase alphanumeric token (8-64 chars).", {});
  }
}

const LABEL_PATTERN = /^[A-Za-z0-9.-]{1,200}$/;

function assertValidPlistLabel(label: unknown): asserts label is string {
  if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "label must be a short, bounded token from [A-Za-z0-9.-].", {});
  }
}

/** The one owned `Label` this installation will ever write -- stable across a vault rename (only the plist's URL content changes), unique per installation so two enabled vaults never collide. */
export function buildOwnedLabel(installationId: string): string {
  assertValidInstallationId(installationId);
  return `${LABEL_PREFIX}.${installationId}`;
}

export interface WakeCadence {
  hour: number;
  minute: number;
  /** `undefined` for a daily cadence; 0 (Sunday) - 6 (Saturday) for a weekly one. */
  weekday?: number;
}

/**
 * A `WakeCadence` the caller has explicitly acknowledged was derived
 * against a NAMED system timezone -- launchd's `StartCalendarInterval`
 * always fires in whatever timezone macOS itself is currently set to
 * (there is no per-cadence IANA timezone field in a plist), so a bare
 * `WakeCadence` must never be handed to `ReconcileInput` directly. The
 * brand carries no runtime information (macOS's actual system timezone is
 * never verified here -- this module has no OS clock/timezone seam of its
 * own); it exists purely so a caller cannot pass an arbitrary-IANA-zone
 * wall-clock reading into this API without first going through
 * `toSystemLocalWakeCadence` and naming the system timezone it converted
 * against at that call site.
 */
export type SystemLocalWakeCadence = WakeCadence & { readonly systemTimeZone: string };

/** Value-free on failure: a caller-supplied timezone marker that fails this check is never echoed into the thrown error. */
function assertBoundedTimeZoneMarker(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100 || hasControlOrNulCharacter(value)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "systemTimeZone must be a short, bounded, control-free, non-empty string.", {});
  }
}

/**
 * `systemTimeZone` is a REAL runtime field on the returned value (final-
 * integration requirement 12), not merely a type-level brand -- a branded-
 * only type is erasable by any caller willing to cast, so `reconcile`
 * additionally validates at runtime that every cadence's own
 * `systemTimeZone` matches `ReconcileInput.systemTimeZone` exactly. This
 * function itself performs no timezone conversion and never inspects the
 * real system clock; it only records the caller's own declaration of what
 * system timezone `cadence`'s hour/minute/weekday were already converted
 * against.
 */
export function toSystemLocalWakeCadence(cadence: WakeCadence, systemTimeZone: string): SystemLocalWakeCadence {
  assertValidCadence(cadence);
  assertBoundedTimeZoneMarker(systemTimeZone);
  const normalized: WakeCadence = cadence.weekday !== undefined ? { hour: cadence.hour, minute: cadence.minute, weekday: cadence.weekday } : { hour: cadence.hour, minute: cadence.minute };
  return { ...normalized, systemTimeZone };
}

/** Validates a vault display name (never a path, never a URL) -- must be non-empty, bounded, and free of control/NUL bytes; nothing else is trusted from it. The actual URL is always built by THIS module (`obsidian://open?vault=` plus a strict `encodeURIComponent` of this value) -- a caller can never supply an arbitrary URL/scheme. */
export function assertValidVaultName(vaultName: unknown): asserts vaultName is string {
  if (typeof vaultName !== "string" || vaultName.trim().length === 0 || vaultName.length > MAX_VAULT_NAME_LENGTH || hasControlOrNulCharacter(vaultName)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "vaultName must be a short, bounded, control-free, non-empty string.", {});
  }
}

/** The one fixed, hardcoded URL scheme+host+path this module will ever build -- `vaultName` is always run through `encodeURIComponent`, so it can never inject an additional query parameter, a different scheme, or a different host. */
export function buildObsidianVaultUrl(vaultName: string): string {
  assertValidVaultName(vaultName);
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}`;
}

function assertValidCadence(cadence: WakeCadence): void {
  if (typeof cadence !== "object" || cadence === null) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "WakeCadence must be an object.", {});
  }
  if (!Number.isInteger(cadence.hour) || cadence.hour < 0 || cadence.hour > 23) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "WakeCadence.hour must be an integer in [0, 23].", {});
  }
  if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "WakeCadence.minute must be an integer in [0, 59].", {});
  }
  if (cadence.weekday !== undefined && (!Number.isInteger(cadence.weekday) || cadence.weekday < 0 || cadence.weekday > 6)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "WakeCadence.weekday must be an integer in [0, 6] when present.", {});
  }
}

/** Deterministic, duplicate-free cadence ordering -- two calls with the same SET of cadences (any input order, any duplicates) always produce the exact same plist bytes, which is what makes `reconcile`'s "content identical -> no-op" fast path and `isOwnedPlistContent`'s regenerate-and-compare check both stable. */
function normalizeCadences(cadences: readonly WakeCadence[]): WakeCadence[] {
  const byKey = new Map<string, WakeCadence>();
  for (const cadence of cadences) {
    assertValidCadence(cadence);
    const key = `${cadence.weekday ?? -1}:${cadence.hour}:${cadence.minute}`;
    if (!byKey.has(key)) {
      byKey.set(key, cadence.weekday !== undefined ? { hour: cadence.hour, minute: cadence.minute, weekday: cadence.weekday } : { hour: cadence.hour, minute: cadence.minute });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const wa = a.weekday ?? -1;
    const wb = b.weekday ?? -1;
    if (wa !== wb) return wa - wb;
    if (a.hour !== b.hour) return a.hour - b.hour;
    return a.minute - b.minute;
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Builds the exact, deterministic plist body for a given vault name +
 * cadence set + owned label. Contains ONLY: the ownership marker, `Label`,
 * a `ProgramArguments` array of exactly `["/usr/bin/open", <the one vault
 * URL>]`, `RunAtLoad: false` (loading/reconciling must never itself pop
 * open the vault outside a configured wake), and `StartCalendarInterval`
 * entries built purely from bounded, deduplicated, deterministically
 * sorted hour/minute/weekday integers. No other key is ever emitted. This
 * exact output is also the "canonical template" `isOwnedPlistContent`
 * regenerates and byte-compares against -- see that function's doc comment.
 */
export function buildLaunchAgentPlist(vaultName: string, cadences: readonly WakeCadence[], label: string): string {
  const url = buildObsidianVaultUrl(vaultName);
  assertValidPlistLabel(label);
  const normalized = normalizeCadences(cadences);
  if (normalized.length === 0 || normalized.length > 16) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "cadences must contain between 1 and 16 distinct entries.", {});
  }
  const intervalDicts = normalized
    .map((cadence) => {
      const weekdayKey = cadence.weekday !== undefined ? `<key>Weekday</key><integer>${cadence.weekday}</integer>` : "";
      return `<dict><key>Hour</key><integer>${cadence.hour}</integer><key>Minute</key><integer>${cadence.minute}</integer>${weekdayKey}</dict>`;
    })
    .join("");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>${OWNERSHIP_MARKER_KEY}</key>
  <string>${OWNERSHIP_MARKER_VALUE}</string>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(OPEN_PATH)}</string>
    <string>${xmlEscape(url)}</string>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StartCalendarInterval</key>
  <array>${intervalDicts}</array>
</dict>
</plist>
`;
  if (Buffer.byteLength(plist, "utf8") > MAX_PLIST_BYTES) {
    throw new EngineError("LAUNCH_AGENT_INVALID", `Generated plist exceeds the maximum size (${MAX_PLIST_BYTES} bytes).`, {});
  }
  return plist;
}

interface ExtractedPlistFields {
  vaultName: string;
  cadences: WakeCadence[];
}

/** Strictly parses the closed `<dict>...</dict><dict>...</dict>` run `buildLaunchAgentPlist` emits for `StartCalendarInterval` -- every byte of `inner` must belong to a contiguous, well-formed dict (no gap, no trailing content); anything else fails closed (`null`). */
function parseCalendarDicts(inner: string): WakeCadence[] | null {
  const DICT_PATTERN = /<dict><key>Hour<\/key><integer>(-?\d+)<\/integer><key>Minute<\/key><integer>(-?\d+)<\/integer>(?:<key>Weekday<\/key><integer>(-?\d+)<\/integer>)?<\/dict>/g;
  const cadences: WakeCadence[] = [];
  let cursor = 0;
  for (const match of inner.matchAll(DICT_PATTERN)) {
    if (match.index !== cursor) return null;
    cursor += match[0].length;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    cadences.push(match[3] !== undefined ? { hour, minute, weekday: Number(match[3]) } : { hour, minute });
  }
  if (cursor !== inner.length) return null;
  if (cadences.length === 0 || cadences.length > 16) return null;
  return cadences;
}

/**
 * Loosely extracts the caller-meaningful fields (`vaultName`, `cadences`)
 * from a candidate plist string, or returns `null` if any expected field
 * is structurally absent/malformed. Deliberately loose (never a full XML
 * parser, never anchored against the WHOLE document) -- extraction success
 * alone proves nothing about ownership; `isOwnedPlistContent` is the one
 * function that turns this into a real verdict, by regenerating the exact
 * canonical plist for the extracted fields and requiring BYTE-FOR-BYTE
 * equality against the original content. That final equality check is what
 * actually rejects a foreign plist that happens to contain a copied marker
 * and label alongside extra keys/a different `ProgramArguments`/a shell
 * invocation: the canonical regeneration can never reproduce bytes it
 * didn't itself write, no matter how loosely fields were extracted.
 */
function extractOwnedPlistFields(contents: string, expectedLabel: string): ExtractedPlistFields | null {
  const markerPattern = new RegExp(`<key>${OWNERSHIP_MARKER_KEY}</key>\\s*<string>${OWNERSHIP_MARKER_VALUE}</string>`);
  if (!markerPattern.test(contents)) return null;

  const labelMatch = contents.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
  if (!labelMatch || xmlUnescape(labelMatch[1]) !== expectedLabel) return null;

  const programMatch = contents.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/);
  if (!programMatch) return null;
  if (xmlUnescape(programMatch[1]) !== OPEN_PATH) return null;

  const decodedUrl = xmlUnescape(programMatch[2]);
  const urlPrefix = "obsidian://open?vault=";
  if (!decodedUrl.startsWith(urlPrefix)) return null;
  let vaultName: string;
  try {
    vaultName = decodeURIComponent(decodedUrl.slice(urlPrefix.length));
    assertValidVaultName(vaultName);
  } catch {
    return null;
  }

  if (!/<key>RunAtLoad<\/key>\s*<false\/>/.test(contents)) return null;

  const calendarMatch = contents.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!calendarMatch) return null;
  const cadences = parseCalendarDicts(calendarMatch[1]);
  if (!cadences) return null;

  return { vaultName, cadences };
}

/**
 * `true` iff `contents` is a plist THIS module could have written FOR
 * `expectedLabel`: the complete limited plist structure round-trips --
 * extraction succeeds AND regenerating the canonical plist
 * (`buildLaunchAgentPlist`) for the extracted `vaultName`/`cadences`/
 * `expectedLabel` reproduces `contents` byte-for-byte. Never a bare
 * marker/label substring match -- a foreign plist that copies the
 * ownership marker and label but adds an extra `ProgramArguments` entry, a
 * shell command, an extra top-level key, or reorders/reformats anything
 * can never satisfy this: the canonical regeneration has exactly one
 * possible output for a given (vaultName, cadences, label), and any
 * deviation anywhere in the original bytes fails the final comparison.
 */
export function isOwnedPlistContent(contents: string, expectedLabel: string): boolean {
  assertValidPlistLabel(expectedLabel);
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_PLIST_BYTES) return false;
  const extracted = extractOwnedPlistFields(contents, expectedLabel);
  if (!extracted) return false;
  try {
    return buildLaunchAgentPlist(extracted.vaultName, extracted.cadences, expectedLabel) === contents;
  } catch {
    return false;
  }
}

export interface BackgroundSchedulerFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Required to be atomic on the same filesystem for a temp file placed beside its destination -- true of `fs.rename` on every OS Obsidian ships on. */
  rename(fromPath: string, toPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /**
   * Returns the file's exact byte size, or `null` if it does not exist.
   * REQUIRED (last-acceptance requirement 6) so every read of a plist --
   * the owned plist itself, and a just-written temp file's own readback
   * verification -- can be bounded BEFORE `readFile` is ever invoked, never
   * only after the fact. A throwing/unavailable stat is never silently
   * skipped in favor of a raw read; every call site treats that the same
   * as "cannot determine" (ambiguous, no mutation).
   */
  statSize(path: string): Promise<number | null>;
  /** Best-effort durability sync for the just-written temp file. Absent (or a no-op) on filesystems/adapters that don't support it -- never required for correctness, only for surviving a hard power loss. */
  fsync?(path: string): Promise<void>;
  /** Best-effort durability sync of the directory entry after a rename. Optional and best-effort: a failure here is swallowed rather than surfaced. */
  fsyncDir?(path: string): Promise<void>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * Fixed-argv-only process seam: every call site in this module builds a
 * complete, closed argv array itself (never string-concatenated, never
 * shell-interpolated). Non-shell, direct-argv-array launch semantics are
 * load-bearing for a real implementation of this interface, not merely a
 * style choice -- a conforming adapter MUST invoke `executablePath`
 * directly with `argv` as a literal array (Node's non-shell child-process
 * launch API family, not a shell-string one), since `argv` entries here (a
 * vault-derived URL, a plist path) are never escaped for a shell by this
 * module.
 */
export interface ProcessRunner {
  run(executablePath: string, argv: readonly string[]): Promise<ProcessResult>;
}

export type BackgroundReconcileStatus =
  | "unsupported-platform"
  | "disabled"
  | "installed"
  | "removed"
  | "foreign-conflict"
  | "ambiguous-launchctl-output"
  | "load-failed"
  | "unload-failed"
  /** `status()` only: the owned plist is present and correct, but `launchctl print` reports the service is not currently loaded (final-integration requirement 9) -- distinct from `"load-failed"`, which means a `reconcile()` bootstrap ATTEMPT itself failed. */
  | "not-loaded";

export interface BackgroundReconcileResult {
  status: BackgroundReconcileStatus;
  changed: boolean;
}

export interface BackgroundSchedulerOptions {
  /** Injected, never read from `process.platform` directly -- e.g. `process.platform` at the real call site. */
  platform: string;
  /** Injected numeric UID (`gui/<uid>` launchd domain target) -- e.g. `process.getuid()` at the real call site. Must be a bounded non-negative safe integer. */
  uid: number;
  /**
   * The user's home directory, injected rather than derived from
   * `os.homedir()` internally, so this module never touches the real
   * filesystem location on its own. `~/Library/LaunchAgents` is derived
   * EXACTLY as `userHomeDir + "/Library/LaunchAgents"` -- this module never
   * accepts a caller-supplied LaunchAgents path directly (final-integration
   * requirement 7): a suffix-only check on a caller-supplied path would
   * accept a "tmp lookalike" such as `/tmp/evil/Library/LaunchAgents`,
   * which this exact-derivation approach makes structurally impossible.
   * Must be an absolute, control-free, traversal-free, bounded path.
   */
  userHomeDir: string;
  /** Stable per-vault installation id (bounded, safe token) this LaunchAgent's `Label` is derived from -- never a display name or filesystem path, so a vault rename never changes ownership identity and two enabled vaults with distinct ids can never collide. */
  installationId: string;
  fs: BackgroundSchedulerFs;
  process: ProcessRunner;
}

export interface ReconcileInput {
  consent: boolean;
  vaultName: string;
  /**
   * The system timezone macOS itself is currently set to -- launchd's
   * `StartCalendarInterval` always fires in that zone, never an arbitrary
   * IANA one (final-integration requirement 12). Every entry in `cadences`
   * must carry this exact same value in its own `systemTimeZone` field;
   * `reconcile` validates this explicitly at runtime.
   */
  systemTimeZone: string;
  /** Every entry must already be a caller-declared system-local wake time -- see `SystemLocalWakeCadence`'s doc comment. */
  cadences: readonly SystemLocalWakeCadence[];
}

function assertValidUid(uid: unknown): asserts uid is number {
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "uid must be a bounded non-negative safe integer.", {});
  }
}

/**
 * Well-known top-level directory names that are never a plausible user home
 * -- deriving `<userHomeDir>/Library/LaunchAgents` from one of these would
 * land on (or beside) a SYSTEM-WIDE LaunchAgents/LaunchDaemons location or a
 * world-writable scratch directory, never a real per-user home (last-
 * acceptance requirement 8). Checked against the FIRST path segment only.
 */
/** Deliberately excludes "Volumes" -- a network-mounted home directory legitimately lives at e.g. "/Volumes/HomeServer/alice" on macOS, so that root is a plausible real user home and must not be rejected outright. */
const FORBIDDEN_HOME_ROOT_SEGMENTS: ReadonlySet<string> = new Set(["Library", "System", "private", "etc", "tmp", "var", "bin", "sbin", "usr", "Applications", "opt", "dev", "proc", "run"]);
const MIN_USER_HOME_SEGMENTS = 2; // e.g. "/Users/alice" -- a bare "/Users" or "/home" alone is not a specific user's home.
const MAX_USER_HOME_SEGMENTS = 32;

function assertValidUserHomeDir(dir: unknown): asserts dir is string {
  if (typeof dir !== "string" || dir.length === 0 || dir.length > MAX_LAUNCH_AGENTS_DIR_LENGTH || hasControlOrNulCharacter(dir)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "userHomeDir must be a short, bounded, control-free string.", {});
  }
  if (!dir.startsWith("/")) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "userHomeDir must be an absolute path.", {});
  }
  const segments = dir.split("/").filter((segment) => segment.length > 0);
  if (segments.includes("..") || segments.includes(".")) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "userHomeDir must not contain a traversal segment.", {});
  }
  // Never the filesystem root itself, never a bounded but implausible number of segments, and
  // never rooted at a well-known system/tmp directory name -- rules out "/" itself, a bare
  // "/Users", "/Library/LaunchAgents"'s own parent, and a "tmp lookalike" such as
  // "/tmp/evil/Users/alice" all in one check (the FIRST segment is what matters: a real user home
  // is never nested inside one of these).
  if (segments.length < MIN_USER_HOME_SEGMENTS || segments.length > MAX_USER_HOME_SEGMENTS) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "userHomeDir does not look like a specific user's home directory.", {});
  }
  if (FORBIDDEN_HOME_ROOT_SEGMENTS.has(segments[0])) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "userHomeDir must not be rooted at a system/shared directory.", {});
  }
}

/** Bounded per-timezone validation-result cache -- avoids reconstructing an `Intl.DateTimeFormat` on every `reconcile()` call for the same repeated system timezone (mirrors `src/scheduling/scheduleTime.ts`'s own `getCachedFormatter` bound/FIFO-eviction pattern, duplicated locally rather than imported so this module stays a leaf). Caches only the boolean validity verdict, never the timezone string's provenance beyond the key itself. */
const MAX_CACHED_TIMEZONE_VALIDATIONS = 64;
const timeZoneValidationCache = new Map<string, boolean>();

function isValidIanaTimeZone(value: string): boolean {
  const cached = timeZoneValidationCache.get(value);
  if (cached !== undefined) return cached;
  let valid: boolean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    valid = value === "UTC" || value.includes("/");
  } catch {
    valid = false;
  }
  if (timeZoneValidationCache.size >= MAX_CACHED_TIMEZONE_VALIDATIONS) {
    const oldestKey = timeZoneValidationCache.keys().next().value;
    if (oldestKey !== undefined) timeZoneValidationCache.delete(oldestKey);
  }
  timeZoneValidationCache.set(value, valid);
  return valid;
}

/**
 * Validates `value` as a real IANA timezone identifier via `Intl` (last-
 * acceptance requirement 5) -- mirrors `src/scheduling/scheduleTime.ts`'s
 * `assertValidIanaTimeZone` check exactly (constructing the formatter IS
 * the validation; a bare UTC-offset string like "+05:00" is additionally
 * rejected since some `Intl` implementations loosely accept it as a
 * "custom time zone identifier"), duplicated locally rather than imported
 * so this module stays a leaf within `src/scheduling` with no dependency on
 * `scheduleTime.ts`. Value-free on failure -- the offending string is
 * never echoed into the thrown error, even though it IS used as the bounded
 * cache key above (the cache never surfaces its keys to a caller).
 */
function assertValidSystemTimeZone(value: unknown): asserts value is string {
  assertBoundedTimeZoneMarker(value);
  if (!isValidIanaTimeZone(value)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "systemTimeZone is not a recognized IANA timezone.", {});
  }
}

function assertValidProcessResult(result: unknown): asserts result is ProcessResult {
  if (typeof result !== "object" || result === null) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "ProcessResult must be an object.", {});
  }
  const record = result as Record<string, unknown>;
  if (typeof record.code !== "number" || !Number.isSafeInteger(record.code)) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "ProcessResult.code must be a safe integer.", {});
  }
  if (typeof record.stdout !== "string" || Buffer.byteLength(record.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "ProcessResult.stdout must be a bounded string.", {});
  }
  if (typeof record.stderr !== "string" || Buffer.byteLength(record.stderr, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw new EngineError("LAUNCH_AGENT_INVALID", "ProcessResult.stderr must be a bounded string.", {});
  }
  if (record.timedOut !== undefined && typeof record.timedOut !== "boolean") {
    throw new EngineError("LAUNCH_AGENT_INVALID", "ProcessResult.timedOut must be a boolean when present.", {});
  }
}

type PrintDeterminedState = "loaded" | "absent" | "ambiguous";

/** Classifies `launchctl print <serviceTarget>` output into an explicit tri-state -- never inferred from arbitrary error wording beyond the one stable, well-known "not found" signal launchd itself emits. Any output/exit-code combination that isn't one of these two recognized shapes is `"ambiguous"`, which callers must never mutate state on. */
function classifyPrintOutput(result: ProcessResult): PrintDeterminedState {
  if (result.code === 0 && /^\s*state\s*=/im.test(result.stdout)) {
    return "loaded";
  }
  if (result.code !== 0 && /could not find service|no such process/i.test(result.stderr)) {
    return "absent";
  }
  return "ambiguous";
}

/**
 * The optional macOS LaunchAgent adapter. Every method fails closed toward
 * inaction: platform mismatch, missing consent, an unparseable/foreign
 * plist, or an unparseable `launchctl` response all stop short of writing,
 * removing, or (un)loading anything, rather than guessing. Ownership is
 * checked by CONTENT (`isOwnedPlistContent`, keyed to this instance's own
 * per-vault `label`), never merely by path -- something else could have
 * been placed at this exact plist path, and this module must never touch
 * it. Loaded/absent service state is always established via an explicit
 * `launchctl print` call classified through `classifyPrintOutput` BEFORE
 * any bootstrap/bootout mutation -- never inferred from a prior
 * bootstrap/bootout call's own error wording.
 */
export class BackgroundScheduler {
  private readonly platform: string;
  private readonly uid: number;
  private readonly launchAgentsDir: string;
  private readonly fs: BackgroundSchedulerFs;
  private readonly process: ProcessRunner;
  private readonly label: string;
  private readonly plistPath: string;
  /** The one exclusive lane every `reconcile()`/`remove()` call is serialized through (final-integration requirement 8) -- `status()` stays read-only and never touches this. */
  private opTail: Promise<void> = Promise.resolve();

  constructor(options: BackgroundSchedulerOptions) {
    assertValidUid(options.uid);
    assertValidUserHomeDir(options.userHomeDir);
    this.platform = options.platform;
    this.uid = options.uid;
    // Exact derivation only (requirement 7) -- never a caller-supplied LaunchAgents path.
    this.launchAgentsDir = `${options.userHomeDir.replace(/\/+$/, "")}${LAUNCH_AGENTS_DIR_SUFFIX}`;
    this.fs = options.fs;
    this.process = options.process;
    this.label = buildOwnedLabel(options.installationId);
    this.plistPath = `${this.launchAgentsDir}/${this.label}.plist`;
    if (!this.plistPath.startsWith(`${this.launchAgentsDir}/`) || this.plistPath.includes("..")) {
      throw new EngineError("LAUNCH_AGENT_INVALID", "Derived plist path escapes the owned LaunchAgents directory.", {});
    }
  }

  /** Queues `fn` behind whatever is already in `opTail` and returns the resulting promise -- the ONE place `opTail` is ever read/reassigned. Serializes every `reconcile()`/`remove()` call so two concurrent calls can never interleave `launchctl print`/`bootout`/plist write/`bootstrap`/unlink. */
  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(fn);
    this.opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private get serviceTarget(): string {
    return `gui/${this.uid}/${this.label}`;
  }

  private get domainTarget(): string {
    return `gui/${this.uid}`;
  }

  /** Catches a throwing `ProcessRunner`/malformed result into `null` -- a fault at this seam must never become an unhandled rejection or expose a raw error. */
  private async runProcess(executablePath: string, argv: readonly string[]): Promise<ProcessResult | null> {
    let result: ProcessResult;
    try {
      result = await this.process.run(executablePath, argv);
    } catch {
      return null;
    }
    try {
      assertValidProcessResult(result);
    } catch {
      return null;
    }
    return result;
  }

  private async determineServiceState(): Promise<PrintDeterminedState> {
    const result = await this.runProcess(LAUNCHCTL_PATH, ["print", this.serviceTarget]);
    if (result === null) return "ambiguous";
    return classifyPrintOutput(result);
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.fs.unlink(path);
    } catch {
      // Best-effort cleanup only; a failed unlink here must never mask the original error.
    }
  }

  /**
   * Tri-state existence check (last-acceptance requirement 5) -- a throwing
   * `fs.exists` (a permission error, a transient I/O fault) is
   * `"ambiguous"`, deliberately DISTINCT from `"absent"`: collapsing them
   * (as a boolean-returning `existsSafe` used to) let `status()` report
   * `"removed"` and `reconcile()` potentially install OVER a path this
   * module genuinely cannot inspect. Every caller below treats
   * `"ambiguous"` the same way -- `"ambiguous-launchctl-output"`, zero
   * launchctl calls, zero writes/unlinks.
   */
  private async existsTriState(path: string): Promise<"present" | "absent" | "ambiguous"> {
    let result: boolean;
    try {
      result = await this.fs.exists(path);
    } catch {
      return "ambiguous";
    }
    if (typeof result !== "boolean") return "ambiguous";
    return result ? "present" : "absent";
  }

  /** `this.fs.statSize` never throws a raw error out of this module -- a throwing/malformed-return stat seam is treated as "cannot determine" (`null`), same as `existsTriState`'s `"ambiguous"`. */
  private async statSizeSafe(path: string): Promise<number | null> {
    let size: number | null;
    try {
      size = await this.fs.statSize(path);
    } catch {
      return null;
    }
    if (size === null) return null;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return null;
    return size;
  }

  /**
   * Reads `this.plistPath`, bounding its size via `statSize` BEFORE
   * `readFile` is ever invoked (last-acceptance requirement 6) -- an
   * oversized or unknown (throwing/null) stat result means `readFile` is
   * never called at all, not merely that its result gets discarded after
   * the fact. Returns `null` -- never throws -- on any stat/read failure
   * or oversized content; every call site treats `null` as "ambiguous,"
   * exactly like an unreadable file.
   */
  private async readOwnedPlistBounded(): Promise<string | null> {
    const size = await this.statSizeSafe(this.plistPath);
    if (size === null || size > MAX_PLIST_BYTES) return null;
    let contents: string;
    try {
      contents = await this.fs.readFile(this.plistPath);
    } catch {
      return null;
    }
    if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > MAX_PLIST_BYTES) return null;
    return contents;
  }

  /** Writes `contents` to a fresh temp file beside `this.plistPath`, fsyncs it, and stat-bounds + reads back the temp file to verify it landed byte-exact -- BEFORE `readFile` is invoked on the temp path too (last-acceptance requirement 6). Returns the temp path on success; throws (and best-effort cleans up the temp file) on any write/fsync/stat/readback failure. Never renames -- see `atomicWritePlist`, which calls this and then revalidates the DESTINATION immediately before its own rename. */
  private async writeAndVerifyTemp(contents: string): Promise<string> {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const tempPath = `${this.launchAgentsDir}/.atomic-tmp-${this.label}.plist.${token}`;

    try {
      await this.fs.writeFile(tempPath, contents);
      if (this.fs.fsync) await this.fs.fsync(tempPath);
    } catch {
      await this.safeUnlink(tempPath);
      throw new EngineError("LAUNCH_AGENT_WRITE_FAILED", "Failed to write the owned LaunchAgent plist.", {});
    }

    const expectedBytes = Buffer.byteLength(contents, "utf8");
    const tempSize = await this.statSizeSafe(tempPath);
    if (tempSize === null || tempSize !== expectedBytes) {
      await this.safeUnlink(tempPath);
      throw new EngineError("LAUNCH_AGENT_WRITE_FAILED", "Temp file size check failed for the owned LaunchAgent plist; prior plist left unchanged.", {});
    }
    try {
      const readBack = await this.fs.readFile(tempPath);
      if (readBack !== contents) throw new Error("readback mismatch");
    } catch {
      await this.safeUnlink(tempPath);
      throw new EngineError("LAUNCH_AGENT_WRITE_FAILED", "Write-back verification failed for the owned LaunchAgent plist; prior plist left unchanged.", {});
    }
    return tempPath;
  }

  /**
   * Writes `contents` via `writeAndVerifyTemp`, then -- IMMEDIATELY BEFORE
   * the atomic rename, never earlier (last-acceptance requirement 7) --
   * revalidates the DESTINATION exactly matches `expected`:
   *  - `{ kind: "absent" }` (fresh install): the destination must still be
   *    genuinely absent; `"present"` or `"ambiguous"` aborts without ever
   *    renaming over it.
   *  - `{ kind: "owned"; priorBytes }` (replacement): the destination must
   *    still read back EXACTLY `priorBytes` and still pass
   *    `isOwnedPlistContent` -- both the byte-exact prior content AND
   *    canonical ownership are re-checked, not merely re-derived.
   * This closes the window `stillOwned()`-called-before-`writeAndVerifyTemp`
   * used to leave open: the temp write/fsync/readback work has no reason to
   * observe the destination at all, so checking ownership before that work
   * started was checking a stale snapshot. Returns `"written"` on success;
   * `"foreign-conflict"` or `"ambiguous"` if the pre-rename revalidation
   * fails (the temp file is cleaned up either way, and the destination is
   * never touched).
   */
  private async atomicWritePlist(contents: string, expected: { kind: "absent" } | { kind: "owned"; priorBytes: string }): Promise<"written" | "foreign-conflict" | "ambiguous"> {
    const tempPath = await this.writeAndVerifyTemp(contents);

    if (expected.kind === "absent") {
      const state = await this.existsTriState(this.plistPath);
      if (state !== "absent") {
        await this.safeUnlink(tempPath);
        return state === "ambiguous" ? "ambiguous" : "foreign-conflict";
      }
    } else {
      const currentContents = await this.readOwnedPlistBounded();
      if (currentContents === null) {
        await this.safeUnlink(tempPath);
        return "ambiguous";
      }
      if (currentContents !== expected.priorBytes || !isOwnedPlistContent(currentContents, this.label)) {
        await this.safeUnlink(tempPath);
        return "foreign-conflict";
      }
    }

    try {
      await this.fs.rename(tempPath, this.plistPath);
    } catch {
      await this.safeUnlink(tempPath);
      throw new EngineError("LAUNCH_AGENT_WRITE_FAILED", "Failed to atomically commit the owned LaunchAgent plist.", {});
    }

    if (this.fs.fsyncDir) {
      try {
        await this.fs.fsyncDir(this.launchAgentsDir);
      } catch {
        // The rename already succeeded and is visible; a directory-fsync failure here is
        // best-effort durability only and must never turn an already-committed write into a
        // thrown error.
      }
    }
    return "written";
  }

  /**
   * Read-only: reports current state without mutating anything. Routed
   * through the SAME exclusive `opTail` lane as `reconcile()`/`remove()`
   * (last-acceptance requirement 9) so it can never observe a half-applied
   * intermediate state mid-way through one of their own print/bootout/
   * write/bootstrap/unlink sequences -- it still performs no mutation of
   * its own. Inspects explicit `launchctl print` state (rather than
   * reporting `"installed"` from the file's presence/content alone) -- see
   * the state-matrix table in this method's implementation.
   */
  status(): Promise<BackgroundReconcileStatus> {
    return this.enqueueOp(() => this.statusInner());
  }

  private async statusInner(): Promise<BackgroundReconcileStatus> {
    if (this.platform !== "darwin") return "unsupported-platform";
    const existence = await this.existsTriState(this.plistPath);
    if (existence === "ambiguous") return "ambiguous-launchctl-output";
    if (existence === "absent") {
      // No plist on disk but launchctl reports our label already LOADED (or its own state can't be
      // determined) is an inconsistent signal -- mirrors reconcileInner's identical fresh-install
      // check. Never simply "removed" without confirming launchctl agrees nothing is loaded either.
      const state = await this.determineServiceState();
      return state === "absent" ? "removed" : "ambiguous-launchctl-output";
    }
    const contents = await this.readOwnedPlistBounded();
    if (contents === null) return "ambiguous-launchctl-output";
    if (!isOwnedPlistContent(contents, this.label)) return "foreign-conflict";

    // File is present and owned -- launchctl's own state decides the rest of the matrix:
    //   owned+desired, loaded       -> "installed"
    //   owned+desired, absent       -> "not-loaded" (never inferred from the file alone)
    //   owned+desired, ambiguous    -> "ambiguous-launchctl-output" (no mutation, this is read-only anyway)
    const state = await this.determineServiceState();
    if (state === "loaded") return "installed";
    if (state === "absent") return "not-loaded";
    return "ambiguous-launchctl-output";
  }

  /**
   * Reconciles the LaunchAgent against the caller's current desired state.
   * Called after restart, a changed vault name, a changed cadence set, a
   * consent flip, or a platform change -- always safe to call repeatedly
   * with the same input (a no-op the second time). Never mutates the
   * plist/service when the current `launchctl print` state is ambiguous.
   * Serialized against every other `reconcile()`/`remove()`/`status()` call
   * on this instance -- two concurrent calls can never interleave their
   * print/bootout/write/bootstrap/unlink sequence.
   */
  reconcile(input: ReconcileInput): Promise<BackgroundReconcileResult> {
    return this.enqueueOp(() => this.reconcileInner(input));
  }

  private async reconcileInner(input: ReconcileInput): Promise<BackgroundReconcileResult> {
    if (this.platform !== "darwin") {
      return { status: "unsupported-platform", changed: false };
    }
    if (!input.consent) {
      return this.removeInternal();
    }
    // final-integration requirement 12 / last-acceptance requirement 8: every cadence must carry
    // the SAME REAL-IANA-validated systemTimeZone ReconcileInput declares -- a branded type alone
    // is erasable by a cast, so this is re-validated at runtime, not merely assumed from the type.
    assertValidSystemTimeZone(input.systemTimeZone);
    for (const cadence of input.cadences) {
      if (cadence.systemTimeZone !== input.systemTimeZone) {
        throw new EngineError("LAUNCH_AGENT_INVALID", "Every cadence's systemTimeZone must match ReconcileInput.systemTimeZone exactly.", {});
      }
    }

    const desiredPlist = buildLaunchAgentPlist(input.vaultName, input.cadences, this.label);
    const existence = await this.existsTriState(this.plistPath);
    if (existence === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };

    if (existence === "absent") {
      const state = await this.determineServiceState();
      // No plist on disk but launchctl reports our label already LOADED is an inconsistent signal
      // (last-acceptance requirement 9's "no plist and service loaded means ambiguous or
      // foreign") -- something else loaded a service under this label without our plist ever
      // having been written, or a leftover load survived a plist deletion outside this module's
      // control. Never bootstrap a fresh plist on top of that without first understanding it.
      if (state !== "absent") return { status: "ambiguous-launchctl-output", changed: false };
      return this.writePlistAndBootstrap(desiredPlist, { kind: "absent" });
    }

    const currentContents = await this.readOwnedPlistBounded();
    if (currentContents === null) {
      return { status: "ambiguous-launchctl-output", changed: false };
    }
    if (!isOwnedPlistContent(currentContents, this.label)) {
      // Never overwrite/remove a plist we didn't write, even if it happens to sit at our exact
      // owned path.
      return { status: "foreign-conflict", changed: false };
    }

    const state = await this.determineServiceState();

    if (currentContents === desiredPlist) {
      if (state === "loaded") return { status: "installed", changed: false };
      if (state === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };
      // "absent": already exactly the plist we want on disk, just not loaded -- bootstrap it.
      const bootstrap = await this.runProcess(LAUNCHCTL_PATH, ["bootstrap", this.domainTarget, this.plistPath]);
      if (bootstrap === null || bootstrap.code !== 0) return { status: "load-failed", changed: false };
      return { status: "installed", changed: false };
    }

    // Content differs (vault or cadence changed): establish state safely before touching anything.
    if (state === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };
    if (state === "loaded") {
      const unload = await this.runProcess(LAUNCHCTL_PATH, ["bootout", this.serviceTarget]);
      if (unload === null || unload.code !== 0) return { status: "unload-failed", changed: false };
    }
    return this.writePlistAndBootstrap(desiredPlist, { kind: "owned", priorBytes: currentContents });
  }

  private async writePlistAndBootstrap(desiredPlist: string, expected: { kind: "absent" } | { kind: "owned"; priorBytes: string }): Promise<BackgroundReconcileResult> {
    const writeResult = await this.atomicWritePlist(desiredPlist, expected);
    if (writeResult === "foreign-conflict") return { status: "foreign-conflict", changed: false };
    if (writeResult === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };
    const bootstrap = await this.runProcess(LAUNCHCTL_PATH, ["bootstrap", this.domainTarget, this.plistPath]);
    if (bootstrap === null || bootstrap.code !== 0) return { status: "load-failed", changed: true };
    return { status: "installed", changed: true };
  }

  /**
   * Explicit uninstall -- removes only the exact owned plist/service.
   * Idempotent: a missing plist is treated as already-removed, never an
   * error. Refuses (leaves everything untouched) if the plist at our owned
   * path is foreign/ambiguous, or if current service state can't be
   * determined. Serialized against every other `reconcile()`/`remove()`/
   * `status()` call on this instance.
   */
  remove(): Promise<BackgroundReconcileResult> {
    return this.enqueueOp(async () => {
      if (this.platform !== "darwin") return { status: "unsupported-platform", changed: false };
      return this.removeInternal();
    });
  }

  private async removeInternal(): Promise<BackgroundReconcileResult> {
    const existence = await this.existsTriState(this.plistPath);
    if (existence === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };
    if (existence === "absent") return { status: "removed", changed: false };
    const contents = await this.readOwnedPlistBounded();
    if (contents === null) {
      return { status: "ambiguous-launchctl-output", changed: false };
    }
    if (!isOwnedPlistContent(contents, this.label)) {
      return { status: "foreign-conflict", changed: false };
    }

    const state = await this.determineServiceState();
    if (state === "ambiguous") return { status: "ambiguous-launchctl-output", changed: false };
    if (state === "loaded") {
      const unload = await this.runProcess(LAUNCHCTL_PATH, ["bootout", this.serviceTarget]);
      if (unload === null || unload.code !== 0) return { status: "unload-failed", changed: false };
    }
    // Revalidate ownership immediately before the destructive unlink (last-acceptance requirement
    // 11's rename-time-revalidation principle, applied to remove()'s own destructive action) --
    // closes the window between the read-and-validate above and this unlink during which an
    // external actor could have replaced the file with something foreign.
    const revalidated = await this.readOwnedPlistBounded();
    if (revalidated === null || revalidated !== contents || !isOwnedPlistContent(revalidated, this.label)) {
      return { status: "foreign-conflict", changed: false };
    }
    try {
      await this.fs.unlink(this.plistPath);
    } catch {
      throw new EngineError("LAUNCH_AGENT_WRITE_FAILED", "Failed to remove the owned LaunchAgent plist.", {});
    }
    return { status: "removed", changed: true };
  }
}

export { OWNERSHIP_MARKER_KEY, OWNERSHIP_MARKER_VALUE, LABEL_PREFIX, LAUNCHCTL_PATH, OPEN_PATH };
