import { createHash } from "node:crypto";

import { AtomicStore, joinRelative, type AtomicStoreFs } from "../engine/atomicStore";
import type { NoteIdentityV1 } from "../engine/contracts";
import { parseNoteIdentityV1 } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { MAX_MANIFEST_NOTE_COUNT } from "../index/indexManifest";
import { identityKey } from "../index/generationMetadata";
import type { IndexFs } from "../index/indexFs";

/**
 * Checkpoint 10A sub-milestone B, item 2: the durable, atomic, versioned
 * PLAN artifact a migration run commits to BEFORE any ingestion begins --
 * `migration/runs/<runId>/plan.json`. Plugin-owned internal data, never
 * exposed to a UI-facing status. Every entry is the exact
 * `(identity, sourceHash, embeddingModel)` triple discovery observed at
 * plan time, canonically sorted by stable identity key so the document is
 * byte-reproducible from the same discovered set regardless of discovery's
 * own enumeration order -- this canonical order is what lets
 * `MigrationRunner` address plan entries by a small persisted integer
 * cursor instead of any per-note id collection.
 */
export interface MigrationPlanEntryV1 {
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
}

/** Review item 8: an explicit tri-state snapshot of whatever generation was CURRENT at plan time -- never "id match is sufficient" when the base could not actually be verified. `"none"`: no current generation existed. `"verified"`: fully loaded/verified, `baseGenerationFingerprint` is a real content fingerprint. `"unverifiable"`: `current.json` pointed at `baseGenerationId` but its artifacts failed to load/verify -- `baseManifestRawFingerprint` (a raw-bytes hash of whatever `manifest.json` bytes exist, independent of whether they parse) is the only signal later drift checks can use; a later re-check that STILL can't verify it AND whose raw bytes no longer match is treated as drift, never as "probably the same corrupt thing". */
export type MigrationBaseGenerationState = "none" | "verified" | "unverifiable";

export interface MigrationPlanV1 {
  schemaVersion: 1;
  runId: string;
  desiredEmbeddingModel: string;
  desiredDimension: number;
  desiredPipelineVersion: number;
  baseGenerationState: MigrationBaseGenerationState;
  baseGenerationId?: number;
  baseGenerationFingerprint?: string;
  baseManifestRawFingerprint?: string;
  /** Recomputed from `entries` and cross-checked on every parse -- a tampered/corrupt entries array can never carry a self-consistent fingerprint. */
  planFingerprint: string;
  entries: MigrationPlanEntryV1[];
}

const PLAN_STORE_SCHEMA_VERSION = 1;
/** Mirrors `generationStore.ts`'s own `MAX_METADATA_ARTIFACT_BYTES` bound for a note-count-bounded JSON list. */
const MAX_PLAN_BYTES = 16 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MODEL_LENGTH = 200;
const BASE_GENERATION_STATES: readonly MigrationBaseGenerationState[] = ["none", "verified", "unverifiable"];

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "runId must be a short, bounded, control-character-free token.");
  }
}

export function migrationPlanFileName(runId: string): string {
  assertValidRunId(runId);
  return `migration/runs/${runId}/plan.json`;
}

export interface PlanFingerprintContext {
  desiredEmbeddingModel: string;
  desiredDimension: number;
  desiredPipelineVersion: number;
}

/**
 * Review item 10: hashes a FIXED-SHAPE JSON object per entry with a fixed
 * key order, never a delimiter-joined string -- a `canonicalPath`
 * containing the delimiter character a naive `join("|")` would use could
 * otherwise let two DIFFERENT entry sets collide onto the same fingerprint
 * (e.g. one entry `"a|b"` vs two entries `"a"`/`"b"`, joined identically).
 * `identity.appleAnnotationId` is always present as `null` (never simply
 * omitted) so the object's key SET is identical across every entry
 * regardless of identity kind -- shape stays fixed either way.
 *
 * Review item 5: `context` (desired model/dimension/pipeline) is hashed
 * IN THE SAME fixed-shape payload as the entries, not merely stored as an
 * adjacent field a caller could compare separately (and forget to, or
 * compare inconsistently) -- a plan/current-generation whose entries are
 * byte-identical but whose desired model/dimension/pipeline differs is
 * ALWAYS a different fingerprint. Every caller (already-up-to-date,
 * pre-build/pre-switch drift checks) uses this exact same formula, so
 * "the note set matches" and "the config matches" can never be checked
 * inconsistently against each other.
 *
 * Review item 4: genuinely ORDER-INDEPENDENT in `entries` -- sorts by
 * stable identity key INTERNALLY (the same canonical order
 * `sortPlanEntries` produces) before hashing, rather than merely
 * documenting that requirement and trusting every caller to pre-sort.
 * Two callers who discovered the identical set in a different enumeration
 * order are therefore GUARANTEED the same fingerprint even if one of them
 * forgot to sort first.
 */
export function computePlanFingerprint(context: PlanFingerprintContext, entries: readonly MigrationPlanEntryV1[]): string {
  const rows = sortPlanEntries(entries).map((entry) => ({
    kind: entry.identity.kind,
    canonicalPath: entry.identity.canonicalPath,
    appleAnnotationId: entry.identity.appleAnnotationId ?? null,
    sourceHash: entry.sourceHash,
    embeddingModel: entry.embeddingModel,
  }));
  const payload = {
    desiredEmbeddingModel: context.desiredEmbeddingModel,
    desiredDimension: context.desiredDimension,
    desiredPipelineVersion: context.desiredPipelineVersion,
    entries: rows,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function sortPlanEntries(entries: readonly MigrationPlanEntryV1[]): MigrationPlanEntryV1[] {
  return [...entries].sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)));
}

function assertBoundedModel(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_MODEL_LENGTH) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", `${field} must be a short, non-empty string.`);
  }
}

function parsePlanEntry(value: unknown, desiredEmbeddingModel: string): MigrationPlanEntryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan entry must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["identity", "sourceHash", "embeddingModel"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan entry has an unrecognized field.");
  }
  const identity = parseNoteIdentityV1(record.identity, "MigrationPlanEntryV1");
  if (typeof record.sourceHash !== "string" || !HEX_64_PATTERN.test(record.sourceHash)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan entry's sourceHash must be a lowercase hex64 hash.");
  }
  assertBoundedModel(record.embeddingModel, "A migration plan entry's embeddingModel");
  // Review item 5: every entry's own embeddingModel must agree with the plan's desiredEmbeddingModel
  // -- a plan can never carry a mixed-model entry set.
  if (record.embeddingModel !== desiredEmbeddingModel) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan entry's embeddingModel does not match the plan's desiredEmbeddingModel.");
  }
  return { identity, sourceHash: record.sourceHash, embeddingModel: record.embeddingModel };
}

export function parseMigrationPlanV1(value: unknown): MigrationPlanV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "runId", "desiredEmbeddingModel", "desiredDimension", "desiredPipelineVersion", "baseGenerationState", "baseGenerationId", "baseGenerationFingerprint", "baseManifestRawFingerprint", "planFingerprint", "entries"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan has an unrecognized field.");
  }
  if (record.schemaVersion !== 1) throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan has an unrecognized schemaVersion.");
  if (typeof record.runId !== "string") throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's runId must be a string.");
  assertValidRunId(record.runId);
  assertBoundedModel(record.desiredEmbeddingModel, "A migration plan's desiredEmbeddingModel");
  if (typeof record.desiredDimension !== "number" || !Number.isInteger(record.desiredDimension) || record.desiredDimension < 1 || record.desiredDimension > MAX_EMBEDDING_DIMENSION) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", `A migration plan's desiredDimension must be an integer in [1, ${MAX_EMBEDDING_DIMENSION}].`);
  }
  if (typeof record.desiredPipelineVersion !== "number" || !Number.isInteger(record.desiredPipelineVersion) || record.desiredPipelineVersion < 0) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's desiredPipelineVersion must be a non-negative integer.");
  }
  if (typeof record.baseGenerationState !== "string" || !BASE_GENERATION_STATES.includes(record.baseGenerationState as MigrationBaseGenerationState)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's baseGenerationState must be a recognized state.");
  }
  const baseGenerationState = record.baseGenerationState as MigrationBaseGenerationState;
  if (record.baseGenerationId !== undefined && (typeof record.baseGenerationId !== "number" || !Number.isInteger(record.baseGenerationId) || record.baseGenerationId < 0)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's baseGenerationId must be a non-negative integer.");
  }
  if (record.baseGenerationFingerprint !== undefined && (typeof record.baseGenerationFingerprint !== "string" || !HEX_64_PATTERN.test(record.baseGenerationFingerprint))) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's baseGenerationFingerprint must be a lowercase hex64 fingerprint.");
  }
  if (record.baseManifestRawFingerprint !== undefined && (typeof record.baseManifestRawFingerprint !== "string" || !HEX_64_PATTERN.test(record.baseManifestRawFingerprint))) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's baseManifestRawFingerprint must be a lowercase hex64 fingerprint.");
  }
  // Cross-field: the state determines which snapshot fields are meaningful -- never let a tampered
  // document claim "none" while still carrying a base id, or "verified" without a real fingerprint.
  if (baseGenerationState === "none" && (record.baseGenerationId !== undefined || record.baseGenerationFingerprint !== undefined || record.baseManifestRawFingerprint !== undefined)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", 'A migration plan with baseGenerationState "none" must carry no base snapshot fields.');
  }
  if (baseGenerationState === "verified" && (record.baseGenerationId === undefined || record.baseGenerationFingerprint === undefined)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", 'A migration plan with baseGenerationState "verified" must carry both baseGenerationId and baseGenerationFingerprint.');
  }
  if (baseGenerationState === "unverifiable" && (record.baseGenerationId === undefined || record.baseManifestRawFingerprint === undefined)) {
    // Review item 4: "unverifiable" must ALWAYS carry a raw fingerprint -- id-alone acceptance is
    // exactly the gap being closed here. A snapshot that could not even be raw-fingerprinted at
    // capture time must never have been persisted as "unverifiable" in the first place (the caller
    // fails closed instead -- see `MigrationRunner.captureBaseGenerationSnapshot`).
    throw new EngineError("MIGRATION_PLAN_CORRUPT", 'A migration plan with baseGenerationState "unverifiable" must carry both baseGenerationId and baseManifestRawFingerprint.');
  }
  if (typeof record.planFingerprint !== "string" || !HEX_64_PATTERN.test(record.planFingerprint)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's planFingerprint must be a lowercase hex64 fingerprint.");
  }
  if (!Array.isArray(record.entries)) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's entries must be an array.");
  }
  if (record.entries.length > MAX_MANIFEST_NOTE_COUNT) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", `A migration plan's entries exceed the approved ceiling of ${MAX_MANIFEST_NOTE_COUNT}.`);
  }
  const entries = record.entries.map((entry) => parsePlanEntry(entry, record.desiredEmbeddingModel as string));
  const seen = new Set<string>();
  let previousKey: string | undefined;
  for (const entry of entries) {
    const key = identityKey(entry.identity);
    if (seen.has(key)) {
      throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's entries contain a duplicate identity.");
    }
    seen.add(key);
    if (previousKey !== undefined && key.localeCompare(previousKey) < 0) {
      throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's entries must be in canonical sorted order.");
    }
    previousKey = key;
  }
  const context: PlanFingerprintContext = { desiredEmbeddingModel: record.desiredEmbeddingModel, desiredDimension: record.desiredDimension, desiredPipelineVersion: record.desiredPipelineVersion };
  if (computePlanFingerprint(context, entries) !== record.planFingerprint) {
    throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan's planFingerprint does not match its own context+entries.");
  }
  return {
    schemaVersion: 1,
    runId: record.runId,
    desiredEmbeddingModel: record.desiredEmbeddingModel,
    desiredDimension: record.desiredDimension,
    desiredPipelineVersion: record.desiredPipelineVersion,
    baseGenerationState,
    baseGenerationId: record.baseGenerationId,
    baseGenerationFingerprint: record.baseGenerationFingerprint,
    baseManifestRawFingerprint: record.baseManifestRawFingerprint,
    planFingerprint: record.planFingerprint,
    entries,
  };
}

export interface BuildMigrationPlanInput {
  runId: string;
  desiredEmbeddingModel: string;
  desiredDimension: number;
  desiredPipelineVersion: number;
  baseGenerationState: MigrationBaseGenerationState;
  baseGenerationId?: number;
  baseGenerationFingerprint?: string;
  baseManifestRawFingerprint?: string;
  entries: readonly MigrationPlanEntryV1[];
}

export function buildMigrationPlanV1(input: BuildMigrationPlanInput): MigrationPlanV1 {
  const entries = sortPlanEntries(input.entries);
  for (const entry of entries) {
    if (entry.embeddingModel !== input.desiredEmbeddingModel) {
      throw new EngineError("MIGRATION_PLAN_CORRUPT", "A migration plan entry's embeddingModel does not match the plan's desiredEmbeddingModel.");
    }
  }
  const context: PlanFingerprintContext = { desiredEmbeddingModel: input.desiredEmbeddingModel, desiredDimension: input.desiredDimension, desiredPipelineVersion: input.desiredPipelineVersion };
  return {
    schemaVersion: 1,
    runId: input.runId,
    desiredEmbeddingModel: input.desiredEmbeddingModel,
    desiredDimension: input.desiredDimension,
    desiredPipelineVersion: input.desiredPipelineVersion,
    baseGenerationState: input.baseGenerationState,
    baseGenerationId: input.baseGenerationId,
    baseGenerationFingerprint: input.baseGenerationFingerprint,
    baseManifestRawFingerprint: input.baseManifestRawFingerprint,
    planFingerprint: computePlanFingerprint(context, entries),
    entries,
  };
}

export class MigrationPlanStore {
  private readonly store: AtomicStore<MigrationPlanV1>;

  constructor(fs: AtomicStoreFs, root: string, runId: string) {
    this.store = new AtomicStore<MigrationPlanV1>({
      fs,
      root,
      fileName: migrationPlanFileName(runId),
      schemaVersion: PLAN_STORE_SCHEMA_VERSION,
      parse: parseMigrationPlanV1,
      maxBytes: MAX_PLAN_BYTES,
    });
  }

  load(): Promise<MigrationPlanV1 | null> {
    return this.store.load();
  }

  save(plan: MigrationPlanV1): Promise<void> {
    return this.store.save(plan);
  }
}

/**
 * Review item 1: deletes `migration/runs/<runId>/plan.json` (and the
 * now-empty directory, if it is) and reports whether the file ends up
 * GENUINELY ABSENT -- used only after a run's staging/plan is safely
 * retired. Never throws on a missing file. The caller
 * (`MigrationRunner.retryCleanup`) must only ever call this AFTER
 * `clearStaging` has itself reported success -- clearing the plan first
 * would orphan any leftover staging files with nothing left to identify
 * them as belonging to a specific (still-being-cleaned-up) run.
 */
export async function clearMigrationPlan(fs: IndexFs, root: string, runId: string): Promise<boolean> {
  const filePath = joinRelative(root, migrationPlanFileName(runId));
  try {
    await fs.unlink(filePath);
  } catch {
    const stillExists = await fs.exists(filePath).catch(() => true);
    if (stillExists) return false;
  }
  try {
    await fs.rmdir(joinRelative(root, `migration/runs/${runId}`));
  } catch {
    // non-empty or already gone -- both benign; the file itself is confirmed gone either way.
  }
  return true;
}

/** Every runId with an on-disk `migration/runs/<runId>/` directory -- foreign (non-runId-shaped) entries under `migration/runs/` are ignored, never reported or touched (review item 14: "never touch foreign entries"). */
export async function listMigrationRunIds(fs: IndexFs, root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(joinRelative(root, "migration/runs"));
  } catch {
    return [];
  }
  return entries.filter((entry) => RUN_ID_PATTERN.test(entry));
}
