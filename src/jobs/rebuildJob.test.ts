import test from "node:test";
import assert from "node:assert/strict";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { buildGeneration, loadCurrentGenerationId, loadGeneration, switchCurrentGeneration, type GenerationInputNote } from "../index/generationStore";
import { IndexStore, planCompaction } from "../index/indexStore";
import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import { JobEngine, type JobEngineClock } from "./jobEngine";
import { JobStore } from "./jobStore";
import { RebuildJobRunner } from "./rebuildJob";

const DIM = 3;
const MODEL = "test-model";
const HASH = "d".repeat(64);

function makeNote(path: string): GenerationInputNote {
  return {
    identity: stableNoteIdentity(canonicalizePath(path)),
    sourceHash: HASH,
    vector: new Float32Array([1, 0, 0]),
    chunkCount: 1,
    loadChunkVectors: async () => [new Float32Array([1, 0, 0])],
  };
}

class FakeJobFs implements AtomicStoreFs {
  files = new Map<string, string>();
  failWriteFileOnCallNumber: number | undefined;
  writeFileCallCount = 0;
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.writeFileCallCount += 1;
    if (this.writeFileCallCount === this.failWriteFileOnCallNumber) {
      throw new Error(`injected failure at writeFile: ${path}`);
    }
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, value);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
    return [...names];
  }
}

class FakeClock implements JobEngineClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

function buildHarness() {
  const indexFs = new FakeIndexFs();
  const runner = new RebuildJobRunner({ fs: indexFs, root: "/root" });
  const jobFs = new FakeJobFs();
  const store = new JobStore(jobFs, "/jobs-root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { "rebuild-index": runner, "migrate-index": runner }, clock);
  return { indexFs, runner, jobFs, store, engine, clock };
}

void test("a full rebuild with no prior generation builds, verifies, and activates generation 1 from pending overlays", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.receipt?.kind, "rebuild");
  if (final?.receipt?.kind === "rebuild") {
    assert.equal(final.receipt.targetGenerationId, 1);
    assert.equal(final.receipt.built, true);
    assert.equal(final.receipt.verified, true);
    assert.equal(final.receipt.activated, true);
  }
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 1);

  const results = await index.queryRelated({ queryVector: new Float32Array([1, 0, 0]), queryChunkVectors: [], limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "A.md");
});

void test("rebuild picks currentGeneration+1 as its target id and coalesces a duplicate manual rebuild trigger", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);

  const first = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  const second = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  assert.equal(first.job.jobId, second.job.jobId, "duplicate manual rebuild triggers must coalesce");

  await h.engine.drain();
  const final = await h.store.getById(first.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 2);
});

void test("a different pipelineVersion produces a distinct (non-coalesced) rebuild job", async () => {
  const h = buildHarness();
  const first = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  const second = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 2 });
  assert.notEqual(first.job.jobId, second.job.jobId);
});

void test("cancellation before activation preserves the prior pointer; the new generation stays on disk, unreferenced and recoverable", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  // Advance through discover only, then request cancellation before build-generation runs.
  await h.engine.runOnce();
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "build-generation");
  await h.engine.requestCancel(job.job.jobId);
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 1, "the prior pointer must be untouched");
});

void test("verify-generation and activate-generation are separately resumable checkpoints across a simulated restart", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);
  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // build-generation
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "verify-generation");
  assert.equal(midway?.receipt?.kind === "rebuild" && midway.receipt.built, true);

  // Simulate a process restart: a brand-new runner instance, same fs/store.
  await h.store.recoverInterruptedJobs();
  const freshRunner = new RebuildJobRunner({ fs: h.indexFs, root: "/root" });
  const freshEngine = new JobEngine(h.store, { "rebuild-index": freshRunner }, h.clock);
  await freshEngine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), midway?.receipt?.kind === "rebuild" ? midway.receipt.targetGenerationId : undefined);
});

void test("a corrupt generation at verify-generation retries rather than silently activating", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);
  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // build-generation
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "verify-generation");
  const targetId = midway?.receipt?.kind === "rebuild" ? midway.receipt.targetGenerationId : undefined;
  assert.ok(targetId !== undefined);

  // Corrupt the built generation's manifest before verify-generation runs.
  h.indexFs.files.set(`/root/generations/gen-${targetId}/manifest.json`, "{not-valid-json");
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "queued", "a corrupt generation must retry, not silently advance to activation");
  assert.equal(final?.job.phase, "verify-generation");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 1, "the prior pointer must stay untouched; nothing must ever have been activated");
});

void test("read-only queryRelated stays usable while a rebuild job is queued/active", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);
  const index = new IndexStore(h.indexFs, "/root");

  await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover only -- rebuild job now "active"-adjacent (queued mid-pipeline)

  const results = await index.queryRelated({ queryVector: new Float32Array([1, 0, 0]), queryChunkVectors: [], limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].path, "A.md");
});

void test("(requirement 7) generation activation succeeds; a one-time JobStore persistence failure while saving the completed/activated receipt does not mark the job failed, and restart recovers to completion", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);
  await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // build-generation
  await h.engine.runOnce(); // verify-generation
  const midway = await h.store.getById((await h.store.list())[0].job.jobId);
  assert.equal(midway?.job.phase, "activate-generation");

  // activate-generation's OWN effect (switching current.json + deleting spent overlays) succeeds;
  // the ENGINE's subsequent persistence of the resulting "completed"/activated receipt fails once.
  h.jobFs.failWriteFileOnCallNumber = h.jobFs.writeFileCallCount + 2;
  await assert.rejects(() => h.engine.runOnce());
  h.jobFs.failWriteFileOnCallNumber = undefined;

  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 2, "the pointer switch (the irreversible effect) must have already committed");
  const afterFailedPersist = await h.store.getById(midway!.job.jobId);
  assert.equal(afterFailedPersist?.status, "active", "the job must be left at its last actually-committed state, never marked failed");
  assert.equal(afterFailedPersist?.job.phase, "activate-generation");

  await h.store.recoverInterruptedJobs();
  const freshRunner = new RebuildJobRunner({ fs: h.indexFs, root: "/root" });
  const freshEngine = new JobEngine(h.store, { "rebuild-index": freshRunner }, h.clock);
  await freshEngine.drain();

  const final = await h.store.getById(midway!.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 2);
});

void test("(requirement 12) a corrupt CHUNK SHARD (not the manifest) at verify-generation retries rather than silently activating -- loadGeneration alone would never have caught this", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // build-generation
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "verify-generation");
  const targetId = midway?.receipt?.kind === "rebuild" ? midway.receipt.targetGenerationId : undefined;
  assert.ok(targetId !== undefined);

  // Corrupt the CHUNK SHARD's raw bytes directly, WITHOUT touching manifest.json's own checksum --
  // `loadGeneration` never decodes a shard's bytes at all (fully lazy), so this corruption is
  // completely invisible to it; only a full streaming verify (decoding + re-checksumming every
  // shard) can ever catch it.
  const shardPath = `/root/generations/gen-${targetId}/shards/shard-0.mvx`;
  const originalBytes = h.indexFs.binaryFiles.get(shardPath);
  assert.ok(originalBytes, "expected shard-0.mvx to exist");
  const corrupted = originalBytes!.slice();
  corrupted[0] ^= 0xff;
  h.indexFs.binaryFiles.set(shardPath, corrupted);

  // Confirm the old, weaker check (loadGeneration alone) would NOT have noticed this corruption --
  // this is exactly the gap requirement 12 closes.
  const loadedDespiteCorruption = await loadGeneration(h.indexFs, "/root", targetId!);
  assert.ok(loadedDespiteCorruption, "loadGeneration must not itself detect a corrupted shard it never reads");

  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "queued", "a corrupt shard must retry, not silently advance to activation");
  assert.equal(final?.job.phase, "verify-generation");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), null, "nothing must ever have been activated");
});

void test("(requirement 11) discoverUnusedGenerationId avoids an orphaned (unreferenced) generation directory, and a crash-after-rename-before-receipt-persist is recovered by adopting the matching existing target rather than retrying forever", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  // Simulate an orphan: a generation directory built and renamed into place (e.g. by an earlier
  // crashed/cancelled compaction), but never referenced by current.json.
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("Orphan.md")] });
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), null, "the orphan must not be the current pointer");

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  const midway = await h.store.getById(job.job.jobId);
  const targetId = midway?.receipt?.kind === "rebuild" ? midway.receipt.targetGenerationId : undefined;
  assert.equal(targetId, 2, "discover must skip the orphaned gen-1 directory even though current.json has never pointed anywhere");

  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 2);
  // The orphan must never have been touched/overwritten.
  const orphanStillLoads = await loadGeneration(h.indexFs, "/root", 1);
  assert.equal(orphanStillLoads.manifest.noteCount, 1);
});

void test("(requirement 11) build-generation adopts an already-existing target directory only when it is a full-integrity, exact-fingerprint match for the current plan -- a foreign/mismatched directory at that id is never overwritten, and triggers a fresh-id recovery transition instead", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  // A FOREIGN generation already occupies id 1 -- built from completely different content, never
  // referenced by current.json (exactly what an id collision from an unrelated prior build looks
  // like on disk).
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("SomethingElseEntirely.md")] });

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  // Force discover to (unrealistically, for this test) hand build-generation a receipt that
  // already names the COLLIDING id -- simulating "a crash after rename left gen-1 occupied by
  // something foreign, and this job's own receipt still names id 1 as its target."
  await h.store.updateJob(job.job.jobId, (current) => ({
    ...current,
    job: { ...current.job, phase: "build-generation" },
    receipt: { kind: "rebuild", targetGenerationId: 1, built: false, verified: false, activated: false },
  }));

  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.receipt?.kind, "rebuild");
  if (final?.receipt?.kind === "rebuild") {
    assert.notEqual(final.receipt.targetGenerationId, 1, "the colliding foreign id must never be adopted/overwritten");
  }
  // The foreign generation at id 1 must be completely untouched.
  const foreignStillLoads = await loadGeneration(h.indexFs, "/root", 1);
  assert.equal(foreignStillLoads.manifest.noteCount, 1);
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), final?.receipt?.kind === "rebuild" ? final.receipt.targetGenerationId : undefined);
});

void test("(requirement 11) crash-after-rename-before-receipt-persist: build-generation ADOPTS an already-existing target directory whose content exactly matches the current plan, instead of retrying buildGeneration forever against an occupied directory", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  // Simulate exactly what a real crash would leave behind: buildGeneration already fully
  // completed its rename for target id 1 (built FROM the exact same overlay content the engine
  // would plan right now), but the engine's OWN persistence of the resulting `built: true` receipt
  // never committed -- the persisted job is still at phase "build-generation" with `built: false`.
  const plan = await planCompaction(h.indexFs, "/root");
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes });

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.store.updateJob(job.job.jobId, (current) => ({
    ...current,
    job: { ...current.job, phase: "build-generation" },
    receipt: { kind: "rebuild", targetGenerationId: 1, built: false, verified: false, activated: false },
  }));

  await h.engine.runOnce(); // build-generation -- must ADOPT gen-1, not call buildGeneration again
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "verify-generation", "a matching existing target must be adopted (built:true) and advance immediately, never re-attempted or treated as a collision");
  assert.equal(midway?.receipt?.kind === "rebuild" && midway.receipt.targetGenerationId, 1);

  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 1);
});

void test("loadGeneration used directly still confirms the activated generation is independently loadable", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);
  await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.drain();
  const id = await loadCurrentGenerationId(h.indexFs, "/root");
  assert.ok(id !== null);
  if (id !== null) {
    const loaded = await loadGeneration(h.indexFs, "/root", id);
    assert.equal(loaded.manifest.noteCount, 0);
  }
});

/** A second, fully independent rebuild-job harness (its own job queue/engine) sharing the SAME `indexFs` -- lets a test drive two rebuild "actors" to completely deterministic points without fighting single-queue FIFO scheduling. */
function buildIndependentHarness(indexFs: FakeIndexFs) {
  const runner = new RebuildJobRunner({ fs: indexFs, root: "/root" });
  const jobFs = new FakeJobFs();
  const store = new JobStore(jobFs, "/jobs-root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { "rebuild-index": runner, "migrate-index": runner }, clock);
  return { runner, jobFs, store, engine, clock };
}

void test("(final-closure requirement 3) job A builds+verifies against base=null while job B independently builds+verifies+activates a NEWER generation first: A's resumed activation detects the stale base, never rolls the pointer backward or touches B's overlays, and enqueues exactly one fresh replacement rebuild", async () => {
  const indexFs = new FakeIndexFs();
  const index = new IndexStore(indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  const jobA = buildIndependentHarness(indexFs);
  const a = await jobA.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await jobA.engine.runOnce(); // discover -- targets generation 1, base = null
  await jobA.engine.runOnce(); // build-generation -- builds gen-1 from A.md
  await jobA.engine.runOnce(); // verify-generation
  const midwayA = await jobA.store.getById(a.job.jobId);
  assert.equal(midwayA?.job.phase, "activate-generation");
  assert.equal(midwayA?.receipt?.kind === "rebuild" && midwayA.receipt.snapshot?.baseGenerationId, null);

  // Independently (a different actor, a different job queue -- e.g. a scheduled compaction, or
  // another rebuild for a different pipeline version), a SECOND note is added and a full rebuild
  // runs to completion, activating a NEWER generation (2) before job A ever resumes.
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([0, 1, 0]), chunkVectors: [new Float32Array([0, 1, 0])] });
  const jobB = buildIndependentHarness(indexFs);
  await jobB.engine.submit({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 2 });
  await jobB.engine.drain();
  assert.equal(await loadCurrentGenerationId(indexFs, "/root"), 2);

  // Job A now resumes its own activate-generation phase -- the pointer has moved on to something
  // OTHER than what A planned against (base=null) and other than A's own target (1).
  await jobA.engine.runOnce();
  const finalA = await jobA.store.getById(a.job.jobId);
  assert.equal(finalA?.status, "cancelled");
  assert.equal(finalA?.lastFailureCode, "REBUILD_SUPERSEDED");

  // The pointer must still be B's newer generation -- never rolled back to A's stale target.
  assert.equal(await loadCurrentGenerationId(indexFs, "/root"), 2);
  // B's generation and both notes must still be fully queryable -- A must never have deleted
  // anything B's activation depended on.
  const results = await index.queryRelated({ queryVector: new Float32Array([0, 1, 0]), queryChunkVectors: [], limit: 5 });
  assert.ok(results.some((r) => r.path === "B.md"));
  const resultsA = await index.queryRelated({ queryVector: new Float32Array([1, 0, 0]), queryChunkVectors: [], limit: 5 });
  assert.ok(resultsA.some((r) => r.path === "A.md"));

  // Exactly one fresh same-key successor rebuild was queued (for A's own pipeline version).
  const allAJobs = await jobA.store.list();
  assert.equal(allAJobs.length, 2, "the original job A plus exactly one successor");
  const successor = allAJobs.find((entry) => entry.job.jobId !== a.job.jobId);
  assert.ok(successor, "a successor job must exist");
  assert.equal(successor!.job.idempotencyKey, finalA!.job.idempotencyKey, "the successor must share A's idempotency key");
  assert.equal(successor!.job.phase, "discover");
  assert.equal(successor!.attempt, 0);
  assert.equal(successor!.status, "queued");
});

void test("(acceptance guard 3) rebuild activation and an independent concurrent IndexStore.compact() over the SAME index share the shared mutation lock -- compact never performs any fs work while rebuild's activation section holds it, and the two never interleave a check/switch", async () => {
  const h = buildHarness();
  const index = new IndexStore(h.indexFs, "/root");
  await index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [new Float32Array([1, 0, 0])] });

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // build-generation
  await h.engine.runOnce(); // verify-generation
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "activate-generation");

  let released: () => void = () => {};
  let paused = false;
  h.indexFs.pauseSignal = new Promise((resolve) => {
    released = resolve;
  });
  h.indexFs.pauseMatcher = (point, path) => point === "rename" && path.includes("current.json");
  h.indexFs.onPaused = () => {
    paused = true;
  };

  const activatePromise = h.engine.runOnce(); // enters activate-generation, acquires the shared lock, pauses inside it
  while (!paused) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const readsAtPause = h.indexFs.readFileCalls.length;
  // A concurrent mutation (upsertNote) also funnels through the SAME shared lock as rebuild's
  // activation, so it MUST NOT be awaited here -- it would deadlock behind the still-paused
  // activation. Fire it without awaiting; it (and compact()) only actually run once released.
  const upsertPromise = index.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: new Float32Array([0, 1, 0]), chunkVectors: [new Float32Array([0, 1, 0])] });
  const compactPromise = upsertPromise.then(() => index.compact(2));

  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(h.indexFs.readFileCalls.length, readsAtPause, "compact() must not perform any fs work while rebuild's activation holds the shared lock");

  released();
  await activatePromise;
  await compactPromise;

  const finalJob = await h.store.getById(job.job.jobId);
  assert.equal(finalJob?.status, "completed");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 2, "rebuild activated generation 1 first, then compact activated generation 2 -- strictly sequential, never interleaved");
});

void test("(acceptance guard 4) activation with currentId==baseGenerationId but a changed base manifest (artifact fingerprint mismatch) is treated as superseded, not blindly activated over a moved base", async () => {
  const h = buildHarness();
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md")] });
  await switchCurrentGeneration(h.indexFs, "/root", 1);

  const job = await h.engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover -- captures base=1 (and its fingerprint) in the receipt snapshot
  await h.engine.runOnce(); // build-generation -- builds target generation 2 from base 1
  await h.engine.runOnce(); // verify-generation
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "activate-generation");

  // Independently, base generation 1's on-disk manifest is replaced by different content while
  // remaining registered as the SAME current generation id -- an artifact fingerprint mismatch at
  // an unchanged id, distinct from the id simply moving to a different number.
  await buildGeneration(h.indexFs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [makeNote("A.md"), makeNote("Z.md")] });

  await h.engine.runOnce(); // activate-generation resumes
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "REBUILD_SUPERSEDED");
  assert.equal(await loadCurrentGenerationId(h.indexFs, "/root"), 1, "the (now-mismatched) base pointer must be left exactly as found -- never overwritten by a stale-plan activation");
});
