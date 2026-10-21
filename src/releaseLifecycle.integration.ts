import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalizePath, stableNoteIdentity } from "./engine/contracts";
import { NodeOwnedFs } from "./engine/nodeFs";
import { buildGeneration, loadCurrentGenerationId, switchCurrentGeneration, verifyGenerationFully } from "./index/generationStore";
import { IndexStore } from "./index/indexStore";
import { writeUpsertOverlay } from "./index/overlayStore";
import { JobEngine, type JobPhaseRunner } from "./jobs/jobEngine";
import { JobStore } from "./jobs/jobStore";
import { RebuildJobRunner } from "./jobs/rebuildJob";
import { deriveEngineActivity } from "./jobs/jobActivity";

// Synthetic metadata/vectors only. Exercise production persistence and scheduling
// without a personal vault, network, model server, fake clock, or manual drain().
const oldHash = "a".repeat(64);
const newHash = "b".repeat(64);
const vector = new Float32Array([1, 0, 0, 0]);
const oldVector = new Float32Array([0, 1, 0, 0]);
const notePath = (i: number) => canonicalizePath(`Books/Apple Books/Test/Book/Annotations/note-${i}.md`);

async function activity(store: JobStore) {
  return deriveEngineActivity(await store.list(), await store.getBulkBatches(), await store.getProviderPause(), await store.getOperatorPause(), true, false, undefined);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "background lifecycle must progress without wake()/drain() or window events");
    await delay(20);
  }
}

// Snapshot every immutable artifact, not just a manifest that might miss a mutation.
async function artifacts(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else result[child] = (await readFile(join(root, child))).toString("base64");
    }
  }
  await walk("");
  return result;
}

for (const upgraded of [false, true]) {
  void test(`release gate: ${upgraded ? "944-note mixed-identity upgrade and interrupted cleanup" : "fresh index initialization"} recovers automatically across restart`, { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "mindmap-release-lifecycle-"));
    const engines: JobEngine[] = [];
    const priorWindow = globalThis.window;
    // A hidden browser window supplies no timer callbacks. Node must still progress.
    globalThis.window = { setTimeout: () => 1, clearTimeout: () => undefined } as unknown as Window & typeof globalThis;
    try {
      class CleanupFaultFs extends NodeOwnedFs {
        failCleanup = upgraded;
        override async unlink(file: string): Promise<void> {
          if (this.failCleanup && file.endsWith(".movl")) {
            this.failCleanup = false;
            throw new Error("synthetic interrupted cleanup");
          }
          await super.unlink(file);
        }
      }
      const fs = new CleanupFaultFs(root);
      const count = upgraded ? 944 : 8;
      if (upgraded) {
        await buildGeneration(fs, root, { generationId: 1, embeddingModel: "synthetic", dimension: 4,
          notes: Array.from({ length: 931 }, (_, i) => ({
            identity: stableNoteIdentity(notePath(i), i < 649 ? `annotation-${i}` : undefined),
            sourceHash: oldHash, vector: oldVector, chunkCount: 1, loadChunkVectors: async () => [oldVector],
          })),
        });
        await switchCurrentGeneration(fs, root, 1);
      }
      const previous = upgraded ? await artifacts(join(root, "generations/gen-1")) : undefined;
      // Low-level writes deliberately recreate the historical mixed producer state.
      for (let i = 0; i < count; i++) {
        await writeUpsertOverlay(fs, root, { identity: stableNoteIdentity(notePath(i)), sourceHash: newHash,
          embeddingModel: "synthetic", dimension: 4, noteVector: vector, chunkVectors: [vector] });
      }
      const store = new JobStore(fs, root);
      const realRunner = new RebuildJobRunner({ fs, root });
      const failBuild: JobPhaseRunner = { step: async (job, signal) => job.job.phase === "build-generation"
        ? { type: "retry", failureCode: "UNKNOWN_TRANSIENT" } : realRunner.step(job, signal) };
      const first = new JobEngine(store, { "rebuild-index": failBuild });
      engines.push(first);
      const job = await first.submit({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 2 });
      first.start();
      await first.whenSettled();
      const waiting = await activity(store);
      assert.equal(waiting.current?.phase, "build-generation");
      assert.equal(waiting.current?.failureCode, "UNKNOWN_TRANSIENT");
      assert.ok(waiting.current?.nextAttemptAtMs);
      assert.equal(await loadCurrentGenerationId(fs, root), upgraded ? 1 : null);
      first.dispose();
      await first.whenSettled();

      // Fresh store/engine: reload must recover durable state, not queue caches.
      const restartedFs = fs; // retains the one-shot filesystem failure, no queue cache
      const restartedStore = new JobStore(restartedFs, root);
      const second = new JobEngine(restartedStore, { "rebuild-index": new RebuildJobRunner({ fs: restartedFs, root }) });
      engines.push(second);
      await second.recoverInterruptedJobs();
      second.start();
      if (upgraded) {
        await waitFor(async () => {
          const entry = await restartedStore.getById(job.job.jobId);
          return entry?.job.phase === "activate-generation" && entry.status === "queued" && entry.nextAttemptAtMs !== undefined;
        });
        assert.equal(await loadCurrentGenerationId(fs, root), 2);
        assert.ok((await readdir(join(root, "overlays"))).length > 0);
        const catalog = await new IndexStore(fs, root).snapshotCatalog();
        assert.ok(catalog);
        assert.equal(catalog.length, count);
        second.dispose();
        await second.whenSettled();
      }
      const finalFs = upgraded ? new NodeOwnedFs(root) : restartedFs;
      const finalStore = upgraded ? new JobStore(finalFs, root) : restartedStore;
      const finalEngine = upgraded ? new JobEngine(finalStore, { "rebuild-index": new RebuildJobRunner({ fs: finalFs, root }) }) : second;
      if (upgraded) {
        engines.push(finalEngine);
        await finalEngine.recoverInterruptedJobs();
        finalEngine.start();
      }
      await waitFor(async () => (await finalStore.getById(job.job.jobId))?.status === "completed");
      await finalEngine.whenSettled();
      const generationId = upgraded ? 2 : 1;
      assert.equal(await loadCurrentGenerationId(finalFs, root), generationId);
      const verified = await verifyGenerationFully(finalFs, root, generationId);
      assert.equal(verified.noteMetadata.length, count);
      assert.equal(new Set(verified.noteMetadata.map(row => row.identity.canonicalPath)).size, count);
      assert.ok(verified.noteMetadata.every(row => row.sourceHash === newHash));
      assert.equal((await readdir(join(root, "overlays"))).length, 0);
      const index = new IndexStore(finalFs, root);
      const matches = await index.queryRelated({ queryVector: vector, queryChunkVectors: [vector], limit: 8 });
      assert.equal(matches.length, 8);
      assert.ok(matches.every(match => match.score === 1));
      assert.equal((await activity(finalStore)).state, "idle");
      if (upgraded) {
        assert.deepEqual(await artifacts(join(root, "generations/gen-1")), previous);
        await verifyGenerationFully(finalFs, root, 1);
      }
    } finally {
      for (const engine of engines) engine.dispose();
      await Promise.all(engines.map(engine => engine.whenSettled()));
      globalThis.window = priorWindow;
      await rm(root, { recursive: true, force: true });
    }
  });
}
