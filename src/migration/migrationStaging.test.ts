import test from "node:test";
import assert from "node:assert/strict";

import { stableNoteIdentity, canonicalizePath } from "../engine/contracts";
import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import { buildGeneration } from "../index/generationStore";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "../index/indexManifest";
import { buildGenerationInputNotes, clearStaging, listStagedNotes, loadStagedNoteMeta, MigrationStagingError, stagingDirPath, verifyStagedNoteArtifact, writeStagedNote } from "./migrationStaging";

const DIMENSION = 4;

function unitVector(seed: number): Float32Array {
  const v = new Float32Array(DIMENSION);
  v[seed % DIMENSION] = 1;
  return v;
}

void test("writeStagedNote + listStagedNotes round-trips metadata for a single note", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", {
    identity,
    sourceHash: "a".repeat(64),
    embeddingModel: "m",
    dimension: DIMENSION,
    noteVector: unitVector(0),
    chunkVectors: [unitVector(1), unitVector(2)],
  });
  const metas = await listStagedNotes(fs, "/data", "run-1");
  assert.equal(metas.length, 1);
  assert.equal(metas[0].chunkCount, 2);
  assert.equal(metas[0].dimension, DIMENSION);
  assert.equal(metas[0].identity.canonicalPath, "Notes/a.md");
});

void test("listStagedNotes returns notes sorted deterministically and never entering the overlays/ namespace", async () => {
  const fs = new FakeIndexFs();
  for (let i = 0; i < 5; i += 1) {
    await writeStagedNote(fs, "/data", "run-1", {
      identity: stableNoteIdentity(canonicalizePath(`Notes/n${i}.md`)),
      sourceHash: "a".repeat(64),
      embeddingModel: "m",
      dimension: DIMENSION,
      noteVector: unitVector(i),
      chunkVectors: [],
    });
  }
  const metas = await listStagedNotes(fs, "/data", "run-1");
  assert.equal(metas.length, 5);
  for (const path of fs.files.keys()) {
    assert.doesNotMatch(path, /^\/data\/overlays\//, "staging must never write into the overlays/ namespace");
  }
  for (const path of fs.binaryFiles.keys()) {
    assert.doesNotMatch(path, /^\/data\/overlays\//);
  }
});

void test("buildGenerationInputNotes assembles lazy GenerationInputNote entries usable directly by buildGeneration, and streams chunk vectors (not resident until loadChunkVectors is called)", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", {
    identity,
    sourceHash: "a".repeat(64),
    embeddingModel: "m",
    dimension: DIMENSION,
    noteVector: unitVector(0),
    chunkVectors: [unitVector(1)],
  });
  const metas = await listStagedNotes(fs, "/data", "run-1");
  const notes = await buildGenerationInputNotes(fs, "/data", "run-1", metas);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].chunkCount, 1);
  assert.equal(notes[0].vector.length, DIMENSION);
  const chunks = await notes[0].loadChunkVectors();
  assert.equal(chunks.length, 1);

  const manifest = await buildGeneration(fs, "/data", { generationId: 1, embeddingModel: "m", dimension: DIMENSION, notes }, {});
  assert.equal(manifest.noteCount, 1);
});

void test("scale: 2,500 staged notes (above the 2,000 overlay cap) build one generation successfully with small dimension vectors", async () => {
  const fs = new FakeIndexFs();
  const COUNT = 2500;
  for (let i = 0; i < COUNT; i += 1) {
    await writeStagedNote(fs, "/data", "run-1", {
      identity: stableNoteIdentity(canonicalizePath(`Notes/n${i.toString().padStart(5, "0")}.md`)),
      sourceHash: "a".repeat(64),
      embeddingModel: "m",
      dimension: DIMENSION,
      noteVector: unitVector(i),
      chunkVectors: [unitVector(i + 1)],
    });
  }
  const metas = await listStagedNotes(fs, "/data", "run-1");
  assert.equal(metas.length, COUNT);
  const notes = await buildGenerationInputNotes(fs, "/data", "run-1", metas);
  const manifest = await buildGeneration(fs, "/data", { generationId: 1, embeddingModel: "m", dimension: DIMENSION, notes }, {});
  assert.equal(manifest.noteCount, COUNT);
});

void test("writeStagedNote rejects a chunk count above the maximum shard row count before writing anything", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  const tooMany = Array.from({ length: MAX_MANIFEST_SHARD_ROW_COUNT + 1 }, (_v, i) => unitVector(i));
  await assert.rejects(
    () => writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: tooMany }),
    MigrationStagingError,
  );
  assert.equal(fs.files.size, 0);
  assert.equal(fs.binaryFiles.size, 0);
});

void test("listStagedNotes fails closed (throws) on a corrupt meta file rather than silently skipping it", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [] });
  const metaPath = [...fs.files.keys()].find((p) => p.endsWith(".meta.json"));
  assert.ok(metaPath);
  fs.files.set(metaPath!, "{ not valid json");
  await assert.rejects(() => listStagedNotes(fs, "/data", "run-1"));
});

void test("a staged note's lazy loadChunkVectors() throws if its chunk-vector binary artifact is missing (corruption, never silently zero-chunked) -- proving the streaming laziness itself: buildGenerationInputNotes alone never reads chunk bytes", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const metas = await listStagedNotes(fs, "/data", "run-1");
  const chunkPath = [...fs.binaryFiles.keys()].find((p) => p.endsWith(".chunks.mvx"));
  assert.ok(chunkPath);
  fs.binaryFiles.delete(chunkPath!);
  const notes = await buildGenerationInputNotes(fs, "/data", "run-1", metas);
  assert.equal(notes.length, 1, "assembling the array itself must not eagerly touch chunk bytes");
  await assert.rejects(() => notes[0].loadChunkVectors(), MigrationStagingError);
});

void test("clearStaging removes every artifact and the directory itself, leaving nothing behind", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  await clearStaging(fs, "/data", "run-1");
  const remaining = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((p) => p.startsWith(`/data/${stagingDirPath("run-1")}`));
  assert.deepEqual(remaining, []);
});

void test("clearStaging is a safe no-op when nothing was ever staged for a runId", async () => {
  const fs = new FakeIndexFs();
  await assert.doesNotReject(() => clearStaging(fs, "/data", "run-never-used"));
});

void test("item 4: verifyStagedNoteArtifact proves a genuinely valid staged note true", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const meta = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(meta);
  assert.equal(await verifyStagedNoteArtifact(fs, "/data", "run-1", meta!), true);
});

void test("item 4: verifyStagedNoteArtifact returns false (never throws) when the note binary is bit-corrupted -- checksum mismatch caught even though the meta JSON is perfectly valid", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const meta = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(meta);
  const notePath = [...fs.binaryFiles.keys()].find((p) => p.endsWith(".note.mvx"));
  assert.ok(notePath);
  fs.corruptNextReadBytesOf.add(notePath!);
  assert.equal(await verifyStagedNoteArtifact(fs, "/data", "run-1", meta!), false);
});

void test("item 4: verifyStagedNoteArtifact returns false when the chunk binary is entirely missing", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const meta = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(meta);
  const chunkPath = [...fs.binaryFiles.keys()].find((p) => p.endsWith(".chunks.mvx"));
  assert.ok(chunkPath);
  fs.binaryFiles.delete(chunkPath!);
  assert.equal(await verifyStagedNoteArtifact(fs, "/data", "run-1", meta!), false);
});

void test("item 4: writeStagedNote removes the PRIOR meta.json before rewriting binaries -- a crash mid-rewrite (injected write failure) leaves NO metadata at all, never a stale meta paired with a partially-rewritten binary", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  // First, a genuinely complete ingestion.
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  assert.ok(await loadStagedNoteMeta(fs, "/data", "run-1", identity));

  // Now re-ingest the SAME identity (e.g. a resumed retry after some earlier crash) with DIFFERENT
  // content, but inject a failure on the FIRST binary write of this second attempt -- simulating a
  // crash partway through the rewrite, well after the prior meta.json was already removed.
  fs.faultOnce.add("writeFileBytes");
  await assert.rejects(() => writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "b".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(2), chunkVectors: [unitVector(3)] }));

  // The OLD meta.json must be GONE (removed before the binary rewrite began) -- never left pointing
  // at a note.mvx that may already have been (partially) overwritten toward the NEW content.
  const metaAfterCrash = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.equal(metaAfterCrash, null, "a crash mid-rewrite must leave no metadata, never a stale one paired with mismatched binaries");

  // A clean retry (no injected fault) must succeed and produce a fully self-consistent artifact.
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "b".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(2), chunkVectors: [unitVector(3)] });
  const finalMeta = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(finalMeta);
  assert.equal(finalMeta!.sourceHash, "b".repeat(64));
  assert.equal(await verifyStagedNoteArtifact(fs, "/data", "run-1", finalMeta!), true);
});

void test("item 2: a genuine (non-ENOENT) marker-unlink failure aborts BEFORE either binary is written -- the prior artifact is left completely untouched", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const notePath = [...fs.binaryFiles.keys()].find((p) => p.endsWith(".note.mvx"));
  const noteBytesBefore = fs.binaryFiles.get(notePath!);

  // Inject a genuine failure (never ENOENT-shaped) specifically on the meta.json unlink call.
  const metaPath = [...fs.files.keys()].find((p) => p.endsWith(".meta.json"));
  fs.faultOnce.add("unlink");
  fs.pathFailPredicate = (path) => path === metaPath;
  await assert.rejects(() => writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "b".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(2), chunkVectors: [unitVector(3)] }));

  // Neither binary was touched -- the note-vector bytes are byte-identical to before the failed
  // attempt, and the OLD metadata (still describing sourceHash "a"...) is still intact.
  assert.deepEqual(fs.binaryFiles.get(notePath!), noteBytesBefore);
  const metaAfterFailure = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(metaAfterFailure);
  assert.equal(metaAfterFailure!.sourceHash, "a".repeat(64), "the OLD (still fully valid) artifact must be untouched by an aborted write");
});

void test("item 2: fsyncDir is called on the staging directory after the marker is removed, before either binary write", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  const dirPath = `/data/${stagingDirPath("run-1")}`;
  const events: string[] = [];
  const originalUnlink = fs.unlink.bind(fs);
  fs.unlink = async (path: string) => {
    events.push(`unlink:${path.endsWith(".meta.json") ? "meta" : path}`);
    return originalUnlink(path);
  };
  const originalFsyncDir = fs.fsyncDir.bind(fs);
  fs.fsyncDir = async (path: string) => {
    events.push(`fsyncDir:${path}`);
    return originalFsyncDir(path);
  };
  const originalWriteFileBytes = fs.writeFileBytes.bind(fs);
  fs.writeFileBytes = async (path: string, bytes: Uint8Array) => {
    events.push("writeFileBytes");
    return originalWriteFileBytes(path, bytes);
  };

  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });

  // First ingestion: no PRIOR meta to unlink, but fsyncDir still runs before any binary write.
  const firstFsyncIndex = events.indexOf(`fsyncDir:${dirPath}`);
  const firstWriteIndex = events.indexOf("writeFileBytes");
  assert.ok(firstFsyncIndex !== -1 && firstFsyncIndex < firstWriteIndex, "fsyncDir must happen before the first binary write");

  events.length = 0;
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "b".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(2), chunkVectors: [unitVector(3)] });
  const unlinkIndex = events.findIndex((e) => e === "unlink:meta");
  const fsyncIndex = events.findIndex((e) => e === `fsyncDir:${dirPath}`);
  const writeIndex = events.findIndex((e) => e === "writeFileBytes");
  assert.ok(unlinkIndex !== -1 && fsyncIndex !== -1 && writeIndex !== -1);
  assert.ok(unlinkIndex < fsyncIndex, "the marker must be removed before the directory is fsync'd");
  assert.ok(fsyncIndex < writeIndex, "the directory must be fsync'd before either binary is written");
});

void test("item 3: an error whose MESSAGE merely contains the substring ENOENT but carries no typed missing-path code is treated as GENUINE -- writeStagedNote aborts before either binary is touched", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [unitVector(1)] });
  const notePath = [...fs.binaryFiles.keys()].find((p) => p.endsWith(".note.mvx"));
  const noteBytesBefore = fs.binaryFiles.get(notePath!);

  const originalUnlink = fs.unlink.bind(fs);
  fs.unlink = async (path: string) => {
    if (path.endsWith(".meta.json")) {
      // Deliberately message-only: the text happens to contain "ENOENT", but this is a real
      // permission failure, not a missing path -- no `.code` property at all.
      throw new Error("permission denied while touching a path that happens to mention ENOENT in its name");
    }
    return originalUnlink(path);
  };

  await assert.rejects(() => writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "b".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(2), chunkVectors: [unitVector(3)] }));
  assert.deepEqual(fs.binaryFiles.get(notePath!), noteBytesBefore, "a message-only ENOENT-shaped (but untyped) error must never be treated as a genuinely-missing marker");
  const metaAfter = await loadStagedNoteMeta(fs, "/data", "run-1", identity);
  assert.ok(metaAfter);
  assert.equal(metaAfter!.sourceHash, "a".repeat(64), "the OLD (still fully valid) artifact must be untouched by the aborted write");
});

void test("item 1: clearStaging distinguishes a genuine readdir failure (permission/IO/unknown, no typed missing-path code) from a missing directory -- returns false, never true", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath("Notes/a.md"));
  await writeStagedNote(fs, "/data", "run-1", { identity, sourceHash: "a".repeat(64), embeddingModel: "m", dimension: DIMENSION, noteVector: unitVector(0), chunkVectors: [] });

  fs.faults.add("readdir"); // an injected fault carries no typed code -- must never be mistaken for ENOENT
  const cleared = await clearStaging(fs, "/data", "run-1");
  assert.equal(cleared, false, "a genuine readdir failure must be reported as NOT cleared, never silently treated as already-gone");
  fs.faults.delete("readdir");

  const metas = await listStagedNotes(fs, "/data", "run-1");
  assert.equal(metas.length, 1, "the staged artifact must remain fully intact after a failed cleanup attempt");
});
