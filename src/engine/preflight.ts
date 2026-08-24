import type { HealthCheckV1, HealthStatus } from "./contracts";
import { parseHealthCheckV1 } from "./contracts";
import { EngineError } from "./errors";

/**
 * The closed, exhaustive list of preflight check codes -- one per bullet in
 * Checkpoint 9's requirement 2 (a-g), plus the two synthetic aggregate
 * summary codes `runPreflight` never emits as an individual check result.
 * Defined as a runtime array first (mirrors `errors.ts`'s
 * `ENGINE_ERROR_CODES` pattern) so a caller/test can enumerate exactly
 * these values without a parallel list that could drift from the type.
 */
export const PREFLIGHT_CHECK_CODES = [
  "VAULT_ADAPTER",
  "OWNED_DATA_PATHS",
  "JOB_STORE",
  "SCHEDULE_STORE",
  "INDEX_STORE",
  "TEMP_CLEANUP",
  "OLLAMA_EMBEDDINGS",
  "LOCAL_METADATA_PROVIDER",
  "APPLE_BOOKS_READING",
  "RESEARCH_PROVIDER",
  "BACKGROUND_SCHEDULER",
] as const;

export type PreflightCheckCode = (typeof PREFLIGHT_CHECK_CODES)[number];

/** Required checks gate `summary.runtimeReady`; their failure means Standard Mode itself cannot be trusted. Every other check is optional -- its failure degrades only its own capability (Checkpoint 9 requirement 1/2). */
const REQUIRED_CHECK_CODES: ReadonlySet<PreflightCheckCode> = new Set(["VAULT_ADAPTER", "OWNED_DATA_PATHS", "JOB_STORE", "SCHEDULE_STORE", "INDEX_STORE", "TEMP_CLEANUP"]);

const OPTIONAL_CHECK_CODES: ReadonlySet<PreflightCheckCode> = new Set(["OLLAMA_EMBEDDINGS", "LOCAL_METADATA_PROVIDER", "APPLE_BOOKS_READING", "RESEARCH_PROVIDER", "BACKGROUND_SCHEDULER"]);

const MAX_CONTEXT_KEYS = 8;
const MAX_MESSAGE_LENGTH = 240;
const MAX_GUIDANCE_LENGTH = 240;

/**
 * Every probe returns a plain result, never throws a raw exception and
 * never carries a path/secret/provider-body field -- `boundedCheck` still
 * catches a misbehaving probe defensively (requirement: "no raw
 * exceptions").
 */
export interface PreflightProbeResult {
  status: HealthStatus;
  message: string;
  guidance?: string;
  context?: Record<string, unknown>;
}

export type PreflightProbe = (signal: AbortSignal) => Promise<PreflightProbeResult>;

export interface PreflightCheckDefinition {
  code: PreflightCheckCode;
  /** `undefined` means the capability is not configured/enabled at all -- skipped rather than probed, and reported as `"ok"` with a static "not enabled" message (an unconfigured optional capability is not a failure). */
  probe?: PreflightProbe;
  timeoutMs?: number;
}

export interface PreflightOptions {
  /** Per-check bounded timeout when a definition does not specify its own; also the outer ceiling `runPreflight` itself never exceeds regardless of check count. */
  defaultTimeoutMs?: number;
  /** Aborted externally (e.g. plugin unload) to cancel every still-pending probe immediately. */
  signal?: AbortSignal;
}

export interface PreflightSummaryV1 {
  /** `true` only if every REQUIRED check reported `"ok"`. */
  runtimeReady: boolean;
  overallStatus: HealthStatus;
  requiredOkCount: number;
  requiredCount: number;
  optionalOkCount: number;
  optionalCount: number;
}

export interface PreflightReportV1 {
  schemaVersion: 1;
  generatedAtIso: string;
  checks: HealthCheckV1[];
  summary: PreflightSummaryV1;
}

const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
const MAX_TOTAL_TIMEOUT_MS = 60_000;

/** A context KEY matching any of these (case-insensitive, substring) is always redacted regardless of its value's type or apparent innocuousness -- a probe author naming a field "endpointUrl" or "apiKey" must not be able to smuggle its value through just by it happening to be short. */
const SENSITIVE_CONTEXT_KEY_PATTERN = /path|url|uri|key|token|secret|passwd|password|authorization|auth|credential/i;
/** Bounded, enum/identifier-shaped strings only -- short, plain alphanumerics/dash/underscore/dot/colon/space. Anything shaped like a real path, URL, or free-text message (slashes, `{`, `"`, newlines, etc.) is redacted rather than passed through, even under an innocuous-looking key. */
const SAFE_CONTEXT_STRING_PATTERN = /^[A-Za-z0-9_.:\- ]{1,64}$/;

function redactContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const keys = Object.keys(context).slice(0, MAX_CONTEXT_KEYS);
  const bounded: Record<string, unknown> = {};
  for (const key of keys) {
    if (SENSITIVE_CONTEXT_KEY_PATTERN.test(key)) {
      bounded[key] = "[redacted]";
      continue;
    }
    const value = context[key];
    // Only a bounded, enum/identifier-shaped primitive passes through; anything else (nested
    // objects, arrays, functions, free-text/path/URL-shaped strings) collapses to a static marker
    // rather than risk leaking an unbounded/sensitive structure (a provider response body, a raw
    // path, a caught error object) into diagnostics -- a per-code safe allow-list, not "any short
    // string" (Checkpoint 9 requirement 7).
    if (typeof value === "string") {
      bounded[key] = SAFE_CONTEXT_STRING_PATTERN.test(value) ? value : "[redacted:unsafe-value]";
    } else if (typeof value === "number" || typeof value === "boolean") {
      bounded[key] = value;
    } else {
      bounded[key] = "[redacted]";
    }
  }
  return bounded;
}

function boundedText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/** Runs `probe` with a bounded per-check timeout and cancellation, and converts any thrown value (including a non-Error throw) into a static, redacted `"unavailable"` result -- a check NEVER throws out of `runPreflight`, and a probe's own raw caught error/message never appears in the result. */
async function boundedCheck(code: PreflightCheckCode, probe: PreflightProbe, timeoutMs: number, outerSignal?: AbortSignal): Promise<HealthCheckV1> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort);
  if (outerSignal?.aborted) controller.abort();

  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A signal that is ALREADY aborted at this point (the outer signal aborted before this check
    // even started, e.g. dispose() racing a just-queued start()) must short-circuit here rather
    // than call probe() at all: `AbortSignal`'s "abort" event only fires on a FUTURE transition,
    // never for a signal that is already aborted when a listener attaches -- a probe that only
    // listens for that event (a well-behaved, cooperative probe) would otherwise hang forever.
    if (controller.signal.aborted) {
      throw new Error("preflight check was already cancelled before it started");
    }
    const result = await Promise.race([
      probe(controller.signal),
      new Promise<PreflightProbeResult>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("preflight check timed out or was cancelled")), { once: true });
      }),
    ]);
    return buildHealthCheck(code, result.status, boundedText(result.message, MAX_MESSAGE_LENGTH), result.guidance ? boundedText(result.guidance, MAX_GUIDANCE_LENGTH) : undefined, redactContext(result.context));
  } catch {
    return buildHealthCheck(code, "unavailable", "Check did not complete within its bounded timeout.");
  } finally {
    window.clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function buildHealthCheck(code: PreflightCheckCode, status: HealthStatus, message: string, guidance?: string, context?: Record<string, unknown>): HealthCheckV1 {
  return parseHealthCheckV1({ schemaVersion: 1, code, status, message, guidance, context });
}

/**
 * `overallStatus` follows Checkpoint 9 requirement 7's rule EXACTLY, which
 * is deliberately NOT "the worst status of any check": a REQUIRED check
 * reporting `"unavailable"` is the only thing that can make the overall
 * status `"unavailable"`. A required check merely `"degraded"`, or ANY
 * optional check failing outright (`"unavailable"` or `"degraded"`), pulls
 * the overall status down to `"degraded"` at most -- optional-capability
 * trouble must never read as "the runtime itself is unavailable".
 */
function summarize(checks: readonly HealthCheckV1[]): PreflightSummaryV1 {
  let requiredOkCount = 0;
  let requiredCount = 0;
  let optionalOkCount = 0;
  let optionalCount = 0;
  let requiredHasUnavailable = false;
  let anyNotOk = false;
  for (const check of checks) {
    const isRequired = REQUIRED_CHECK_CODES.has(check.code as PreflightCheckCode);
    const isOptional = OPTIONAL_CHECK_CODES.has(check.code as PreflightCheckCode);
    if (isRequired) {
      requiredCount += 1;
      if (check.status === "ok") requiredOkCount += 1;
      if (check.status === "unavailable") requiredHasUnavailable = true;
    } else if (isOptional) {
      optionalCount += 1;
      if (check.status === "ok") optionalOkCount += 1;
    }
    if (check.status !== "ok") anyNotOk = true;
  }
  const overallStatus: HealthStatus = requiredHasUnavailable ? "unavailable" : anyNotOk ? "degraded" : "ok";
  return {
    runtimeReady: requiredCount > 0 && requiredOkCount === requiredCount,
    overallStatus,
    requiredOkCount,
    requiredCount,
    optionalOkCount,
    optionalCount,
  };
}

/**
 * Fails closed BEFORE any probe runs (Checkpoint 9 requirement 7): every
 * code in `PREFLIGHT_CHECK_CODES` must appear in `definitions` exactly
 * once -- a duplicate or a missing code is a caller/composition bug, never
 * silently tolerated (a missing required code could otherwise let
 * `runtimeReady` report `true` despite a capability nobody actually
 * checked). Also validates each definition's own `timeoutMs`, when
 * provided, is a plain positive integer within the module's bound -- an
 * invalid one is rejected here rather than silently clamped or coerced.
 */
function validateDefinitions(definitions: readonly PreflightCheckDefinition[]): void {
  const seen = new Map<string, number>();
  for (const definition of definitions) {
    seen.set(definition.code, (seen.get(definition.code) ?? 0) + 1);
    if (definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > MAX_TOTAL_TIMEOUT_MS)) {
      throw new EngineError("PREFLIGHT_CONTRACT_INVALID", `Preflight check "${definition.code}" has an invalid timeoutMs.`);
    }
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([code]) => code);
  if (duplicates.length > 0) {
    throw new EngineError("PREFLIGHT_CONTRACT_INVALID", "Preflight definitions contain duplicate check codes.", { duplicateCount: duplicates.length });
  }
  const missing = PREFLIGHT_CHECK_CODES.filter((code) => !seen.has(code));
  if (missing.length > 0) {
    throw new EngineError("PREFLIGHT_CONTRACT_INVALID", "Preflight definitions are missing required check codes.", { missingCount: missing.length });
  }
}

const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Rejects a non-canonical `generatedAtIso` (Checkpoint 9 requirement 7) rather than persisting/reporting a report timestamp that isn't safely re-parseable/comparable in exactly one format. */
function validateGeneratedAtIso(nowIso: string): void {
  if (typeof nowIso !== "string" || !CANONICAL_ISO_PATTERN.test(nowIso) || Number.isNaN(Date.parse(nowIso))) {
    throw new EngineError("PREFLIGHT_CONTRACT_INVALID", "runPreflight nowIso must be a canonical ISO-8601 UTC timestamp.");
  }
}

/**
 * Runs every provided check independently and concurrently, each bounded
 * by its own timeout/cancellation, and NEVER touches the vault, an index,
 * a job queue's execution, or any provider beyond a bounded readiness
 * probe -- see this module's checkpoint requirement. A check with no probe
 * (capability not configured) is reported `"ok"` with a static message
 * rather than skipped from the report entirely, so the check code allow-
 * list stays exhaustive and stable across configurations.
 */
export async function runPreflight(definitions: readonly PreflightCheckDefinition[], options: PreflightOptions = {}, nowIso: string = new Date().toISOString()): Promise<PreflightReportV1> {
  validateDefinitions(definitions);
  validateGeneratedAtIso(nowIso);
  if (options.defaultTimeoutMs !== undefined && (!Number.isInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs < 1)) {
    throw new EngineError("PREFLIGHT_CONTRACT_INVALID", "runPreflight defaultTimeoutMs must be a positive integer.");
  }
  const defaultTimeoutMs = Math.min(options.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS);
  const checks = await Promise.all(
    definitions.map((definition) => {
      if (!definition.probe) {
        // A capability with no probe at all was never actually checked -- reporting it "ok" would
        // claim health nothing confirmed. `"degraded"` is honest about that while still never
        // gating `runtimeReady` (only a REQUIRED check's status feeds `requiredOkCount`, and every
        // required code is always wired with a real probe in practice -- see
        // `MindmapEngine.buildPreflightDefinitions`).
        return Promise.resolve(buildHealthCheck(definition.code, "degraded", "Capability is not configured."));
      }
      const timeoutMs = Math.min(definition.timeoutMs ?? defaultTimeoutMs, MAX_TOTAL_TIMEOUT_MS);
      return boundedCheck(definition.code, definition.probe, timeoutMs, options.signal);
    }),
  );
  return {
    schemaVersion: 1,
    generatedAtIso: nowIso,
    checks,
    summary: summarize(checks),
  };
}
