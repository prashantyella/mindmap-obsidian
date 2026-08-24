import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { computeMetadataChecksumHex } from "./generationMetadata";
import {
  buildGeneration,
  cleanupStaleStaging,
  generationDirPath,
  GenerationBuildCancelledError,
  GenerationStoreError,
  loadCurrentGenerationId,
  loadGeneration,
  switchCurrentGeneration,
  type BuildGenerationInput,
  type GenerationInputNote,
} from "./generationStore";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";
import { checksumHex, encodeVectorMatrix, type VectorMatrix } from "./vectorCodec";

const DIM = 4;
const MODEL = "mxbai-embed-large";
const HASH = "b".repeat(64);

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function vector(random: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) v[i] = random() * 2 - 1;
  return v;
}

function makeNote(path: string, chunkCount: number, random: () => number): GenerationInputNote {
  return {
    identity: stableNoteIdentity(canonicalizePath(path)),
    sourceHash: HASH,
    vector: vector(random),
    chunkCount,
    loadChunkVectors: async () => Array.from({ length: chunkCount }, () => vector(random)),
  };
}

function buildInput(notes: GenerationInputNote[], generationId = 1): BuildGenerationInput {
  return { generationId, embeddingModel: MODEL, dimension: DIM, notes };
}

function mvxPath(fs: FakeIndexFs, generationId: number, fileBase: "notes" | `shards/${string}`): string {
  void fs;
  return `/root/${generationDirPath(generationId)}/${fileBase}.mvx`;
}

void test("buildGeneration + loadGeneration round-trips a small generation with chunks across two shards", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(1);
  const notes = Array.from({ length: 5 }, (_, i) => makeNote(`Note-${i}.md`, 2, random));
  const manifest = await buildGeneration(fs, "/root", buildInput(notes));
  assert.equal(manifest.noteCount, 5);
  assert.equal(manifest.chunkCount, 10);

  const loaded = await loadGeneration(fs, "/root", 1);
  assert.equal(loaded.noteMatrix.count, 5);
  assert.equal(loaded.manifest.generationId, 1);
  assert.equal(loaded.shardIdByNoteKey.size, 5);

  // Vectors are raw binary files, never JSON.
  assert.ok(fs.binaryFiles.has(mvxPath(fs, 1, "notes")));
  assert.ok(!fs.files.has(mvxPath(fs, 1, "notes")));
});

void test("buildGeneration leaves generations/ and current.json untouched if the build fails before rename", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(2);
  const notes = [makeNote("A.md", 1, random)];
  fs.faults.add("writeFileBytes");
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput(notes)), GenerationStoreError);
  const generationFiles = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((k) => k.includes("/generations/"));
  assert.deepEqual(generationFiles, []);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

void test("buildGeneration fault injection: every write/fsync/rename point during build fails closed without corrupting generations/", async () => {
  const points: Array<"writeFile" | "writeFileBytes" | "fsync" | "rename"> = ["writeFile", "writeFileBytes", "fsync", "rename"];
  for (const point of points) {
    const fs = new FakeIndexFs();
    const random = seededRandom(3);
    const notes = [makeNote("A.md", 1, random), makeNote("B.md", 0, random)];
    await buildGeneration(fs, "/root", buildInput(notes, 100));
    fs.faultOnce.add(point);
    await assert.rejects(() => buildGeneration(fs, "/root", buildInput(notes, 101)), GenerationStoreError);
    const gen101Files = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((k) => k.includes(generationDirPath(101)));
    assert.deepEqual(gen101Files, [], `fault at ${point} must not leave a partial generations/${101} directory`);
    const loaded = await loadGeneration(fs, "/root", 100);
    assert.equal(loaded.noteMatrix.count, 2);
  }
});

void test("switchCurrentGeneration verifies the target generation loads before writing the pointer, and never activates a generation that was only built (not switched)", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(4);
  const notes = [makeNote("A.md", 1, random)];
  await buildGeneration(fs, "/root", buildInput(notes, 5));
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null, "building alone must not activate the generation");

  fs.faultOnce.add("rename"); // current.json is itself written via rename (AtomicStore)
  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 5), Error);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
  const loaded = await loadGeneration(fs, "/root", 5);
  assert.equal(loaded.manifest.generationId, 5);

  await switchCurrentGeneration(fs, "/root", 5);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 5);
});

void test("switchCurrentGeneration refuses to point current.json at a generation that does not exist or fails to load", async () => {
  const fs = new FakeIndexFs();
  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 999), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);

  const random = seededRandom(41);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 42));
  // Corrupt the generation before it's ever switched to.
  const notesPath = mvxPath(fs, 42, "notes");
  const bytes = fs.binaryFiles.get(notesPath);
  if (bytes) bytes[10] ^= 0xff;
  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 42), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null, "the pointer must never have been written for an unverifiable generation");
});

void test("loadCurrentGenerationId fails closed on a corrupt pointer file rather than guessing another generation", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(6);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 7));
  await switchCurrentGeneration(fs, "/root", 7);
  fs.corruptNextReadOf.add("/root/current.json");
  await assert.rejects(() => loadCurrentGenerationId(fs, "/root"), GenerationStoreError);
});

void test("loadGeneration rejects a manifest with a checksum that no longer matches its notes.mvx", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(8);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 9));
  const manifestPath = `/root/${generationDirPath(9)}/manifest.json`;
  const raw = JSON.parse(await fs.readFile(manifestPath)) as { data: { noteMatrixChecksum: string } };
  raw.data.noteMatrixChecksum = "c".repeat(64);
  fs.files.set(manifestPath, JSON.stringify(raw));
  await assert.rejects(() => loadGeneration(fs, "/root", 9), GenerationStoreError);
});

void test("loadGeneration rejects a manifest with a dimension that no longer matches notes.mvx", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(10);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 11));
  const manifestPath = `/root/${generationDirPath(11)}/manifest.json`;
  const raw = JSON.parse(await fs.readFile(manifestPath)) as { data: { dimension: number } };
  raw.data.dimension = DIM + 1;
  fs.files.set(manifestPath, JSON.stringify(raw));
  await assert.rejects(() => loadGeneration(fs, "/root", 11), GenerationStoreError);
});

void test("loadGeneration rejects a manifest whose embeddingModel no longer matches notes.meta.json", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(12);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 13));
  const manifestPath = `/root/${generationDirPath(13)}/manifest.json`;
  const raw = JSON.parse(await fs.readFile(manifestPath)) as { data: { embeddingModel: string } };
  raw.data.embeddingModel = "different-model";
  fs.files.set(manifestPath, JSON.stringify(raw));
  await assert.rejects(() => loadGeneration(fs, "/root", 13), GenerationStoreError);
});

void test("loadGeneration rejects a corrupted (single flipped byte) notes.mvx -- binary truncation/corruption is caught", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(14);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 15));
  const notesPath = mvxPath(fs, 15, "notes");
  const bytes = fs.binaryFiles.get(notesPath) as Uint8Array;
  bytes[20] ^= 0xff;
  await assert.rejects(() => loadGeneration(fs, "/root", 15), GenerationStoreError);
});

void test("loadGeneration rejects a truncated notes.mvx", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(141);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 151));
  const notesPath = mvxPath(fs, 151, "notes");
  const bytes = fs.binaryFiles.get(notesPath) as Uint8Array;
  fs.binaryFiles.set(notesPath, bytes.slice(0, bytes.length - 4));
  await assert.rejects(() => loadGeneration(fs, "/root", 151), GenerationStoreError);
});

void test("loadGeneration rejects note metadata whose checksum no longer matches the manifest", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(16);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random), makeNote("B.md", 1, random)], 17));
  const metaPath = `/root/${generationDirPath(17)}/notes.meta.json`;
  const raw = JSON.parse(await fs.readFile(metaPath)) as { data: Array<{ sourceHash: string }> };
  raw.data[0].sourceHash = "c".repeat(64);
  fs.files.set(metaPath, JSON.stringify(raw));
  await assert.rejects(() => loadGeneration(fs, "/root", 17), GenerationStoreError);
});

void test("loadShard rejects a shard whose offsets no longer match the manifest -- loadGeneration itself never has to read shard files just to detect this (routing comes from note metadata, not shard reads)", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(18);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 2, random)], 19));
  const offsetsPath = `/root/${generationDirPath(19)}/shards/shard-0.offsets.json`;
  const raw = JSON.parse(await fs.readFile(offsetsPath)) as { data: Array<{ length: number }> };
  raw.data[0].length = 999;
  fs.files.set(offsetsPath, JSON.stringify(raw));
  // loadGeneration succeeds -- it never reads shard files at all.
  const loaded = await loadGeneration(fs, "/root", 19);
  await assert.rejects(() => loaded.loadShard("shard-0"), GenerationStoreError);
});

void test("loadGeneration.loadShard re-validates a shard's matrix checksum on every call", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(20);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 2, random)], 21));
  const loaded = await loadGeneration(fs, "/root", 21);
  const shard = await loaded.loadShard("shard-0");
  assert.equal(shard.matrix.count, 2);

  const shardVectorPath = `/root/${generationDirPath(21)}/shards/shard-0.mvx`;
  const bytes = fs.binaryFiles.get(shardVectorPath) as Uint8Array;
  bytes[20] ^= 0xff;
  await assert.rejects(() => loaded.loadShard("shard-0"), GenerationStoreError);
});

void test("buildGeneration rejects a note with more chunks than fit in a single shard", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(22);
  const notes = [makeNote("A.md", MAX_MANIFEST_SHARD_ROW_COUNT + 1, random)];
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput(notes)), GenerationStoreError);
});

void test("buildGeneration rejects a duplicate note identity in its input", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(23);
  const note = makeNote("A.md", 1, random);
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput([note, { ...note }])), GenerationStoreError);
});

void test("buildGeneration builds an empty (zero-note) generation without a sample query", async () => {
  const fs = new FakeIndexFs();
  const manifest = await buildGeneration(fs, "/root", buildInput([]));
  assert.equal(manifest.noteCount, 0);
  assert.equal(manifest.chunkCount, 0);
  const loaded = await loadGeneration(fs, "/root", 1);
  assert.equal(loaded.noteMatrix.count, 0);
});

void test("buildGeneration packs chunks into multiple shards once MAX_MANIFEST_SHARD_ROW_COUNT is exceeded, never splitting one note's chunks across shards", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(24);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  const manifest = await buildGeneration(fs, "/root", buildInput(notes, 30));
  assert.equal(manifest.chunkShards.length, 2, "each note's chunk block alone exceeds half the shard cap, so they cannot share one shard");
  const loaded = await loadGeneration(fs, "/root", 30);
  const shardForA = loaded.shardIdByNoteKey.get("path:A.md");
  const shardForB = loaded.shardIdByNoteKey.get("path:B.md");
  assert.notEqual(shardForA, shardForB);
});

void test("buildGeneration is genuinely streaming: instrumented loaders prove the sum of chunk rows loaded between consecutive shard writes never exceeds MAX_MANIFEST_SHARD_ROW_COUNT, and each note's loader fires exactly once, only when its own output shard is being written", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(70);
  // Four notes, each large enough that only one fits per shard (mirrors the multi-shard test),
  // forcing 4 distinct output shards so there is real streaming behavior to observe.
  const perNoteChunks = Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6);
  const loadCallLog: { path: string; rows: number }[] = [];
  function instrumentedNote(path: string): GenerationInputNote {
    return {
      identity: stableNoteIdentity(canonicalizePath(path)),
      sourceHash: HASH,
      vector: vector(random),
      chunkCount: perNoteChunks,
      loadChunkVectors: async () => {
        loadCallLog.push({ path, rows: perNoteChunks });
        return Array.from({ length: perNoteChunks }, () => vector(random));
      },
    };
  }
  const notes = ["A.md", "B.md"].map((p) => instrumentedNote(p));

  // Reconstruct shard boundaries from the ORDER in which each shard's vector file is atomically
  // committed (AtomicBinaryStore.save() renames its temp file onto the final shard-<n>.mvx path
  // once that shard is fully written) -- partition the loader-call log by those boundaries and
  // assert each partition's row sum never exceeds one shard's cap.
  const shardWriteMarkers: number[] = [];
  const originalRename = fs.rename.bind(fs);
  fs.rename = async (fromPath: string, toPath: string) => {
    await originalRename(fromPath, toPath);
    if (toPath.includes("/shards/") && toPath.endsWith(".mvx")) {
      shardWriteMarkers.push(loadCallLog.length);
    }
  };

  await buildGeneration(fs, "/root", buildInput(notes, 80));

  assert.equal(shardWriteMarkers.length, 2, "setup sanity check: two notes, each forcing its own shard");
  let previousBoundary = 0;
  for (const marker of shardWriteMarkers) {
    const segment = loadCallLog.slice(previousBoundary, marker);
    const rowsInSegment = segment.reduce((sum, entry) => sum + entry.rows, 0);
    assert.ok(rowsInSegment <= MAX_MANIFEST_SHARD_ROW_COUNT, `rows loaded before one shard write (${rowsInSegment}) must never exceed MAX_MANIFEST_SHARD_ROW_COUNT (${MAX_MANIFEST_SHARD_ROW_COUNT})`);
    previousBoundary = marker;
  }
  assert.equal(loadCallLog.length, notes.length, "each note's loadChunkVectors must be called exactly once");
});

void test("buildGeneration cancellation via AbortSignal before the rename leaves generations/ and current.json untouched", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(43);
  const notes = [makeNote("A.md", 1, random)];
  const controller = new AbortController();
  // Let the build proceed through every write and all of verifyStagedGeneration -- abort is only
  // observed right at the LAST checkpoint, immediately before the final staging->generations
  // rename -- by triggering it the moment verification starts reading notes.mvx back, then
  // letting that read (and the rest of verification) proceed completely normally.
  let released: () => void = () => {};
  fs.pauseSignal = new Promise((resolve) => {
    released = resolve;
  });
  fs.pauseMatcher = (point, path) => point === "readFileBytes" && path.includes("/staging/") && path.endsWith("/notes.mvx");
  fs.onPaused = () => {
    controller.abort();
    released();
  };

  await assert.rejects(() => buildGeneration(fs, "/root", buildInput(notes, 44), { signal: controller.signal }), GenerationBuildCancelledError);
  const generationFiles = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((k) => k.includes(generationDirPath(44)));
  assert.deepEqual(generationFiles, []);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);

  const removed = await cleanupStaleStaging(fs, "/root");
  assert.ok(removed > 0, "the cancelled build's staging directory must be safely cleanable");
});

void test("buildGeneration cancellation is a distinct signal from a plain failure -- a fault-injected failure is NOT reported as cancellation", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(45);
  fs.faultOnce.add("writeFileBytes");
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 46)), (error: unknown) => {
    assert.ok(error instanceof GenerationStoreError);
    assert.ok(!(error instanceof GenerationBuildCancelledError), "a plain fault-injected failure must not be reported as GenerationBuildCancelledError");
    return true;
  });
});

void test("cleanupStaleStaging removes leftover staging directories from an interrupted build without touching generations/ or current.json", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(25);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 40));
  await switchCurrentGeneration(fs, "/root", 40);

  // Fail only the final staging->generations directory rename (never an AtomicStore-internal
  // temp-file rename, which always includes the ".atomic-tmp-" marker), so every artifact under
  // staging is fully written and committed before the failure.
  fs.faults.add("rename");
  fs.pathFailPredicate = (path) => !path.includes(".atomic-tmp-");
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput([makeNote("B.md", 1, random)], 41)));
  fs.faults.delete("rename");

  const stagingFilesBefore = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((k) => k.includes("/staging/"));
  assert.ok(stagingFilesBefore.length > 0, "expected a leftover staging directory to clean up");

  const removed = await cleanupStaleStaging(fs, "/root");
  assert.ok(removed > 0);
  const stagingFilesAfter = [...fs.files.keys(), ...fs.binaryFiles.keys()].filter((k) => k.includes("/staging/"));
  assert.deepEqual(stagingFilesAfter, []);

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 40);
  const loaded = await loadGeneration(fs, "/root", 40);
  assert.equal(loaded.noteMatrix.count, 1);
});

void test("cleanupStaleStaging is a no-op (returns 0) when there is no staging directory at all", async () => {
  const fs = new FakeIndexFs();
  assert.equal(await cleanupStaleStaging(fs, "/root"), 0);
});

void test("cleanupStaleStaging never deletes outside its own staging root, even if a directory listing returns a traversal-like entry name", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(50);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 60));
  await switchCurrentGeneration(fs, "/root", 60);
  fs.dirs.add("/root/staging/../generations/gen-60");
  const originalReaddir = fs.readdir.bind(fs);
  fs.readdir = async (dirPath: string) => {
    if (dirPath === "/root/staging") return ["../generations"];
    return originalReaddir(dirPath);
  };

  await cleanupStaleStaging(fs, "/root");

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 60);
  const loaded = await loadGeneration(fs, "/root", 60);
  assert.equal(loaded.noteMatrix.count, 1);
});

void test("FakeIndexFs.unlink rejects a directory (matching real fs semantics) and FakeIndexFs.rmdir rejects a non-empty directory", async () => {
  const fs = new FakeIndexFs();
  await fs.mkdir("/root/staging/token");
  await fs.writeFileBytes("/root/staging/token/file.mvx", Uint8Array.from([1]));
  await assert.rejects(() => fs.unlink("/root/staging/token"));
  await assert.rejects(() => fs.rmdir("/root/staging/token"));
  await fs.unlink("/root/staging/token/file.mvx");
  await fs.rmdir("/root/staging/token");
  assert.equal(await fs.exists("/root/staging/token"), false);
});

void test("cleanupStaleStaging removes an interrupted multi-shard build's leftover staging directory, including its nested shards/ subdirectory (files-first, then bottom-up rmdir on now-empty directories -- never unlink on a directory)", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(95);
  await buildGeneration(fs, "/root", buildInput([makeNote("A.md", 1, random)], 200));
  await switchCurrentGeneration(fs, "/root", 200);

  // Force a multi-shard generation (so staging/<token>/shards/ actually exists) whose final
  // staging->generations rename fails, leaving a nested leftover directory tree behind.
  const notes = [
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("C.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  fs.faults.add("rename");
  fs.pathFailPredicate = (path) => !path.includes(".atomic-tmp-");
  await assert.rejects(() => buildGeneration(fs, "/root", buildInput(notes, 201)));
  fs.faults.delete("rename");

  const stagingEntriesBefore = [...fs.files.keys(), ...fs.binaryFiles.keys(), ...fs.dirs].filter((k) => k.includes("/staging/"));
  assert.ok(stagingEntriesBefore.some((k) => k.endsWith("/shards")), "setup sanity check: a nested shards/ subdirectory must exist");

  const removed = await cleanupStaleStaging(fs, "/root");
  assert.ok(removed > 0);
  const stagingEntriesAfter = [...fs.files.keys(), ...fs.binaryFiles.keys(), ...fs.dirs].filter((k) => k.includes("/staging/"));
  assert.deepEqual(stagingEntriesAfter, [], "every leftover file AND directory, including the nested shards/ subdirectory, must be gone");

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 200);
});

void test("switchCurrentGeneration rejects a corruption in a NON-sample (later) shard's vectors, not just the first/sample shard -- proving full streaming verification touches every shard before the pointer can move", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(96);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  const manifest = await buildGeneration(fs, "/root", buildInput(notes, 91));
  assert.equal(manifest.chunkShards.length, 2, "setup sanity check: two shards");

  // Corrupt shard-1 (the SECOND shard -- never the sample shard the end-to-end refine query
  // touches, which is always shard-0) after the build has already fully succeeded.
  const shard1Path = `/root/${generationDirPath(91)}/shards/shard-1.mvx`;
  const bytes = fs.binaryFiles.get(shard1Path) as Uint8Array;
  bytes[20] ^= 0xff;

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 91), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null, "current.json must never be written when any shard -- including a non-sample one -- fails verification");
});

void test("switchCurrentGeneration rejects a corruption in a NON-sample shard's offsets file too", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(97);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  await buildGeneration(fs, "/root", buildInput(notes, 92));
  const offsetsPath = `/root/${generationDirPath(92)}/shards/shard-1.offsets.json`;
  const raw = JSON.parse(await fs.readFile(offsetsPath)) as { data: Array<{ length: number }> };
  raw.data[0].length = 999;
  fs.files.set(offsetsPath, JSON.stringify(raw));

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 92), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

async function readEnvelope<T>(fs: FakeIndexFs, path: string): Promise<{ schemaVersion: number; data: T }> {
  return JSON.parse(await fs.readFile(path)) as { schemaVersion: number; data: T };
}

function writeEnvelope(fs: FakeIndexFs, path: string, envelope: unknown): void {
  fs.files.set(path, JSON.stringify(envelope));
}

void test("switchCurrentGeneration rejects an identity appearing in more than one chunk shard's offsets, even with a recomputed (matching) offsetChecksum", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(300);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  const manifest = await buildGeneration(fs, "/root", buildInput(notes, 300));
  assert.equal(manifest.chunkShards.length, 2, "setup sanity check: two shards");

  // Retarget shard-1's only offset entry at A's identity (already fully covered by shard-0)
  // instead of B's -- same start/length, so shard-1's own [0, count) partition stays exactly
  // valid, and the offsetChecksum is recomputed so THAT check alone cannot be what catches this.
  const shard1OffsetsPath = `/root/${generationDirPath(300)}/shards/shard-1.offsets.json`;
  const offsetsEnvelope = await readEnvelope<Array<{ identity: unknown; start: number; length: number }>>(fs, shard1OffsetsPath);
  offsetsEnvelope.data[0].identity = notes[0].identity;
  const newOffsetChecksum = computeMetadataChecksumHex(offsetsEnvelope.data);
  writeEnvelope(fs, shard1OffsetsPath, offsetsEnvelope);

  const manifestPath = `/root/${generationDirPath(300)}/manifest.json`;
  const manifestEnvelope = await readEnvelope<{ chunkShards: Array<{ shardId: string; offsetChecksum: string }> }>(fs, manifestPath);
  const shard1Entry = manifestEnvelope.data.chunkShards.find((s) => s.shardId === "shard-1");
  assert.ok(shard1Entry);
  shard1Entry.offsetChecksum = newOffsetChecksum;
  writeEnvelope(fs, manifestPath, manifestEnvelope);

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 300), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

void test("switchCurrentGeneration rejects a shard whose offsets reference a note whose notes.meta.json declares a DIFFERENT owning shardId", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(301);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  await buildGeneration(fs, "/root", buildInput(notes, 301));

  // A's chunks physically live in shard-0's offsets (untouched); only notes.meta.json's OWN
  // declared shardId for A is corrupted to point at shard-1 instead -- and the metadata checksum
  // is recomputed so that check alone cannot be what catches this.
  const metaPath = `/root/${generationDirPath(301)}/notes.meta.json`;
  const metaEnvelope = await readEnvelope<Array<{ identity: { canonicalPath: string }; shardId?: string }>>(fs, metaPath);
  const aRow = metaEnvelope.data.find((row) => row.identity.canonicalPath === "A.md");
  assert.ok(aRow);
  assert.equal(aRow.shardId, "shard-0", "setup sanity check: A was actually built into shard-0");
  aRow.shardId = "shard-1";
  const newMetaChecksum = computeMetadataChecksumHex(metaEnvelope.data);
  writeEnvelope(fs, metaPath, metaEnvelope);

  const manifestPath = `/root/${generationDirPath(301)}/manifest.json`;
  const manifestEnvelope = await readEnvelope<{ noteMetadataChecksum: string }>(fs, manifestPath);
  manifestEnvelope.data.noteMetadataChecksum = newMetaChecksum;
  writeEnvelope(fs, manifestPath, manifestEnvelope);

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 301), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

void test("switchCurrentGeneration rejects an offset entry for a note notes.meta.json declares has zero chunks (no shardId at all)", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(304);
  const notes = [makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random), makeNote("C.md", 0, random)];
  const manifest = await buildGeneration(fs, "/root", buildInput(notes, 304));
  assert.equal(manifest.chunkShards.length, 1, "setup sanity check: one shard, owned entirely by A");

  // Retarget shard-0's only offset entry at C's identity (declared chunkCount 0, so no shardId at
  // all in notes.meta.json) instead of A's -- same start/length, so the shard's own [0, count)
  // partition stays exactly valid, and the offsetChecksum is recomputed.
  const shard0OffsetsPath = `/root/${generationDirPath(304)}/shards/shard-0.offsets.json`;
  const offsetsEnvelope = await readEnvelope<Array<{ identity: unknown; start: number; length: number }>>(fs, shard0OffsetsPath);
  offsetsEnvelope.data[0].identity = notes[1].identity;
  const newOffsetChecksum = computeMetadataChecksumHex(offsetsEnvelope.data);
  writeEnvelope(fs, shard0OffsetsPath, offsetsEnvelope);

  const manifestPath = `/root/${generationDirPath(304)}/manifest.json`;
  const manifestEnvelope = await readEnvelope<{ chunkShards: Array<{ shardId: string; offsetChecksum: string }> }>(fs, manifestPath);
  const shard0Entry = manifestEnvelope.data.chunkShards.find((s) => s.shardId === "shard-0");
  assert.ok(shard0Entry);
  shard0Entry.offsetChecksum = newOffsetChecksum;
  writeEnvelope(fs, manifestPath, manifestEnvelope);

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 304), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

void test("switchCurrentGeneration rejects a non-sample shard whose dimension no longer matches manifest.dimension, even with a recomputed (matching) checksum -- proves this is caught by shape validation, not checksum comparison; loadGeneration().loadShard() rejects it too", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(302);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  const manifest = await buildGeneration(fs, "/root", buildInput(notes, 302));
  assert.equal(manifest.chunkShards.length, 2, "setup sanity check: two shards");
  const shard1Entry = manifest.chunkShards.find((s) => s.shardId === "shard-1");
  assert.ok(shard1Entry);

  // Re-encode shard-1 (the NON-sample shard -- the end-to-end sample query always runs against
  // shard-0) with the WRONG dimension (DIM + 1), same row count, and otherwise perfectly valid
  // (unit-norm) rows -- then recompute its checksum from the tampered bytes, so the checksum
  // check itself passes; only explicit shape validation can catch this.
  const wrongDimension = DIM + 1;
  const wrongData = new Float32Array(shard1Entry.count * wrongDimension);
  for (let row = 0; row < shard1Entry.count; row += 1) {
    wrongData[row * wrongDimension] = 1; // unit vector along the first axis: valid L2 norm 1
  }
  const wrongMatrix: VectorMatrix = { kind: "chunk", dimension: wrongDimension, count: shard1Entry.count, data: wrongData };
  const wrongEncoded = encodeVectorMatrix(wrongMatrix);
  const wrongChecksum = checksumHex(wrongEncoded);
  fs.binaryFiles.set(`/root/${generationDirPath(302)}/shards/shard-1.mvx`, wrongEncoded);

  const manifestPath = `/root/${generationDirPath(302)}/manifest.json`;
  const manifestEnvelope = await readEnvelope<{ chunkShards: Array<{ shardId: string; checksum: string }> }>(fs, manifestPath);
  const shard1ManifestEntry = manifestEnvelope.data.chunkShards.find((s) => s.shardId === "shard-1");
  assert.ok(shard1ManifestEntry);
  shard1ManifestEntry.checksum = wrongChecksum;
  writeEnvelope(fs, manifestPath, manifestEnvelope);

  await assert.rejects(() => switchCurrentGeneration(fs, "/root", 302), GenerationStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);

  // loadGeneration itself never reads shard files (routing comes from note metadata alone), so it
  // still succeeds; the dimension mismatch is only caught once loadShard() actually decodes shard-1.
  const loaded = await loadGeneration(fs, "/root", 302);
  await assert.rejects(() => loaded.loadShard("shard-1"), GenerationStoreError);
});

/**
 * Deterministic, no-GC structural regression for the one-shard-resident
 * invariant: rather than proving non-retention at runtime (which would
 * require either a production-only test seam or GC-timing-dependent
 * instrumentation, both rejected for this module), this audits
 * `verifyGenerationIntegrity`'s OWN source text for the exact shape of the
 * bug this invariant guards against -- a decoded shard held in a variable
 * that outlives its own loop iteration. Paired with the runtime corruption
 * tests above (e.g. "...NON-sample (later) shard's vectors...", the
 * duplicate-identity/wrong-shardId/wrong-dimension tests), which already
 * prove EVERY shard is genuinely read, decoded, and cross-checked -- this
 * test only needs to additionally prove none of that decoded data escapes
 * its own iteration.
 */
void test("source-level regression: verifyGenerationIntegrity never retains a decoded shard outside its own loop iteration", () => {
  const source = readFileSync(new URL("./generationStore.ts", import.meta.url), "utf8");

  const fnStart = source.indexOf("async function verifyGenerationIntegrity(");
  assert.ok(fnStart >= 0, "verifyGenerationIntegrity function not found in generationStore.ts");

  const loopStart = source.indexOf("for (const shardEntry of loadedManifest.chunkShards) {", fnStart);
  assert.ok(loopStart >= 0, "shard loop not found inside verifyGenerationIntegrity");

  // The exact shape of the regression this guards against: a `let sampleShard` (or similarly
  // named holder) declared BEFORE the loop and assigned only on the first iteration, then read
  // again after the loop has already moved on to later shards.
  const preLoopBody = source.slice(fnStart, loopStart);
  assert.ok(!/\bsampleShard\b/.test(preLoopBody), "no variable declared before the shard loop may be intended to hold a decoded shard across iterations");

  // Find the loop body's own matching closing brace via brace-depth counting, so the check below
  // is scoped to exactly the loop's own body, not "somewhere later in the file."
  let depth = 0;
  let loopEnd = -1;
  for (let i = loopStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        loopEnd = i;
        break;
      }
    }
  }
  assert.ok(loopEnd > loopStart, "could not find the shard loop's matching closing brace");
  const loopBody = source.slice(loopStart, loopEnd);
  const afterLoop = source.slice(loopEnd);
  const fnEnd = afterLoop.indexOf("\n}\n");
  assert.ok(fnEnd >= 0, "could not find verifyGenerationIntegrity's own closing brace");
  const postLoopBody = afterLoop.slice(0, fnEnd);

  // No variable declared outside the loop may be assigned a decoded shard from inside it (the
  // exact write pattern the old bug relied on: `sampleShard = {...}` inside the loop, populating a
  // pre-loop-declared holder).
  assert.ok(!/\bsampleShard\s*=/.test(loopBody), "no pre-loop variable may be assigned a decoded shard from inside the loop");

  // The sample query's chunk-level refinement must run INSIDE the shard loop, against that shard's
  // own still-in-scope decoded matrix/offsets -- never after the loop, which would require
  // retaining a decoded shard beyond its own iteration.
  assert.ok(loopBody.includes("refineWithChunks("), "refineWithChunks must be called from inside the shard loop, not after it");
  assert.ok(!postLoopBody.includes("refineWithChunks("), "refineWithChunks must not run again after the shard loop has already finished");
});
