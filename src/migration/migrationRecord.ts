import { ENGINE_ERROR_CODES, EngineError } from "../engine/errors";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { MAX_MANIFEST_CHUNK_COUNT, MAX_MANIFEST_NOTE_COUNT } from "../index/indexManifest";
import {
  buildMigrationStatusV1,
  MIGRATION_MESSAGE_CODES,
  MIGRATION_PHASES,
  type MigrationMessageCode,
  type MigrationPhase,
  type MigrationStatusV1,
} from "./migrationContract";
import type { MigrationBaseGenerationState } from "./migrationPlan";

/**
 * Checkpoint 10A sub-milestone B: the ONE strict, versioned, internal
 * record `MigrationStore` actually persists -- a superset of the public,
 * redacted `MigrationStatusV1` a caller/UI observes via
 * `MigrationRunner.getStatus()`. Every field here that is NOT part of
 * `MigrationStatusV1` is internal run-ownership/drift-detection
 * bookkeeping that must never leak to a UI-facing status.
 *
 * Deliberately holds NO per-note id collection -- per-note progress lives
 * in the durable `MigrationPlanV1` artifact (`migrationPlan.ts`) plus this
 * record's own bounded `cursorIndex` into that plan's canonically sorted
 * entries, and is independently re-derivable from strictly validated
 * staging metadata on restart -- never trusted from this record alone
 * (`migrationRunner.ts`'s own cursor-trust re-check).
 */
export interface MigrationRecordV1 {
  schemaVersion: 1;
  phase: MigrationPhase;
  messageCode: MigrationMessageCode;
  discoveredCount: number;
  processedCount: number;
  failedCount: number;
  updatedAtIso: string;
  /** Review item 9: must be a member of the SAME closed set every other job-failure-code field in this codebase uses (`ENGINE_ERROR_CODES` plus the synthetic `"UNKNOWN_TRANSIENT"` fallback) -- never an arbitrary string. */
  lastFailureCode?: string;
  runId?: string;
  /** Review item 12: increments on every persisted mutation of this record -- `MigrationStore`'s compare-and-set check (`persist()`'s expected-revision argument) uses this to detect a concurrent writer (another `MigrationRunner` instance, in-process or not) that mutated the record between this reconcile pass's own read and its write. */
  revision: number;

  /** The exact embedding model/dimension/pipeline THIS run was planned against -- re-checked before build/verify/activate so a mid-run config change is detected as drift rather than silently finishing under stale assumptions. Required (never `undefined`) once `phase` is anything other than `"not-started"`. */
  desiredEmbeddingModel?: string;
  desiredDimension?: number;
  desiredPipelineVersion?: number;
  /** Order-independent hash over the plan's (identity, sourceHash) pairs -- mirrors `MigrationPlanV1.planFingerprint`; kept here too so a drift check never needs to load the plan artifact just to compare fingerprints. */
  planFingerprint?: string;
  /** Review item 8: an explicit tri-state snapshot of whatever generation was current at plan time -- see `MigrationBaseGenerationState`'s own doc comment. Never inferred from "id present" alone. */
  baseGenerationState?: MigrationBaseGenerationState;
  baseGenerationId?: number;
  baseGenerationFingerprint?: string;
  baseManifestRawFingerprint?: string;
  /** The staging run id this run's staged ingestion artifacts live under (`migration/staging/<stagingRunId>/`) -- defaults to `runId`, kept distinct so a superseded run's stale staging can be identified and cleared independently of a CURRENT run's own id. */
  stagingRunId?: string;
  /** Bounded cursor (a single integer, never a per-note collection) into `MigrationPlanV1.entries` -- the next entry index this run has not yet confirmed staged. Re-derived/validated against actual staging metadata on resume, never blindly trusted alone. */
  cursorIndex?: number;
  /** Review item 5: the running total of chunk rows across every plan entry at index `< cursorIndex` -- checked against `MAX_MANIFEST_CHUNK_COUNT` incrementally as ingestion proceeds (never only at the very end), and reconstructed from scratch whenever `cursorIndex` itself is corrected by a cursor-trust re-check. */
  stagedChunkCount?: number;
  /** The generation id this run built (once known), before the pointer switch -- set the moment `buildGeneration` succeeds. */
  activationGenerationId?: number;
  /** The freshly-built target generation's own `manifestArtifactFingerprint`, captured immediately after `buildGeneration` -- lets every later phase (up through the pointer switch) confirm no corruption occurred since, without needing to trust `activationGenerationId` alone. */
  builtGenerationFingerprint?: string;
  /** Item 4/7: persisted BEFORE this run stops making further progress or cancels anything in flight, so a crash mid-cancellation is still recognizable as "this run was being cancelled" on restart rather than silently resuming as if nothing had happened. */
  cancellationRequested: boolean;
  /** Review item 6: `true` from the moment `"complete"` is FIRST persisted (durably, before any cleanup is attempted) until this run's staging/plan cleanup has actually succeeded -- a terminal `"complete"` record with `cleanupPending: true` is still resumable (a later `reconcile()` retries ONLY the best-effort cleanup, never re-enters activation), so a crash between persisting completion and finishing cleanup can never strand an un-retried cleanup. `false` for every other phase. */
  cleanupPending: boolean;
}

const MAX_SAFE_PROGRESS_COUNT = 1_000_000;
const MAX_GENERATION_ID = Number.MAX_SAFE_INTEGER;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Review item 9: the SAME strict runId shape `migrationPlan.ts`/`migrationStaging.ts` already enforce -- never the looser "any printable ASCII" bound a slash-bearing (path-traversal-shaped) token could pass. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
/** Review item 9: the SAME closed failure-code allow-list `migrationContract.ts`'s own `RECOGNIZED_STATUS_FAILURE_CODES` already enforces on the public status -- built independently from the same `ENGINE_ERROR_CODES` source of truth (mirrors that module's own doc comment on why: `src/migration` stays decoupled from `src/jobs`'s module graph). */
const RECOGNIZED_FAILURE_CODES: ReadonlySet<string> = new Set<string>([...ENGINE_ERROR_CODES, "UNKNOWN_TRANSIENT"]);
const BASE_GENERATION_STATES: readonly MigrationBaseGenerationState[] = ["none", "verified", "unverifiable"];

/** Review item 9: which `MigrationMessageCode`s are legal for a given `phase` -- a persisted record claiming e.g. phase `"build"` with messageCode `"COMPLETE"` is corrupt, not merely stale. */
const ALLOWED_MESSAGE_CODES_BY_PHASE: Readonly<Record<MigrationPhase, ReadonlySet<MigrationMessageCode>>> = {
  "not-started": new Set(["NOT_STARTED"]),
  discover: new Set(["DISCOVERING_NOTES"]),
  plan: new Set(["PLANNING", "PLAN_DRIFT_REPLANNING", "MODEL_CHANGED_REPLANNING"]),
  build: new Set(["BUILDING_INDEX"]),
  verify: new Set(["VERIFYING_GENERATION"]),
  activate: new Set(["ACTIVATING_GENERATION"]),
  complete: new Set(["COMPLETE", "ALREADY_UP_TO_DATE"]),
  cancelled: new Set(["CANCELLED"]),
  failed: new Set(["FAILED_RETRYABLE", "FAILED_TERMINAL"]),
};

function assertNonNegativeSafeInt(value: unknown, field: string, max = MAX_SAFE_PROGRESS_COUNT): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", `MigrationRecordV1.${field} must be an integer in [0, ${max}].`);
  }
}

function assertRunId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", `MigrationRecordV1.${field} must be a short, bounded runId-shaped token.`);
  }
}

function assertHex64(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", `MigrationRecordV1.${field} must be a lowercase hex64 fingerprint.`);
  }
}

function assertGenerationId(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_GENERATION_ID) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", `MigrationRecordV1.${field} must be a non-negative integer generation id.`);
  }
}

export interface BuildMigrationRecordExtra {
  lastFailureCode?: string;
  runId?: string;
  revision?: number;
  desiredEmbeddingModel?: string;
  desiredDimension?: number;
  desiredPipelineVersion?: number;
  planFingerprint?: string;
  baseGenerationState?: MigrationBaseGenerationState;
  baseGenerationId?: number;
  baseGenerationFingerprint?: string;
  baseManifestRawFingerprint?: string;
  stagingRunId?: string;
  cursorIndex?: number;
  stagedChunkCount?: number;
  activationGenerationId?: number;
  builtGenerationFingerprint?: string;
  cancellationRequested?: boolean;
  cleanupPending?: boolean;
}

export function buildMigrationRecordV1(phase: MigrationPhase, messageCode: MigrationMessageCode, counts: { discoveredCount: number; processedCount: number; failedCount: number }, nowIso: string, extra?: BuildMigrationRecordExtra): MigrationRecordV1 {
  return {
    schemaVersion: 1,
    phase,
    messageCode,
    discoveredCount: counts.discoveredCount,
    processedCount: counts.processedCount,
    failedCount: counts.failedCount,
    updatedAtIso: nowIso,
    lastFailureCode: extra?.lastFailureCode,
    runId: extra?.runId,
    revision: extra?.revision ?? 0,
    desiredEmbeddingModel: extra?.desiredEmbeddingModel,
    desiredDimension: extra?.desiredDimension,
    desiredPipelineVersion: extra?.desiredPipelineVersion,
    planFingerprint: extra?.planFingerprint,
    baseGenerationState: extra?.baseGenerationState,
    baseGenerationId: extra?.baseGenerationId,
    baseGenerationFingerprint: extra?.baseGenerationFingerprint,
    baseManifestRawFingerprint: extra?.baseManifestRawFingerprint,
    stagingRunId: extra?.stagingRunId,
    cursorIndex: extra?.cursorIndex,
    stagedChunkCount: extra?.stagedChunkCount,
    activationGenerationId: extra?.activationGenerationId,
    builtGenerationFingerprint: extra?.builtGenerationFingerprint,
    cancellationRequested: extra?.cancellationRequested ?? false,
    cleanupPending: extra?.cleanupPending ?? false,
  };
}

/** Projects the internal record down to the redacted, UI-facing `MigrationStatusV1` shape -- the ONE path any external caller ever observes migration progress through. */
export function toPublicMigrationStatus(record: MigrationRecordV1): MigrationStatusV1 {
  return buildMigrationStatusV1(record.phase, record.messageCode, { discoveredCount: record.discoveredCount, processedCount: record.processedCount, failedCount: record.failedCount }, record.updatedAtIso, {
    lastFailureCode: record.lastFailureCode,
    runId: record.runId,
  });
}

const ALLOWED_RECORD_KEYS = new Set([
  "schemaVersion",
  "phase",
  "messageCode",
  "discoveredCount",
  "processedCount",
  "failedCount",
  "updatedAtIso",
  "lastFailureCode",
  "runId",
  "revision",
  "desiredEmbeddingModel",
  "desiredDimension",
  "desiredPipelineVersion",
  "planFingerprint",
  "baseGenerationState",
  "baseGenerationId",
  "baseGenerationFingerprint",
  "baseManifestRawFingerprint",
  "stagingRunId",
  "cursorIndex",
  "stagedChunkCount",
  "activationGenerationId",
  "builtGenerationFingerprint",
  "cancellationRequested",
  "cleanupPending",
]);

const ACTIVE_PHASES: ReadonlySet<MigrationPhase> = new Set(["discover", "plan", "build", "verify", "activate"]);
const BUILD_OR_LATER_PHASES: ReadonlySet<MigrationPhase> = new Set(["build", "verify", "activate"]);

/** Strict, fail-closed parser mirroring `parseMigrationStatusV1`'s own discipline, extended with this record's internal-only fields and cross-field phase correlations (review item 9). Never trusts a persisted document's `phase`/count/field relationship without re-validating it. */
export function parseMigrationRecordV1(value: unknown): MigrationRecordV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_RECORD_KEYS.has(key)) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record has an unrecognized field.");
    }
  }
  if (record.schemaVersion !== 1) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record has an unrecognized schemaVersion.");
  }
  if (typeof record.phase !== "string" || !(MIGRATION_PHASES as readonly string[]).includes(record.phase)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record has an unrecognized phase.");
  }
  const phase = record.phase as MigrationPhase;
  if (typeof record.messageCode !== "string" || !(MIGRATION_MESSAGE_CODES as readonly string[]).includes(record.messageCode)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record has an unrecognized messageCode.");
  }
  const messageCode = record.messageCode as MigrationMessageCode;
  if (!ALLOWED_MESSAGE_CODES_BY_PHASE[phase].has(messageCode)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record's messageCode is not valid for its own phase.");
  }
  assertNonNegativeSafeInt(record.discoveredCount, "discoveredCount");
  assertNonNegativeSafeInt(record.processedCount, "processedCount");
  assertNonNegativeSafeInt(record.failedCount, "failedCount");
  if (record.processedCount + record.failedCount > record.discoveredCount) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record processedCount+failedCount exceeds discoveredCount.");
  }
  if (typeof record.updatedAtIso !== "string" || !CANONICAL_ISO_PATTERN.test(record.updatedAtIso)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record updatedAtIso must be a canonical ISO-8601 timestamp.");
  }
  if (record.lastFailureCode !== undefined && (typeof record.lastFailureCode !== "string" || !RECOGNIZED_FAILURE_CODES.has(record.lastFailureCode))) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record lastFailureCode must be a member of the closed EngineErrorCode/job-failure-code set.");
  }
  if (record.runId !== undefined) assertRunId(record.runId, "runId");
  assertNonNegativeSafeInt(record.revision, "revision", MAX_REVISION);
  if (record.desiredEmbeddingModel !== undefined && (typeof record.desiredEmbeddingModel !== "string" || record.desiredEmbeddingModel.length === 0 || record.desiredEmbeddingModel.length > 200)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record desiredEmbeddingModel must be a short, non-empty string.");
  }
  if (record.desiredDimension !== undefined && (typeof record.desiredDimension !== "number" || !Number.isInteger(record.desiredDimension) || record.desiredDimension < 1 || record.desiredDimension > MAX_EMBEDDING_DIMENSION)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", `Persisted migration record desiredDimension must be an integer in [1, ${MAX_EMBEDDING_DIMENSION}].`);
  }
  if (record.desiredPipelineVersion !== undefined && (typeof record.desiredPipelineVersion !== "number" || !Number.isInteger(record.desiredPipelineVersion) || record.desiredPipelineVersion < 0)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record desiredPipelineVersion must be a non-negative integer.");
  }
  if (record.planFingerprint !== undefined) assertHex64(record.planFingerprint, "planFingerprint");
  if (record.baseGenerationState !== undefined && !BASE_GENERATION_STATES.includes(record.baseGenerationState as MigrationBaseGenerationState)) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record baseGenerationState must be a recognized state.");
  }
  if (record.baseGenerationId !== undefined) assertGenerationId(record.baseGenerationId, "baseGenerationId");
  if (record.baseGenerationFingerprint !== undefined) assertHex64(record.baseGenerationFingerprint, "baseGenerationFingerprint");
  if (record.baseManifestRawFingerprint !== undefined) assertHex64(record.baseManifestRawFingerprint, "baseManifestRawFingerprint");
  if (record.activationGenerationId !== undefined) assertGenerationId(record.activationGenerationId, "activationGenerationId");
  if (record.builtGenerationFingerprint !== undefined) assertHex64(record.builtGenerationFingerprint, "builtGenerationFingerprint");
  if (record.stagingRunId !== undefined) assertRunId(record.stagingRunId, "stagingRunId");
  if (record.cursorIndex !== undefined) {
    assertNonNegativeSafeInt(record.cursorIndex, "cursorIndex");
    if (record.cursorIndex > MAX_MANIFEST_NOTE_COUNT || record.cursorIndex > record.discoveredCount) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record cursorIndex exceeds its own discoveredCount or the approved ceiling.");
    }
  }
  if (record.stagedChunkCount !== undefined) {
    assertNonNegativeSafeInt(record.stagedChunkCount, "stagedChunkCount");
    if (record.stagedChunkCount > MAX_MANIFEST_CHUNK_COUNT) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", `Persisted migration record stagedChunkCount exceeds the approved ceiling of ${MAX_MANIFEST_CHUNK_COUNT}.`);
    }
  }
  if (typeof record.cancellationRequested !== "boolean") {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record cancellationRequested must be a boolean.");
  }
  if (typeof record.cleanupPending !== "boolean") {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record cleanupPending must be a boolean.");
  }

  // Cross-field phase correlations (review item 9).
  if (ACTIVE_PHASES.has(phase) || phase === "complete") {
    if (record.runId === undefined || record.desiredEmbeddingModel === undefined || record.desiredDimension === undefined || record.desiredPipelineVersion === undefined) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record is missing run/model/dimension/pipeline fields required by its own phase.");
    }
  }
  if (BUILD_OR_LATER_PHASES.has(phase)) {
    if (record.planFingerprint === undefined || record.baseGenerationState === undefined || record.stagingRunId === undefined || record.cursorIndex === undefined) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record is missing plan/base/staging/cursor fields required by its own phase.");
    }
  }
  if (phase === "activate") {
    if (record.activationGenerationId === undefined || record.builtGenerationFingerprint === undefined) {
      throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record is missing target/built-fingerprint fields required by phase \"activate\".");
    }
  }
  if (phase === "failed" && record.lastFailureCode === undefined) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", 'Persisted migration record phase "failed" must carry a lastFailureCode.');
  }
  if (phase !== "cancelled" && (phase === "complete" || phase === "failed") && record.cancellationRequested === true) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", "Persisted migration record cannot claim cancellationRequested on a terminal outcome other than \"cancelled\".");
  }
  if (phase !== "complete" && record.cleanupPending === true) {
    throw new EngineError("MIGRATION_STATE_CORRUPT", 'Persisted migration record cleanupPending may only be true at phase "complete".');
  }

  return {
    schemaVersion: 1,
    phase,
    messageCode,
    discoveredCount: record.discoveredCount,
    processedCount: record.processedCount,
    failedCount: record.failedCount,
    updatedAtIso: record.updatedAtIso,
    lastFailureCode: record.lastFailureCode,
    runId: record.runId,
    revision: record.revision,
    desiredEmbeddingModel: record.desiredEmbeddingModel,
    desiredDimension: record.desiredDimension,
    desiredPipelineVersion: record.desiredPipelineVersion,
    planFingerprint: record.planFingerprint,
    baseGenerationState: record.baseGenerationState as MigrationBaseGenerationState | undefined,
    baseGenerationId: record.baseGenerationId,
    baseGenerationFingerprint: record.baseGenerationFingerprint,
    baseManifestRawFingerprint: record.baseManifestRawFingerprint,
    stagingRunId: record.stagingRunId,
    cursorIndex: record.cursorIndex,
    stagedChunkCount: record.stagedChunkCount,
    activationGenerationId: record.activationGenerationId,
    builtGenerationFingerprint: record.builtGenerationFingerprint,
    cancellationRequested: record.cancellationRequested,
    cleanupPending: record.cleanupPending,
  };
}
