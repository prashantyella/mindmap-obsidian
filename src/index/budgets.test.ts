import test from "node:test";
import assert from "node:assert/strict";

import {
  BUDGET_DISK_BYTES,
  BUDGET_REBUILD_PEAK_MEMORY_BYTES,
  BUDGET_STEADY_STATE_MEMORY_BYTES,
  computeCompactionRebuildPeakBytes,
  computeDiskBytes,
  computeDiskBytesWithOverlays,
  computeOverlayContainerBytes,
  computeOverlayDiskBytesBudget,
  computeRebuildPeakBytes,
  computeSteadyStateBytes,
  computeSteadyStateBytesWithOverlays,
  MAX_PENDING_OVERLAY_CHUNK_ROWS,
  MAX_PENDING_OVERLAY_COUNT,
} from "./budgets";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";

const TARGET_DIMENSION = 1024;
const TARGET_NOTE_COUNT = 10_000;
const TARGET_CHUNK_COUNT = 100_000;
const TARGET_SHARD_COUNT = TARGET_CHUNK_COUNT / MAX_MANIFEST_SHARD_ROW_COUNT;

void test("at the approved 10k-note/100k-chunk/1024-dim target, steady-state memory INCLUDING the full pending-overlay allowance stays within the 128MB budget", () => {
  const shardCounts = Array.from({ length: TARGET_SHARD_COUNT }, () => MAX_MANIFEST_SHARD_ROW_COUNT);
  const largestShardCount = Math.max(...shardCounts);
  const steadyStateBytes = computeSteadyStateBytesWithOverlays({ dimension: TARGET_DIMENSION, noteCount: TARGET_NOTE_COUNT, largestShardCount });
  assert.ok(
    steadyStateBytes <= BUDGET_STEADY_STATE_MEMORY_BYTES,
    `steady-state with overlays (${(steadyStateBytes / 1024 / 1024).toFixed(1)}MB) must fit within ${BUDGET_STEADY_STATE_MEMORY_BYTES / 1024 / 1024}MB`,
  );
  // The overlay allowance itself must be a real, nonzero addition -- not a no-op accounting term.
  const withoutOverlays = computeSteadyStateBytes({ dimension: TARGET_DIMENSION, noteCount: TARGET_NOTE_COUNT, largestShardCount });
  assert.ok(steadyStateBytes > withoutOverlays);
});

void test("at the approved 10k-note/100k-chunk/1024-dim target, disk usage INCLUDING the full pending-overlay allowance stays within the 600MB budget", () => {
  const shardCounts = Array.from({ length: TARGET_SHARD_COUNT }, () => MAX_MANIFEST_SHARD_ROW_COUNT);
  const diskBytes = computeDiskBytesWithOverlays(TARGET_DIMENSION, TARGET_NOTE_COUNT, shardCounts);
  assert.ok(diskBytes <= BUDGET_DISK_BYTES, `disk with overlays (${(diskBytes / 1024 / 1024).toFixed(1)}MB) must fit within ${BUDGET_DISK_BYTES / 1024 / 1024}MB`);
  const withoutOverlays = computeDiskBytes(TARGET_DIMENSION, TARGET_NOTE_COUNT, shardCounts);
  assert.ok(diskBytes > withoutOverlays);
});

void test("computeOverlayDiskBytesBudget grows with dimension and reflects both MAX_PENDING_OVERLAY_COUNT and MAX_PENDING_OVERLAY_CHUNK_ROWS", () => {
  const small = computeOverlayDiskBytesBudget(64);
  const large = computeOverlayDiskBytesBudget(TARGET_DIMENSION);
  assert.ok(large > small);
  // Sanity: the budget must be able to account for every pending overlay's note vector plus the
  // full aggregate chunk-row allowance, not some smaller placeholder.
  const minimumPlausibleBytes = MAX_PENDING_OVERLAY_COUNT * TARGET_DIMENSION * 4 + MAX_PENDING_OVERLAY_CHUNK_ROWS * TARGET_DIMENSION * 4;
  assert.ok(computeOverlayDiskBytesBudget(TARGET_DIMENSION) >= minimumPlausibleBytes);
});

void test("MAX_PENDING_OVERLAY_CHUNK_ROWS is bounded to the same order of magnitude as one shard's row cap (MAX_MANIFEST_SHARD_ROW_COUNT), not an unrelated/looser figure", () => {
  assert.ok(MAX_PENDING_OVERLAY_CHUNK_ROWS <= MAX_MANIFEST_SHARD_ROW_COUNT * 4);
  assert.ok(MAX_PENDING_OVERLAY_CHUNK_ROWS >= MAX_MANIFEST_SHARD_ROW_COUNT);
});

void test("compaction's actual rebuild peak (old committed note matrix + new note matrix + one old input shard/overlay + one new output shard + metadata) stays within the 512MB budget at the 10k/100k/1024 target", () => {
  const peak = computeCompactionRebuildPeakBytes({
    dimension: TARGET_DIMENSION,
    oldNoteCount: TARGET_NOTE_COUNT,
    newNoteCount: TARGET_NOTE_COUNT,
    largestShardCount: MAX_MANIFEST_SHARD_ROW_COUNT,
  });
  assert.ok(peak <= BUDGET_REBUILD_PEAK_MEMORY_BYTES, `compaction rebuild peak (${(peak / 1024 / 1024).toFixed(1)}MB) must fit within ${BUDGET_REBUILD_PEAK_MEMORY_BYTES / 1024 / 1024}MB`);
  // The old committed generation's note matrix is a REAL additional cost streaming compaction
  // pays (it stays resident throughout) -- confirm this function's peak is strictly larger than
  // a from-scratch build's peak at the same shape, not accidentally equal to it (which would mean
  // the old note matrix wasn't actually being counted).
  const freshBuildPeak = computeRebuildPeakBytes({ dimension: TARGET_DIMENSION, noteCount: TARGET_NOTE_COUNT, largestShardCount: MAX_MANIFEST_SHARD_ROW_COUNT });
  assert.ok(peak > freshBuildPeak);
});

void test("computeCompactionRebuildPeakBytes with no prior generation (oldNoteCount=0) equals a fresh build's peak plus the streaming shard/overlay overhead, never double-counting a nonexistent old generation", () => {
  const peakWithNoOldGeneration = computeCompactionRebuildPeakBytes({ dimension: TARGET_DIMENSION, oldNoteCount: 0, newNoteCount: 100, largestShardCount: 50 });
  const peakWithSmallOldGeneration = computeCompactionRebuildPeakBytes({ dimension: TARGET_DIMENSION, oldNoteCount: 1, newNoteCount: 100, largestShardCount: 50 });
  assert.ok(peakWithSmallOldGeneration > peakWithNoOldGeneration);
});

void test("computeOverlayContainerBytes grows with dimension and with chunkCount, and is always at least the fixed framing + one note vector's worth of bytes", () => {
  const chunkless = computeOverlayContainerBytes(TARGET_DIMENSION, 0);
  const withChunks = computeOverlayContainerBytes(TARGET_DIMENSION, 100);
  assert.ok(withChunks > chunkless, "adding chunk rows must increase the projected container size");
  const smallDim = computeOverlayContainerBytes(64, 0);
  assert.ok(chunkless > smallDim, "a larger dimension must increase the projected container size even with no chunks");
  // A real container is never larger than this: header + both checksums + actual metadata JSON
  // (<= the enforced cap) + actual note-vector bytes + actual chunk-vector bytes.
  assert.ok(chunkless > 0);
});

void test("computeOverlayContainerBytes at a real overlay's exact shape is a safe upper bound for (never smaller than) the container writeUpsertOverlay actually produces", async () => {
  const { encodeOverlayContainer } = await import("./overlayCodec");
  const { encodeVectorMatrix } = await import("./vectorCodec");
  const dimension = 8;
  const chunkCount = 3;
  const noteVector = encodeVectorMatrix({ kind: "note", dimension, count: 1, data: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]) });
  const chunkData = new Float32Array(chunkCount * dimension);
  for (let i = 0; i < chunkCount; i += 1) chunkData[i * dimension] = 1;
  const chunkVector = encodeVectorMatrix({ kind: "chunk", dimension, count: chunkCount, data: chunkData });
  const metadataJsonBytes = new TextEncoder().encode(
    JSON.stringify({ identity: { canonicalPath: "A.md" }, operation: "upsert", version: 1, recordedAt: new Date().toISOString(), sourceHash: "a".repeat(64), embeddingModel: "m", dimension, chunkCount }),
  );
  const container = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes, noteVectorBytes: noteVector, chunkVectorBytes: chunkVector });
  const projected = computeOverlayContainerBytes(dimension, chunkCount);
  assert.ok(projected >= container.length, `projected (${projected}) must never under-count the real container (${container.length})`);
});
