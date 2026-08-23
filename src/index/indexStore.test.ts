import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { buildGeneration, generationDirPath, loadCurrentGenerationId, loadGeneration, switchCurrentGeneration, verifyGenerationFully, type GenerationInputNote } from "./generationStore";
import { overlayFileName, readOverlayPrefix, writeUpsertOverlay } from "./overlayStore";
import {
  compactionSnapshotMatchesGeneration,
  computeProjectedOverlayResourceUsage,
  describeCompactionSnapshot,
  finalizeCompactionFromSnapshot,
  GenerationBuildCancelledError,
  IndexStore,
  IndexStoreError,
  manifestArtifactFingerprint,
  planCompaction,
} from "./indexStore";
import { MAX_MANIFEST_NOTE_COUNT, MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";
import { MAX_PENDING_OVERLAY_COUNT } from "./budgets";
import type { OverlayPrefixRecord } from "./overlayStore";

const DIM = 4;
const MODEL = "mxbai-embed-large";
const HASH = "c".repeat(64);

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

async function seedBaseGeneration(fs: FakeIndexFs, notes: GenerationInputNote[], generationId = 1): Promise<void> {
  await buildGeneration(fs, "/root", { generationId, embeddingModel: MODEL, dimension: DIM, notes });
  await switchCurrentGeneration(fs, "/root", generationId);
}

/** A synthetic `OverlayPrefixRecord` for exercising `computeProjectedOverlayResourceUsage` directly, without needing an actual overlay file on disk. */
function fakeOverlayRecord(path: string, overrides: Partial<OverlayPrefixRecord> = {}): OverlayPrefixRecord {
  return {
    identity: stableNoteIdentity(canonicalizePath(path)),
    operation: "upsert",
    version: 1,
    recordedAt: new Date(0).toISOString(),
    mutationId: "fake-mutation-id",
    dimension: DIM,
    chunkCount: 0,
    fingerprint: "f".repeat(64),
    containerLength: 1000,
    ...overrides,
  };
}

void test("queryRelated returns [] when no generation has ever been activated and there are no overlays", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  const results = await store.queryRelated({ queryVector: vector(seededRandom(1)), queryChunkVectors: [], limit: 5 });
  assert.deepEqual(results, []);
});

void test("queryRelated ranks base notes exactly like a full note-level ranking over the generation's own matrix", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(2);
  const notes = Array.from({ length: 4 }, (_, i) => makeNote(`Note-${i}.md`, 0, random));
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");
  const query = notes[0].vector;
  const results = await store.queryRelated({ queryVector: query, queryChunkVectors: [], excludePath: canonicalizePath("Note-0.md"), limit: 10 });
  assert.equal(results.length, 3);
  assert.ok(!results.some((r) => r.path === "Note-0.md"));
});

void test("an upsert overlay shadows the base row entirely (different vector wins the ranking), scored WITHOUT a second full note matrix", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(3);
  const target = makeNote("Target.md", 0, random);
  const other = makeNote("Other.md", 0, random);
  await seedBaseGeneration(fs, [target, other], 1);

  const store = new IndexStore(fs, "/root");
  await store.upsertNote({
    identity: target.identity,
    sourceHash: "e".repeat(64),
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: other.vector,
    chunkVectors: [],
  });

  const results = await store.queryRelated({ queryVector: other.vector, queryChunkVectors: [], excludePath: canonicalizePath("Other.md"), limit: 10 });
  assert.equal(results[0].path, "Target.md");
  assert.ok(results[0].score > 0.99, "Target's overlaid vector should now be ~identical to the query");
});

void test("a tombstone overlay removes a base note from every query result entirely", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(4);
  const notes = [makeNote("A.md", 0, random), makeNote("B.md", 0, random), makeNote("C.md", 0, random)];
  await seedBaseGeneration(fs, notes, 1);

  const store = new IndexStore(fs, "/root");
  await store.deleteNote(notes[1].identity);

  const results = await store.queryRelated({ queryVector: notes[0].vector, queryChunkVectors: [], limit: 10 });
  assert.ok(!results.some((r) => r.path === "B.md"));
  assert.equal(results.length, 2);
});

void test("an overlay-only note (identity not in the base generation) is queryable and its own chunks are refined by loading exactly its own overlay, not any shard", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(5);
  await seedBaseGeneration(fs, [makeNote("Base.md", 0, random)], 1);

  const store = new IndexStore(fs, "/root");
  const newChunk = vector(random);
  await store.upsertNote({
    identity: stableNoteIdentity(canonicalizePath("New.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: newChunk,
    chunkVectors: [newChunk],
  });

  const readsBefore = fs.readFileCalls.length;
  const results = await store.queryRelated({ queryVector: newChunk, queryChunkVectors: [newChunk], limit: 10 });
  assert.ok(results.some((r) => r.path === "New.md"));
  const shardReadsDuringQuery = fs.readFileCalls.slice(readsBefore).filter((p) => p.includes("/shards/"));
  assert.deepEqual(shardReadsDuringQuery, [], "an overlay-sourced note's chunks must never require a shard load");
});

void test("lazy shard loading: a query touches exactly the distinct base shards its candidates' chunks live in, never more", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(6);
  const notes = [
    makeNote("A.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
    makeNote("B.md", Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6), random),
  ];
  await seedBaseGeneration(fs, notes, 1);
  const loaded = await loadGeneration(fs, "/root", 1);
  assert.equal(loaded.manifest.chunkShards.length, 2, "setup sanity check");

  const store = new IndexStore(fs, "/root");
  const readsBefore = fs.readFileCalls.length;
  await store.queryRelated({ queryVector: notes[0].vector, queryChunkVectors: [vector(random)], limit: 10 });
  const shardVectorReads = fs.readFileCalls.slice(readsBefore).filter((p) => p.includes("/shards/") && p.endsWith(".mvx"));
  const distinctShardFiles = new Set(shardVectorReads);
  assert.equal(distinctShardFiles.size, 2);
  assert.equal(shardVectorReads.length, 2, "each needed shard's vector file must be read exactly once per query");
});

void test("lazy overlay chunk loading: a query with N overlay-sourced candidates reads exactly N overlay containers in full, never more, and never all of them upfront", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(7);
  await seedBaseGeneration(fs, [], 1);
  const store = new IndexStore(fs, "/root");
  const query = vector(random);
  for (let i = 0; i < 5; i += 1) {
    await store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath(`Overlay-${i}.md`)),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: query,
      chunkVectors: [query],
    });
  }
  const readsBefore = fs.readFileCalls.length;
  await store.queryRelated({ queryVector: query, queryChunkVectors: [query], limit: 10 });
  // `readFileCalls` tracks FULL reads only (never the lazy prefix range reads) -- so this counts
  // exactly how many overlay containers were read in their entirety for refinement.
  const overlayFullReads = fs.readFileCalls.slice(readsBefore).filter((p) => p.includes("/overlays/"));
  assert.equal(overlayFullReads.length, 5);
});

void test("compact() rebuilds a new generation from base+overlays, activates it, and deletes exactly the incorporated overlays afterward", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(8);
  const notes = [makeNote("A.md", 1, random), makeNote("B.md", 1, random)];
  await seedBaseGeneration(fs, notes, 1);

  const store = new IndexStore(fs, "/root");
  await store.deleteNote(notes[1].identity); // tombstone B
  const newVector = vector(random);
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("C.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: newVector, chunkVectors: [] });

  await store.compact(2);

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 2);
  const generation2 = await loadGeneration(fs, "/root", 2);
  const paths = generation2.ids.map((p) => String(p));
  assert.ok(paths.includes("A.md"));
  assert.ok(paths.includes("C.md"));
  assert.ok(!paths.includes("B.md"));

  assert.equal(await readOverlayPrefix(fs, "/root", notes[1].identity), null);
  assert.equal(await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("C.md"))), null);
});

void test("compact() preserves a base note's chunks across compaction (reassembled from its owning shard, not lost)", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(9);
  const notes = [makeNote("A.md", 3, random)];
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");
  await store.compact(2);
  const generation2 = await loadGeneration(fs, "/root", 2);
  assert.equal(generation2.manifest.chunkCount, 3);
});

void test("compact() streams: it never accumulates all base+overlay chunks -- each distinct base shard is loaded exactly once (never re-loaded), and each overlay's full container is loaded exactly once", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(60);
  const perNoteChunks = Math.floor(MAX_MANIFEST_SHARD_ROW_COUNT * 0.6);
  const notes = [makeNote("A.md", perNoteChunks, random), makeNote("B.md", perNoteChunks, random)];
  await seedBaseGeneration(fs, notes, 1);
  const baseGeneration = await loadGeneration(fs, "/root", 1);
  assert.equal(baseGeneration.manifest.chunkShards.length, 2, "setup sanity check: two base shards");

  const store = new IndexStore(fs, "/root");
  await store.upsertNote({
    identity: stableNoteIdentity(canonicalizePath("C.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: vector(random),
    chunkVectors: [vector(random), vector(random)],
  });
  await store.upsertNote({
    identity: stableNoteIdentity(canonicalizePath("D.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: vector(random),
    chunkVectors: [vector(random)],
  });

  const readsBefore = fs.readFileCalls.length;
  await store.compact(2);
  const readsDuringCompact = fs.readFileCalls.slice(readsBefore);

  const baseShardVectorReads = readsDuringCompact.filter((p) => p.includes(`/${generationDirPath(1)}/shards/`) && p.endsWith(".mvx"));
  assert.equal(new Set(baseShardVectorReads).size, 2, "both base shards must be touched (A and B each own one)");
  assert.equal(baseShardVectorReads.length, 2, "each base shard's vector file must be read exactly once during compaction, never re-loaded");

  // Each overlay is read in full exactly ONCE to obtain its chunk vectors for the new generation
  // (streaming: never more than one overlay's chunk payload resident at a time). Its post-switch
  // deletion (`deleteOverlay`) checks existence via `fs.exists` + `unlink` alone -- it never reads
  // the overlay's payload a second time -- so this is exactly 1 full read per overlay, never more.
  const overlayReads = readsDuringCompact.filter((p) => p.includes("/overlays/"));
  assert.equal(overlayReads.length, 2, "2 overlays x 1 full read each for their chunks = 2, never more (deletion never re-reads the payload)");
});

void test("compact() reads base note vectors and chunk rows via subarray views, not Float32Array#slice copies -- the slice-call count must not scale with corpus size (no duplicate full-input copy retained)", async () => {
  async function compactSliceCallCount(noteCount: number, seed: number): Promise<number> {
    const fs = new FakeIndexFs();
    const random = seededRandom(seed);
    const notes = Array.from({ length: noteCount }, (_, i) => makeNote(`N-${i}.md`, 1, random));
    await seedBaseGeneration(fs, notes, 1);
    const store = new IndexStore(fs, "/root");
    const originalSlice = Float32Array.prototype.slice;
    let calls = 0;
    Float32Array.prototype.slice = function (this: Float32Array, start?: number, end?: number) {
      calls += 1;
      return originalSlice.call(this, start, end);
    };
    try {
      await store.compact(2);
    } finally {
      Float32Array.prototype.slice = originalSlice;
    }
    return calls;
  }

  const smallCorpusCalls = await compactSliceCallCount(2, 101);
  const largeCorpusCalls = await compactSliceCallCount(40, 102);
  assert.equal(
    smallCorpusCalls,
    largeCorpusCalls,
    "the number of Float32Array#slice calls during compact() must not scale with the number of notes -- base note vectors and base/overlay chunk rows must be read via subarray views, not per-row slice copies",
  );
});

void test("compact() with no base generation and no dimension-bearing upsert overlay fails without any mutation", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  await assert.rejects(() => store.compact(1), IndexStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), null);
});

void test("compact() with no base generation but a pending upsert overlay succeeds, inferring dimension/model from it", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  const random = seededRandom(31);
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("A.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });
  await store.compact(1);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
  const generation = await loadGeneration(fs, "/root", 1);
  assert.equal(generation.manifest.dimension, DIM);
  assert.equal(generation.manifest.embeddingModel, MODEL);
});

void test("a failed compact() (verification/build failure) leaves the active generation, pointer, and every overlay completely unchanged", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(10);
  const notes = [makeNote("A.md", 0, random)];
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });

  fs.faults.add("rename");
  fs.pathFailPredicate = (path) => !path.includes(".atomic-tmp-");
  await assert.rejects(() => store.compact(2));
  fs.faults.delete("rename");

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1, "the pointer must still reference the original generation");
  assert.notEqual(await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("B.md"))), null, "the overlay must not have been deleted by a failed compaction");
  const results = await store.queryRelated({ queryVector: notes[0].vector, queryChunkVectors: [], limit: 10 });
  assert.ok(results.some((r) => r.path === "B.md"), "the overlay must still be visible in the committed view after the failed compaction");
});

void test("compact() honors AbortSignal cancellation: aborting before the rename leaves the active pointer and every overlay unchanged", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(11);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });

  const controller = new AbortController();
  let released: () => void = () => {};
  fs.pauseSignal = new Promise((resolve) => {
    released = resolve;
  });
  fs.pauseMatcher = (point, path) => point === "readFileBytes" && path.includes("/staging/") && path.endsWith("/notes.mvx");
  fs.onPaused = () => {
    controller.abort();
    released();
  };

  await assert.rejects(() => store.compact(2, { signal: controller.signal }), GenerationBuildCancelledError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
  assert.notEqual(await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("B.md"))), null, "cancellation must leave the overlay unchanged");
});

void test("compact() checks abort AFTER buildGeneration has fully completed (new generation built+renamed) and BEFORE the pointer switch -- that abort leaves the new generation on disk but unreferenced, and the prior pointer/every overlay unchanged", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(21);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });

  const controller = new AbortController();
  let released: () => void = () => {};
  fs.pauseSignal = new Promise((resolve) => {
    released = resolve;
  });
  // Pause exactly on buildGeneration's OWN final staging->generations rename -- abort the signal
  // there, then let the rename (and therefore the whole build) complete completely normally, so
  // generation 2 is fully built and on disk by the time buildGeneration returns. Only THEN does
  // compact()'s post-build, pre-pointer-switch check observe the abort.
  fs.pauseMatcher = (point, path) => point === "rename" && path.includes("/staging/") && !path.includes(".atomic-tmp-");
  fs.onPaused = () => {
    controller.abort();
    released();
  };

  await assert.rejects(() => store.compact(2, { signal: controller.signal }), GenerationBuildCancelledError);

  // The new generation was fully built, verified, and renamed into place -- it exists and loads.
  await assert.doesNotReject(() => loadGeneration(fs, "/root", 2));
  // But it was never activated: the pointer still references generation 1.
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
  // And no overlay was deleted, since deletion only happens after a successful pointer switch.
  assert.notEqual(await readOverlayPrefix(fs, "/root", stableNoteIdentity(canonicalizePath("B.md"))), null);
});

void test("(requirement 13) compact() never deletes a REPLACEMENT overlay written by an independent concurrent mutator after planning -- version-checked delete-if-matches, not a blind identity-keyed delete", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(31);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");
  const bIdentity = stableNoteIdentity(canonicalizePath("B.md"));
  const originalBVector = vector(random);
  await store.upsertNote({ identity: bIdentity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: originalBVector, chunkVectors: [] });

  let released: () => void = () => {};
  fs.pauseSignal = new Promise((resolve) => {
    released = resolve;
  });
  // Pause exactly at the pointer-switch commit -- by this point buildGeneration/verify have
  // already fully captured the snapshot's content; the delete-if-matches loop over B's overlay
  // has not run yet.
  fs.pauseMatcher = (point, path) => point === "rename" && path.includes("current.json");
  const replacedBVector = vector(random);
  fs.onPaused = () => {
    // An INDEPENDENT concurrent mutator (a separate IndexStore instance, or another job) replaces
    // B's overlay with new content -- bumping its version -- entirely outside this compact()'s own
    // mutation queue, exactly the race requirement 13 must survive.
    void writeUpsertOverlay(fs, "/root", { identity: bIdentity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: replacedBVector, chunkVectors: [] }).then(() => released());
  };

  await store.compact(2);

  // The replacement must still be there, untouched, at its bumped version.
  const survivingB = await readOverlayPrefix(fs, "/root", bIdentity);
  assert.ok(survivingB, "the replacement overlay written after planning must never be deleted");
  assert.equal(survivingB?.version, 2);

  // The merged committed view must still serve B (via its surviving overlay), not silently drop it.
  const results = await store.queryRelated({ queryVector: replacedBVector, queryChunkVectors: [], limit: 5 });
  assert.ok(results.some((r) => r.path === "B.md"));
});

void test("(requirement 10) finalizeCompactionFromSnapshot never deletes a replacement overlay written after the snapshot was described, using only the bounded {fileName, version} descriptor -- never a live CompactionPlan", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(41);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const bIdentity = stableNoteIdentity(canonicalizePath("B.md"));
  await writeUpsertOverlay(fs, "/root", { identity: bIdentity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });

  const plan = await planCompaction(fs, "/root");
  const snapshot = describeCompactionSnapshot(plan);
  await buildGeneration(fs, "/root", { generationId: 2, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes });

  // B is replaced AFTER the snapshot was described but BEFORE activation ever runs.
  const replacedBVector = vector(random);
  await writeUpsertOverlay(fs, "/root", { identity: bIdentity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: replacedBVector, chunkVectors: [] });

  await finalizeCompactionFromSnapshot(fs, "/root", 2, snapshot.overlays);

  const survivingB = await readOverlayPrefix(fs, "/root", bIdentity);
  assert.ok(survivingB, "the replacement must survive activation-from-snapshot");
  assert.equal(survivingB?.version, 2);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 2);
});

void test("a query concurrent with an in-flight compaction sees the prior committed view until the pointer switch commits, then the new one", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(12);
  const oldNote = makeNote("Old.md", 0, random);
  await seedBaseGeneration(fs, [oldNote], 1);
  const store = new IndexStore(fs, "/root");
  const newNoteVector = vector(random);
  await store.upsertNote({ identity: stableNoteIdentity(canonicalizePath("New.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: newNoteVector, chunkVectors: [] });

  let paused = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fs.pauseMatcher = (point, path) => point === "rename" && path.includes("/staging/") && !path.includes(".atomic-tmp-");
  fs.pauseSignal = gate;
  fs.onPaused = () => {
    paused = true;
  };

  const compactPromise = store.compact(2);
  while (!paused) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const duringResults = await store.queryRelated({ queryVector: oldNote.vector, queryChunkVectors: [], limit: 10 });
  assert.deepEqual(
    duringResults.map((r) => r.path).sort(),
    ["New.md", "Old.md"],
    "the compacted view isn't active yet, but the pre-existing overlay is still visible via the merged committed view",
  );
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);

  release();
  await compactPromise;

  assert.equal(await loadCurrentGenerationId(fs, "/root"), 2);
  const afterResults = await store.queryRelated({ queryVector: oldNote.vector, queryChunkVectors: [], limit: 10 });
  assert.deepEqual(afterResults.map((r) => r.path).sort(), ["New.md", "Old.md"]);
});

void test("upsertNote/deleteNote/compact are serialized: three concurrent upserts for the same identity land on strictly increasing versions", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  const random = seededRandom(13);
  await Promise.all([
    store.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
    store.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
    store.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
  ]);
  const overlay = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(overlay?.version, 3);
});

void test("(final-closure requirement 2) two INDEPENDENT IndexStore instances over the same fs+root share one mutation queue: their upserts for the same identity are serialized (strictly increasing versions), never racing", async () => {
  const fs = new FakeIndexFs();
  const storeA = new IndexStore(fs, "/root");
  const storeB = new IndexStore(fs, "/root");
  const identity = stableNoteIdentity(canonicalizePath("A.md"));
  const random = seededRandom(99);
  await Promise.all([
    storeA.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
    storeB.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
    storeA.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
  ]);
  const overlay = await readOverlayPrefix(fs, "/root", identity);
  assert.equal(overlay?.version, 3, "all three mutations, across two independent IndexStore instances, must land on strictly increasing versions -- never lost/raced");
});

void test("(final-closure requirement 2) an independent IndexStore's compact() and another IndexStore's concurrent upsertNote for an UNRELATED identity are serialized through the shared queue, never interleaved mid-mutation", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(98);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const storeA = new IndexStore(fs, "/root");
  const storeB = new IndexStore(fs, "/root");
  await storeA.upsertNote({ identity: stableNoteIdentity(canonicalizePath("B.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });

  const [compactResult] = await Promise.allSettled([
    storeA.compact(2),
    storeB.upsertNote({ identity: stableNoteIdentity(canonicalizePath("C.md")), sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] }),
  ]);
  assert.equal(compactResult.status, "fulfilled");

  // Whichever order the shared queue actually ran them in, the result must be fully consistent:
  // C.md must be queryable either way (either compacted in, or still a valid pending overlay).
  const results = await storeA.queryRelated({ queryVector: new Float32Array([1, 0, 0, 0]), queryChunkVectors: [], limit: 10 });
  assert.ok(results.some((r) => r.path === "C.md"));
});

void test("queryRelated fails closed with an actionable IndexStoreError when an OWNED overlay file is corrupt -- it never silently resurrects base state or drops the corrupt note", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(14);
  const notes = [makeNote("A.md", 0, random), makeNote("B.md", 0, random)];
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");
  await store.deleteNote(notes[1].identity); // tombstone B

  // Corrupt B's tombstone overlay after the fact.
  const path = `/root/${overlayFileName(notes[1].identity)}`;
  const bytes = fs.binaryFiles.get(path) as Uint8Array;
  bytes[10] ^= 0xff;

  await assert.rejects(() => store.queryRelated({ queryVector: notes[0].vector, queryChunkVectors: [], limit: 10 }), IndexStoreError);
});

void test("regression: a corrupted tombstone overlay must never let the query path silently resurrect the base row it was supposed to hide", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(15);
  const notes = [makeNote("A.md", 0, random), makeNote("Secret.md", 0, random)];
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");
  await store.deleteNote(notes[1].identity);
  const path = `/root/${overlayFileName(notes[1].identity)}`;
  const bytes = fs.binaryFiles.get(path) as Uint8Array;
  bytes[10] ^= 0xff;

  let threw = false;
  try {
    await store.queryRelated({ queryVector: notes[0].vector, queryChunkVectors: [], limit: 10 });
  } catch (error) {
    threw = true;
    assert.ok(error instanceof IndexStoreError);
  }
  assert.ok(threw, "must throw rather than returning results that could include the resurrected Secret.md");
});

void test("regression: a corrupted upsert overlay must never let compaction incorporate stale/corrupt data into the new generation", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(16);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");
  const identity = stableNoteIdentity(canonicalizePath("B.md"));
  await store.upsertNote({ identity, sourceHash: HASH, embeddingModel: MODEL, dimension: DIM, noteVector: vector(random), chunkVectors: [] });
  const path = `/root/${overlayFileName(identity)}`;
  const bytes = fs.binaryFiles.get(path) as Uint8Array;
  bytes[10] ^= 0xff;

  await assert.rejects(() => store.compact(2), IndexStoreError);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1, "compaction must not have activated a generation built from corrupt data");
});

void test("listOverlayPrefixes/queryRelated tolerate a foreign (non-owned) file under overlays/ without failing closed", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(17);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  fs.binaryFiles.set("/root/overlays/.DS_Store", Uint8Array.from([1, 2, 3]));
  const store = new IndexStore(fs, "/root");
  const results = await store.queryRelated({ queryVector: vector(random), queryChunkVectors: [], limit: 10 });
  assert.equal(results.length, 1);
});

void test("upsertNote rejects once the pending-overlay count budget would be exceeded, requiring compaction first", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  const random = seededRandom(18);
  // Directly seed MAX_PENDING_OVERLAY_COUNT overlay files without going through the (slow)
  // budget-checked upsertNote path, so this test stays fast.
  const { writeUpsertOverlay } = await import("./overlayStore");
  for (let i = 0; i < MAX_PENDING_OVERLAY_COUNT; i += 1) {
    await writeUpsertOverlay(fs, "/root", {
      identity: stableNoteIdentity(canonicalizePath(`Bulk-${i}.md`)),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    });
  }
  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("OneTooMany.md")),
        sourceHash: HASH,
        embeddingModel: MODEL,
        dimension: DIM,
        noteVector: vector(random),
        chunkVectors: [],
      }),
    IndexStoreError,
  );
  // Replacing an EXISTING identity's overlay must still be allowed (it doesn't increase the count).
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("Bulk-0.md")),
      sourceHash: "f".repeat(64),
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    }),
  );
});

void test("deleteNote (a tombstone) is bounded by the same pending-overlay-count budget as an upsert -- no mutation may create the 2001st overlay file", async () => {
  const fs = new FakeIndexFs();
  const store = new IndexStore(fs, "/root");
  const random = seededRandom(20);
  const { writeUpsertOverlay: rawWrite } = await import("./overlayStore");
  for (let i = 0; i < MAX_PENDING_OVERLAY_COUNT; i += 1) {
    await rawWrite(fs, "/root", {
      identity: stableNoteIdentity(canonicalizePath(`Bulk-${i}.md`)),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    });
  }
  // A tombstone for a BRAND-NEW identity would create the 2001st overlay file -- rejected.
  await assert.rejects(() => store.deleteNote(stableNoteIdentity(canonicalizePath("NeverSeen.md"))), IndexStoreError);
  // A tombstone that REPLACES an existing identity's overlay is still allowed (no new file).
  await assert.doesNotReject(() => store.deleteNote(stableNoteIdentity(canonicalizePath("Bulk-0.md"))));
});

void test("effective merged-corpus ceiling: an upsert for a NEW identity is rejected once the base generation already has MAX_MANIFEST_NOTE_COUNT effective notes, but replacing an EXISTING identity is not, and a tombstone freeing a slot allows one more new upsert", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(21);
  // A full base generation at the exact note-count ceiling (chunkless, for speed).
  const notes = Array.from({ length: MAX_MANIFEST_NOTE_COUNT }, (_, i) => makeNote(`Full-${i}.md`, 0, random));
  await seedBaseGeneration(fs, notes, 1);
  const store = new IndexStore(fs, "/root");

  // A brand-new identity: rejected, the effective corpus is already at the ceiling.
  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("NewOne.md")),
        sourceHash: HASH,
        embeddingModel: MODEL,
        dimension: DIM,
        noteVector: vector(random),
        chunkVectors: [],
      }),
    IndexStoreError,
  );

  // Replacing an EXISTING identity's vector: allowed, since it subtracts its own current
  // effective presence first and does not grow the corpus.
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("Full-0.md")),
      sourceHash: "e".repeat(64),
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    }),
  );

  // Tombstoning an existing note frees a slot in the effective corpus, so exactly one new upsert
  // now fits.
  await store.deleteNote(stableNoteIdentity(canonicalizePath("Full-1.md")));
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("NewOne.md")),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    }),
  );
});

void test("upsertNote enforces one embedding dimension/model across the active generation and every pending upsert: with a base, a mismatch is rejected before the write", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(22);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");

  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("B.md")),
        sourceHash: HASH,
        embeddingModel: MODEL,
        dimension: DIM + 1, // mismatched dimension
        noteVector: new Float32Array(DIM + 1).fill(1),
        chunkVectors: [],
      }),
    IndexStoreError,
  );
  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("B.md")),
        sourceHash: HASH,
        embeddingModel: "a-different-model",
        dimension: DIM,
        noteVector: vector(random),
        chunkVectors: [],
      }),
    IndexStoreError,
  );
  // A matching upsert still succeeds.
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("B.md")),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: DIM,
      noteVector: vector(random),
      chunkVectors: [],
    }),
  );
});

void test("upsertNote enforces one embedding dimension/model across pending upserts even with NO base generation: the first upsert establishes it, and a later mismatched upsert is rejected before the write", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(23);
  const store = new IndexStore(fs, "/root");

  await store.upsertNote({
    identity: stableNoteIdentity(canonicalizePath("First.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: vector(random),
    chunkVectors: [],
  });

  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("Second.md")),
        sourceHash: HASH,
        embeddingModel: MODEL,
        dimension: DIM + 1,
        noteVector: new Float32Array(DIM + 1).fill(1),
        chunkVectors: [],
      }),
    IndexStoreError,
  );
  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("Second.md")),
        sourceHash: HASH,
        embeddingModel: "a-different-model",
        dimension: DIM,
        noteVector: vector(random),
        chunkVectors: [],
      }),
    IndexStoreError,
  );
  // A matching upsert still succeeds, and a query never discovers mixed dimensions after the fact.
  await store.upsertNote({
    identity: stableNoteIdentity(canonicalizePath("Second.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    dimension: DIM,
    noteVector: vector(random),
    chunkVectors: [],
  });
  const results = await store.queryRelated({ queryVector: vector(random), queryChunkVectors: [], limit: 10 });
  assert.equal(results.length, 2);
});

void test("cleanupStaleStaging via IndexStore removes an interrupted compaction's staging directory without touching the active generation", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(19);
  await seedBaseGeneration(fs, [makeNote("A.md", 0, random)], 1);
  const store = new IndexStore(fs, "/root");

  fs.faults.add("rename");
  fs.pathFailPredicate = (path) => !path.includes(".atomic-tmp-");
  await assert.rejects(() => store.compact(2));
  fs.faults.delete("rename");

  const removed = await store.cleanupStaleStaging();
  assert.ok(removed > 0);
  assert.equal(await loadCurrentGenerationId(fs, "/root"), 1);
});

void test("computeProjectedOverlayResourceUsage: a new-identity upsert adds exactly one resident overlay note vector's worth of steady-state bytes and its own projected container's worth of disk bytes; a tombstone adds neither", () => {
  const shape = { dimension: 1024, noteCount: 0, shardCounts: [] };
  const baseline = computeProjectedOverlayResourceUsage(shape, [], stableNoteIdentity(canonicalizePath("New.md")), { operation: "tombstone" });
  const withUpsert = computeProjectedOverlayResourceUsage(shape, [], stableNoteIdentity(canonicalizePath("New.md")), { operation: "upsert", chunkCount: 50 });
  assert.ok(baseline && withUpsert);
  assert.ok(withUpsert!.steadyStateBytes > baseline!.steadyStateBytes, "an upsert must add a resident note vector; a tombstone never does");
  assert.ok(withUpsert!.diskBytes > baseline!.diskBytes, "an upsert's container carries a note vector AND chunk vectors a tombstone's container never has");
});

void test("computeProjectedOverlayResourceUsage: replacing an EXISTING overlay identity does not double-count that identity's own current footprint", () => {
  const shape = { dimension: 1024, noteCount: 0, shardCounts: [] };
  const identity = stableNoteIdentity(canonicalizePath("Existing.md"));
  const existingRecord = fakeOverlayRecord("Existing.md", { chunkCount: 5, containerLength: 50_000 });
  const otherRecord = fakeOverlayRecord("Other.md", { chunkCount: 5, containerLength: 50_000 });

  // Replacing "Existing.md" itself: its own prior footprint must be excluded from "every OTHER
  // pending overlay" and replaced by the new projection, never added on top of it.
  const replacement = computeProjectedOverlayResourceUsage(shape, [existingRecord, otherRecord], identity, { operation: "upsert", chunkCount: 5 });
  // A brand-new identity with the exact same shape, alongside the same two OTHER overlays, should
  // cost exactly one MORE resident note vector's worth of steady-state than the replacement case.
  const brandNew = computeProjectedOverlayResourceUsage(
    shape,
    [existingRecord, otherRecord],
    stableNoteIdentity(canonicalizePath("BrandNew.md")),
    { operation: "upsert", chunkCount: 5 },
  );
  assert.ok(replacement && brandNew);
  assert.ok(brandNew!.steadyStateBytes > replacement!.steadyStateBytes, "a brand-new identity adds a resident note vector on top of both existing overlays; a same-identity replacement does not");
});

void test("computeProjectedOverlayResourceUsage returns null when no dimension is established anywhere (no base generation, no dimension-bearing overlay) -- nothing byte-significant to bound yet", () => {
  const usage = computeProjectedOverlayResourceUsage(null, [], stableNoteIdentity(canonicalizePath("A.md")), { operation: "tombstone" });
  assert.equal(usage, null);
});

void test("upsertNote enforces PROJECTED ACTUAL steady-state memory at a legal higher-dimensional, near-budget base generation -- rejecting a SECOND resident overlay note vector once budget is exhausted, while still allowing a replacement of the ALREADY-PENDING one and a tombstone, even though the fixed pending-overlay COUNT budget alone would have allowed all of it", async () => {
  // dimension=8192 (the legal MAX_DIMENSION) x noteCount=3838 lands the base generation's own
  // steady-state EXACTLY one note-vector's worth (32768 bytes) below the 128MB budget --
  // computeSteadyStateBytes({dimension:8192, noteCount:3838, largestShardCount:0}) ===
  // BUDGET_STEADY_STATE_MEMORY_BYTES - 32768 -- legal on its own (parseVectorIndexManifestV1
  // accepts it), with room for EXACTLY one resident overlay note vector and no more.
  const highDim = 8192;
  const nearBudgetNoteCount = 3838;
  const fs = new FakeIndexFs();
  const random = seededRandom(200);
  const notes = Array.from({ length: nearBudgetNoteCount }, (_, i) => {
    const v = new Float32Array(highDim);
    for (let d = 0; d < highDim; d += 1) v[d] = random() * 2 - 1;
    return { identity: stableNoteIdentity(canonicalizePath(`Big-${i}.md`)), sourceHash: HASH, vector: v, chunkCount: 0, loadChunkVectors: async () => [] };
  });
  await buildGeneration(fs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: highDim, notes });
  await switchCurrentGeneration(fs, "/root", 1);
  const store = new IndexStore(fs, "/root");

  const newVector = new Float32Array(highDim).fill(0);
  newVector[0] = 1;

  // The FIRST overlay (a brand-new identity) exactly fills the remaining headroom -- allowed.
  // Well within MAX_PENDING_OVERLAY_COUNT (2000) and MAX_MANIFEST_NOTE_COUNT (10000) -- the fixed
  // count-based budgets alone would have allowed many more than just this one.
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("First.md")),
      sourceHash: HASH,
      embeddingModel: MODEL,
      dimension: highDim,
      noteVector: newVector,
      chunkVectors: [],
    }),
  );

  // A SECOND new identity would need a second resident overlay note vector -- no headroom left,
  // rejected, even though the fixed pending-overlay COUNT budget alone would still allow it.
  await assert.rejects(
    () =>
      store.upsertNote({
        identity: stableNoteIdentity(canonicalizePath("Second.md")),
        sourceHash: HASH,
        embeddingModel: MODEL,
        dimension: highDim,
        noteVector: newVector,
        chunkVectors: [],
      }),
    IndexStoreError,
  );

  // But REPLACING the one ALREADY-PENDING overlay ("First.md") is still allowed: its own prior
  // resident footprint is excluded before the new one is projected, so this never grows past the
  // one resident vector already accounted for (replacement accounting, not a double count).
  await assert.doesNotReject(() =>
    store.upsertNote({
      identity: stableNoteIdentity(canonicalizePath("First.md")),
      sourceHash: "f".repeat(64),
      embeddingModel: MODEL,
      dimension: highDim,
      noteVector: newVector,
      chunkVectors: [],
    }),
  );

  // A tombstone for a BRAND-NEW identity never adds a resident note vector, so it is never
  // blocked by the steady-state check either, even with "First.md"'s overlay still pending.
  await assert.doesNotReject(() => store.deleteNote(stableNoteIdentity(canonicalizePath("Big-1.md"))));
});

void test("(final-closure requirement 5) the SEMANTIC snapshot match and the BYTE-EXACT manifestArtifactFingerprint are genuinely different checks: identical metadata with altered-but-valid vector bytes passes the former but fails the latter", async () => {
  const fs = new FakeIndexFs();
  const random = seededRandom(51);
  const note = makeNote("A.md", 1, random);
  await buildGeneration(fs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [note] });
  await switchCurrentGeneration(fs, "/root", 1);

  const plan = await planCompaction(fs, "/root");
  const snapshot = describeCompactionSnapshot(plan);
  const { manifest: originalManifest } = await verifyGenerationFully(fs, "/root", 1);
  const originalFingerprint = manifestArtifactFingerprint(originalManifest);

  // Overwrite generation 1 with a FRESH, fully self-consistent build for the EXACT SAME identity/
  // sourceHash/chunkCount (so the SEMANTIC snapshot must still match) but genuinely DIFFERENT
  // (still valid, still unit-norm) vector bytes -- e.g. a non-deterministic re-embedding of the
  // same source. This is "altered-but-valid", never "corrupt": it passes its own full integrity
  // verification cleanly.
  const alteredRandom = seededRandom(999);
  const alteredNote: GenerationInputNote = { ...note, vector: vector(alteredRandom), loadChunkVectors: async () => [vector(alteredRandom)] };
  await buildGeneration(fs, "/root", { generationId: 1, embeddingModel: MODEL, dimension: DIM, notes: [alteredNote] });

  const { manifest: alteredManifest, noteMetadata: alteredNoteMetadata } = await verifyGenerationFully(fs, "/root", 1);

  // The SEMANTIC check (identity/sourceHash/chunkCount only) still matches -- exactly as
  // documented, this is not a byte-exact claim.
  assert.equal(compactionSnapshotMatchesGeneration(snapshot, alteredManifest, alteredNoteMetadata), true);

  // The BYTE-EXACT artifact fingerprint, which DOES cover the real vector-matrix checksum, must
  // NOT match -- proving a post-receipt exact-artifact check catches what the semantic one cannot.
  assert.notEqual(manifestArtifactFingerprint(alteredManifest), originalFingerprint);
});
