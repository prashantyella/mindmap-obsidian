import { canonicalizePath, type CanonicalPath } from "../engine/contracts";
import { isApproximatelyUnitNorm, rowL2Norm, type VectorMatrix } from "./vectorCodec";
import type { ChunkShardNoteOffset, ScoredNote } from "./vectorTypes";

/**
 * Pure, deterministic exact-search core: L2 normalization, cosine scoring
 * (a plain dot product once both sides are normalized), exact note-level
 * ranking over the full note matrix, and bounded chunk-level refinement
 * over only the rows belonging to a note-level candidate set. No native
 * addon, WASM, or approximate-nearest-neighbor dependency -- this is the
 * "deterministic two-tier exact index" the design calls for, sized for the
 * documented target scale (10,000 notes / 100,000 chunks / 1,024
 * dimensions), not a general-purpose ANN engine.
 */

export class CosineIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CosineIndexError";
  }
}

/** Hard ceiling on `limit` for both note ranking and chunk refinement -- a caller-supplied limit is always bounded, never allowed to force scanning/sorting an unbounded result set. */
export const MAX_RANKING_LIMIT = 1000;

export function l2Norm(vector: Float32Array): number {
  return rowL2Norm(vector, 0, vector.length);
}

/**
 * Returns a new L2-normalized copy of `vector`. Throws `CosineIndexError`
 * for a zero (or non-finite) vector -- a zero vector has no direction, so
 * "normalize" is undefined, and silently returning it unchanged would let
 * a degenerate embedding silently score a spurious 0 (or NaN) similarity
 * against everything instead of failing closed at the point the bad
 * vector was about to enter the index/query path.
 */
export function normalizeVector(vector: Float32Array): Float32Array {
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new CosineIndexError(`vector component at index ${i} is not finite.`);
    }
  }
  const norm = l2Norm(vector);
  if (!(norm > 0)) {
    throw new CosineIndexError("cannot normalize a zero-norm vector.");
  }
  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = vector[i] / norm;
  }
  return normalized;
}

/** Dot product of two equal-length vectors -- the cosine similarity of two ALREADY-normalized vectors. Callers that haven't normalized their inputs should go through `normalizeVector` first; this function itself does no normalization (it is the inner scoring primitive both note ranking and chunk refinement share). */
export function dotProduct(a: Float32Array, b: Float32Array, aOffset = 0, bOffset = 0, length = a.length): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    sum += a[aOffset + i] * b[bOffset + i];
  }
  return sum;
}

function assertBoundedLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RANKING_LIMIT) {
    throw new CosineIndexError(`limit must be an integer in (0, ${MAX_RANKING_LIMIT}].`);
  }
}

/**
 * Validates a `VectorMatrix` a caller may have constructed directly
 * (rather than via `decodeVectorMatrix`, which already guarantees this and
 * whose rows are trusted-normalized by construction). `dimension` and
 * `count` are checked to be positive/non-negative integers FIRST, before
 * they are ever multiplied together -- a non-integer or negative field
 * (e.g. a malformed `dimension: -1` paired with a `count` that happens to
 * make `count * dimension` collide with `data.length` by coincidence)
 * could otherwise slip past a shape check that only compares the product.
 * Only then is `data.length` checked against the now-validated `count *
 * dimension`, so a mismatched matrix can never be silently read out of
 * bounds or under-read.
 */
function assertValidMatrixShape(matrix: VectorMatrix, label: string): void {
  if (!Number.isInteger(matrix.dimension) || matrix.dimension <= 0) {
    throw new CosineIndexError(`${label}.dimension must be a positive integer, got ${matrix.dimension}.`);
  }
  if (!Number.isInteger(matrix.count) || matrix.count < 0) {
    throw new CosineIndexError(`${label}.count must be a non-negative integer, got ${matrix.count}.`);
  }
  if (matrix.data.length !== matrix.count * matrix.dimension) {
    throw new CosineIndexError(
      `${label}: data length (${matrix.data.length}) does not match count * dimension (${matrix.count * matrix.dimension}).`,
    );
  }
}

/**
 * Validates that `id` is a well-formed, already-canonical path. Wraps
 * `canonicalizePath` so a malformed input (e.g. containing a control
 * character, or an absolute/traversing path) that would make
 * `canonicalizePath` itself THROW is converted into a `CosineIndexError`
 * just like the "recomputes to a different string" case, rather than
 * leaking an unrelated `EngineError` out of this module.
 */
function assertCanonicalId(id: CanonicalPath, field: string): void {
  let recanonicalized: string;
  try {
    recanonicalized = canonicalizePath(id);
  } catch (error) {
    throw new CosineIndexError(`${field} "${id}" is not a valid canonical path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (recanonicalized !== id) {
    throw new CosineIndexError(`${field} "${id}" is not in canonical form.`);
  }
}

/** Validates that `vector` is entirely finite and approximately unit-norm (same tolerance the codec enforces on stored rows) -- a query vector that isn't normalized would silently skew every cosine score against it. */
function assertNormalizedFiniteVector(vector: Float32Array, label: string): void {
  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      throw new CosineIndexError(`${label} component at index ${i} is not finite.`);
    }
  }
  const norm = rowL2Norm(vector, 0, vector.length);
  if (!isApproximatelyUnitNorm(norm)) {
    throw new CosineIndexError(`${label} has norm ${norm}, which is not approximately unit-norm.`);
  }
}

/** Deterministic tie-break: higher score first; on an exact score tie, ascending canonical path -- stable and reproducible across runs/machines, never dependent on original array/insertion order. */
function compareScored(a: ScoredNote, b: ScoredNote): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

export interface RankNotesOptions {
  /** Must already be L2-normalized (see `normalizeVector`); this function does not renormalize it, so it can be called once per query rather than once per candidate row. */
  queryVector: Float32Array;
  /** `kind` must be `"note"`; each row is assumed already L2-normalized (as every row this codec/index ever writes is). */
  matrix: VectorMatrix;
  /** Parallel to `matrix`'s rows: `ids[i]` is the canonical path of the note in row `i`. Must be unique and every entry must already be in canonical form. */
  ids: readonly CanonicalPath[];
  /** Excluded from the results entirely -- typically the querying note's own path, so a note never appears as "related to itself." */
  excludePath?: CanonicalPath;
  limit: number;
}

/**
 * Exact cosine ranking over the full note matrix: computes every row's
 * similarity to `queryVector`, excludes `excludePath`, drops any
 * non-finite score, sorts by `compareScored` (descending score, then
 * ascending path), and returns at most `limit` results. `O(notes *
 * dimension)` -- exact, not approximate, and expected to comfortably meet
 * the design's query-latency budget at the documented target scale.
 */
export function rankNotes(options: RankNotesOptions): ScoredNote[] {
  const { queryVector, matrix, ids, excludePath, limit } = options;
  if (matrix.kind !== "note") {
    throw new CosineIndexError(`rankNotes requires a "note" matrix, got "${matrix.kind}".`);
  }
  assertValidMatrixShape(matrix, "rankNotes matrix");
  if (ids.length !== matrix.count) {
    throw new CosineIndexError(`ids length (${ids.length}) does not match matrix.count (${matrix.count}).`);
  }
  if (queryVector.length !== matrix.dimension) {
    throw new CosineIndexError(`queryVector dimension (${queryVector.length}) does not match matrix.dimension (${matrix.dimension}).`);
  }
  assertNormalizedFiniteVector(queryVector, "queryVector");
  assertBoundedLimit(limit);

  const seenIds = new Set<CanonicalPath>();
  for (const id of ids) {
    assertCanonicalId(id, "ids entry");
    if (seenIds.has(id)) {
      throw new CosineIndexError(`ids contains a duplicate runtime id: "${id}".`);
    }
    seenIds.add(id);
  }

  const scored: ScoredNote[] = [];
  for (let row = 0; row < matrix.count; row += 1) {
    const path = ids[row];
    if (excludePath !== undefined && path === excludePath) continue;
    const score = dotProduct(queryVector, matrix.data, 0, row * matrix.dimension, matrix.dimension);
    if (!Number.isFinite(score)) continue;
    scored.push({ path, score });
  }
  scored.sort(compareScored);
  return scored.slice(0, limit);
}

export interface RefineWithChunksOptions {
  /** The query's own chunk vectors (already L2-normalized), e.g. a note's own chunk embeddings for note-to-note related search, or a single-element array for a plain text query. Every candidate's refined score is the MAX cosine similarity across all (query chunk, candidate chunk) pairs -- mirrors `related_from_chunks`'s `score > scores[path]` max-aggregation in python/mindmap.py, ported behaviorally rather than line-by-line for the new bounded-candidate two-tier shape. */
  queryChunkVectors: readonly Float32Array[];
  /** The bounded note-level candidate set (typically `rankNotes`'s own output) -- refinement is scoped to EXACTLY these notes and can never surface a note outside this set, even if some other note's chunks would score higher. Candidate paths must be unique and every candidate score must be finite. */
  candidates: readonly ScoredNote[];
  /** `kind` must be `"chunk"`. */
  chunkMatrix: VectorMatrix;
  /** Per-note contiguous row ranges into `chunkMatrix` -- only rows within a listed candidate's own range are ever read. A note with no entry here (no chunks) simply cannot be refined and is dropped from the output. Every entry's range must be non-negative, non-zero-length, in-bounds, non-overlapping with every other entry, and have a unique note identity. */
  noteOffsets: readonly ChunkShardNoteOffset[];
  limit: number;
}

/**
 * Bounded chunk-level refinement: for each note in `candidates` (and ONLY
 * those notes -- `noteOffsets` entries for any other note are never
 * consulted), scores every one of its chunk rows against every query chunk
 * vector and keeps the maximum. Re-sorts the refined scores with the same
 * deterministic tie-break `rankNotes` uses and returns at most `limit`
 * results. Cost is bounded by the candidate set's total chunk count, not
 * the whole shard.
 */
export function refineWithChunks(options: RefineWithChunksOptions): ScoredNote[] {
  const { queryChunkVectors, candidates, chunkMatrix, noteOffsets, limit } = options;
  if (chunkMatrix.kind !== "chunk") {
    throw new CosineIndexError(`refineWithChunks requires a "chunk" matrix, got "${chunkMatrix.kind}".`);
  }
  assertValidMatrixShape(chunkMatrix, "refineWithChunks chunkMatrix");
  if (queryChunkVectors.length === 0) {
    throw new CosineIndexError("queryChunkVectors must contain at least one vector.");
  }
  for (const [index, vector] of queryChunkVectors.entries()) {
    if (vector.length !== chunkMatrix.dimension) {
      throw new CosineIndexError(`queryChunkVectors[${index}] dimension (${vector.length}) does not match chunkMatrix.dimension (${chunkMatrix.dimension}).`);
    }
    assertNormalizedFiniteVector(vector, `queryChunkVectors[${index}]`);
  }
  assertBoundedLimit(limit);

  // Validate ALL note offsets up front -- bounds, non-overlap, and identity uniqueness are
  // structural invariants of the shard itself, not something that only matters for the notes
  // that happen to be candidates this call.
  const offsetsByPath = new Map<CanonicalPath, ChunkShardNoteOffset>();
  const sortedForOverlapCheck: ChunkShardNoteOffset[] = [];
  for (const offset of noteOffsets) {
    const path = offset.identity.canonicalPath;
    assertCanonicalId(path, "noteOffsets entry identity.canonicalPath");
    if (offsetsByPath.has(path)) {
      throw new CosineIndexError(`noteOffsets has a duplicate identity for "${path}".`);
    }
    if (!Number.isInteger(offset.start) || !Number.isInteger(offset.length)) {
      throw new CosineIndexError(`noteOffset for "${path}" must have integer start/length, got start=${offset.start}, length=${offset.length}.`);
    }
    if (offset.start < 0 || offset.length <= 0 || offset.start + offset.length > chunkMatrix.count) {
      throw new CosineIndexError(`noteOffset for "${path}" is out of bounds for the given chunkMatrix.`);
    }
    offsetsByPath.set(path, offset);
    sortedForOverlapCheck.push(offset);
  }
  sortedForOverlapCheck.sort((a, b) => a.start - b.start);
  for (let i = 1; i < sortedForOverlapCheck.length; i += 1) {
    const previous = sortedForOverlapCheck[i - 1];
    const current = sortedForOverlapCheck[i];
    if (current.start < previous.start + previous.length) {
      throw new CosineIndexError(
        `noteOffsets has overlapping ranges: "${previous.identity.canonicalPath}" and "${current.identity.canonicalPath}".`,
      );
    }
  }

  const seenCandidatePaths = new Set<CanonicalPath>();
  for (const candidate of candidates) {
    assertCanonicalId(candidate.path, "candidates entry path");
    if (seenCandidatePaths.has(candidate.path)) {
      throw new CosineIndexError(`candidates has a duplicate path: "${candidate.path}".`);
    }
    seenCandidatePaths.add(candidate.path);
    if (!Number.isFinite(candidate.score)) {
      throw new CosineIndexError(`candidate score for "${candidate.path}" is not finite.`);
    }
  }

  const refined: ScoredNote[] = [];
  for (const candidate of candidates) {
    const offset = offsetsByPath.get(candidate.path);
    if (!offset) continue; // no chunks indexed for this note -- cannot be refined, dropped from output
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let row = offset.start; row < offset.start + offset.length; row += 1) {
      for (const queryVector of queryChunkVectors) {
        const score = dotProduct(queryVector, chunkMatrix.data, 0, row * chunkMatrix.dimension, chunkMatrix.dimension);
        if (Number.isFinite(score) && score > bestScore) {
          bestScore = score;
        }
      }
    }
    if (Number.isFinite(bestScore)) {
      refined.push({ path: candidate.path, score: bestScore });
    }
  }
  refined.sort(compareScored);
  return refined.slice(0, limit);
}
