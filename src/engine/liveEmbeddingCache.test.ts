import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { projectSource } from "./sourceProjection";
import { createCachedLiveEmbeddingSeam } from "./liveEmbeddingCache";

function projection(path: string, body: string) {
  return projectSource(stableNoteIdentity(canonicalizePath(path)), body);
}

function result(seed: number) {
  return { model: "m", dimension: 2, noteVector: new Float32Array([seed, 0]), chunkVectors: [new Float32Array([0, seed])] };
}

void test("live embedding cache keys source identity/hash and isolates caller mutation", async () => {
  let calls = 0;
  const seam = createCachedLiveEmbeddingSeam({ embed: async () => result(++calls) }, { maxEntries: 4, maxBytes: 1024 });
  const a = projection("A.md", "alpha");
  const first = await seam.embed(a, new AbortController().signal);
  first.noteVector[0] = 99;
  first.chunkVectors[0][1] = 99;
  const hit = await seam.embed(a, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual([...hit.noteVector], [1, 0]);
  assert.deepEqual([...hit.chunkVectors[0]], [0, 1]);
  await seam.embed(projection("A.md", "changed"), new AbortController().signal);
  await seam.embed(projection("B.md", "alpha"), new AbortController().signal);
  assert.equal(calls, 3);
});

void test("live embedding cache enforces LRU entry/byte limits and bypasses oversize values", async () => {
  let calls = 0;
  const seam = createCachedLiveEmbeddingSeam({ embed: async () => result(++calls) }, { maxEntries: 2, maxBytes: 32 });
  const a = projection("A.md", "a");
  const b = projection("B.md", "b");
  const c = projection("C.md", "c");
  await seam.embed(a, new AbortController().signal);
  await seam.embed(b, new AbortController().signal);
  await seam.embed(a, new AbortController().signal);
  await seam.embed(c, new AbortController().signal);
  await seam.embed(b, new AbortController().signal);
  assert.equal(calls, 4, "B was the least-recently used entry");
  assert.ok(seam.retainedBytes <= 32);

  const oversize = createCachedLiveEmbeddingSeam({ embed: async () => result(++calls) }, { maxEntries: 2, maxBytes: 8 });
  await oversize.embed(a, new AbortController().signal);
  await oversize.embed(a, new AbortController().signal);
  assert.equal(oversize.retainedBytes, 0);
  assert.equal(calls, 6);
});

void test("failures and aborted requests are not cached; clear releases retained bytes", async () => {
  let calls = 0;
  const seam = createCachedLiveEmbeddingSeam({ embed: async () => {
    calls += 1;
    if (calls === 1) throw new Error("failed");
    return result(calls);
  } }, { maxEntries: 4, maxBytes: 1024 });
  const a = projection("A.md", "a");
  await assert.rejects(() => seam.embed(a, new AbortController().signal));
  await seam.embed(a, new AbortController().signal);
  assert.equal(calls, 2);
  assert.ok(seam.retainedBytes > 0);
  seam.clear();
  assert.equal(seam.retainedBytes, 0);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => seam.embed(a, aborted.signal));
  assert.equal(calls, 2);
});

void test("concurrent same-key completions replace accounting without sharing cancellation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const seam = createCachedLiveEmbeddingSeam({ embed: async () => {
    const value = ++calls;
    await gate;
    return result(value);
  } }, { maxEntries: 2, maxBytes: 32 });
  const a = projection("A.md", "a");
  const first = seam.embed(a, new AbortController().signal);
  const second = seam.embed(a, new AbortController().signal);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(seam.retainedBytes, 16);
});

void test("combined-budget guard bypasses retention", async () => {
  let calls = 0;
  const seam = createCachedLiveEmbeddingSeam({ embed: async () => result(++calls) }, { maxEntries: 2, maxBytes: 32, canRetain: () => false });
  const a = projection("A.md", "a");
  await seam.embed(a, new AbortController().signal);
  await seam.embed(a, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(seam.retainedBytes, 0);
});
