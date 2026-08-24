import type { NoteIdentityV1, SourceProjectionV1 } from "../engine/contracts";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { isUnitNorm } from "../engine/vectorValidation";
import { projectSource } from "../engine/sourceProjection";
import { noteIdentityStableKey, toFailureCode } from "../jobs/jobTypes";
import type { EmbeddedNote, NoteEmbeddingSeam } from "../jobs/noteJob";
import type { IndexFs } from "../index/indexFs";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "../index/indexManifest";
import { writeStagedNote } from "./migrationStaging";
import type { MigrationPlanEntryV1 } from "./migrationPlan";

/**
 * Checkpoint 10A sub-milestone B, item 1: the vault-read half of migration
 * ingestion. Deliberately narrower than `NoteJobRunner`'s own
 * `NoteSourceReader` (which this module never imports -- migration
 * ingestion is a completely separate path from ordinary `"process-note"`
 * jobs): resolution is BY STABLE IDENTITY, `signal`-aware, and returns
 * `null` for "no longer resolves to anything" rather than throwing.
 */
export interface MigrationSourceReader {
  read(identity: NoteIdentityV1, signal: AbortSignal): Promise<{ identity: NoteIdentityV1; rawContent: string } | null>;
}

export interface MigrationIngestionDeps {
  sourceReader: MigrationSourceReader;
  /** Ollama-only in production (`createProductionNoteEmbeddingSeam` from `productionProviderSeams.ts`, backed by `OllamaEmbeddingProvider`) -- reused as-is; migration never talks to a metadata provider, `NoteWriter`, `JobEngine`, or `IndexStore` overlays. */
  embedding: NoteEmbeddingSeam;
}

export type PrepareIngestOutcome =
  /** Resolved, projected, embedded, and strictly validated -- NOTHING has been written to disk yet. `embedded.chunkVectors.length` is now known, so a caller can budget-check before ever calling `commitStagedNote`. */
  | { type: "prepared"; embedded: EmbeddedNote }
  /** The source no longer resolves, resolved to an unrelated stable identity, or its current sourceHash no longer matches the plan -- the caller must treat this as plan drift and replan, never patch just this one entry. */
  | { type: "drift" }
  | { type: "failed"; failureCode: string };

export type MigrationIngestOutcome = { type: "staged" } | { type: "drift" } | { type: "failed"; failureCode: string };

function isFiniteVectorLike(value: unknown): value is Float32Array | number[] {
  if (value instanceof Float32Array) return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== "number") return false;
  }
  return true;
}

/**
 * Mirrors `noteJob.ts`'s own `validateEmbeddedNote` (duplicated rather than
 * imported/exported -- migration deliberately never depends on `src/jobs`'
 * job-runner internals, only its small pure helpers like
 * `noteIdentityStableKey`/`toFailureCode`): the embedding seam's result is
 * caller-supplied and gets exactly as little trust as any other external
 * input BEFORE it is ever staged.
 */
function validateEmbeddedNote(embedded: unknown, expectedModel: string, desiredDimension: number | undefined): string | null {
  if (typeof embedded !== "object" || embedded === null || Array.isArray(embedded)) return "EMBEDDING_VECTOR_INVALID";
  const record = embedded as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model !== expectedModel) return "EMBEDDING_MODEL_MISMATCH";
  if (typeof record.dimension !== "number" || !Number.isInteger(record.dimension) || record.dimension <= 0 || record.dimension > MAX_EMBEDDING_DIMENSION) {
    return "EMBEDDING_DIMENSION_INVALID";
  }
  if (desiredDimension !== undefined && record.dimension !== desiredDimension) return "EMBEDDING_DIMENSION_MISMATCH";
  const dimension = record.dimension;
  if (!isFiniteVectorLike(record.noteVector) || record.noteVector.length !== dimension) return "EMBEDDING_DIMENSION_MISMATCH";
  if (!isUnitNorm(record.noteVector)) return "EMBEDDING_VECTOR_INVALID";
  if (!Array.isArray(record.chunkVectors) || record.chunkVectors.length > MAX_MANIFEST_SHARD_ROW_COUNT) return "EMBEDDING_COUNT_MISMATCH";
  for (const chunk of record.chunkVectors) {
    if (!isFiniteVectorLike(chunk) || chunk.length !== dimension) return "EMBEDDING_DIMENSION_MISMATCH";
    if (!isUnitNorm(chunk)) return "EMBEDDING_VECTOR_INVALID";
  }
  return null;
}

/**
 * Review item 2: the PREPARE half of ingesting one plan entry -- resolve ->
 * project -> verify sourceHash/identity against the plan -> embed (Ollama
 * only) -> strictly validate. Deliberately never writes anything to disk:
 * splitting this from `commitStagedNote` is what lets a caller (
 * `MigrationRunner.reconcileBuild`) budget-check the REAL, now-known
 * `embedded.chunkVectors.length` BEFORE the entry is ever staged, so an
 * entry that would cross the approved disk/rebuild-peak budget is never
 * written in the first place -- not written-then-detected-then-orphaned.
 */
export async function prepareIngestEntry(deps: MigrationIngestionDeps, entry: MigrationPlanEntryV1, desiredDimension: number | undefined, signal: AbortSignal): Promise<PrepareIngestOutcome> {
  let found: { identity: NoteIdentityV1; rawContent: string } | null;
  try {
    found = await deps.sourceReader.read(entry.identity, signal);
  } catch (error) {
    return { type: "failed", failureCode: toFailureCode(error) };
  }
  if (!found) return { type: "drift" };
  if (noteIdentityStableKey(found.identity) !== noteIdentityStableKey(entry.identity)) return { type: "drift" };

  let projection: SourceProjectionV1;
  try {
    projection = projectSource(found.identity, found.rawContent);
  } catch (error) {
    return { type: "failed", failureCode: toFailureCode(error) };
  }
  if (projection.sourceHash !== entry.sourceHash) return { type: "drift" };

  let embedded: EmbeddedNote;
  try {
    embedded = await deps.embedding.embed(projection, signal);
  } catch (error) {
    return { type: "failed", failureCode: toFailureCode(error) };
  }
  const invalidCode = validateEmbeddedNote(embedded, entry.embeddingModel, desiredDimension);
  if (invalidCode) return { type: "failed", failureCode: invalidCode };
  return { type: "prepared", embedded };
}

/** Review item 2: the COMMIT half -- writes an already-prepared, already-validated embedding to staging. Called ONLY after the caller's own budget check has passed; never called at all for an entry that would cross the budget, so that entry's artifacts never touch disk. */
export async function commitStagedNote(fs: IndexFs, dataRoot: string, stagingRunId: string, entry: MigrationPlanEntryV1, embedded: EmbeddedNote): Promise<{ type: "staged" } | { type: "failed"; failureCode: string }> {
  try {
    await writeStagedNote(fs, dataRoot, stagingRunId, {
      identity: entry.identity,
      sourceHash: entry.sourceHash,
      embeddingModel: entry.embeddingModel,
      dimension: embedded.dimension,
      noteVector: embedded.noteVector,
      chunkVectors: embedded.chunkVectors,
    });
  } catch (error) {
    return { type: "failed", failureCode: toFailureCode(error) };
  }
  return { type: "staged" };
}

/**
 * Convenience: prepare then unconditionally commit, exactly the original
 * (pre-item-2) single-call behavior -- kept for callers that have no
 * reason to budget-check between the two steps (none inside this codebase
 * currently; `MigrationRunner` always calls `prepareIngestEntry`/
 * `commitStagedNote` separately so it CAN check in between).
 */
export async function ingestPlanEntry(deps: MigrationIngestionDeps, fs: IndexFs, dataRoot: string, stagingRunId: string, entry: MigrationPlanEntryV1, desiredDimension: number | undefined, signal: AbortSignal): Promise<MigrationIngestOutcome> {
  const prepared = await prepareIngestEntry(deps, entry, desiredDimension, signal);
  if (prepared.type !== "prepared") return prepared;
  return commitStagedNote(fs, dataRoot, stagingRunId, entry, prepared.embedded);
}
