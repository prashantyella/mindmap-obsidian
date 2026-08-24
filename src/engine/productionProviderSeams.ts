import type { EmbeddingProvider } from "./embeddingProvider";
import { EngineError } from "./errors";
import { MAX_EMBEDDING_DIMENSION } from "./embeddingLimits";
import { chunkText } from "./chunker";
import type { MetadataInferenceProvider } from "./metadataPipeline";
import { runMetadataPipeline, type MetadataPipelineConfig } from "./metadataPipeline";
import type { EmbeddedNote, NoteEmbeddingSeam, NoteMetadataSeam } from "../jobs/noteJob";
import type { SourceProjectionV1 } from "./contracts";
import { isUnitNorm } from "./vectorValidation";

/** Mirrors `noteJob.ts`'s own private `isFiniteVectorLike` (duplicated rather than shared -- a dense, non-sparse, finite-number vector shape check small enough that each caller owning its own copy costs nothing and avoids a cross-module coupling neither side needs). */
function isFiniteVectorLike(value: unknown): value is Float32Array | number[] {
  if (value instanceof Float32Array) return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== "number") return false;
  }
  return true;
}

/**
 * Checkpoint 10A sub-milestone C, item 7: the seam's OWN strict response
 * validation, independent of (and never a substitute for) `NoteJobRunner`'s
 * own downstream `validateEmbeddedNote` re-check -- a caller-supplied
 * provider result gets exactly as little trust here as anywhere else. The
 * bounded batch id set requested (`"note"` plus `"chunk:0"..."chunk:N-1"`)
 * must come back with EXACT cardinality/uniqueness: no missing id, no
 * duplicate id, no extra/unrecognized id silently ignored -- a provider
 * that returns the right id set plus a stray extra entry (a bug, or a
 * response mixed up across a concurrent request) fails closed here rather
 * than quietly succeeding on the subset this code happens to look up.
 */
function assertExactIdSet(requestedIds: readonly string[], responseItems: readonly { id: string }[]): void {
  if (responseItems.length !== requestedIds.length) {
    throw new EngineError("EMBEDDING_COUNT_MISMATCH", "Embedding provider returned a different number of items than requested.", {
      requested: requestedIds.length,
      received: responseItems.length,
    });
  }
  const seen = new Set<string>();
  for (const item of responseItems) {
    if (seen.has(item.id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider returned a duplicate item id.");
    }
    seen.add(item.id);
  }
  const requested = new Set(requestedIds);
  for (const id of seen) {
    if (!requested.has(id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider returned an id that was never requested.");
    }
  }
  for (const id of requested) {
    if (!seen.has(id)) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Embedding provider did not return every requested item.");
    }
  }
}

/** Every returned vector must be a dense, unit-norm array/`Float32Array` of exactly `dimension` values -- checked here (not just downstream in `NoteJobRunner.validateEmbeddedNote`) so a malformed provider result never even reaches this seam's own return value. */
function assertDenseUnitVector(values: unknown, dimension: number): asserts values is Float32Array | number[] {
  if (!isFiniteVectorLike(values) || values.length !== dimension) {
    throw new EngineError("EMBEDDING_DIMENSION_MISMATCH", "Embedding provider returned a vector of the wrong dimension.");
  }
  if (!isUnitNorm(values)) {
    throw new EngineError("EMBEDDING_VECTOR_INVALID", "Embedding provider returned a non-unit-length vector.");
  }
}

/**
 * Production `NoteEmbeddingSeam`: embeds the note's own projected body PLUS
 * every one of its chunks in ONE `embedBatch` call, keyed by caller-
 * assigned correlation ids (`"note"` / `"chunk:<index>"`) so the result is
 * never reassembled by array position alone.
 *
 * Item 7: `chunkOptions` (target/overlap tokens) is a REQUIRED, caller-
 * configured argument -- never a hardcoded production default baked into
 * this seam. Neither the note's own text nor any chunk's text is ever
 * truncated here: `OllamaEmbeddingProvider` already performs its own
 * bounded sub-batching (by item count AND summed character length) and
 * fails closed (`EMBEDDING_BATCH_INVALID`) if a single item's text alone
 * exceeds its configured per-request character bound -- pre-truncating
 * text in this seam would silently drop source content BEFORE that
 * provider-level bound ever got a chance to reject it outright, exactly
 * the "silent truncation" failure mode this item closes.
 */
export function createProductionNoteEmbeddingSeam(provider: EmbeddingProvider, embeddingModel: string, chunkOptions: { targetTokens: number; overlapTokens: number }): NoteEmbeddingSeam {
  return {
    async embed(projection: SourceProjectionV1, signal: AbortSignal): Promise<EmbeddedNote> {
      const chunks = chunkText(projection.projectedBody, chunkOptions);
      const requestedIds = ["note", ...chunks.map((_chunk, index) => `chunk:${index}`)];
      const items = [{ id: "note", text: projection.projectedBody }, ...chunks.map((chunk, index) => ({ id: `chunk:${index}`, text: chunk }))];
      const batch = await provider.embedBatch({ model: embeddingModel, items }, { signal });

      if (batch.model !== embeddingModel) {
        throw new EngineError("EMBEDDING_MODEL_MISMATCH", "Embedding provider responded with a different model than requested.");
      }
      if (!Number.isInteger(batch.dimension) || batch.dimension <= 0 || batch.dimension > MAX_EMBEDDING_DIMENSION) {
        throw new EngineError("EMBEDDING_DIMENSION_INVALID", "Embedding provider responded with an invalid dimension.");
      }
      assertExactIdSet(requestedIds, batch.items);

      const byId = new Map(batch.items.map((item) => [item.id, item.values] as const));
      const noteValues = byId.get("note");
      assertDenseUnitVector(noteValues, batch.dimension);
      const chunkVectors: Float32Array[] = chunks.map((_chunk, index) => {
        const values = byId.get(`chunk:${index}`);
        assertDenseUnitVector(values, batch.dimension);
        return Float32Array.from(values);
      });
      return { model: batch.model, dimension: batch.dimension, noteVector: Float32Array.from(noteValues), chunkVectors };
    },
  };
}

/**
 * Production `NoteMetadataSeam`: runs the existing `runMetadataPipeline`
 * coordinator against the note's projected body, UNTRUNCATED (item 7:
 * "metadata seam must also not silently truncate") -- `runMetadataPipeline`
 * already fails closed with `METADATA_PROMPT_TOO_LARGE` against its own
 * configured bound when the note text itself is oversized; pre-slicing the
 * text here would silently swallow the overflow instead of ever letting
 * that check run.
 *
 * `related` is passed as an empty array -- Checkpoint 10A's per-note
 * ingestion step runs BEFORE any index exists to query related candidates
 * from (migration builds the index as it goes), so there is nothing
 * genuine to select yet; this mirrors `NoteJobDeps.buildRelatedLinks`
 * staying unwired this checkpoint (see `productionEngine.ts`'s own doc
 * comment) rather than fabricating a related list. A later checkpoint that
 * runs ordinary (non-migration) note processing against an already-built
 * index is expected to supply a real `relatedSelector.ts`-backed related
 * list instead.
 */
export function createProductionNoteMetadataSeam(provider: MetadataInferenceProvider, config: MetadataPipelineConfig): NoteMetadataSeam {
  return {
    async extract(projection: SourceProjectionV1, signal: AbortSignal) {
      return runMetadataPipeline(provider, config, { identity: projection.identity, text: projection.projectedBody, related: [] }, { signal });
    },
  };
}
