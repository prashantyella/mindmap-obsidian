import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";
import { encodeOverlayContainer } from "./overlayCodec";
import {
  deleteOverlay,
  isOwnedOverlayFileName,
  listOverlayPrefixes,
  overlayFileName,
  OverlayStoreError,
  readOverlayFull,
  readOverlayPrefix,
  writeTombstoneOverlay,
  writeUpsertOverlay,
  type UpsertOverlayInput,
} from "./overlayStore";
import { encodeVectorMatrix } from "./vectorCodec";

const DIM = 3;
const HASH = "d".repeat(64);
const MODEL = "mxbai-embed-large";

function upsertInput(path: string, overrides: Partial<UpsertOverlayInput> = {}): UpsertOverlayInput {
  return {
    identity: stableNoteIdentity(canonicalizePath(path)),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: Float32Array.from([1, 2, 3]),
    chunkVectors: [Float32Array.from([1, 0, 0])],
    ...overrides,
  };
}

void test("writeUpsertOverlay + readOverlayPrefix round-trips (lazy, note-vector only)", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const prefix = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(prefix?.operation, "upsert");
  assert.equal(prefix?.version, 1);
  assert.equal(prefix?.sourceHash, HASH);
  assert.equal(prefix?.noteVector?.length, DIM);
});

void test("writeUpsertOverlay + readOverlayFull round-trips including chunk vectors", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const full = await readOverlayFull(fs, "/root", identity);
  assert.equal(full?.chunkMatrix?.count, 1);
  assert.equal(full?.chunkMatrix?.dimension, DIM);
});

void test("readOverlayPrefix never reads any chunk-vector bytes (lazy at the I/O level)", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md", { chunkVectors: Array.from({ length: 20 }, () => Float32Array.from([1, 0, 0])) }));
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  const path = `/root/${overlayFileName(identity)}`;
  const fullBytes = fs.binaryFiles.get(path) as Uint8Array;

  fs.readRangeCalls.length = 0;
  await readOverlayPrefix(fs, "/root", identity);
  const totalRangeBytesRead = fs.readRangeCalls.filter((c) => c.path === path).reduce((sum, c) => sum + c.length, 0);
  assert.ok(totalRangeBytesRead < fullBytes.length, "the prefix read must be strictly smaller than the full container (chunk bytes never touched)");
});

void test("writeTombstoneOverlay + readOverlayPrefix round-trips and carries no vector fields", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeTombstoneOverlay(fs, "/root", { identity });
  const prefix = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(prefix?.operation, "tombstone");
  assert.equal(prefix?.sourceHash, undefined);
  assert.equal(prefix?.noteVector, undefined);
});

void test("readOverlayPrefix/readOverlayFull return null when no overlay exists for the identity", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Nope.md"));
  assert.equal(await readOverlayPrefix(fs, "/root", identity), null);
  assert.equal(await readOverlayFull(fs, "/root", identity), null);
});

void test("writeUpsertOverlay replaces the same identity's overlay atomically (only that one file changes) and auto-increments its own version", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("B.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md", { sourceHash: "e".repeat(64) }));

  const a = await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("A.md")));
  const b = await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("B.md")));
  assert.equal(a?.version, 2);
  assert.equal(a?.sourceHash, "e".repeat(64));
  assert.equal(b?.version, 1, "writing A's overlay must never touch B's file");
});

void test("a tombstone shadows a prior upsert, and can itself be shadowed by a later upsert -- versions keep advancing across operations", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  await writeTombstoneOverlay(fs, "/root", { identity });
  const afterTombstone = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(afterTombstone?.operation, "tombstone");
  assert.equal(afterTombstone?.version, 2);
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const afterUpsert = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(afterUpsert?.operation, "upsert");
  assert.equal(afterUpsert?.version, 3);
});

void test("deleteOverlay removes exactly one identity's file (and its version resets on the next write, by design) and is idempotent on an already-missing file", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("B.md"));
  await deleteOverlay(fs, "/root", identity);
  assert.equal(await readOverlayPrefix(fs, "/root", identity), null);
  assert.notEqual(await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("B.md"))), null);
  await assert.doesNotReject(() => deleteOverlay(fs, "/root", identity));

  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const afterRewrite = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(afterRewrite?.version, 1, "version starts fresh once the prior overlay was deleted -- not a globally durable counter");
});

void test("listOverlayPrefixes returns every well-formed overlay's prefix", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("B.md"));
  await writeTombstoneOverlay(fs, "/root", { identity: stableNoteIdentity(canonicalizePath("C.md")) });
  const { records, foreignFiles } = await listOverlayPrefixes(fs, "/root");
  assert.equal(records.length, 3);
  assert.deepEqual(foreignFiles, []);
});

void test("listOverlayPrefixes reports (never deletes) a foreign, non-owned filename under overlays/", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  fs.binaryFiles.set("/root/overlays/readme.txt", Uint8Array.from([1, 2, 3]));
  const { records, foreignFiles } = await listOverlayPrefixes(fs, "/root");
  assert.equal(records.length, 1);
  assert.deepEqual(foreignFiles, ["readme.txt"]);
  assert.ok(fs.binaryFiles.has("/root/overlays/readme.txt"), "a foreign file must never be deleted");
});

void test("isOwnedOverlayFileName recognizes exactly the shape overlayFileName produces", () => {
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  const basename = overlayFileName(identity).replace("overlays/", "");
  assert.ok(isOwnedOverlayFileName(basename));
  assert.ok(!isOwnedOverlayFileName("readme.txt"));
  assert.ok(!isOwnedOverlayFileName("A".repeat(64) + ".movl")); // uppercase hex is not owned (lowercase only)
});

void test("listOverlayPrefixes FAILS CLOSED (throws) when an OWNED overlay filename fails validation -- never silently skips it", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const identityB = stableNoteIdentity(canonicalizePath("B.md"));
  const ownedButCorruptPath = `/root/${overlayFileName(identityB)}`;
  fs.binaryFiles.set(ownedButCorruptPath, Uint8Array.from([1, 2, 3, 4])); // owned-shaped filename, garbage content
  await assert.rejects(() => listOverlayPrefixes(fs, "/root"), OverlayStoreError);
});

void test("listOverlayPrefixes returns an empty result (not a throw) when the overlays directory does not exist yet", async () => {
  const fs = new FakeIndexFs();
  const { records, foreignFiles } = await listOverlayPrefixes(fs, "/root");
  assert.deepEqual(records, []);
  assert.deepEqual(foreignFiles, []);
});

void test("readOverlayPrefix (targeted, single-identity) fails closed on a corrupt file", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const path = `/root/${overlayFileName(identity)}`;
  fs.corruptNextReadBytesOf.add(path);
  await assert.rejects(() => readOverlayPrefix(fs, "/root", identity), OverlayStoreError);
});

void test("readOverlayPrefix rejects a file placed at the wrong identity's path (filename/content identity mismatch)", async () => {
  const fs = new FakeIndexFs();
  const identityA = stableNoteIdentity(canonicalizePath("A.md"));
  const identityB = stableNoteIdentity(canonicalizePath("B.md"));
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  const aPath = `/root/${overlayFileName(identityA)}`;
  const bPath = `/root/${overlayFileName(identityB)}`;
  fs.binaryFiles.set(bPath, fs.binaryFiles.get(aPath) as Uint8Array);
  await assert.rejects(() => readOverlayPrefix(fs, "/root", identityB), OverlayStoreError);
});

void test("writeUpsertOverlay rejects a note/chunk vector with the wrong dimension", async () => {
  const fs = new FakeIndexFs();
  await assert.rejects(() => writeUpsertOverlay(fs, "/root", upsertInput("A.md", { noteVector: Float32Array.from([1, 2]) })), OverlayStoreError);
  await assert.rejects(() => writeUpsertOverlay(fs, "/root", upsertInput("A.md", { chunkVectors: [Float32Array.from([1, 2])] })), OverlayStoreError);
});

void test("overlay fault injection: writeFileBytes/fsync/rename failures during writeUpsertOverlay leave the prior overlay (if any) untouched", async () => {
  for (const point of ["writeFileBytes", "fsync", "rename"] as const) {
    const fs = new FakeIndexFs();
    await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
    fs.faultOnce.add(point);
    await assert.rejects(() => writeUpsertOverlay(fs, "/root", upsertInput("A.md", { sourceHash: "f".repeat(64) })));
    const loaded = await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("A.md")));
    assert.equal(loaded?.version, 1, `fault at ${point} must leave the previously-committed overlay version untouched`);
    assert.equal(loaded?.sourceHash, HASH);
  }
});

void test("overlay fault injection: a readFileBytesRange failure while checking the current version surfaces as an error without writing anything", async () => {
  const fs = new FakeIndexFs();
  await writeUpsertOverlay(fs, "/root", upsertInput("A.md"));
  fs.faultOnce.add("readFileBytesRange");
  await assert.rejects(() => writeUpsertOverlay(fs, "/root", upsertInput("A.md", { sourceHash: "f".repeat(64) })));
  const loaded = await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("A.md")));
  assert.equal(loaded?.version, 1);
  assert.equal(loaded?.sourceHash, HASH);
});

void test("writeUpsertOverlay enforces the exact MAX_MANIFEST_SHARD_ROW_COUNT boundary on a single overlay's own chunk row count", async () => {
  const fs = new FakeIndexFs();
  await assert.doesNotReject(() =>
    writeUpsertOverlay(fs, "/root", upsertInput("A.md", { chunkVectors: Array.from({ length: MAX_MANIFEST_SHARD_ROW_COUNT }, () => Float32Array.from([1, 0, 0])) })),
  );
  await assert.rejects(
    () =>
      writeUpsertOverlay(fs, "/root", upsertInput("B.md", { chunkVectors: Array.from({ length: MAX_MANIFEST_SHARD_ROW_COUNT + 1 }, () => Float32Array.from([1, 0, 0])) })),
    OverlayStoreError,
  );
});

void test("a foreign container claiming chunkCount beyond MAX_MANIFEST_SHARD_ROW_COUNT is rejected at parse time, before decodeOverlayFull ever decodes its chunk matrix", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Oversized.md"));
  const dim = 3;
  const oversizedCount = MAX_MANIFEST_SHARD_ROW_COUNT + 1;

  const noteMatrix = encodeVectorMatrix({ kind: "note", dimension: dim, count: 1, data: Float32Array.from([1, 0, 0]) });
  const chunkData = new Float32Array(oversizedCount * dim);
  for (let i = 0; i < oversizedCount; i += 1) chunkData.set([1, 0, 0], i * dim);
  const chunkMatrix = encodeVectorMatrix({ kind: "chunk", dimension: dim, count: oversizedCount, data: chunkData });

  const metadata = {
    identity,
    operation: "upsert" as const,
    version: 1,
    recordedAt: new Date().toISOString(),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: dim,
    chunkCount: oversizedCount, // claims more than MAX_MANIFEST_SHARD_ROW_COUNT
  };
  const container = encodeOverlayContainer({
    operation: "upsert",
    metadataJsonBytes: new TextEncoder().encode(JSON.stringify(metadata)),
    noteVectorBytes: noteMatrix,
    chunkVectorBytes: chunkMatrix,
  });
  fs.binaryFiles.set(`/root/${overlayFileName(identity)}`, container);

  await assert.rejects(() => readOverlayPrefix(fs, "/root", identity), OverlayStoreError);
});

void test("writeUpsertOverlay enforces the OVERLAY_METADATA_JSON_MAX_BYTES cap on its own metadata (an oversized identity path is rejected before any write)", async () => {
  const fs = new FakeIndexFs();
  const hugePath = `${"A/".repeat(400)}Note.md`; // pushes the identity's canonicalPath, and thus metadata JSON, well past the cap
  await assert.rejects(() => writeUpsertOverlay(fs, "/root", upsertInput(hugePath)), OverlayStoreError);
});
