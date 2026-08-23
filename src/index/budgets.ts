import { OVERLAY_CHECKSUM_BYTES, OVERLAY_HEADER_BYTES } from "./overlayCodec";
import { CHECKSUM_BYTES, encodedMatrixByteLength, HEADER_BYTES } from "./vectorCodec";

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
 * Rebuild peak for a FRESH build (no prior generation involved, e.g.
 * bootstrapping the very first generation from scratch): the note
 * matrix's raw AND encoded bytes, plus the largest shard's raw AND
 * encoded bytes (the peak streaming unit, since shards are
 * generated/encoded one at a time), plus the metadata allowance. For
 * COMPACTION's rebuild peak (which additionally keeps the prior
 * committed generation's note matrix resident throughout, and streams
 * from an old input shard/overlay into a new output shard), see
 * `computeCompactionRebuildPeakBytes`.
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

export interface CompactionByteAccountingShape {
  dimension: number;
  /** The prior committed generation's note count -- its note matrix stays resident throughout compaction (`IndexStore.compact` loads it first and never releases it until the new generation is built). 0 if there was no prior generation. */
  oldNoteCount: number;
  /** The new (post-merge) generation's note count. */
  newNoteCount: number;
  /** The largest shard row count on EITHER side -- one old input shard/overlay payload and one new output shard are each resident at a time (streaming, see `buildGeneration`/`IndexStore.compact`), never more than one of each simultaneously. */
  largestShardCount: number;
}

/**
 * Compaction's actual rebuild peak: the OLD committed generation's note
 * matrix (resident throughout, since compaction reads it to build the
 * merged view) + the NEW note matrix being built (raw AND encoded) + ONE
 * old input shard/overlay chunk payload (streaming source, resident only
 * while its notes are being written into the current output shard) + ONE
 * new output shard (raw AND encoded) + the metadata allowance.
 * Compaction is genuinely streaming -- it never accumulates all base+
 * overlay chunks at once (see `buildGeneration`'s per-shard loop and
 * `IndexStore.compact`'s single-source-shard cache) -- so this is the
 * true peak, not an approximation that assumes full materialization.
 */
export function computeCompactionRebuildPeakBytes({ dimension, oldNoteCount, newNoteCount, largestShardCount }: CompactionByteAccountingShape): number {
  return (
    decodedMatrixByteLength(dimension, oldNoteCount) +
    decodedMatrixByteLength(dimension, newNoteCount) +
    encodedMatrixByteLength(dimension, newNoteCount) +
    decodedMatrixByteLength(dimension, largestShardCount) + // one old input shard/overlay payload
    decodedMatrixByteLength(dimension, largestShardCount) + // one new output shard, raw
    encodedMatrixByteLength(dimension, largestShardCount) + // one new output shard, encoded
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

/**
 * Between compactions, mutations accumulate as overlay files -- these two
 * ceilings bound how many can pile up before a write is rejected and
 * compaction is required, so overlays can NEVER push steady-state memory
 * or disk usage past budget no matter how long compaction is deferred.
 * `MAX_PENDING_OVERLAY_COUNT` bounds how many individual note vectors the
 * merged view keeps resident (each overlay note vector is read into
 * memory during ranking -- see `indexStore.ts`'s composite-view ranking,
 * which does NOT copy them into a second full matrix, but does keep them
 * resident as individual small arrays). `MAX_PENDING_OVERLAY_CHUNK_ROWS`
 * bounds the on-disk chunk-vector footprint across ALL pending overlays
 * combined (chunk vectors are never resident in the merged view at all --
 * see `overlayCodec.ts`'s prefix/full split -- so this is a disk-only
 * bound, sized at 2x `MAX_MANIFEST_SHARD_ROW_COUNT` -- generous headroom
 * for pending mutations between compactions while staying the same order
 * of magnitude as one shard, not an unrelated/looser figure). ALSO
 * enforced per-overlay (`overlayStore.ts`'s `writeUpsertOverlay`): a
 * single overlay's own chunk rows can never exceed
 * `MAX_MANIFEST_SHARD_ROW_COUNT` either, since one overlay's chunk
 * payload must itself fit the same bounded refinement workspace as one
 * shard (see `MAX_MANIFEST_SHARD_ROW_COUNT` in `indexManifest.ts`).
 */
export const MAX_PENDING_OVERLAY_COUNT = 2_000;
export const MAX_PENDING_OVERLAY_CHUNK_ROWS = 20_000;

/** Fixed per-overlay-container framing overhead: the container header plus BOTH its checksums (`overlayCodec.ts`) -- independent of vector payload size. */
const OVERLAY_CONTAINER_FIXED_OVERHEAD_BYTES = OVERLAY_HEADER_BYTES + OVERLAY_CHECKSUM_BYTES * 2;
/** One vector-codec matrix's own header+checksum overhead (`vectorCodec.ts`) -- charged once per note vector (always present) and, conservatively, once per overlay for its chunk vector too (see `computeOverlayDiskBytesBudget`'s doc comment on why that's the conservative worst case). */
const CODEC_VECTOR_OVERHEAD_BYTES = HEADER_BYTES + CHECKSUM_BYTES;
/**
 * Enforced maximum overlay metadata JSON size -- NOT just an estimate the
 * budget assumes: `overlayStore.ts`'s write path rejects (before ever
 * writing) any overlay whose metadata JSON would exceed this, so the
 * budget's assumption and reality can never drift apart. Generous for
 * `{identity, operation, version, recordedAt, sourceHash, embeddingModel,
 * dimension, chunkCount}` (a canonical path up to a few hundred bytes,
 * two hex hashes, an ISO timestamp, small integers).
 */
export const OVERLAY_METADATA_JSON_MAX_BYTES = 512;

/**
 * Worst-case on-disk bytes ALL pending overlays combined could ever reach
 * while staying within `MAX_PENDING_OVERLAY_COUNT`/`MAX_PENDING_OVERLAY_CHUNK_ROWS`
 * (and the enforced per-overlay `OVERLAY_METADATA_JSON_MAX_BYTES` and
 * `MAX_MANIFEST_SHARD_ROW_COUNT` chunk-row caps) -- an upper bound
 * reserved permanently in the disk budget (see
 * `computeDiskBytesWithOverlays`), not a measurement of current actual
 * usage. Charges: the outer container framing (header + both checksums +
 * the enforced metadata-JSON maximum) once per overlay; each overlay's
 * note-vector encoding (which already includes its own codec
 * header+checksum via `encodedMatrixByteLength`); the aggregate raw
 * chunk-vector payload bytes across all pending overlays; and, because
 * `MAX_PENDING_OVERLAY_CHUNK_ROWS` rows can be spread across as many as
 * `MAX_PENDING_OVERLAY_COUNT` SEPARATE containers (each with its own
 * independent chunk-vector codec header+checksum, unlike a single shared
 * shard matrix), one codec-vector-overhead charge PER OVERLAY for the
 * chunk span -- not one shared charge for the aggregate, which would
 * understate the real worst case.
 */
export function computeOverlayDiskBytesBudget(dimension: number): number {
  const outerContainerOverhead = MAX_PENDING_OVERLAY_COUNT * (OVERLAY_CONTAINER_FIXED_OVERHEAD_BYTES + OVERLAY_METADATA_JSON_MAX_BYTES);
  const noteVectorBytes = MAX_PENDING_OVERLAY_COUNT * encodedMatrixByteLength(dimension, 1);
  const chunkVectorRawBytes = MAX_PENDING_OVERLAY_CHUNK_ROWS * dimension * BYTES_PER_FLOAT32;
  const chunkVectorCodecOverhead = MAX_PENDING_OVERLAY_COUNT * CODEC_VECTOR_OVERHEAD_BYTES;
  return outerContainerOverhead + noteVectorBytes + chunkVectorRawBytes + chunkVectorCodecOverhead;
}

/**
 * The EXACT (for an upsert) or safe-conservative (for a tombstone, which
 * physically has no note/chunk vector bytes at all -- this over-estimates
 * rather than measuring it exactly) on-disk byte length ONE overlay
 * container of this shape would occupy: the container's fixed framing
 * (header + both checksums) + the enforced `OVERLAY_METADATA_JSON_MAX_BYTES`
 * ceiling (a real container's metadata is never larger, so this is never
 * an under-count) + its encoded note-vector matrix + its encoded
 * chunk-vector matrix. Unlike `computeOverlayDiskBytesBudget` above (which
 * reserves the full `MAX_PENDING_OVERLAY_COUNT`/`MAX_PENDING_OVERLAY_CHUNK_ROWS`
 * worst case permanently, regardless of actual pending state), this is for
 * accounting ONE overlay's ACTUAL (or about-to-be-written) projected
 * footprint -- see `indexStore.ts`'s per-mutation resource-budget check.
 */
export function computeOverlayContainerBytes(dimension: number, chunkCount: number): number {
  return OVERLAY_CONTAINER_FIXED_OVERHEAD_BYTES + OVERLAY_METADATA_JSON_MAX_BYTES + encodedMatrixByteLength(dimension, 1) + encodedMatrixByteLength(dimension, chunkCount);
}

/** `computeSteadyStateBytes` plus the worst-case resident bytes of up to `MAX_PENDING_OVERLAY_COUNT` overlay note vectors (never their chunk vectors, which are never resident in the merged view -- see `overlayCodec.ts`). */
export function computeSteadyStateBytesWithOverlays(shape: MatrixByteAccountingShape): number {
  return computeSteadyStateBytes(shape) + decodedMatrixByteLength(shape.dimension, MAX_PENDING_OVERLAY_COUNT);
}

/** `computeDiskBytes` plus the worst-case pending-overlay disk allowance (`computeOverlayDiskBytesBudget`). */
export function computeDiskBytesWithOverlays(dimension: number, noteCount: number, shardCounts: readonly number[]): number {
  return computeDiskBytes(dimension, noteCount, shardCounts) + computeOverlayDiskBytesBudget(dimension);
}
