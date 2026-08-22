import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import {
  BUDGET_DISK_BYTES,
  BUDGET_REBUILD_PEAK_MEMORY_BYTES,
  BUDGET_STEADY_STATE_MEMORY_BYTES,
  computeDiskBytes,
  computeRebuildPeakBytes,
  computeSteadyStateBytes,
} from "./budgets";
import { rankNotes, refineWithChunks } from "./cosineIndex";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";
import { decodeVectorMatrix, encodeVectorMatrix, encodedMatrixByteLength } from "./vectorCodec";
import type { ChunkShardNoteOffset } from "./vectorTypes";

/**
 * Opt-in synthetic benchmark at the design's documented target scale
 * (10,000 notes / 100,000 chunks / 1,024 dimensions). Skipped by default
 * -- never runs in ordinary `npm test`/CI, never allocates the full
 * corpus unless explicitly requested -- so it can never make the default
 * suite flaky or slow. Enable with:
 *
 *   MINDMAP_RUN_INDEX_BENCHMARK=1 npx tsx --test src/index/benchmark.test.ts
 *
 * This checkpoint has no persistence/job-engine layer yet, so "startup"
 * and "rebuild peak memory" are necessarily ESTIMATES from the codec/index
 * primitives that exist today, not a measurement of the real
 * committed-generation load path Checkpoint 5 will add. They are
 * documented as estimates, not asserted as if they were the final
 * end-to-end numbers.
 *
 * The approved budgets are asserted as hard ceilings, never silently
 * loosened -- and are imported from `budgets.ts`, the SAME constants and
 * byte-accounting helpers `indexManifest.ts` enforces as executable
 * parse-time invariants, so the parser and this benchmark can never
 * quietly drift apart on what "128MB steady state" means:
 *   - committed-index startup  <= 3000 ms
 *   - query p95                <= 250 ms
 *   - steady-state memory      <= 128 MB (beyond baseline)
 *   - rebuild peak memory      <= 512 MB
 *   - index disk usage         <= 600 MB
 *
 * SHARDED RESIDENCY: the two-tier design's whole point is that a query
 * never needs the entire chunk corpus resident -- only the note matrix
 * (for the note-first ranking pass) plus, on demand, the chunk shard(s)
 * covering the current candidate set. This harness honors that: chunk
 * shards are generated and encoded ONE AT A TIME purely to account for
 * disk size and streaming/rebuild-peak bytes, and at most ONE decoded
 * shard (sized at `MAX_MANIFEST_SHARD_ROW_COUNT`, the manifest's own
 * per-shard cap) is ever kept resident as the bounded chunk-refinement
 * workspace. It is never copied into a second, full-corpus matrix.
 *
 * QUERY WORKLOAD: because notes are assigned to shards randomly for this
 * synthetic corpus, only ~1/shardCount of a real note-first candidate set
 * would happen to fall in the one retained shard -- refining against that
 * alone would understate the actual max-pair refinement work a query
 * does. So, for EVERY query, each of the (up to `limit`) ranked candidates
 * is deterministically remapped to its own non-overlapping row range
 * within the retained shard (`candidates[i]` -> rows
 * `[i*chunksPerNote, (i+1)*chunksPerNote)`) purely as benchmark metadata --
 * this does not change `refineWithChunks`'s production semantics at all
 * (it still only ever reads the offsets it's given), it just ensures every
 * top candidate actually gets refined each query, exercising the full
 * documented workload.
 *
 * Memory is asserted via DETERMINISTIC BYTE ACCOUNTING, not
 * `process.memoryUsage().heapUsed`: V8's heap figure excludes the backing
 * storage of TypedArrays/ArrayBuffers entirely (they're allocated outside
 * the V8 heap), so a heap-delta measurement systematically undercounts the
 * very allocations this budget exists to bound, and is also noisy (GC
 * timing, JIT, V8 internals) in a way that would otherwise force a
 * tolerance multiplier that quietly weakens the approved budget itself.
 * `process.memoryUsage()`/`arrayBuffers` are still read and logged, but
 * purely as observational context -- never as the basis for a pass/fail
 * assertion.
 */

const RUN_BENCHMARK = process.env.MINDMAP_RUN_INDEX_BENCHMARK === "1";

const TARGET_NOTE_COUNT = 10_000;
const TARGET_CHUNK_COUNT = 100_000;
const TARGET_DIMENSION = 1024;

const BUDGET_STARTUP_MS = 3_000;
const BUDGET_QUERY_P95_MS = 250;
const QUERY_LIMIT = 20;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function randomUnitVector(random: () => number, dimension: number): Float32Array {
  const vector = new Float32Array(dimension);
  let sumSquares = 0;
  for (let i = 0; i < dimension; i += 1) {
    const value = random() * 2 - 1;
    vector[i] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  for (let i = 0; i < dimension; i += 1) {
    vector[i] /= norm;
  }
  return vector;
}

function percentile(sortedMs: number[], p: number): number {
  const index = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[index];
}

const benchmarkTest = RUN_BENCHMARK ? test : test.skip;

void benchmarkTest(
  `synthetic benchmark: ${TARGET_NOTE_COUNT} notes / ${TARGET_CHUNK_COUNT} chunks / ${TARGET_DIMENSION} dims meets approved budgets`,
  { timeout: 120_000 },
  () => {
    const random = seededRandom(42);
    const chunksPerNote = Math.round(TARGET_CHUNK_COUNT / TARGET_NOTE_COUNT);

    // One shard = MAX_MANIFEST_SHARD_ROW_COUNT rows exactly -- the manifest's own per-shard cap,
    // so this benchmark's "one resident shard" workspace matches what a real committed generation
    // would actually be allowed to write.
    const shardNoteSpan = MAX_MANIFEST_SHARD_ROW_COUNT / chunksPerNote;
    assert.ok(Number.isInteger(shardNoteSpan), "MAX_MANIFEST_SHARD_ROW_COUNT must divide evenly by chunksPerNote for this benchmark's shard math");
    const shardCount = TARGET_NOTE_COUNT / shardNoteSpan;
    assert.ok(Number.isInteger(shardCount), "TARGET_NOTE_COUNT must divide evenly by shardNoteSpan for this benchmark's shard math");
    assert.ok(
      QUERY_LIMIT * chunksPerNote <= MAX_MANIFEST_SHARD_ROW_COUNT,
      "the retained shard must have room for every ranked candidate's own non-overlapping refinement range",
    );
    const RETAINED_SHARD_INDEX = 0;

    // --- Build the synthetic note matrix (resident for the whole benchmark: this is the
    // steady-state working set every query's note-first ranking pass reads) ---
    const notePaths = Array.from({ length: TARGET_NOTE_COUNT }, (_, i) => canonicalizePath(`Bench/Note-${i}.md`));
    const noteData = new Float32Array(TARGET_NOTE_COUNT * TARGET_DIMENSION);
    for (let i = 0; i < TARGET_NOTE_COUNT; i += 1) {
      noteData.set(randomUnitVector(random, TARGET_DIMENSION), i * TARGET_DIMENSION);
    }
    const noteMatrixEncoded = encodeVectorMatrix({ kind: "note", dimension: TARGET_DIMENSION, count: TARGET_NOTE_COUNT, data: noteData });

    // --- Generate/encode every chunk shard SEQUENTIALLY, purely for disk-size and
    // streaming-peak accounting -- at most one shard's raw+encoded bytes are ever alive at once,
    // and only the retained shard's decoded matrix survives past its own loop iteration. This
    // never builds (or copies into) a second full-corpus chunk matrix. ---
    let measuredDiskEstimateBytes = noteMatrixEncoded.byteLength;
    const shardCounts: number[] = [];
    let retainedChunkMatrix: { kind: "chunk"; dimension: number; count: number; data: Float32Array } | undefined;

    for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
      const shardChunkCount = shardNoteSpan * chunksPerNote; // === MAX_MANIFEST_SHARD_ROW_COUNT
      shardCounts.push(shardChunkCount);
      const shardData = new Float32Array(shardChunkCount * TARGET_DIMENSION);
      for (let i = 0; i < shardChunkCount; i += 1) {
        shardData.set(randomUnitVector(random, TARGET_DIMENSION), i * TARGET_DIMENSION);
      }
      const shardEncoded = encodeVectorMatrix({ kind: "chunk", dimension: TARGET_DIMENSION, count: shardChunkCount, data: shardData });
      measuredDiskEstimateBytes += shardEncoded.byteLength;

      if (shardIndex === RETAINED_SHARD_INDEX) {
        // Decode it back (as a real load path would read a shard off disk) and keep ONLY this one
        // shard resident, as the bounded chunk-refinement workspace.
        const decoded = decodeVectorMatrix(shardEncoded, { expectedKind: "chunk" });
        retainedChunkMatrix = { kind: "chunk", dimension: decoded.dimension, count: decoded.count, data: decoded.data };
      }
      // shardData/shardEncoded for every other shard are dropped here -- nothing beyond this
      // iteration retains a reference to them.
    }
    if (!retainedChunkMatrix) {
      throw new Error("benchmark setup error: no shard was retained");
    }
    const largestShardCount = shardNoteSpan * chunksPerNote; // every shard is the same size here

    // --- Budgets: computed via the SAME shared helpers `indexManifest.ts` enforces as executable
    // invariants, from the declared shape alone -- not reimplemented arithmetic that could drift. ---
    const steadyStateBytes = computeSteadyStateBytes({ dimension: TARGET_DIMENSION, noteCount: TARGET_NOTE_COUNT, largestShardCount });
    const rebuildPeakBytes = computeRebuildPeakBytes({ dimension: TARGET_DIMENSION, noteCount: TARGET_NOTE_COUNT, largestShardCount });
    const diskEstimateBytes = computeDiskBytes(TARGET_DIMENSION, TARGET_NOTE_COUNT, shardCounts);
    // Cross-check: the shared helper's disk figure must agree with the bytes actually measured
    // while sequentially encoding every shard above (the helper adds the metadata allowance on
    // top, which the raw measurement below does not).
    assert.ok(
      diskEstimateBytes >= measuredDiskEstimateBytes,
      `computeDiskBytes (${diskEstimateBytes}) must be at least the measured encoded bytes (${measuredDiskEstimateBytes})`,
    );

    // --- Startup estimate: decode (round-trip) the note matrix, as a committed-generation load
    // would (the retained shard was already decoded above) ---
    const startupStart = performance.now();
    const decodedNoteMatrix = decodeVectorMatrix(noteMatrixEncoded, { expectedKind: "note" });
    const startupMs = performance.now() - startupStart;

    // --- Query p95: actual note-first ranking + bounded chunk refinement, repeated. Every ranked
    // candidate is deterministically remapped (benchmark-only metadata, not a production behavior
    // change) to its own non-overlapping range within the retained shard, so refinement covers ALL
    // top candidates every query, not just the ones that happen to land in shard 0. ---
    const queryLatenciesMs: number[] = [];
    const queryCount = 200;
    for (let q = 0; q < queryCount; q += 1) {
      const queryVector = randomUnitVector(random, TARGET_DIMENSION);
      const start = performance.now();
      const candidates = rankNotes({ queryVector, matrix: decodedNoteMatrix, ids: notePaths, limit: QUERY_LIMIT });
      const remappedOffsets: ChunkShardNoteOffset[] = candidates.map((candidate, i) => ({
        identity: stableNoteIdentity(candidate.path),
        start: i * chunksPerNote,
        length: chunksPerNote,
      }));
      const refined = refineWithChunks({
        queryChunkVectors: [queryVector],
        candidates,
        chunkMatrix: retainedChunkMatrix,
        noteOffsets: remappedOffsets,
        limit: QUERY_LIMIT,
      });
      queryLatenciesMs.push(performance.now() - start);
      assert.equal(refined.length, candidates.length, "every ranked candidate must have been refined -- none should be silently dropped");
    }
    queryLatenciesMs.sort((a, b) => a - b);
    const p95Ms = percentile(queryLatenciesMs, 95);

    // Observational only -- never asserted against, since heapUsed excludes TypedArray backing
    // storage and is noisy across GC/JIT states. Logged purely for context alongside the
    // deterministic byte-accounting figures above.
    const observedMemory = process.memoryUsage();

    console.log(
      `[index benchmark] startup=${startupMs.toFixed(1)}ms p95=${p95Ms.toFixed(1)}ms ` +
        `steadyStateBytes=${(steadyStateBytes / 1024 / 1024).toFixed(1)}MB ` +
        `rebuildPeakBytes=${(rebuildPeakBytes / 1024 / 1024).toFixed(1)}MB ` +
        `disk=${(diskEstimateBytes / 1024 / 1024).toFixed(1)}MB ` +
        `[observational: heapUsed=${(observedMemory.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
        `arrayBuffers=${(observedMemory.arrayBuffers / 1024 / 1024).toFixed(1)}MB]`,
    );

    assert.ok(startupMs <= BUDGET_STARTUP_MS, `startup estimate ${startupMs.toFixed(1)}ms exceeds the approved ${BUDGET_STARTUP_MS}ms budget`);
    assert.ok(p95Ms <= BUDGET_QUERY_P95_MS, `query p95 estimate ${p95Ms.toFixed(1)}ms exceeds the approved ${BUDGET_QUERY_P95_MS}ms budget`);
    assert.ok(
      diskEstimateBytes <= BUDGET_DISK_BYTES,
      `disk estimate ${(diskEstimateBytes / 1024 / 1024).toFixed(1)}MB exceeds the approved ${BUDGET_DISK_BYTES / 1024 / 1024}MB budget`,
    );
    assert.ok(
      steadyStateBytes <= BUDGET_STEADY_STATE_MEMORY_BYTES,
      `steady-state byte accounting ${(steadyStateBytes / 1024 / 1024).toFixed(1)}MB exceeds the approved ${BUDGET_STEADY_STATE_MEMORY_BYTES / 1024 / 1024}MB budget`,
    );
    assert.ok(
      rebuildPeakBytes <= BUDGET_REBUILD_PEAK_MEMORY_BYTES,
      `rebuild peak byte accounting ${(rebuildPeakBytes / 1024 / 1024).toFixed(1)}MB exceeds the approved ${BUDGET_REBUILD_PEAK_MEMORY_BYTES / 1024 / 1024}MB budget`,
    );

    // Sanity check on the byte-accounting formula itself, independent of the measured run above.
    assert.equal(encodedMatrixByteLength(TARGET_DIMENSION, TARGET_NOTE_COUNT), noteMatrixEncoded.byteLength);
  },
);

void test("benchmark constants match the approved plan budgets exactly (guards against silent weakening)", () => {
  assert.equal(BUDGET_STARTUP_MS, 3_000);
  assert.equal(BUDGET_QUERY_P95_MS, 250);
  assert.equal(BUDGET_STEADY_STATE_MEMORY_BYTES, 128 * 1024 * 1024);
  assert.equal(BUDGET_REBUILD_PEAK_MEMORY_BYTES, 512 * 1024 * 1024);
  assert.equal(BUDGET_DISK_BYTES, 600 * 1024 * 1024);
});
