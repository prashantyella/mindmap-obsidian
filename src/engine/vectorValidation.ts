import type { EngineErrorCode } from "./errors";
import { EngineError } from "./errors";

/**
 * Shared, provider-neutral unit-vector checks -- used both by
 * `OllamaEmbeddingProvider.normalizeVector` (verifying its own freshly
 * L2-normalized output) and `embeddingProvider.ts`'s `buildEmbeddingVectorV1`
 * (verifying a value handed in from outside before ever constructing an
 * `EmbeddingVectorV1` contract object from it, rather than trusting a type
 * annotation). Never trusts per-component finiteness alone: the norm is
 * always explicitly recomputed and checked against a documented Float64
 * tolerance, since a per-component check alone cannot catch summation
 * drift, an already-non-unit input, or a subtle scaling bug.
 */
export const UNIT_NORM_TOLERANCE = 1e-6;

/** Accepts any iterable of numbers -- notably including `Float32Array` directly, so callers never need an `Array.from()` copy just to check a vector's norm. */
export function squaredNorm(values: Iterable<number>): number {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  return sum;
}

/** Recomputes the Euclidean norm from scratch (never reuses a caller-supplied magnitude) and checks it is within `tolerance` of 1. Accepts any iterable of numbers (e.g. `Float32Array` or `number[]`) directly -- never requires a copy. */
export function isUnitNorm(values: Iterable<number>, tolerance: number = UNIT_NORM_TOLERANCE): boolean {
  const normSquared = squaredNorm(values);
  if (!Number.isFinite(normSquared)) {
    return false;
  }
  const norm = Math.sqrt(normSquared);
  return Number.isFinite(norm) && Math.abs(norm - 1) <= tolerance;
}

/**
 * Fails closed unless `values` is (at its actual runtime shape, never
 * merely its static type) a dense, non-empty array of finite numbers,
 * bounded by `maxDimension`, whose recomputed norm is unit length within
 * `UNIT_NORM_TOLERANCE`. `null`, a non-array, a sparse array (a hole,
 * distinct from an explicit element), or an array containing a non-number
 * entry is rejected with a structured `EngineError` -- never a raw
 * `TypeError` escaping from indexing/arithmetic on an unexpected shape. A
 * single check any caller constructing an `EmbeddingVectorV1`-shaped value
 * can run before trusting it, regardless of where the value came from.
 */
export function validateUnitVector(values: unknown, maxDimension: number, errorCode: EngineErrorCode): asserts values is number[] {
  if (!Array.isArray(values)) {
    throw new EngineError(errorCode, "Vector must be an array of numbers.");
  }
  if (values.length === 0 || values.length > maxDimension) {
    throw new EngineError(errorCode, "Vector dimension is outside the bounded range.", { dimension: values.length, maxDimension });
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values)) {
      throw new EngineError(errorCode, "Vector must not be sparse.");
    }
    const value: unknown = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EngineError(errorCode, "Vector contains a non-finite or non-number value.");
    }
  }
  if (!isUnitNorm(values)) {
    throw new EngineError(errorCode, "Vector is not unit-length within the documented tolerance.");
  }
}
