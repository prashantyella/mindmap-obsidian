import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { effectiveIndexView } from "./effectiveIndexView";
import type { NoteRowMetadataV1 } from "./generationMetadata";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { buildGeneration, loadCurrentGenerationId, switchCurrentGeneration, verifyGenerationFully } from "./generationStore";
import { describeCompactionSnapshot, finalizeCompactionFromSnapshot, IndexStore, planCompaction } from "./indexStore";
import { listOverlayPrefixes, overlayFileName, readOverlayPrefix, writeUpsertOverlay, type OverlayPrefixRecord } from "./overlayStore";

const path = canonicalizePath("Books/Apple Books/Author/Book/Annotations/a.md");
const apple = stableNoteIdentity(path, "annotation-a");
const plain = stableNoteIdentity(path);
const oldHash = "a".repeat(64);
const newHash = "b".repeat(64);
const vector = new Float32Array([1, 0]);
const otherVector = new Float32Array([0, 1]);
const input = (identity = plain, sourceHash = newHash) => ({ identity, sourceHash, embeddingModel: "model", dimension: 2, noteVector: vector, chunkVectors: [vector] });
const row = (identity = apple): NoteRowMetadataV1 => ({ schemaVersion: 1, identity, sourceHash: oldHash, embeddingModel: "model", rowIndex: 0, chunkCount: 1, shardId: "s0" });
const overlay = (identity = plain, time = 1, operation: "upsert" | "tombstone" = "upsert"): OverlayPrefixRecord => ({ identity, operation, version: 1, recordedAt: new Date(time).toISOString(), mutationId: "test", fingerprint: "c".repeat(64), containerLength: 100, ...operation === "upsert" ? input(identity) : {} });

async function seed(fs: FakeIndexFs): Promise<IndexStore> {
  await buildGeneration(fs, "/root", { generationId: 1, embeddingModel: "model", dimension: 2, notes: [{ identity: apple, sourceHash: oldHash, vector: otherVector, chunkCount: 1, loadChunkVectors: async () => [otherVector] }] });
  await switchCurrentGeneration(fs, "/root", 1);
  return new IndexStore(fs, "/root");
}

void test("mixed Apple base/path overlay: query, refinement, lookup, catalog and verified compaction share the newest record", async () => {
  const fs = new FakeIndexFs();
  const store = await seed(fs);
  await store.upsertNote(input());
  assert.deepEqual(await store.queryRelated({ queryVector: vector, queryChunkVectors: [], limit: 10 }), [{ path, score: 1 }]);
  assert.deepEqual(await store.queryRelated({ queryVector: vector, queryChunkVectors: [vector], limit: 10 }), [{ path, score: 1 }]);
  assert.equal(await store.getRecord(apple), null, "obsolete base identity must not appear indexed");
  assert.equal((await store.getRecord(plain))?.sourceHash, newHash);
  assert.deepEqual(await store.snapshotCatalog(), [{ identity: plain, sourceHash: newHash }]);
  const plan = await planCompaction(fs, "/root");
  assert.equal(plan.notes.length, 1);
  assert.deepEqual(plan.notes[0].vector, vector);
  assert.deepEqual(await plan.notes[0].loadChunkVectors(), [vector]);
  await store.compact(2);
  const verified = await verifyGenerationFully(fs, "/root", 2);
  assert.equal(verified.manifest.noteCount, 1);
  assert.equal(verified.manifest.chunkCount, 1);
  assert.equal(verified.noteMetadata[0].sourceHash, newHash);
  assert.equal((await listOverlayPrefixes(fs, "/root")).records.length, 0);
  assert.equal((await verifyGenerationFully(fs, "/root", 1)).noteMetadata[0].sourceHash, oldHash);
  // Both existing producers continue to work, including rapid cross-key updates.
  await store.upsertNote(input(apple, "d".repeat(64)));
  await store.upsertNote(input(plain, "e".repeat(64)));
  assert.equal((await planCompaction(fs, "/root")).notes.length, 1);
  assert.deepEqual(await store.snapshotCatalog(), [{ identity: plain, sourceHash: "e".repeat(64) }]);
});

void test("stable-ID rename and path reuse survive independently; tombstones remove aliases without deleting a later occupant", () => {
  const renamed = stableNoteIdentity(canonicalizePath("Books/Apple Books/Author/Book/Annotations/renamed.md"), "annotation-a");
  const view = effectiveIndexView([row()], [overlay(renamed, 1), overlay(plain, 2)]);
  assert.deepEqual(view.overlays.map((entry) => entry.identity), [renamed, plain]);
  const deleted = effectiveIndexView([row()], [overlay(apple, 1, "tombstone"), overlay(plain, 2)]);
  assert.deepEqual(deleted.overlays.map((entry) => entry.identity), [plain]);
  assert.equal(effectiveIndexView([row()], [overlay(plain, 2, "tombstone")]).base.length, 0);
  assert.equal(effectiveIndexView([], [overlay(plain, 1), overlay(apple, 2, "tombstone")]).overlays.length, 0);
  const reused = stableNoteIdentity(path, "annotation-b");
  assert.deepEqual(effectiveIndexView([row(reused)], [overlay(apple, 2, "tombstone")]).base, [row(reused)]);
});

void test("ambiguous equal-time aliases and distinct live annotation IDs fail closed, independently of listing order", () => {
  for (const records of [[overlay(), overlay(apple)], [overlay(apple), overlay()]]) {
    assert.throws(() => effectiveIndexView([], records), (error: unknown) => error instanceof EngineError && error.code === "INDEX_IDENTITY_CONFLICT");
  }
  assert.throws(() => effectiveIndexView([row()], [overlay(stableNoteIdentity(path, "unrelated-id"), 2)]), { code: "INDEX_IDENTITY_CONFLICT" });
  // An explicit deletion followed by reuse is unambiguous.
  assert.equal(effectiveIndexView([], [overlay(apple, 1, "tombstone"), overlay(stableNoteIdentity(path, "new-id"), 2)]).overlays.length, 1);
});

void test("a changed snapshot cannot mix old note vectors and hashes with new overlay chunks", async () => {
  const fs = new FakeIndexFs();
  const store = await seed(fs);
  await store.upsertNote(input());
  const plan = await planCompaction(fs, "/root");
  await store.upsertNote({ ...input(), chunkVectors: [otherVector] });
  await assert.rejects(() => plan.notes[0].loadChunkVectors(), { code: "REBUILD_SUPERSEDED" });
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
  assert.ok(await readOverlayPrefix(fs, "/root", plain));
});

void test("interrupted alias cleanup retires older records first and leaves the latest record searchable", async () => {
  class InterruptedFs extends FakeIndexFs {
    failOn: string | undefined;
    override async unlink(file: string): Promise<void> {
      if (file === this.failOn) throw new Error("cleanup interrupted");
      return super.unlink(file);
    }
  }
  const fs = new InterruptedFs();
  const store = await seed(fs);
  await store.upsertNote(input(apple, oldHash));
  await store.upsertNote(input());
  const plan = await planCompaction(fs, "/root");
  const snapshot = describeCompactionSnapshot(plan);
  assert.equal(snapshot.overlays.length, 2, "retain every raw snapshot entry, including the superseded alias");
  await buildGeneration(fs, "/root", { generationId: 2, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes });
  fs.failOn = `/root/${overlayFileName(plain)}`;
  await assert.rejects(() => finalizeCompactionFromSnapshot(fs, "/root", 2, snapshot.overlays));
  assert.equal(await readOverlayPrefix(fs, "/root", apple), null);
  assert.deepEqual(await store.snapshotCatalog(), [{ identity: plain, sourceHash: newHash }]);
  fs.failOn = undefined;
  await finalizeCompactionFromSnapshot(fs, "/root", 2, snapshot.overlays);
  assert.equal((await listOverlayPrefixes(fs, "/root")).records.length, 0);
});

void test("cleanup preserves a concurrent replacement of a superseded alias", async () => {
  const fs = new FakeIndexFs();
  const store = await seed(fs);
  await store.upsertNote(input(apple, oldHash));
  await store.upsertNote(input());
  const plan = await planCompaction(fs, "/root");
  await buildGeneration(fs, "/root", { generationId: 2, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes });
  await store.upsertNote(input(apple, "f".repeat(64)));
  await finalizeCompactionFromSnapshot(fs, "/root", 2, describeCompactionSnapshot(plan).overlays);
  assert.deepEqual(await store.snapshotCatalog(), [{ identity: apple, sourceHash: "f".repeat(64) }]);
  assert.equal((await listOverlayPrefixes(fs, "/root")).records.length, 1);
});

void test("ambiguous raw overlays fail query, catalog, lookup and planning without replacing the pointer", async () => {
  const fs = new FakeIndexFs();
  const store = await seed(fs);
  await writeUpsertOverlay(fs, "/root", { ...input(apple), now: () => new Date(1) });
  await writeUpsertOverlay(fs, "/root", { ...input(), now: () => new Date(1) });
  for (const read of [() => store.snapshotCatalog(), () => store.getRecord(plain), () => planCompaction(fs, "/root"), () => store.queryRelated({ queryVector: vector, queryChunkVectors: [vector], limit: 10 })]) {
    await assert.rejects(read, { code: "INDEX_IDENTITY_CONFLICT" });
  }
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
});
