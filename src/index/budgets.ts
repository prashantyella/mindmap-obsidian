import { encodedMatrixByteLength } from "./vectorCodec";

/**
 * The design's approved memory/disk budgets, as ONE shared source of
 * truth. These are not benchmark-only aspirations: `indexManifest.ts`
 * enforces them as executable parse-time invariants (a manifest that
 * would require more than the budget to load/query/store is rejected
 * outright, the same way an out-of-range field is), and
 * `benchmark.test.ts` asserts its own byte accounting against the exact
 * same constants and helpers. Both consumers import from here so the
 * parser and the benchmark can never quietly drift apart on what "128MB
 * steady state" means.
 */

export const BUDGET_STEADY_STATE_MEMORY_BYTES = 128 * 1024 * 1024;
export const BUDGET_REBUILD_PEAK_MEMORY_BYTES = 512 * 1024 * 1024;
export const BUDGET_DISK_BYTES = 600 * 1024 * 1024;

/**
 * Conservative, explicit allowance for bookkeeping that rides along with
 * the resident matrices/on-disk files (per-note offset entries, manifest
 * JSON, shard metadata) -- not zero, but bounded and declared rather than
 * left to whatever the heap happens to report. Applied once per budget
 * (steady-state, rebuild-peak, disk), not per-shard.
 */
export const METADATA_ALLOWANCE_BYTES = 8 * 1024 * 1024;

const BYTES_PER_FLOAT32 = 4;

/** Raw, decoded (in-memory, resident) byte size of a `count x dimension` Float32 matrix -- header/checksum-free, unlike `encodedMatrixByteLength`. */
export function decodedMatrixByteLength(dimension: number, count: number): number {
  return count * dimension * BYTES_PER_FLOAT32;
}

export interface MatrixByteAccountingShape {
  dimension: number;
  noteCount: number;
  /** The largest single chunk shard's row count (0 if there are no shards) -- the two-tier design only ever keeps ONE decoded shard resident at a time as the bounded chunk-refinement workspace, so it is this maximum, not the sum, that bounds steady-state/rebuild-peak memory. */
  largestShardCount: number;
}

/**
 * Steady-state resident memory: the note matrix (always resident, since
 * every query starts with a full note-level ranking pass) + the largest
 * single decoded chunk shard (the bounded chunk-refinement workspace --
 * shards are read/decoded on demand and are NOT all kept resident
 * simultaneously) + one query-vector-sized workspace + the metadata
 * allowance.
 */
export function computeSteadyStateBytes({ dimension, noteCount, largestShardCount }: MatrixByteAccountingShape): number {
  return (
    decodedMatrixByteLength(dimension, noteCount) +
    decodedMatrixByteLength(dimension, largestShardCount) +
    dimension * BYTES_PER_FLOAT32 +
    METADATA_ALLOWANCE_BYTES
  );
}

/**
 * Rebuild peak: the largest single moment of concurrent allocation while
 * building/loading a generation -- the note matrix's raw AND encoded
 * bytes, plus the largest shard's raw AND encoded bytes (the peak
 * streaming unit, since shards are generated/encoded one at a time), plus
 * the metadata allowance.
 */
export function computeRebuildPeakBytes({ dimension, noteCount, largestShardCount }: MatrixByteAccountingShape): number {
  return (
    decodedMatrixByteLength(dimension, noteCount) +
    encodedMatrixByteLength(dimension, noteCount) +
    decodedMatrixByteLength(dimension, largestShardCount) +
    encodedMatrixByteLength(dimension, largestShardCount) +
    METADATA_ALLOWANCE_BYTES
  );
}

/**
 * On-disk size: the encoded note matrix + every shard's encoded bytes
 * (summed -- unlike steady-state/rebuild-peak, disk usage is the whole
 * committed generation, not just what's resident at once) + the metadata
 * allowance for the manifest file itself and any other bookkeeping.
 */
export function computeDiskBytes(dimension: number, noteCount: number, shardCounts: readonly number[]): number {
  const shardBytes = shardCounts.reduce((total, count) => total + encodedMatrixByteLength(dimension, count), 0);
  return encodedMatrixByteLength(dimension, noteCount) + shardBytes + METADATA_ALLOWANCE_BYTES;
}
