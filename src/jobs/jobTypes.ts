import {
  JOB_KIND_PHASES,
  JOB_KIND_TARGET_KIND,
  JOB_TRIGGER_KINDS,
  parseQueueJobV1,
  isJobTrigger,
  type JobKind,
  type JobPhase,
  type JobTrigger,
  type NoteIdentityV1,
  type QueueJobV1,
  type SchemaVersion,
} from "../engine/contracts";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { ENGINE_ERROR_CODES, EngineError, type EngineErrorCode } from "../engine/errors";

/**
 * Checkpoint 7's persisted job model builds directly on Checkpoint 1's
 * `QueueJobV1`/`JOB_KIND_PHASES`/`JOB_TRIGGER_KINDS` contracts (imported,
 * never redefined) and adds only the engine-bookkeeping fields those
 * contracts deliberately leave out: attempt count, run status, cancellation
 * intent, a redacted static failure code/class, and a minimal durable phase
 * receipt. Nothing here ever carries note bodies, prompts, provider
 * response bodies, API keys, or vectors -- see `JobReceiptV1`.
 */

/** Codepoint check (never a regex literal containing an actual control byte) -- see src/index/sourceControlBytes.test.ts for why this codebase avoids control-byte regex literals. */
function hasControlOrNulCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * A note identity's STABLE key -- for an `"apple-annotation"` identity, its
 * `appleAnnotationId` (never the renameable `canonicalPath`); for a
 * `"path"` identity, the path itself. Shared by every `src/jobs` runner
 * that needs to compare/deduplicate identities by their durable identity
 * rather than their current path (`noteJob.ts`'s rename-following source
 * lookup, `scopeJob.ts`'s duplicate-discovery check) -- previously
 * duplicated verbatim in both files (and again in
 * `src/index/generationMetadata.ts`'s `identityKey`, which stays a
 * separate copy so `src/index` never depends on `src/jobs`), now a single
 * shared definition within `src/jobs` itself (Checkpoint 7 acceptance
 * guard 7).
 */
export function noteIdentityStableKey(identity: NoteIdentityV1): string {
  return identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
}

/**
 * A short, bounded, control-character-free, non-empty string -- the shape
 * every free-text identifier a caller-supplied seam hands back (an
 * embedding model name, etc.) must have before it is ever trusted, logged,
 * or persisted. Shared so every seam-output identifier check in
 * `src/jobs` uses exactly the same rule rather than each runner
 * re-deriving its own slightly different bound/character check.
 */
export function assertBoundedControlFreeIdentifier(value: unknown, maxLength: number, label: string, code: EngineErrorCode = "CONTRACT_SHAPE_INVALID"): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || hasControlOrNulCharacter(value)) {
    throw new EngineError(code, `${label} must be a short, bounded, control-free, non-empty string.`, {});
  }
}

/** Hard caps -- see Checkpoint 7 requirement 7 (resource/security). */
export const MAX_PERSISTED_JOBS = 5000;
export const MAX_ATTEMPT_COUNT = 20;
export const MAX_JOB_ID_LENGTH = 128;
export const MAX_FAILURE_CODE_LENGTH = 64;
export const MAX_PAUSE_CODE_LENGTH = 64;
export const MAX_RECEIPT_HASH_LENGTH = 64;
export const MAX_STORE_SERIALIZED_BYTES = 8 * 1024 * 1024;
/** Mirrors `scopeJob.ts`'s `MAX_SCOPE_DISCOVERY_ITEMS` -- a defensive bound on the scope receipt's own count fields, kept in lock-step by that module rather than imported (jobTypes.ts stays leaf-level within `src/jobs`). */
export const MAX_SCOPE_DISCOVERY_ITEMS = 20_000;
/** Mirrors `src/index/budgets.ts`'s `MAX_PENDING_OVERLAY_COUNT` -- declared independently (not imported) so `src/jobs` never depends on `src/index`'s internal budget module just for one constant; a rebuild snapshot can never legitimately need to describe more overlays than the index layer itself would ever allow pending at once. */
export const MAX_REBUILD_SNAPSHOT_OVERLAYS = 2000;
export const MAX_REBUILD_SNAPSHOT_MODEL_LENGTH = 200;
const OVERLAY_FILE_NAME_PATTERN = /^overlays\/[0-9a-f]{64}\.movl$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

/** No `"paused"` member -- Checkpoint 7's engine never produces one (a provider-wide pause blocks DISPATCH via `ProviderPauseV1`, it never sets a job's own status), so an unused, never-modeled status is not carried in the type at all. */
export type JobStatus = "queued" | "active" | "failed" | "cancelled" | "completed";

const JOB_STATUS_SET: Record<JobStatus, true> = { queued: true, active: true, failed: true, cancelled: true, completed: true };
function isJobStatus(value: unknown): value is JobStatus { return typeof value === "string" && Object.prototype.hasOwnProperty.call(JOB_STATUS_SET, value); }
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["failed", "cancelled", "completed"]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type FailureClass = "terminal" | "transient";

/**
 * Failure codes that can NEVER succeed on a bare retry with the same
 * inputs (a malformed/mismatched shape, an unrecoverable content
 * conflict). Everything else -- including any code this module has never
 * seen before -- defaults to `"transient"` and stays retryable, per
 * Checkpoint 7 requirement 1: "unknown failures default transient/
 * retryable, never silently terminal."
 */
const KNOWN_TERMINAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "SOURCE_STALE",
  "IDENTITY_INVALID",
  "CONTRACT_SHAPE_INVALID",
  "CONTRACT_SCHEMA_VERSION_MISMATCH",
  "CONTRACT_SCHEMA_VERSION_MISSING",
  "FRONTMATTER_MALFORMED",
  "PATH_EMPTY",
  "PATH_ABSOLUTE",
  "PATH_TRAVERSAL",
  "PATH_CONTROL_CHARACTER",
  "EMBEDDING_MODEL_NOT_FOUND",
  "EMBEDDING_DIMENSION_MISMATCH",
  "EMBEDDING_DIMENSION_INVALID",
  "EMBEDDING_MODEL_MISMATCH",
  "EMBEDDING_VECTOR_INVALID",
  "EMBEDDING_COUNT_MISMATCH",
  "EMBEDDING_BATCH_INVALID",
  "EMBEDDING_ENDPOINT_INVALID",
  "METADATA_RESPONSE_INVALID",
  "METADATA_CONFIG_INVALID",
  "METADATA_PROMPT_TOO_LARGE",
  "METADATA_RESPONSE_TOO_LARGE",
  "METADATA_ENDPOINT_INVALID",
  "JOB_SHAPE_INVALID",
  "JOB_TRANSITION_INVALID",
  "JOB_CAP_EXCEEDED",
  "REBUILD_SUPERSEDED",
  "GENERATION_ARTIFACT_MISMATCH",
  "SCOPE_SUPERSEDED",
]);

/**
 * The ONLY place an arbitrary caught error's `EngineError.code` (or a
 * seam-defined string) is turned into a persisted failure classification.
 * Never inspects `.message` -- only a bounded, allow-list-shaped code is
 * ever persisted (see `assertFailureCode`), so a provider/seam error's raw
 * text can never leak into the store even indirectly through this
 * function's input.
 */
export function classifyFailureCode(code: string): FailureClass {
  return KNOWN_TERMINAL_FAILURE_CODES.has(code) ? "terminal" : "transient";
}

/**
 * The closed allow-list of every failure code this store will ever persist:
 * every `EngineErrorCode` plus `"UNKNOWN_TRANSIENT"` itself. Deliberately
 * NOT a shape/regex check ("looks like SCREAMING_SNAKE_CASE") -- a shape
 * check alone would happily accept a seam naming its `Error` e.g.
 * `"SECRET_TOKEN"` (or any other attacker/bug-chosen uppercase string) and
 * persist it verbatim. `toFailureCode`/`sanitizeFailureCode` are the only
 * two functions permitted to decide what gets persisted as a failure code;
 * every other module must route through one of them rather than persisting
 * a code string directly.
 */
const RECOGNIZED_FAILURE_CODES: ReadonlySet<string> = new Set<string>([...ENGINE_ERROR_CODES, "UNKNOWN_TRANSIENT"]);

/**
 * Extracts a bounded, store-safe failure code from an arbitrary caught
 * error -- never its message. ONLY a real `EngineError` instance's own
 * `.code` is ever trusted directly: a plain `Error` (or any other thrown
 * value) is ALWAYS redacted to `"UNKNOWN_TRANSIENT"`, even when its
 * `.name` happens to be spelled exactly like a recognized code (e.g. a
 * seam throwing `new Error("...")` with `.name = "SOURCE_STALE"` set by
 * hand). `.name` is caller-controlled, freeform text with no type-level
 * guarantee behind it -- classifying on it would let any thrown value
 * claim an arbitrary terminal/transient classification, or a provider-wide
 * pause, just by picking the right string. Only `EngineError`, whose
 * `code` is a compile-time-checked `EngineErrorCode`, is ever trusted.
 */
export function toFailureCode(error: unknown): string {
  if (error instanceof EngineError && RECOGNIZED_FAILURE_CODES.has(error.code)) return error.code;
  return "UNKNOWN_TRANSIENT";
}

/**
 * Sanitizes a job-phase-runner-supplied outcome code (`PhaseStepOutcome`'s
 * `retry.failureCode` / `provider-pause.code` / `obsolete.failureCode`)
 * through the exact same closed allow-list as `toFailureCode`, before it is
 * ever classified or persisted -- a runner is caller-supplied code (every
 * job kind's `noteJob.ts`/`rebuildJob.ts`, and any future kind), not a
 * trusted internal source, so its outcome code gets no more trust than an
 * arbitrary caught `Error.name` does.
 */
export function sanitizeFailureCode(code: string): string {
  return RECOGNIZED_FAILURE_CODES.has(code) ? code : "UNKNOWN_TRANSIENT";
}

/**
 * A NARROW allow-list of failure codes that indicate the PROVIDER ITSELF is
 * unreachable/misconfigured (as opposed to this one job's own content being
 * rejected) -- these are the only codes `JobEngine.applyStepOutcome` ever
 * honors as a `"provider-pause"` outcome. Shared between `jobEngine.ts`
 * (which enforces it) and `noteJob.ts` (the only current runner that ever
 * returns this outcome kind), so the two can never drift apart. A runner
 * returning `"provider-pause"` with any OTHER code -- even a real,
 * recognized `EngineErrorCode` -- is downgraded to an ordinary per-job
 * retry: only this exact set of codes ever escalates to blocking every
 * other queued job of the same kind (Checkpoint 7 requirement 11).
 */
export const PROVIDER_WIDE_PAUSE_CODES: ReadonlySet<string> = new Set(["EMBEDDING_ENDPOINT_INVALID", "EMBEDDING_MODEL_NOT_FOUND", "METADATA_ENDPOINT_INVALID", "METADATA_CONFIG_INVALID"]);

/**
 * Minimal, content-free durable phase output -- exactly enough for restart
 * to skip already-committed work without redoing it, never enough to
 * reconstruct the note/vectors/prompt themselves.
 *
 * `noteContentHash`/`overlayCommitted` are a commit RECEIPT, not content:
 * on restart, "note write committed, overlay write failed" is
 * distinguishable from "neither committed" purely from these two booleans
 * plus the hash, without ever having persisted the note body itself.
 */
/**
 * One overlay's bounded, content-free identity in a persisted
 * `RebuildSnapshotV1` -- mirrors `CompactionSnapshotOverlayEntry` in
 * `src/index/indexStore.ts`, duplicated here (not imported) to keep
 * `src/jobs` decoupled from `src/index`'s module graph; both sides are
 * kept in lock-step by `rebuildJob.ts`, which is the only bridge between
 * them.
 *
 * `fingerprint` (Checkpoint 7 final-closure requirement 1) is REQUIRED,
 * not merely advisory: `version` alone is not durable identity across a
 * compaction cycle, because `overlayStore.ts` deliberately resets an
 * identity's version counter back to 1 once its prior overlay file is
 * deleted (see that module's own doc comment) -- a brand-new, entirely
 * different overlay for the SAME identity can legitimately reach version 1
 * again. `fingerprint` is derived from the overlay's validated
 * container/prefix metadata plus its note-vector checksum, so it changes
 * whenever the overlay's actual content does, even when filename+version
 * alone would collide with a stale snapshot entry.
 */
export interface RebuildSnapshotOverlayEntryV1 {
  fileName: string;
  version: number;
  fingerprint: string;
}

/**
 * The bounded, content-free descriptor of exactly what a rebuild/migrate
 * job's `build-generation` phase actually built its target generation
 * FROM -- persisted so `activate-generation` (possibly running after a
 * restart, possibly long after other jobs have mutated overlays in
 * between) never has to recompute a fresh overlay snapshot to decide what
 * to delete. See Checkpoint 7 requirement 10.
 *
 * `baseGenerationId`/`baseFingerprint` (final-closure requirement 3) name
 * the CURRENT-POINTER generation this plan was built against (`null` for
 * an initial build with no base generation yet) -- so activation can
 * detect "the pointer has since moved on to something newer than what
 * this rebuild planned against" and refuse to activate a now-stale
 * target over it, rather than trusting `targetGenerationId` alone (which
 * says nothing about whether some OTHER generation became current in the
 * meantime).
 */
export interface RebuildSnapshotV1 {
  baseGenerationId: number | null;
  baseFingerprint: string | null;
  dimension: number;
  embeddingModel: string;
  overlays: RebuildSnapshotOverlayEntryV1[];
  fingerprint: string;
}

/**
 * Minimal, content-free durable phase output -- exactly enough for restart
 * to skip already-committed work without redoing it, never enough to
 * reconstruct the note/vectors/prompt themselves.
 *
 * `noteContentHash`/`overlayCommitted` are a commit RECEIPT, not content:
 * on restart, "note write committed, overlay write failed" is
 * distinguishable from "neither committed" purely from these two booleans
 * plus the hash, without ever having persisted the note body itself.
 */
export type JobReceiptV1 =
  | { kind: "note"; noteCommitted: boolean; noteContentHash?: string; overlayCommitted: boolean }
  | {
      kind: "rebuild";
      targetGenerationId?: number;
      built: boolean;
      verified: boolean;
      activated: boolean;
      snapshot?: RebuildSnapshotV1;
      /**
       * A bounded, BYTE-EXACT fingerprint of the target generation's own
       * manifest checksums (`manifestArtifactFingerprint` in
       * `src/index/indexStore.ts`), captured the moment `built` becomes
       * `true` (whether by a fresh `buildGeneration` or by adopting an
       * already-matching existing directory). Distinct from
       * `snapshot.fingerprint`, which is only ever a SEMANTIC match
       * (identity/sourceHash/chunkCount, never actual vector bytes) --
       * this field is what `verify-generation`/`activate-generation` use
       * to confirm the artifact reloaded at that later phase is
       * BYTE-IDENTICAL to what this job itself committed to, catching
       * corruption introduced after this job's own build (Checkpoint 7
       * final-closure requirement 5).
       */
      builtManifestFingerprint?: string;
    }
  | {
      kind: "scope";
      discovered: boolean;
      discoveredCount?: number;
      /**
       * A bounded, lowercase-hex64, CONTENT-FREE fingerprint of exactly
       * which discovered set `discover` saw (Checkpoint 7 acceptance guard
       * 8) -- derived from each item's stable identity key + sourceHash +
       * embeddingModel, never from note content. Re-discovery is
       * legitimate across phases (the vault keeps changing), but
       * `import`/`enqueue` must never silently act on a DIFFERENT set than
       * the one `discoveredCount` was recorded against: each phase
       * recomputes this fingerprint over its own fresh discovery and
       * compares it to this persisted value, superseding the job (via the
       * same durable successor mechanism `rebuildJob.ts` uses) rather than
       * importing/enqueuing under a stale receipt the moment they diverge.
       */
      discoveryFingerprint?: string;
      imported?: boolean;
      enqueuedCount?: number;
    };

function assertReceiptHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RECEIPT_HASH_LENGTH || hasControlOrNulCharacter(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", `PersistedJobV1.receipt.${field} must be a short bounded hash string.`, { field });
  }
}

/** Exactly the note-write commit contract: `noteCommitted` requires a real lowercase-hex64 hash; not-yet-committed forbids carrying one at all (never a stale/placeholder hash sitting alongside `noteCommitted: false`). */
function assertNoteReceiptInvariants(record: { noteCommitted: boolean; noteContentHash?: string; overlayCommitted: boolean }, contractName: string): void {
  if (record.overlayCommitted && !record.noteCommitted) {
    throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: overlayCommitted requires noteCommitted.`, {});
  }
  if (record.noteCommitted) {
    if (record.noteContentHash === undefined || !HEX_64_PATTERN.test(record.noteContentHash)) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: noteCommitted requires an exact lowercase hex64 noteContentHash.`, {});
    }
  } else if (record.noteContentHash !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: noteContentHash must be absent while noteCommitted is false.`, {});
  }
}

/**
 * `activated => verified => built => targetGenerationId present` -- a strict chain, checked in
 * order so the error always names the weakest broken link. `built` additionally requires a
 * persisted `snapshot` (Checkpoint 7 final-closure requirement 4) AND a `builtManifestFingerprint`
 * (Checkpoint 7 acceptance guard 5): every path that ever sets `built: true`
 * (`rebuildJob.ts`'s `stepBuildGeneration`) always sets both in the exact same update, so their
 * absence together is unreachable for a legitimate run. Conversely, `built: false` forbids
 * carrying EITHER a stale `snapshot` or `builtManifestFingerprint` alongside it -- a not-yet-built
 * receipt can never accumulate build-time artifacts from some earlier, since-superseded attempt.
 */
function assertRebuildReceiptInvariants(
  record: { targetGenerationId?: number; built: boolean; verified: boolean; activated: boolean; snapshot?: RebuildSnapshotV1; builtManifestFingerprint?: string },
  contractName: string,
): void {
  if (record.activated && !record.verified) {
    throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: activated requires verified.`, {});
  }
  if (record.verified && !record.built) {
    throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: verified requires built.`, {});
  }
  if (record.built) {
    if (record.targetGenerationId === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: built requires a targetGenerationId.`, {});
    }
    if (record.snapshot === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: built requires a persisted snapshot.`, {});
    }
    if (record.builtManifestFingerprint === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: built requires a builtManifestFingerprint.`, {});
    }
  } else {
    if (record.snapshot !== undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: snapshot must be absent while built is false.`, {});
    }
    if (record.builtManifestFingerprint !== undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", `${contractName}: builtManifestFingerprint must be absent while built is false.`, {});
    }
  }
}

function assertRebuildSnapshotOverlayEntry(value: unknown, index: number): RebuildSnapshotOverlayEntryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays[${index}] must be a JSON object.`, {});
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fileName !== "string" || !OVERLAY_FILE_NAME_PATTERN.test(record.fileName)) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays[${index}].fileName is not a well-formed owned overlay path.`, {});
  }
  if (typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version < 1) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays[${index}].version must be a positive safe integer.`, {});
  }
  if (typeof record.fingerprint !== "string" || !HEX_64_PATTERN.test(record.fingerprint)) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays[${index}].fingerprint must be a lowercase hex64 hash.`, {});
  }
  const extra = Object.keys(record).filter((key) => key !== "fileName" && key !== "version" && key !== "fingerprint");
  if (extra.length > 0) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays[${index}] has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  return { fileName: record.fileName, version: record.version, fingerprint: record.fingerprint };
}

function parseRebuildSnapshotV1(value: unknown): RebuildSnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (typeof record.dimension !== "number" || !Number.isInteger(record.dimension) || record.dimension < 1 || record.dimension > MAX_EMBEDDING_DIMENSION) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.dimension must be an integer in [1, ${MAX_EMBEDDING_DIMENSION}].`, {});
  }
  if (typeof record.embeddingModel !== "string" || record.embeddingModel.trim().length === 0 || record.embeddingModel.length > MAX_REBUILD_SNAPSHOT_MODEL_LENGTH || hasControlOrNulCharacter(record.embeddingModel)) {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.embeddingModel must be a short bounded non-empty string.", {});
  }
  if (!Array.isArray(record.overlays) || record.overlays.length > MAX_REBUILD_SNAPSHOT_OVERLAYS) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays must be an array of at most ${MAX_REBUILD_SNAPSHOT_OVERLAYS} entries.`, {});
  }
  const overlays = record.overlays.map((entry, index) => assertRebuildSnapshotOverlayEntry(entry, index));
  const seenFileNames = new Set<string>();
  for (let i = 0; i < overlays.length; i += 1) {
    if (seenFileNames.has(overlays[i].fileName)) {
      throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot.overlays contains a duplicate fileName at index ${i}.`, {});
    }
    seenFileNames.add(overlays[i].fileName);
    if (i > 0 && overlays[i - 1].fileName.localeCompare(overlays[i].fileName) >= 0) {
      throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.overlays must be in strictly ascending fileName order (deterministic ordering).", {});
    }
  }
  if (typeof record.fingerprint !== "string" || !HEX_64_PATTERN.test(record.fingerprint)) {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.fingerprint must be a lowercase hex64 hash.", {});
  }
  let baseGenerationId: number | null;
  if (record.baseGenerationId === null) {
    baseGenerationId = null;
  } else if (typeof record.baseGenerationId === "number" && Number.isSafeInteger(record.baseGenerationId) && record.baseGenerationId >= 0) {
    baseGenerationId = record.baseGenerationId;
  } else {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.baseGenerationId must be a non-negative safe integer or null.", {});
  }
  let baseFingerprint: string | null;
  if (record.baseFingerprint === null) {
    baseFingerprint = null;
  } else if (typeof record.baseFingerprint === "string" && HEX_64_PATTERN.test(record.baseFingerprint)) {
    baseFingerprint = record.baseFingerprint;
  } else {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.baseFingerprint must be a lowercase hex64 hash or null.", {});
  }
  if ((baseGenerationId === null) !== (baseFingerprint === null)) {
    throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt snapshot.baseGenerationId and baseFingerprint must be null together.", {});
  }
  const extra = Object.keys(record).filter((key) => !["dimension", "embeddingModel", "overlays", "fingerprint", "baseGenerationId", "baseFingerprint"].includes(key));
  if (extra.length > 0) {
    throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt snapshot has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  return { baseGenerationId, baseFingerprint, dimension: record.dimension, embeddingModel: record.embeddingModel, overlays, fingerprint: record.fingerprint };
}

export function parseJobReceiptV1(value: unknown): JobReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.receipt must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "note") {
    if (typeof record.noteCommitted !== "boolean" || typeof record.overlayCommitted !== "boolean") {
      throw new EngineError("JOB_SHAPE_INVALID", "note receipt requires boolean noteCommitted/overlayCommitted.", {});
    }
    if (record.noteContentHash !== undefined) assertReceiptHash(record.noteContentHash, "noteContentHash");
    const extra = Object.keys(record).filter((key) => key !== "kind" && key !== "noteCommitted" && key !== "noteContentHash" && key !== "overlayCommitted");
    if (extra.length > 0) {
      throw new EngineError("JOB_SHAPE_INVALID", `note receipt has unrecognized field(s): ${extra.join(", ")}.`, {});
    }
    const receipt: Extract<JobReceiptV1, { kind: "note" }> = { kind: "note", noteCommitted: record.noteCommitted, noteContentHash: record.noteContentHash, overlayCommitted: record.overlayCommitted };
    assertNoteReceiptInvariants(receipt, "PersistedJobV1.receipt");
    return receipt;
  }
  if (record.kind === "rebuild") {
    if (typeof record.built !== "boolean" || typeof record.verified !== "boolean" || typeof record.activated !== "boolean") {
      throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt requires boolean built/verified/activated.", {});
    }
    if (record.targetGenerationId !== undefined && (typeof record.targetGenerationId !== "number" || !Number.isSafeInteger(record.targetGenerationId) || record.targetGenerationId < 0)) {
      throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt targetGenerationId must be a non-negative safe integer.", {});
    }
    const snapshot = record.snapshot !== undefined ? parseRebuildSnapshotV1(record.snapshot) : undefined;
    let builtManifestFingerprint: string | undefined;
    if (record.builtManifestFingerprint !== undefined) {
      if (typeof record.builtManifestFingerprint !== "string" || !HEX_64_PATTERN.test(record.builtManifestFingerprint)) {
        throw new EngineError("JOB_SHAPE_INVALID", "rebuild receipt builtManifestFingerprint must be a lowercase hex64 hash.", {});
      }
      builtManifestFingerprint = record.builtManifestFingerprint;
    }
    const extra = Object.keys(record).filter((key) => !["kind", "targetGenerationId", "built", "verified", "activated", "snapshot", "builtManifestFingerprint"].includes(key));
    if (extra.length > 0) {
      throw new EngineError("JOB_SHAPE_INVALID", `rebuild receipt has unrecognized field(s): ${extra.join(", ")}.`, {});
    }
    const receipt: Extract<JobReceiptV1, { kind: "rebuild" }> = {
      kind: "rebuild",
      targetGenerationId: record.targetGenerationId,
      built: record.built,
      verified: record.verified,
      activated: record.activated,
      snapshot,
      builtManifestFingerprint,
    };
    assertRebuildReceiptInvariants(receipt, "PersistedJobV1.receipt");
    return receipt;
  }
  if (record.kind === "scope") {
    if (typeof record.discovered !== "boolean") {
      throw new EngineError("JOB_SHAPE_INVALID", "scope receipt requires boolean discovered.", {});
    }
    if (record.discoveredCount !== undefined && (typeof record.discoveredCount !== "number" || !Number.isInteger(record.discoveredCount) || record.discoveredCount < 0 || record.discoveredCount > MAX_SCOPE_DISCOVERY_ITEMS)) {
      throw new EngineError("JOB_SHAPE_INVALID", `scope receipt discoveredCount must be an integer in [0, ${MAX_SCOPE_DISCOVERY_ITEMS}].`, {});
    }
    if (record.discoveryFingerprint !== undefined && (typeof record.discoveryFingerprint !== "string" || !HEX_64_PATTERN.test(record.discoveryFingerprint))) {
      throw new EngineError("JOB_SHAPE_INVALID", "scope receipt discoveryFingerprint must be a lowercase hex64 hash.", {});
    }
    if ((record.discovered && record.discoveredCount !== undefined) !== (record.discoveryFingerprint !== undefined)) {
      throw new EngineError("JOB_SHAPE_INVALID", "scope receipt discoveryFingerprint must be set together with discovered/discoveredCount.", {});
    }
    if (record.imported !== undefined && typeof record.imported !== "boolean") {
      throw new EngineError("JOB_SHAPE_INVALID", "scope receipt imported must be a boolean when present.", {});
    }
    if (record.enqueuedCount !== undefined && (typeof record.enqueuedCount !== "number" || !Number.isInteger(record.enqueuedCount) || record.enqueuedCount < 0 || record.enqueuedCount > MAX_SCOPE_DISCOVERY_ITEMS)) {
      throw new EngineError("JOB_SHAPE_INVALID", `scope receipt enqueuedCount must be an integer in [0, ${MAX_SCOPE_DISCOVERY_ITEMS}].`, {});
    }
    const extra = Object.keys(record).filter((key) => !["kind", "discovered", "discoveredCount", "discoveryFingerprint", "imported", "enqueuedCount"].includes(key));
    if (extra.length > 0) {
      throw new EngineError("JOB_SHAPE_INVALID", `scope receipt has unrecognized field(s): ${extra.join(", ")}.`, {});
    }
    return {
      kind: "scope",
      discovered: record.discovered,
      discoveredCount: record.discoveredCount,
      discoveryFingerprint: record.discoveryFingerprint,
      imported: record.imported,
      enqueuedCount: record.enqueuedCount,
    };
  }
  throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1.receipt.kind must be "note", "rebuild", or "scope".', {});
}

const RECEIPT_KIND_BY_JOB_KIND: Readonly<Record<JobKind, JobReceiptV1["kind"]>> = {
  "process-note": "note",
  "reading-sync": "scope",
  "scope-refresh": "scope",
  "rebuild-index": "rebuild",
  "migrate-index": "rebuild",
};

export interface PersistedJobV1 {
  schemaVersion: SchemaVersion;
  job: QueueJobV1;
  status: JobStatus;
  /** Incremented (and persisted) BEFORE any external/model work for the attempt begins -- never after. */
  attempt: number;
  cancelRequested: boolean;
  lastFailureCode?: string;
  lastFailureClass?: FailureClass;
  receipt?: JobReceiptV1;
  /**
   * Deterministic backoff bookkeeping, an epoch-ms value compared against
   * an injected clock -- never a `setTimeout`/sleep inside this durable
   * core. `undefined` means immediately eligible.
   */
  nextAttemptAtMs?: number;
}

function assertFailureCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FAILURE_CODE_LENGTH || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", `${field} must be a short bounded uppercase failure code.`, { field });
  }
}

/**
 * Cross-field invariants between `status`/`job.phase` and `receipt` that no
 * single field's own parser can see in isolation -- see Checkpoint 7
 * requirement 5. Every check here rejects a shape that could only arise
 * from a corrupted/hand-edited document or a genuine engine bug, never a
 * legitimate mid-pipeline state a running job could actually be in.
 */
function assertPersistedJobInvariants(
  job: QueueJobV1,
  status: JobStatus,
  receipt: JobReceiptV1 | undefined,
  lastFailureCode: string | undefined,
  lastFailureClass: FailureClass | undefined,
  nextAttemptAtMs: number | undefined,
): void {
  const phases = JOB_KIND_PHASES[job.kind];
  const phaseIndex = phases.indexOf(job.phase);
  const finalPhase = phases[phases.length - 1];

  if ((lastFailureCode === undefined) !== (lastFailureClass === undefined)) {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.lastFailureCode/lastFailureClass must appear together.", {});
  }
  if (status === "failed" && lastFailureCode === undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: status "failed" requires lastFailureCode/lastFailureClass.', {});
  }
  if (status === "completed" && lastFailureCode !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: status "completed" must not carry a stale lastFailureCode/lastFailureClass.', {});
  }
  // nextAttemptAtMs is backoff bookkeeping for one specific case: a queued job backing off after a
  // TRANSIENT retry. It is never legitimate on an active/failed/cancelled/completed job, and never
  // alongside a non-transient (terminal) lastFailureClass -- see requirement 12.
  if (nextAttemptAtMs !== undefined && (status !== "queued" || lastFailureClass !== "transient")) {
    throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1.nextAttemptAtMs may only be set on a "queued" job with lastFailureClass "transient".', {});
  }

  // The final phase and status "completed" are set TOGETHER, atomically, in exactly one place
  // (JobEngine.applyStepOutcome's "complete" case) -- each is impossible without the other.
  if (status === "completed" && job.phase !== finalPhase) {
    throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: status "completed" requires job.phase to be the final phase for its kind.', {});
  }
  if (job.phase === finalPhase && status !== "completed") {
    throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: job.phase at the final phase requires status "completed".', {});
  }

  if (receipt?.kind === "note") {
    // noteCommitted/overlayCommitted are set exactly when advancing INTO write-overlay/complete
    // respectively (see NoteJobRunner) -- persisting either flag true at an EARLIER phase than
    // that is an impossible "future" receipt no legitimate run could ever produce.
    const writeOverlayIndex = phases.indexOf("write-overlay");
    if (receipt.noteCommitted && writeOverlayIndex !== -1 && phaseIndex < writeOverlayIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.noteCommitted is impossible before phase \"write-overlay\".", {});
    }
    if (receipt.overlayCommitted && job.phase !== finalPhase) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.overlayCommitted is impossible before the final phase.", {});
    }
    if (status === "completed" && !(receipt.noteCommitted && receipt.overlayCommitted)) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a completed note job requires a fully-committed receipt.', {});
    }
  }
  if (receipt?.kind === "rebuild") {
    const verifyIndex = phases.indexOf("verify-generation");
    const activateIndex = phases.indexOf("activate-generation");
    if (receipt.built && verifyIndex !== -1 && phaseIndex < verifyIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.built is impossible before phase \"verify-generation\".", {});
    }
    if (receipt.verified && activateIndex !== -1 && phaseIndex < activateIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.verified is impossible before phase \"activate-generation\".", {});
    }
    if (receipt.activated && job.phase !== finalPhase) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.activated is impossible before the final phase.", {});
    }
    if (status === "completed" && !receipt.activated) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a completed rebuild/migrate job requires an activated receipt.', {});
    }
  }
  if (receipt?.kind === "scope") {
    const discoverIndex = phases.indexOf("discover");
    const importIndex = phases.indexOf("import"); // -1 for scope-refresh, which has no import phase
    const enqueueIndex = phases.indexOf("enqueue");

    // discovered/discoveredCount are set TOGETHER, exactly when advancing OUT of "discover" --
    // persisting either one while still AT "discover" is an impossible "future" receipt.
    if (receipt.discovered !== (receipt.discoveredCount !== undefined)) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1: receipt.discovered and discoveredCount must be set together.", {});
    }
    if (receipt.discovered && phaseIndex <= discoverIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: receipt.discovered is impossible before leaving phase "discover".', {});
    }
    if (receipt.imported && job.kind !== "reading-sync") {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: receipt.imported is impossible for a job kind other than "reading-sync".', {});
    }
    if (receipt.imported && importIndex !== -1 && phaseIndex <= importIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: receipt.imported is impossible before leaving phase "import".', {});
    }
    // A reading-sync job that has moved past "import" (into enqueue/complete) must already carry
    // imported: true -- there is no other legitimate way to have left that phase.
    if (job.kind === "reading-sync" && importIndex !== -1 && phaseIndex > importIndex && !receipt.imported) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a reading-sync job past phase "import" requires receipt.imported.', {});
    }
    if (receipt.enqueuedCount !== undefined && enqueueIndex !== -1 && phaseIndex <= enqueueIndex) {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: receipt.enqueuedCount is impossible before leaving phase "enqueue".', {});
    }
    if (status === "completed") {
      if (!receipt.discovered || receipt.discoveredCount === undefined) {
        throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a completed scope job requires a discovered receipt with discoveredCount.', {});
      }
      if (receipt.enqueuedCount === undefined) {
        throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a completed scope job requires enqueuedCount to be recorded.', {});
      }
      if (job.kind === "reading-sync" && !receipt.imported) {
        throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1: a completed reading-sync job requires receipt.imported.', {});
      }
    }
  }
}

export function parsePersistedJobV1(value: unknown): PersistedJobV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.schemaVersion must be 1.", { received: record.schemaVersion });
  }
  const job = parseQueueJobV1(record.job);
  if (!isJobStatus(record.status)) {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.status is not a recognized job status.", {});
  }
  const status = record.status;
  if (typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 0 || record.attempt > MAX_ATTEMPT_COUNT) {
    throw new EngineError("JOB_SHAPE_INVALID", `PersistedJobV1.attempt must be an integer in [0, ${MAX_ATTEMPT_COUNT}].`, {});
  }
  if (typeof record.cancelRequested !== "boolean") {
    throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.cancelRequested must be a boolean.", {});
  }
  let lastFailureCode: string | undefined;
  let lastFailureClass: FailureClass | undefined;
  if (record.lastFailureCode !== undefined) {
    assertFailureCode(record.lastFailureCode, "PersistedJobV1.lastFailureCode");
    lastFailureCode = record.lastFailureCode;
  }
  if (record.lastFailureClass !== undefined) {
    if (record.lastFailureClass !== "terminal" && record.lastFailureClass !== "transient") {
      throw new EngineError("JOB_SHAPE_INVALID", 'PersistedJobV1.lastFailureClass must be "terminal" or "transient".', {});
    }
    lastFailureClass = record.lastFailureClass;
  }
  let receipt: JobReceiptV1 | undefined;
  if (record.receipt !== undefined) {
    receipt = parseJobReceiptV1(record.receipt);
    if (receipt.kind !== RECEIPT_KIND_BY_JOB_KIND[job.kind]) {
      throw new EngineError("JOB_SHAPE_INVALID", `PersistedJobV1.receipt.kind does not match job.kind "${job.kind}".`, {});
    }
  }
  if (job.jobId.length > MAX_JOB_ID_LENGTH) {
    throw new EngineError("JOB_SHAPE_INVALID", `PersistedJobV1.job.jobId exceeds max length (${MAX_JOB_ID_LENGTH}).`, {});
  }
  let nextAttemptAtMs: number | undefined;
  if (record.nextAttemptAtMs !== undefined) {
    if (typeof record.nextAttemptAtMs !== "number" || !Number.isSafeInteger(record.nextAttemptAtMs) || record.nextAttemptAtMs < 0) {
      throw new EngineError("JOB_SHAPE_INVALID", "PersistedJobV1.nextAttemptAtMs must be a non-negative safe integer.", {});
    }
    nextAttemptAtMs = record.nextAttemptAtMs;
  }
  assertPersistedJobInvariants(job, status, receipt, lastFailureCode, lastFailureClass, nextAttemptAtMs);
  return { schemaVersion: 1, job, status, attempt: record.attempt, cancelRequested: record.cancelRequested, lastFailureCode, lastFailureClass, receipt, nextAttemptAtMs };
}

/**
 * A durable link from one SCHEDULED occurrence's deterministic identity
 * (`occurrenceId`, computed by `src/scheduling/scheduleTypes.ts` from
 * schedule id + logical due instant + work identity -- never by this
 * module) to the exact job it produced. This is what makes
 * `JobStore.submitScheduledOccurrence` crash-safe across a job that
 * completes (even synchronously, even reaching a TERMINAL status) before
 * the schedule's own state is durably advanced: a retry of the SAME
 * occurrenceId finds this record and returns the SAME job rather than
 * appending a duplicate, regardless of that job's current status --
 * `JobStore.appendOrCoalesce` (used by ordinary `JobEngine.submit`, e.g. a
 * deliberate manual rerun) is completely unaffected and untouched by this
 * registry: it still coalesces only onto non-terminal work, exactly as
 * before.
 *
 * `acknowledged` is set once the schedule that produced this occurrence has
 * durably recorded its own "submitted" outcome (crash protocol step d) --
 * purely registry housekeeping, never load-bearing for correctness: an
 * unacknowledged record is functionally identical to an acknowledged one
 * for `submitScheduledOccurrence`'s own lookup, and losing track of whether
 * an occurrence was ever acknowledged can never cause a duplicate job.
 * Pruning (`JobStore`'s cap enforcement) may remove only ACKNOWLEDGED
 * entries -- an unacknowledged entry is a live crash-recovery receipt that
 * must never be silently dropped while its schedule might still need it.
 */
export interface ScheduledOccurrenceRecordV1 {
  schemaVersion: SchemaVersion;
  occurrenceId: string;
  /** The `idempotencyKey` of the job this occurrence is linked to -- redundant with `jobId` but checked independently at parse time against the referenced job's own key, so a corrupted/hand-edited registry pointing an occurrence at a job with a DIFFERENT idempotency key fails closed rather than silently trusting a dangling/mismatched link. */
  idempotencyKey: string;
  jobId: string;
  acknowledged: boolean;
  createdAt: string;
  /** Present iff `acknowledged`; never present, never stale, on an unacknowledged record. */
  acknowledgedAt?: string;
}

export const MAX_SCHEDULED_OCCURRENCES = 2000;
const OCCURRENCE_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Value-free on failure: a caller-supplied occurrenceId that fails this check is never echoed into the thrown error. */
export function assertScheduledOccurrenceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OCCURRENCE_ID_PATTERN.test(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", "occurrenceId must be a 64-character lowercase hex hash.", {});
  }
}

function parseScheduledOccurrenceRecordV1(value: unknown): ScheduledOccurrenceRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.schemaVersion must be 1.", {});
  }
  assertScheduledOccurrenceId(record.occurrenceId);
  assertBoundedControlFreeIdentifier(record.idempotencyKey, 128, "ScheduledOccurrenceRecordV1.idempotencyKey", "JOB_STORE_CORRUPT");
  const idempotencyKey = record.idempotencyKey;
  assertBoundedControlFreeIdentifier(record.jobId, MAX_JOB_ID_LENGTH, "ScheduledOccurrenceRecordV1.jobId", "JOB_STORE_CORRUPT");
  const jobId = record.jobId;
  if (typeof record.acknowledged !== "boolean") {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.acknowledged must be a boolean.", {});
  }
  if (typeof record.createdAt !== "string") {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.createdAt must be a string.", {});
  }
  const createdAtDate = new Date(record.createdAt);
  if (Number.isNaN(createdAtDate.getTime()) || createdAtDate.toISOString() !== record.createdAt) {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.createdAt must be a canonical UTC ISO-8601 timestamp.", {});
  }
  let acknowledgedAt: string | undefined;
  if (record.acknowledgedAt !== undefined) {
    if (typeof record.acknowledgedAt !== "string") {
      throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.acknowledgedAt must be a string.", {});
    }
    const acknowledgedAtDate = new Date(record.acknowledgedAt);
    if (Number.isNaN(acknowledgedAtDate.getTime()) || acknowledgedAtDate.toISOString() !== record.acknowledgedAt) {
      throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.acknowledgedAt must be a canonical UTC ISO-8601 timestamp.", {});
    }
    if (acknowledgedAtDate.getTime() < createdAtDate.getTime()) {
      throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.acknowledgedAt must not precede createdAt.", {});
    }
    acknowledgedAt = record.acknowledgedAt;
  }
  if (record.acknowledged !== (acknowledgedAt !== undefined)) {
    throw new EngineError("JOB_STORE_CORRUPT", "ScheduledOccurrenceRecordV1.acknowledgedAt must be present iff acknowledged is true.", {});
  }
  const extra = Object.keys(record).filter((key) => !["schemaVersion", "occurrenceId", "idempotencyKey", "jobId", "acknowledged", "createdAt", "acknowledgedAt"].includes(key));
  if (extra.length > 0) {
    throw new EngineError("JOB_STORE_CORRUPT", `ScheduledOccurrenceRecordV1 has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  return { schemaVersion: 1, occurrenceId: record.occurrenceId, idempotencyKey, jobId, acknowledged: record.acknowledged, createdAt: record.createdAt, acknowledgedAt };
}

export interface ProviderPauseV1 {
  active: boolean;
  code?: string;
  pausedAtMs?: number;
}

export function parseProviderPauseV1(value: unknown): ProviderPauseV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_SHAPE_INVALID", "ProviderPauseV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (typeof record.active !== "boolean") {
    throw new EngineError("JOB_SHAPE_INVALID", "ProviderPauseV1.active must be a boolean.", {});
  }
  let code: string | undefined;
  if (record.code !== undefined) {
    assertFailureCode(record.code, "ProviderPauseV1.code");
    code = record.code;
  }
  let pausedAtMs: number | undefined;
  if (record.pausedAtMs !== undefined) {
    if (typeof record.pausedAtMs !== "number" || !Number.isSafeInteger(record.pausedAtMs) || record.pausedAtMs < 0) {
      throw new EngineError("JOB_SHAPE_INVALID", "ProviderPauseV1.pausedAtMs must be a non-negative safe integer.", {});
    }
    pausedAtMs = record.pausedAtMs;
  }
  // An active pause is meaningless without knowing WHY/WHEN it started; an inactive pause carrying
  // a stale code/timestamp from a PRIOR pause is exactly the kind of impossible "leftover future
  // state" Checkpoint 7 requirement 5 asks to reject, not silently ignore.
  if (record.active) {
    if (code === undefined || pausedAtMs === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", "ProviderPauseV1: an active pause requires both code and pausedAtMs.", {});
    }
  } else if (code !== undefined || pausedAtMs !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", "ProviderPauseV1: an inactive pause must not carry code/pausedAtMs.", {});
  }
  return { active: record.active, code, pausedAtMs };
}

export interface JobStoreDocumentV1 {
  schemaVersion: SchemaVersion;
  jobs: PersistedJobV1[];
  providerPause: ProviderPauseV1;
  /** Absent on a document persisted before Checkpoint 8's occurrence registry existed -- `parseJobStoreDocumentV1` defaults it to `[]` explicitly (a genuine migration path, never a silent pass-through of some OTHER malformed value: present-but-not-an-array, or present-with-a-malformed-entry, still fails closed). */
  scheduledOccurrences: ScheduledOccurrenceRecordV1[];
  bulkBatches: BulkBatchV1[];
}

export type BulkBatchStatusV1 = "active" | "completed" | "completed-with-failures" | "failed" | "cancelled";
export interface BulkBatchItemV1 {
  batchItemId: string;
  jobId: string;
  status: JobStatus;
}
/** Bounded, content-free progress ledger for one scope/global bulk root. */
export interface BulkBatchV1 {
  schemaVersion: SchemaVersion;
  batchId: string;
  rootJobId: string;
  trigger: JobTrigger;
  scopeId?: string;
  occurrenceId?: string;
  status: BulkBatchStatusV1;
  /** Set atomically when scope discovery commits; never inferred from children. */
  discoveredTotal?: number;
  createdAt: string;
  updatedAt: string;
  items: BulkBatchItemV1[];
}
export const MAX_BULK_BATCHES = 16;
const BULK_BATCH_STATUS_SET: Record<BulkBatchStatusV1, true> = { active: true, completed: true, "completed-with-failures": true, failed: true, cancelled: true };
function isBulkBatchStatus(value: unknown): value is BulkBatchStatusV1 { return typeof value === "string" && Object.prototype.hasOwnProperty.call(BULK_BATCH_STATUS_SET, value); }

function parseBulkBatchV1(value: unknown, jobsById: ReadonlyMap<string, PersistedJobV1>): BulkBatchV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 must be a JSON object.", {});
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.schemaVersion must be 1.", {});
  assertBoundedControlFreeIdentifier(record.batchId, MAX_JOB_ID_LENGTH, "BulkBatchV1.batchId", "JOB_STORE_CORRUPT");
  const batchId = record.batchId;
  assertBoundedControlFreeIdentifier(record.rootJobId, MAX_JOB_ID_LENGTH, "BulkBatchV1.rootJobId", "JOB_STORE_CORRUPT");
  const rootJobId = record.rootJobId;
  const root = jobsById.get(rootJobId);
  if (!isBulkBatchStatus(record.status)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.status is invalid.", {});
  const status = record.status;
  if ((!root && record.status === "active") || (root && ((root.job.kind !== "scope-refresh" && root.job.kind !== "rebuild-index") || root.job.batchId !== batchId))) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.rootJobId must reference its bulk root job.", {});
  if (!isJobTrigger(record.trigger) || (root && record.trigger !== root.job.trigger)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.trigger must match its root job.", {});
  const trigger = record.trigger;
  if (record.scopeId !== undefined) assertBoundedControlFreeIdentifier(record.scopeId, 200, "BulkBatchV1.scopeId", "JOB_STORE_CORRUPT");
  if (root?.job.target.kind === "scope" && record.scopeId !== root.job.target.scopeId) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.scopeId must match its scope root.", {});
  if (root && root.job.target.kind !== "scope" && record.scopeId !== undefined) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.scopeId is only valid for a scope root.", {});
  if (record.occurrenceId !== undefined) assertScheduledOccurrenceId(record.occurrenceId);
  if (record.discoveredTotal !== undefined && (typeof record.discoveredTotal !== "number" || !Number.isInteger(record.discoveredTotal) || record.discoveredTotal < 0 || record.discoveredTotal > MAX_SCOPE_DISCOVERY_ITEMS)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.discoveredTotal is invalid.", {});
  if (root?.receipt?.kind === "scope" && root.receipt.discoveredCount !== undefined && record.discoveredTotal !== root.receipt.discoveredCount) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.discoveredTotal must match root discovery.", {});
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 timestamps must be strings.", {});
  const createdAt = new Date(record.createdAt); const updatedAt = new Date(record.updatedAt);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== record.createdAt || Number.isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== record.updatedAt || updatedAt < createdAt) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 timestamps must be canonical and ordered.", {});
  if (!Array.isArray(record.items) || record.items.length > MAX_SCOPE_DISCOVERY_ITEMS) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1.items must be a bounded array.", {});
  const seen = new Set<string>();
  const items = record.items.map((value): BulkBatchItemV1 => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 item must be an object.", {});
    const item = value as Record<string, unknown>;
    if (typeof item.batchItemId !== "string" || !HEX_64_PATTERN.test(item.batchItemId) || seen.has(item.batchItemId)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 item id is invalid.", {});
    seen.add(item.batchItemId);
    assertBoundedControlFreeIdentifier(item.jobId, MAX_JOB_ID_LENGTH, "BulkBatchV1.item.jobId", "JOB_STORE_CORRUPT");
    const jobId = item.jobId;
  if (!isJobStatus(item.status)) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 item status is invalid.", {});
    const itemStatus = item.status;
    const job = jobsById.get(jobId);
    // Terminal children may be pruned from the queue after their last status is copied into
    // this ledger. Non-terminal work must always remain addressable.
    if ((!job && !isTerminalJobStatus(itemStatus)) || (job && (job.job.batchId !== batchId || job.job.batchItemId !== item.batchItemId || job.status !== itemStatus))) throw new EngineError("JOB_STORE_CORRUPT", "BulkBatchV1 item must match its child job.", {});
    return { batchItemId: item.batchItemId, jobId, status: itemStatus };
  });
  if ((status === "completed" || status === "completed-with-failures") && (record.discoveredTotal === undefined || items.length !== record.discoveredTotal || items.some((item) => !isTerminalJobStatus(item.status)))) throw new EngineError("JOB_STORE_CORRUPT", "Completed BulkBatchV1 must have a complete terminal item ledger.", {});
  if (root) {
    if (status === "active" && (root.status === "failed" || root.status === "cancelled")) throw new EngineError("JOB_STORE_CORRUPT", "An active batch cannot retain a failed/cancelled root.", {});
    if ((status === "failed" || status === "cancelled") && root.status !== status) throw new EngineError("JOB_STORE_CORRUPT", "Terminal batch status must match its root.", {});
    if ((status === "completed" || status === "completed-with-failures") && root.status !== "completed") throw new EngineError("JOB_STORE_CORRUPT", "Completed batch status requires a completed root.", {});
  }
  if (status === "completed" && items.some((item) => item.status !== "completed")) throw new EngineError("JOB_STORE_CORRUPT", "Completed batch items must all be completed.", {});
  if (status === "completed-with-failures" && !items.some((item) => item.status === "failed" || item.status === "cancelled")) throw new EngineError("JOB_STORE_CORRUPT", "Completed-with-failures requires a failed/cancelled item.", {});
  return { schemaVersion: 1, batchId, rootJobId, trigger, scopeId: record.scopeId, occurrenceId: record.occurrenceId, status, discoveredTotal: record.discoveredTotal, createdAt: record.createdAt, updatedAt: record.updatedAt, items };
}

export function parseJobStoreDocumentV1(value: unknown): JobStoreDocumentV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("JOB_STORE_CORRUPT", "JobStoreDocumentV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("JOB_STORE_CORRUPT", "JobStoreDocumentV1.schemaVersion must be 1.", { received: record.schemaVersion });
  }
  if (!Array.isArray(record.jobs)) {
    throw new EngineError("JOB_STORE_CORRUPT", "JobStoreDocumentV1.jobs must be an array.", {});
  }
  if (record.jobs.length > MAX_PERSISTED_JOBS) {
    throw new EngineError("JOB_CAP_EXCEEDED", `JobStoreDocumentV1.jobs exceeds max persisted job count (${MAX_PERSISTED_JOBS}).`, {});
  }
  const jobs = record.jobs.map((entry) => parsePersistedJobV1(entry));
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const jobsById = new Map<string, PersistedJobV1>();
  for (const persisted of jobs) {
    if (seenIds.has(persisted.job.jobId)) {
      throw new EngineError("JOB_STORE_CORRUPT", `Duplicate jobId "${persisted.job.jobId}" in job store.`, {});
    }
    seenIds.add(persisted.job.jobId);
    jobsById.set(persisted.job.jobId, persisted);
    if (!isTerminalJobStatus(persisted.status)) {
      if (seenKeys.has(persisted.job.idempotencyKey)) {
        throw new EngineError("JOB_STORE_CORRUPT", `Duplicate active idempotencyKey "${persisted.job.idempotencyKey}" in job store.`, {});
      }
      seenKeys.add(persisted.job.idempotencyKey);
    }
  }

  // Explicit schema/default migration path (requirement 1): absent entirely -> a fresh, empty
  // registry; present -> strictly parsed and cross-validated against `jobs` above, never trusted
  // as-is. A malformed present value fails closed exactly like every other field here.
  let scheduledOccurrences: ScheduledOccurrenceRecordV1[];
  if (record.scheduledOccurrences === undefined) {
    scheduledOccurrences = [];
  } else {
    if (!Array.isArray(record.scheduledOccurrences)) {
      throw new EngineError("JOB_STORE_CORRUPT", "JobStoreDocumentV1.scheduledOccurrences must be an array.", {});
    }
    if (record.scheduledOccurrences.length > MAX_SCHEDULED_OCCURRENCES) {
      throw new EngineError("JOB_CAP_EXCEEDED", `JobStoreDocumentV1.scheduledOccurrences exceeds max count (${MAX_SCHEDULED_OCCURRENCES}).`, {});
    }
    scheduledOccurrences = record.scheduledOccurrences.map((entry) => parseScheduledOccurrenceRecordV1(entry));
    const seenOccurrenceIds = new Set<string>();
    for (const occurrence of scheduledOccurrences) {
      if (seenOccurrenceIds.has(occurrence.occurrenceId)) {
        throw new EngineError("JOB_STORE_CORRUPT", `Duplicate occurrenceId "${occurrence.occurrenceId}" in scheduled-occurrence registry.`, {});
      }
      seenOccurrenceIds.add(occurrence.occurrenceId);
      const referencedJob = jobsById.get(occurrence.jobId);
      if (!referencedJob) {
        throw new EngineError("JOB_STORE_CORRUPT", `Scheduled occurrence "${occurrence.occurrenceId}" references a missing job "${occurrence.jobId}".`, {});
      }
      if (referencedJob.job.idempotencyKey !== occurrence.idempotencyKey) {
        throw new EngineError("JOB_STORE_CORRUPT", `Scheduled occurrence "${occurrence.occurrenceId}" idempotencyKey does not match its referenced job's idempotencyKey.`, {});
      }
    }
  }

  let bulkBatches: BulkBatchV1[];
  if (record.bulkBatches === undefined) bulkBatches = [];
  else {
    if (!Array.isArray(record.bulkBatches) || record.bulkBatches.length > MAX_BULK_BATCHES) throw new EngineError("JOB_STORE_CORRUPT", "JobStoreDocumentV1.bulkBatches must be a bounded array.", {});
    bulkBatches = record.bulkBatches.map((entry) => parseBulkBatchV1(entry, jobsById));
    if (new Set(bulkBatches.map((batch) => batch.batchId)).size !== bulkBatches.length) throw new EngineError("JOB_STORE_CORRUPT", "Duplicate bulk batch id.", {});
    if (bulkBatches.filter((batch) => batch.status === "active").length > 1) throw new EngineError("JOB_STORE_CORRUPT", "Only one bulk batch may be active.", {});
    for (const batch of bulkBatches) {
      if (batch.occurrenceId !== undefined) {
        const occurrence = scheduledOccurrences.find((entry) => entry.occurrenceId === batch.occurrenceId);
        if (!occurrence || occurrence.jobId !== batch.rootJobId) throw new EngineError("JOB_STORE_CORRUPT", "Bulk batch occurrence must reference its root.", {});
      }
    }
  }

  const providerPause = parseProviderPauseV1(record.providerPause);
  return { schemaVersion: 1, jobs, providerPause, scheduledOccurrences, bulkBatches };
}

/**
 * A phase transition is legal iff it stays on the same phase (re-persisting
 * the same in-progress phase, e.g. bumping `attempt` before retrying it) or
 * advances EXACTLY one step forward through `JOB_KIND_PHASES[kind]` --
 * never skips a phase, never moves backward. Combined with "persist attempt
 * + phase before external work" (enforced by `JobEngine`, not this
 * function), the persisted phase is always exactly the earliest
 * not-yet-committed step, so a same-phase resume after a crash is always
 * safe to simply redo -- see the individual phase runners for why each
 * phase's work is idempotent.
 */
export function isLegalPhaseTransition(kind: JobKind, from: JobPhase, to: JobPhase): boolean {
  const phases = JOB_KIND_PHASES[kind];
  const fromIndex = phases.indexOf(from);
  const toIndex = phases.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex === fromIndex || toIndex === fromIndex + 1;
}

export function assertLegalPhaseTransition(kind: JobKind, from: JobPhase, to: JobPhase): void {
  if (!isLegalPhaseTransition(kind, from, to)) {
    throw new EngineError("JOB_TRANSITION_INVALID", `Illegal phase transition for job kind "${kind}": "${from}" -> "${to}".`, { kind, from, to });
  }
}

/**
 * `JobStore.supersedeWithSuccessor`'s shape guard (Checkpoint 7 last-contract
 * guard 2): a successor is never an arbitrary caller-supplied job -- it must
 * be EXACTLY "the same work, restarted from scratch." Every field checked
 * here mirrors what `JobEngine.applyStepOutcome`'s `"superseded"` case
 * itself constructs, so a caller (or a future runner) that hand-builds a
 * malformed successor fails closed BEFORE any document mutation, never
 * after. `idempotencyKey` equality is checked explicitly rather than
 * trusted to imply the other identity fields (kind/target/pipelineVersion/
 * sourceHash/embeddingModel) -- it is a hash, and this function is the
 * shape gate, not a place to lean on hash-collision odds.
 */
export function assertValidSuccessorShape(old: PersistedJobV1, successor: PersistedJobV1): void {
  if (successor.job.jobId === old.job.jobId) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have a different jobId than the old job.", {});
  }
  if (successor.job.kind !== old.job.kind) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have the same kind as the old job.", {});
  }
  if (successor.job.pipelineVersion !== old.job.pipelineVersion) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have the same pipelineVersion as the old job.", {});
  }
  if (successor.job.sourceHash !== old.job.sourceHash || successor.job.embeddingModel !== old.job.embeddingModel) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have the same sourceHash/embeddingModel as the old job.", {});
  }
  if (JSON.stringify(successor.job.target) !== JSON.stringify(old.job.target)) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must target the same thing as the old job.", {});
  }
  if (successor.job.idempotencyKey !== old.job.idempotencyKey) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have the same idempotencyKey as the old job.", {});
  }
  const initialPhase = JOB_KIND_PHASES[successor.job.kind][0];
  if (successor.job.phase !== initialPhase) {
    throw new EngineError("JOB_SHAPE_INVALID", `supersedeWithSuccessor: successor must start at phase "${initialPhase}".`, {});
  }
  if (successor.status !== "queued") {
    throw new EngineError("JOB_SHAPE_INVALID", 'supersedeWithSuccessor: successor must have status "queued".', {});
  }
  if (successor.attempt !== 0) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must have attempt 0.", {});
  }
  if (successor.cancelRequested !== false) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must not carry cancelRequested.", {});
  }
  if (successor.receipt !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must not carry a receipt.", {});
  }
  if (successor.lastFailureCode !== undefined || successor.lastFailureClass !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must not carry a failure code/class.", {});
  }
  if (successor.nextAttemptAtMs !== undefined) {
    throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor: successor must not carry backoff bookkeeping.", {});
  }
}

export { JOB_KIND_PHASES, JOB_KIND_TARGET_KIND, JOB_TRIGGER_KINDS };
export type { JobKind, JobPhase, QueueJobV1 };
