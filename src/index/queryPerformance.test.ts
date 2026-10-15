import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { NodeOwnedFs } from "../engine/nodeFs";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { buildGeneration, switchCurrentGeneration, type GenerationInputNote } from "./generationStore";
import { IndexStore, queryRelated as queryRelatedUncached } from "./indexStore";
import { compareScored } from "./cosineIndex";
import { computeCompactionRebuildPeakBytes, computeDiskBytes, computeSteadyStateBytes, LIVE_QUERY_EMBEDDING_CACHE_MAX_BYTES } from "./budgets";
import type { IndexFs } from "./indexFs";

const MODEL = "benchmark-model";

function unitVector(dimension: number, index: number): Float32Array {
  const vector = new Float32Array(dimension);
  vector[index % dimension] = 1;
  return vector;
}

function notes(count: number, dimension: number, chunksPerNote: number): GenerationInputNote[] {
  return Array.from({ length: count }, (_, index) => ({
    identity: stableNoteIdentity(canonicalizePath(`Note-${String(index).padStart(5, "0")}.md`)),
    sourceHash: index.toString(16).padStart(64, "0"),
    vector: unitVector(dimension, index < 20 ? 0 : 1 + (index % (dimension - 1))),
    chunkCount: chunksPerNote,
    loadChunkVectors: async () => Array.from({ length: chunksPerNote }, () => unitVector(dimension, index < 20 ? 0 : 1 + (index % (dimension - 1)))),
  }));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

void test("deterministic full-query fixture preserves exact order and warm base reads", async () => {
  const storage = new FakeIndexFs();
  const fixture = notes(64, 16, 2);
  await buildGeneration(storage, "/root", { generationId: 1, embeddingModel: MODEL, dimension: 16, notes: fixture });
  await switchCurrentGeneration(storage, "/root", 1);
  const store = new IndexStore(storage, "/root");
  const options = { queryVector: unitVector(16, 0), queryChunkVectors: [unitVector(16, 0)], limit: 20 };
  const cold = await store.queryRelated(options);
  const baseReads = storage.readFileCalls.filter((file) => file.endsWith("notes.mvx")).length;
  const warm = await store.queryRelated(options);
  assert.deepEqual(warm, cold);
  assert.deepEqual(warm, [...warm].sort(compareScored));
  assert.equal(storage.readFileCalls.filter((file) => file.endsWith("notes.mvx")).length, baseReads);
});

void test("opt-in 1k/10k full-query benchmark", { skip: process.env.MINDMAP_RUN_QUERY_BENCHMARK !== "1" }, async () => {
  for (const noteCount of [1_000, 10_000]) {
    const dimension = 1_024;
    const chunksPerNote = 10;
    const useNode = process.env.MINDMAP_QUERY_BENCHMARK_FS === "node";
    const tempRoot = useNode ? await fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-query-benchmark-")) : null;
    const storage: IndexFs = useNode ? new NodeOwnedFs(tempRoot!) : new FakeIndexFs();
    const root = tempRoot ?? "/root";
    try {
      const fixture = notes(noteCount, dimension, chunksPerNote);
      await buildGeneration(storage, root, { generationId: 1, embeddingModel: MODEL, dimension, notes: fixture });
      await switchCurrentGeneration(storage, root, 1);
      const options = { queryVector: unitVector(dimension, 0), queryChunkVectors: [unitVector(dimension, 0)], limit: 20 };
      const uncachedMs: number[] = [];
      for (let iteration = 0; iteration < 4; iteration += 1) {
        const started = performance.now();
        await queryRelatedUncached(storage, root, options);
        uncachedMs.push(performance.now() - started);
      }
      const stageMeasurements: Array<{ stage: string; wallMs: number; maxSynchronousSliceMs: number }> = [];
      const measuredOptions = {
        ...options,
        onLoadStage: (stage: { stage: string; wallMs: number; maxSynchronousSliceMs: number }) => stageMeasurements.push(stage),
        onQueryStage: (stage: { stage: string; wallMs: number; maxSynchronousSliceMs: number }) => stageMeasurements.push(stage),
      };
      const histogram = monitorEventLoopDelay({ resolution: 1 });
      histogram.enable();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const readsBeforeCold = storage instanceof FakeIndexFs ? storage.readFileCalls.length : 0;
      const coldMs: number[] = [];
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const coldStore = new IndexStore(storage, root);
        const started = performance.now();
        await coldStore.queryRelated(measuredOptions);
        coldMs.push(performance.now() - started);
      }
      const readsAfterCold = storage instanceof FakeIndexFs ? storage.readFileCalls.length : 0;
      const store = new IndexStore(storage, root);
      const warmMs: number[] = [];
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const started = performance.now();
        await store.queryRelated(measuredOptions);
        warmMs.push(performance.now() - started);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      histogram.disable();
      const observedMemory = process.memoryUsage();
      const largestShardCount = 10_000;
      const stageNames = [...new Set(stageMeasurements.map((stage) => stage.stage))];
      const stageAverageWallMs = Object.fromEntries(stageNames.map((stageName) => {
        const matching = stageMeasurements.filter((stage) => stage.stage === stageName);
        return [stageName, Number((matching.reduce((sum, stage) => sum + stage.wallMs, 0) / matching.length).toFixed(2))];
      }));
      const output = {
        notes: noteCount,
        chunks: noteCount * chunksPerNote,
        dimension,
        fs: useNode ? "NodeOwnedFs" : "FakeIndexFs",
        uncachedP50Ms: Number(percentile(uncachedMs, 0.5).toFixed(2)),
        uncachedP95Ms: Number(percentile(uncachedMs, 0.95).toFixed(2)),
        coldP50Ms: Number(percentile(coldMs, 0.5).toFixed(2)),
        coldP95Ms: Number(percentile(coldMs, 0.95).toFixed(2)),
        warmP50Ms: Number(percentile(warmMs, 0.5).toFixed(2)),
        warmP95Ms: Number(percentile(warmMs, 0.95).toFixed(2)),
        longestEventLoopDelayMs: Number((histogram.max / 1e6).toFixed(2)),
        steadyStateMiB: Number((computeSteadyStateBytes({ dimension, noteCount, largestShardCount }) / 1024 / 1024).toFixed(2)),
        steadyStateWithCacheAndActiveCloneMiB: Number(((computeSteadyStateBytes({ dimension, noteCount, largestShardCount }) + LIVE_QUERY_EMBEDDING_CACHE_MAX_BYTES * 2) / 1024 / 1024).toFixed(2)),
        rebuildWithConcurrentReaderMiB: Number((computeCompactionRebuildPeakBytes({ dimension, oldNoteCount: noteCount, newNoteCount: noteCount, largestShardCount }) / 1024 / 1024).toFixed(2)),
        diskMiB: Number((computeDiskBytes(dimension, noteCount, Array.from({ length: Math.ceil(noteCount * chunksPerNote / largestShardCount) }, (_unused, index) => Math.min(largestShardCount, noteCount * chunksPerNote - index * largestShardCount))) / 1024 / 1024).toFixed(2)),
        coldFullReads: storage instanceof FakeIndexFs ? readsAfterCold - readsBeforeCold : "see Node timing",
        warmFullReadsPerQuery: storage instanceof FakeIndexFs ? Number(((storage.readFileCalls.length - readsAfterCold) / warmMs.length).toFixed(2)) : "see Node timing",
        providerCalls: 0,
        stageAverageWallMs,
        maxMeasuredSynchronousSliceMs: Number(Math.max(0, ...stageMeasurements.map((stage) => stage.maxSynchronousSliceMs)).toFixed(2)),
        observedMemoryMiB: Object.fromEntries((["rss", "heapUsed", "external", "arrayBuffers"] as const).map((key) => [key, Number((observedMemory[key] / 1024 / 1024).toFixed(2))])),
        runtime: process.version,
        hardware: `${os.cpus()[0]?.model ?? "unknown"}; ${os.cpus().length} logical CPUs; ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GiB RAM`,
      };
      process.stdout.write(`QUERY_BENCHMARK ${JSON.stringify(output)}\n`);
      if (noteCount === 10_000) assert.ok(output.warmP95Ms <= 250, `warm p95 ${output.warmP95Ms}ms exceeded 250ms target`);
    } finally {
      if (tempRoot) await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  }
});
