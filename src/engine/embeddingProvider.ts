import type { EmbeddingVectorV1, NoteIdentityV1 } from "./contracts";
import { parseEmbeddingVectorV1 } from "./contracts";
import { MAX_EMBEDDING_DIMENSION } from "./embeddingLimits";
import { validateUnitVector } from "./vectorValidation";

/**
 * Provider-neutral embedding seam: independent of Obsidian, of any specific
 * inference backend, of index persistence/`VectorStore`, and of note writes.
 * `OllamaEmbeddingProvider` is the only concrete implementation for 0.3.0 --
 * no remote embedding provider exists or is configured -- but callers depend
 * on this interface only, never on the Ollama adapter directly.
 */
export interface EmbeddingRequestItem {
  /**
   * Caller-assigned correlation id (e.g. a chunk's `"path#index"` key),
   * opaque to the provider. Echoed back unchanged on the matching result so
   * callers never rely on array position alone to recover which input a
   * vector belongs to, even across an internally sub-batched request.
   */
  id: string;
  text: string;
}

export interface EmbeddingResultItem {
  id: string;
  /** L2-normalized (unit-length) values, ready for exact cosine ranking. */
  values: number[];
}

export interface EmbeddingBatchRequest {
  model: string;
  items: EmbeddingRequestItem[];
}

export interface EmbeddingBatchResult {
  model: string;
  dimension: number;
  items: EmbeddingResultItem[];
}

export interface EmbeddingProviderCallOptions {
  signal?: AbortSignal;
}

export interface EmbeddingProvider {
  embedBatch(request: EmbeddingBatchRequest, options?: EmbeddingProviderCallOptions): Promise<EmbeddingBatchResult>;
}

/**
 * Builds and strictly validates an `EmbeddingVectorV1` for one note identity
 * from a provider result item. Never called by the provider itself --
 * assembling per-note/per-chunk contract records from raw batch results is
 * a caller concern, not part of the embedding seam.
 *
 * `values` is independently re-verified with `validateUnitVector` before
 * `parseEmbeddingVectorV1` ever runs: `parseEmbeddingVectorV1`'s own
 * contract-shape check only confirms "an array of finite numbers of the
 * declared length", not dimension bound or unit-norm, so a caller cannot
 * construct an oversized, zero/non-finite, or non-unit-length
 * `EmbeddingVectorV1` just because the value happens to type-check.
 */
export function buildEmbeddingVectorV1(identity: NoteIdentityV1, model: string, values: readonly number[]): EmbeddingVectorV1 {
  validateUnitVector(values, MAX_EMBEDDING_DIMENSION, "CONTRACT_SHAPE_INVALID");
  return parseEmbeddingVectorV1({
    schemaVersion: 1,
    identity,
    model,
    dimension: values.length,
    values: [...values],
  });
}
