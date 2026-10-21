import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { buildCatalogPredicate, PRODUCTION_RELATED_VERSION } from "../engine/productionEngine";
import { JobEngine } from "../jobs/jobEngine";
import { JobStore } from "../jobs/jobStore";
import { RebuildJobRunner } from "../jobs/rebuildJob";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { buildGeneration, loadCurrentGenerationId, switchCurrentGeneration, verifyGenerationFully, type GenerationInputNote } from "./generationStore";
import { compactionSnapshotMatchesGeneration, describeCompactionSnapshot, IndexStore, manifestArtifactFingerprint, planCompaction } from "./indexStore";

const root = "/freshness";
const hash = "a".repeat(64);
const model = "synthetic";
const vector = new Float32Array([1, 0]);
const identity = stableNoteIdentity(canonicalizePath("Notes/unchanged.md"));
const annotation = stableNoteIdentity(identity.canonicalPath, "synthetic-annotation");
function note(relatedVersion?: number): GenerationInputNote {
  return { identity, sourceHash: hash, vector, chunkCount: 1, loadChunkVectors: async () => [vector],
    ...(relatedVersion !== undefined ? { relatedVersion } : {}) };
}
async function seed(fs: FakeIndexFs, relatedVersion?: number) {
  await buildGeneration(fs, root, { generationId: 1, embeddingModel: model, dimension: 2, notes: [note(relatedVersion)] });
  await switchCurrentGeneration(fs, root, 1);
}

for (const version of [undefined, 0, 1, PRODUCTION_RELATED_VERSION, 7]) {
  void test(`freshness survives generation verification and repeated compaction: ${String(version)}`, async () => {
    const fs = new FakeIndexFs();
    await seed(fs, version);
    for (const id of [1, 2, 3]) {
      if (id > 1) await new IndexStore(fs, root).compact(id);
      const verified = await verifyGenerationFully(fs, root, id);
      assert.equal(verified.noteMetadata[0].relatedVersion, version);
      const index = new IndexStore(fs, root); // no cached generation
      assert.equal((await index.getRecord(identity))?.relatedVersion, version);
      const catalog = await index.snapshotCatalog();
      assert.ok(catalog);
      assert.equal(catalog[0].relatedVersion, version);
      assert.equal(buildCatalogPredicate(catalog, PRODUCTION_RELATED_VERSION)(identity, hash), (version ?? 0) >= PRODUCTION_RELATED_VERSION);
    }
  });
}

for (const mixed of [false, true]) {
  void test(`overlay freshness survives cleanup and restart (mixed identities: ${mixed})`, async () => {
    const fs = new FakeIndexFs();
    await seed(fs);
    const index = new IndexStore(fs, root);
    await index.upsertNote({ identity: mixed ? annotation : identity, sourceHash: hash, embeddingModel: model, dimension: 2,
      noteVector: vector, chunkVectors: [vector], relatedVersion: PRODUCTION_RELATED_VERSION });
    const before = await index.snapshotCatalog();
    await index.compact(2);
    assert.deepEqual(await new IndexStore(fs, root).snapshotCatalog(), before);
    assert.equal((await verifyGenerationFully(fs, root, 2)).noteMetadata[0].relatedVersion, PRODUCTION_RELATED_VERSION);
    assert.equal((await verifyGenerationFully(fs, root, 1)).noteMetadata[0].relatedVersion, undefined, "never invent freshness in an old generation");
  });
}

void test("compaction snapshot rejects an otherwise identical generation with missing/different freshness", async () => {
  const fs = new FakeIndexFs();
  await seed(fs, PRODUCTION_RELATED_VERSION);
  const descriptor = describeCompactionSnapshot(await planCompaction(fs, root));
  const { manifest, noteMetadata } = await verifyGenerationFully(fs, root, 1);
  assert.equal(compactionSnapshotMatchesGeneration(descriptor, manifest, noteMetadata), true);
  for (const version of [undefined, 0, 1, 3]) {
    assert.equal(compactionSnapshotMatchesGeneration(descriptor, manifest, noteMetadata.map(row => ({ ...row, relatedVersion: version }))), false);
  }
});

void test("rebuild restart refuses to adopt a legacy orphan that dropped freshness", async () => {
  const fs = new FakeIndexFs();
  await seed(fs, PRODUCTION_RELATED_VERSION);
  const store = new JobStore(fs, root);
  const first = new JobEngine(store, { "rebuild-index": new RebuildJobRunner({ fs, root }) });
  const job = await first.submit({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 2 });
  await first.runOnce(); // durable discovery selects generation 2
  first.dispose();
  await buildGeneration(fs, root, { generationId: 2, embeddingModel: model, dimension: 2, notes: [note()] });
  const restartedStore = new JobStore(fs, root);
  const restarted = new JobEngine(restartedStore, { "rebuild-index": new RebuildJobRunner({ fs, root }) });
  try {
    await restarted.drain();
    assert.equal((await restartedStore.getById(job.job.jobId))?.status, "completed");
    assert.equal(await loadCurrentGenerationId(fs, root), 3, "orphan generation 2 must not be adopted");
    assert.equal((await verifyGenerationFully(fs, root, 3)).noteMetadata[0].relatedVersion, PRODUCTION_RELATED_VERSION);
  } finally { restarted.dispose(); }
});

for (const version of [-1, 0.5, NaN, Infinity]) {
  void test(`invalid freshness fails closed without replacing the active index: ${version}`, async () => {
    const fs = new FakeIndexFs();
    await seed(fs, PRODUCTION_RELATED_VERSION);
    await assert.rejects(() => buildGeneration(fs, root, { generationId: 2, embeddingModel: model, dimension: 2, notes: [note(version)] }));
    assert.equal(await loadCurrentGenerationId(fs, root), 1);
    assert.equal((await verifyGenerationFully(fs, root, 1)).noteMetadata[0].relatedVersion, PRODUCTION_RELATED_VERSION);
  });
}

for (const phase of ["verify-generation", "activate-generation"] as const) {
  void test(`upgrade restarts a legacy lossy rebuild checkpoint at ${phase} without discarding freshness`, async () => {
    const fs = new FakeIndexFs();
    await seed(fs);
    await new IndexStore(fs, root).upsertNote({ identity, sourceHash: hash, embeddingModel: model, dimension: 2,
      noteVector: vector, chunkVectors: [vector], relatedVersion: PRODUCTION_RELATED_VERSION });
    const plan = await planCompaction(fs, root);
    const legacyPlan = { ...plan, notes: plan.notes.map(({ relatedVersion: _ignored, ...entry }) => entry) };
    const legacyManifest = await buildGeneration(fs, root, { generationId: 2, embeddingModel: model, dimension: 2, notes: legacyPlan.notes });
    const store = new JobStore(fs, root);
    const engine = new JobEngine(store, { "rebuild-index": new RebuildJobRunner({ fs, root }) });
    const job = await engine.submit({ kind: "rebuild-index", trigger: "scheduled", pipelineVersion: 2 });
    await engine.runOnce();
    await store.updateJob(job.job.jobId, current => ({ ...current, job: { ...current.job, phase: "verify-generation" }, receipt: {
      kind: "rebuild", targetGenerationId: 2, built: true, verified: false, activated: false,
      snapshot: describeCompactionSnapshot(legacyPlan), builtManifestFingerprint: manifestArtifactFingerprint(legacyManifest),
    } }));
    if (phase === "activate-generation") await store.updateJob(job.job.jobId, current => ({ ...current, job: { ...current.job, phase }, receipt: {
      kind: "rebuild", targetGenerationId: 2, built: true, verified: true, activated: false,
      snapshot: describeCompactionSnapshot(legacyPlan), builtManifestFingerprint: manifestArtifactFingerprint(legacyManifest),
    } }));
    engine.dispose();
    const freshStore = new JobStore(fs, root);
    const fresh = new JobEngine(freshStore, { "rebuild-index": new RebuildJobRunner({ fs, root }) });
    try {
      await fresh.drain();
      assert.equal(await loadCurrentGenerationId(fs, root), 3);
      assert.equal((await verifyGenerationFully(fs, root, 3)).noteMetadata[0].relatedVersion, PRODUCTION_RELATED_VERSION);
      const jobs = await freshStore.list();
      assert.equal(jobs.length, 2, "exactly one replacement rebuild");
      assert.equal(jobs.filter(entry => entry.status === "completed").length, 1);
    } finally { fresh.dispose(); }
  });
}
