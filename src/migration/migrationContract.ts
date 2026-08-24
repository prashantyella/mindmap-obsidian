import { ENGINE_ERROR_CODES, EngineError } from "../engine/errors";

/**
 * Checkpoint 10A: the restart-safe 0.2.x -> TypeScript index migration's
 * own durable phase machine. Deliberately a SEPARATE, higher-level phase
 * list from `JobPhase`'s `"migrate-index"` phases (`discover`/
 * `build-generation`/`verify-generation`/`activate-generation`/
 * `complete`, see `contracts.ts`'s `JOB_KIND_PHASES`) -- a migration run
 * is not just one job; it is a whole per-note ingestion pass (many
 * `"process-note"` jobs) FOLLOWED BY one `"migrate-index"` job, and this
 * module's phases describe the OUTER sequence, not the inner job's own
 * resumable state.
 *
 * `"discover"`: enumerating eligible notes from the configured scope.
 * `"plan"`: deciding whether migration is needed at all (already-matching
 * generation is a no-op) or must supersede a stale/mismatched plan.
 * `"build"`: per-note ingestion (`"process-note"` jobs) is in flight.
 * `"verify"`/`"activate"`: the submitted `"migrate-index"` job's own
 * `verify-generation`/`activate-generation` phases are in flight.
 * `"complete"`: the migration is finished and the TS generation is live.
 * `"cancelled"`/`"failed"` are terminal, non-progressing outcomes.
 */
export const MIGRATION_PHASES = ["not-started", "discover", "plan", "build", "verify", "activate", "complete", "cancelled", "failed"] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

const TERMINAL_MIGRATION_PHASES: ReadonlySet<MigrationPhase> = new Set(["complete", "cancelled", "failed"]);
export function isTerminalMigrationPhase(phase: MigrationPhase): boolean {
  return TERMINAL_MIGRATION_PHASES.has(phase);
}

/** Once a run reaches `"activate"`, cancellation is no longer honored (mirrors `jobEngine.ts`'s own `IRREVERSIBLE_COMMIT_PHASE` for `"migrate-index"`: `"activate-generation"`) -- surfaced here so a caller's UI affordance can stop offering "cancel" the instant it would no longer do anything, rather than only discovering that after the request is silently ignored. */
const IRREVERSIBLE_MIGRATION_PHASES: ReadonlySet<MigrationPhase> = new Set(["activate", "complete", "cancelled", "failed"]);

/** Closed, exhaustive set of every status message code this module ever emits -- mirrors `SHADOW_REASON_CODES`'s own closed-allow-list pattern (`shadowEngine.ts`) so a redaction/report-shape audit can enumerate every value exhaustively. Never a raw error message. */
export const MIGRATION_MESSAGE_CODES = [
  "NOT_STARTED",
  "DISCOVERING_NOTES",
  "PLANNING",
  "ALREADY_UP_TO_DATE",
  "MODEL_CHANGED_REPLANNING",
  "PLAN_DRIFT_REPLANNING",
  "BUILDING_INDEX",
  "VERIFYING_GENERATION",
  "ACTIVATING_GENERATION",
  "COMPLETE",
  "CANCELLED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
] as const;
export type MigrationMessageCode = (typeof MIGRATION_MESSAGE_CODES)[number];

export interface MigrationStatusV1 {
  schemaVersion: 1;
  phase: MigrationPhase;
  messageCode: MigrationMessageCode;
  /**
   * `true` while Reading/research/search/index-dependent work must stay
   * blocked pending migration -- Standard Mode (ordinary note editing,
   * settings, the plugin itself) is NEVER blocked by this flag or by
   * migration at all, before/during/after a failure (item 5: "Standard
   * Mode must remain usable before/during/after migration failure").
   */
  indexDependentFeaturesBlocked: boolean;
  /** Bounded, content-free progress counts -- never a raw list of paths/identities. */
  discoveredCount: number;
  processedCount: number;
  failedCount: number;
  canStart: boolean;
  canRetry: boolean;
  canCancel: boolean;
  updatedAtIso: string;
  /** The closed `EngineErrorCode`/job-failure-code that most recently caused a `"failed"` phase, when known. Never a raw message. */
  lastFailureCode?: string;
  /**
   * Item 1: a short, opaque, bounded identifier for THIS migration attempt
   * -- minted fresh every time `MigrationRunner.start()` begins a NEW run
   * (never reused across a retry after `"failed"`/`"cancelled"`), and
   * carried unchanged through every subsequent phase transition of that
   * SAME run. Absent only for the synthesized, never-persisted
   * `"not-started"` status `getStatus()` returns on a fresh install.
   */
  runId?: string;
}

const MAX_SAFE_PROGRESS_COUNT = 1_000_000;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Item 1: `runId`/`migrateIndexJobId` are short, printable-ASCII, control-character-free tokens -- real job ids are UUIDs, but this pattern is deliberately looser (bounded length, printable ASCII) so it also accepts a test double's own short synthetic ids, mirroring `migrationStaging.ts`'s own `RUN_ID_PATTERN` discipline. */
const BOUNDED_TOKEN_PATTERN = /^[\x21-\x7E]{1,128}$/;
/** Item 12: `lastFailureCode` must be a member of the SAME closed set `jobTypes.ts`'s own `RECOGNIZED_FAILURE_CODES` enforces (every `EngineErrorCode` plus the one synthetic `"UNKNOWN_TRANSIENT"` fallback) -- never an arbitrary bounded string. Declared independently (not imported from `jobTypes.ts`, which itself is leaf-level within `src/jobs`) to keep `src/migration` decoupled from `src/jobs`'s module graph; both sets are built from the SAME `ENGINE_ERROR_CODES` source of truth, so they cannot drift apart. */
const RECOGNIZED_STATUS_FAILURE_CODES: ReadonlySet<string> = new Set<string>([...ENGINE_ERROR_CODES, "UNKNOWN_TRANSIENT"]);

function assertNonNegativeSafeInt(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SAFE_PROGRESS_COUNT) {
    throw new EngineError("MIGRATION_CONTRACT_INVALID", `MigrationStatusV1.${field} must be an integer in [0, ${MAX_SAFE_PROGRESS_COUNT}].`);
  }
}

/** `true` iff `phase`'s affordances/counts are internally consistent with `MigrationStatusV1`'s own invariants (Checkpoint 10A item 5): a terminal phase never claims `canCancel`; only `"failed"` ever claims `canRetry`; `canStart` is exclusive with every in-flight phase. Pure/side-effect-free -- used both by `deriveMigrationAffordances` (the single source of truth for correct construction) and `parseMigrationStatusV1` (which re-validates ANY caller-supplied value, including one this module did not itself construct). */
export function deriveMigrationAffordances(phase: MigrationPhase): { canStart: boolean; canRetry: boolean; canCancel: boolean } {
  const canStart = phase === "not-started" || phase === "cancelled" || phase === "failed" || phase === "complete";
  const canRetry = phase === "failed";
  const canCancel = !IRREVERSIBLE_MIGRATION_PHASES.has(phase);
  return { canStart, canRetry, canCancel };
}

/** `true` for every non-terminal, non-"complete" phase -- Reading/research/search stay gated until migration either finishes or is abandoned (cancelled/failed leave the PRIOR state, if any, as the last known-good; a caller decides separately whether "prior state" means "still Python/no TS index yet" in 10A, since nothing user-reachable has cut over). */
export function computeIndexDependentFeaturesBlocked(phase: MigrationPhase): boolean {
  return phase !== "complete";
}

export interface MigrationStatusExtra {
  /** The closed `EngineErrorCode`/job-failure-code that caused a `"failed"` phase, when known. */
  lastFailureCode?: string;
  /** Item 1: this run's own opaque identifier -- see `MigrationStatusV1.runId`'s own doc comment. */
  runId?: string;
}

export function buildMigrationStatusV1(phase: MigrationPhase, messageCode: MigrationMessageCode, counts: { discoveredCount: number; processedCount: number; failedCount: number }, nowIso: string, extra?: MigrationStatusExtra): MigrationStatusV1 {
  const affordances = deriveMigrationAffordances(phase);
  return {
    schemaVersion: 1,
    phase,
    messageCode,
    indexDependentFeaturesBlocked: computeIndexDependentFeaturesBlocked(phase),
    discoveredCount: counts.discoveredCount,
    processedCount: counts.processedCount,
    failedCount: counts.failedCount,
    ...affordances,
    updatedAtIso: nowIso,
    lastFailureCode: extra?.lastFailureCode,
    runId: extra?.runId,
  };
}

/**
 * Strict, fail-closed parser for a `MigrationStatusV1` read back from
 * persisted state (`migrationStore.ts`) or handed across a process/module
 * boundary -- exact key set, closed phase/message-code enumerations,
 * bounded non-negative integer counts, canonical ISO timestamp, and
 * cross-field consistency (affordances must match what
 * `deriveMigrationAffordances(phase)` itself would compute; a persisted
 * document that disagrees is corrupt, not merely stale) via
 * `MIGRATION_STATE_CORRUPT` rather than `MIGRATION_CONTRACT_INVALID`
 * (Checkpoint 10A item 4: "Corrupt migration state fails closed with
 * actionable closed error codes, no path/body/error-message leakage").
 */
export function parseMigrationStatusV1(value: unknown): MigrationStatusV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["schemaVersion", "phase", "messageCode", "indexDependentFeaturesBlocked", "discoveredCount", "processedCount", "failedCount", "canStart", "canRetry", "canCancel", "updatedAtIso", "lastFailureCode", "runId"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status has an unrecognized field.");
    }
  }
  if (record.schemaVersion !== 1) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status has an unrecognized schemaVersion.");
  }
  if (typeof record.phase !== "string" || !(MIGRATION_PHASES as readonly string[]).includes(record.phase)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status has an unrecognized phase.");
  }
  const phase = record.phase as MigrationPhase;
  if (typeof record.messageCode !== "string" || !(MIGRATION_MESSAGE_CODES as readonly string[]).includes(record.messageCode)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status has an unrecognized messageCode.");
  }
  if (typeof record.indexDependentFeaturesBlocked !== "boolean" || record.indexDependentFeaturesBlocked !== computeIndexDependentFeaturesBlocked(phase)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status indexDependentFeaturesBlocked disagrees with its own phase.");
  }
  assertNonNegativeSafeInt(record.discoveredCount, "discoveredCount");
  assertNonNegativeSafeInt(record.processedCount, "processedCount");
  assertNonNegativeSafeInt(record.failedCount, "failedCount");
  if (record.processedCount + record.failedCount > record.discoveredCount) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status processedCount+failedCount exceeds discoveredCount.");
  }
  const affordances = deriveMigrationAffordances(phase);
  if (record.canStart !== affordances.canStart || record.canRetry !== affordances.canRetry || record.canCancel !== affordances.canCancel) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status affordances disagree with its own phase.");
  }
  if (typeof record.updatedAtIso !== "string" || !CANONICAL_ISO_PATTERN.test(record.updatedAtIso)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status updatedAtIso must be a canonical ISO-8601 timestamp.");
  }
  if (record.lastFailureCode !== undefined && !RECOGNIZED_STATUS_FAILURE_CODES.has(record.lastFailureCode as string)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status lastFailureCode must be a member of the closed EngineErrorCode/job-failure-code set.");
  }
  if (record.runId !== undefined && (typeof record.runId !== "string" || !BOUNDED_TOKEN_PATTERN.test(record.runId))) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration status runId must be a short, bounded, control-character-free token.");
  }
  return {
    schemaVersion: 1,
    phase,
    messageCode: record.messageCode as MigrationMessageCode,
    indexDependentFeaturesBlocked: record.indexDependentFeaturesBlocked,
    discoveredCount: record.discoveredCount,
    processedCount: record.processedCount,
    failedCount: record.failedCount,
    canStart: affordances.canStart,
    canRetry: affordances.canRetry,
    canCancel: affordances.canCancel,
    updatedAtIso: record.updatedAtIso,
    runId: record.runId,
    lastFailureCode: record.lastFailureCode as string | undefined,
  };
}
