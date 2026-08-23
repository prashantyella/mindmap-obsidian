import test from "node:test";
import assert from "node:assert/strict";

import { AtomicBinaryStore, AtomicBinaryStoreError } from "./atomicBinaryStore";
import { FakeIndexFs } from "./fakeIndexFs.test-support";

function makeStore(fs: FakeIndexFs, maxBytes = 1024): AtomicBinaryStore {
  return new AtomicBinaryStore({ fs, root: "/root", fileName: "data.mvx", maxBytes });
}

void test("save then load round-trips the exact bytes", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
  await store.save(bytes);
  const loaded = await store.load();
  assert.deepEqual([...(loaded as Uint8Array)], [...bytes]);
});

void test("load returns null when no committed file exists yet", async () => {
  const fs = new FakeIndexFs();
  assert.equal(await makeStore(fs).load(), null);
});

void test("save rejects bytes exceeding maxBytes without writing anything", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs, 4);
  await assert.rejects(() => store.save(Uint8Array.from([1, 2, 3, 4, 5])), AtomicBinaryStoreError);
  assert.equal(await store.load(), null);
});

void test("save fault injection: writeFileBytes/fsync/rename failures leave the prior committed file untouched", async () => {
  for (const point of ["writeFileBytes", "fsync", "rename"] as const) {
    const fs = new FakeIndexFs();
    const store = makeStore(fs);
    await store.save(Uint8Array.from([9, 9, 9]));
    fs.faultOnce.add(point);
    await assert.rejects(() => store.save(Uint8Array.from([1, 1, 1])));
    const loaded = await store.load();
    assert.deepEqual([...(loaded as Uint8Array)], [9, 9, 9], `fault at ${point} must leave the previously-committed bytes untouched`);
  }
});

void test("save write-back verification catches a corrupted temp-file readback (byte-for-byte, not just length)", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  // Corrupt the temp file's content the moment it's written, so save()'s own write-back
  // verification (reading the temp file back before renaming) is what has to catch this.
  const originalWriteFileBytes = fs.writeFileBytes.bind(fs);
  fs.writeFileBytes = async (path: string, bytes: Uint8Array) => {
    await originalWriteFileBytes(path, bytes);
    fs.corruptNextReadBytesOf.add(path);
  };
  await assert.rejects(() => store.save(Uint8Array.from([4, 5, 6])), AtomicBinaryStoreError);
  assert.equal(await store.load(), null, "a failed write-back verification must never commit anything");
});

void test("load rejects an oversized committed file via statSize alone, WITHOUT ever calling readFileBytes on it", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs, 10);
  // Placed directly (bypassing save()'s own maxBytes check), simulating a file that grew past
  // maxBytes on disk after it was written (or was tampered with).
  fs.binaryFiles.set("/root/data.mvx", new Uint8Array(20));
  fs.readFileCalls.length = 0;
  await assert.rejects(() => store.load(), AtomicBinaryStoreError);
  assert.deepEqual(fs.readFileCalls, [], "an oversized committed file must be rejected via statSize before readFileBytes is ever called");
});

void test("save's write-back verification rejects an oversized temp file via statSize alone, WITHOUT ever calling readFileBytes on it", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs, 5);
  const originalWriteFileBytes = fs.writeFileBytes.bind(fs);
  // Simulate a misbehaving filesystem: the temp file actually written to disk ends up larger than
  // what save() asked to write (which was itself within maxBytes).
  fs.writeFileBytes = async (path: string, bytes: Uint8Array) => {
    await originalWriteFileBytes(path, new Uint8Array(bytes.length + 100));
  };
  fs.readFileCalls.length = 0;
  await assert.rejects(() => store.save(Uint8Array.from([1, 2, 3])), AtomicBinaryStoreError);
  assert.deepEqual(fs.readFileCalls, [], "an oversized temp file must be rejected via statSize before readFileBytes is ever called on it");
  assert.equal(await store.load(), null, "a failed write-back verification must never commit anything");
});

void test("load rejects a negative, fractional, non-finite, or unsafe-integer statSize result, WITHOUT ever calling readFileBytes", async () => {
  const invalidSizes = [-1, 3.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const size of invalidSizes) {
    const fs = new FakeIndexFs();
    const store = makeStore(fs);
    fs.binaryFiles.set("/root/data.mvx", new Uint8Array(5));
    fs.statSize = async () => size;
    fs.readFileCalls.length = 0;
    await assert.rejects(() => store.load(), AtomicBinaryStoreError, `expected load() to reject statSize=${size}`);
    assert.deepEqual(fs.readFileCalls, [], `readFileBytes must never be called for an invalid statSize result (${size})`);
  }
});

void test("save's write-back verification rejects a negative, fractional, non-finite, or unsafe-integer statSize result on the temp file, WITHOUT ever calling readFileBytes", async () => {
  const invalidSizes = [-1, 3.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const size of invalidSizes) {
    const fs = new FakeIndexFs();
    const store = makeStore(fs);
    const originalStatSize = fs.statSize.bind(fs);
    fs.statSize = async (path: string) => (path.includes(".atomic-tmp-") ? size : originalStatSize(path));
    fs.readFileCalls.length = 0;
    await assert.rejects(() => store.save(Uint8Array.from([1, 2, 3])), AtomicBinaryStoreError, `expected save() to reject statSize=${size}`);
    assert.deepEqual(fs.readFileCalls, [], `readFileBytes must never be called for an invalid statSize result (${size})`);
    assert.equal(await store.load(), null, "a failed write-back verification must never commit anything");
  }
});

void test("loadRange reads exactly the requested span without reading the rest of the file", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  await store.save(Uint8Array.from([10, 20, 30, 40, 50]));
  const range = await store.loadRange(1, 3);
  assert.deepEqual([...range], [20, 30, 40]);
});

void test("loadRange rejects a non-integer or negative offset/length before ever touching the filesystem", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  await store.save(Uint8Array.from([1, 2, 3, 4, 5]));
  const readsBefore = fs.readRangeCalls.length;
  await assert.rejects(() => store.loadRange(-1, 2), AtomicBinaryStoreError);
  await assert.rejects(() => store.loadRange(1.5, 2), AtomicBinaryStoreError);
  await assert.rejects(() => store.loadRange(0, -1), AtomicBinaryStoreError);
  await assert.rejects(() => store.loadRange(0, 2.5), AtomicBinaryStoreError);
  assert.equal(fs.readRangeCalls.length, readsBefore, "an invalid range must never reach the filesystem");
});

void test("loadRange rejects a range whose offset+length exceeds maxBytes, before ever touching the filesystem", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs, 10);
  await store.save(Uint8Array.from([1, 2, 3]));
  const readsBefore = fs.readRangeCalls.length;
  await assert.rejects(() => store.loadRange(5, 10), AtomicBinaryStoreError); // 5+10=15 > maxBytes(10)
  assert.equal(fs.readRangeCalls.length, readsBefore);
});

void test("loadRange rejects an unsafe-integer offset+length (overflow) before ever touching the filesystem", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs, Number.MAX_SAFE_INTEGER);
  await store.save(Uint8Array.from([1, 2, 3]));
  const readsBefore = fs.readRangeCalls.length;
  await assert.rejects(() => store.loadRange(Number.MAX_SAFE_INTEGER, 10), AtomicBinaryStoreError);
  assert.equal(fs.readRangeCalls.length, readsBefore);
});

void test("loadRange rejects a range past the end of the actual file", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  await store.save(Uint8Array.from([1, 2, 3]));
  await assert.rejects(() => store.loadRange(0, 10), AtomicBinaryStoreError);
});

void test("loadRange rejects when no committed file exists", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  await assert.rejects(() => store.loadRange(0, 1), AtomicBinaryStoreError);
});

void test("loadRange rejects if the filesystem returns a length other than exactly what was requested (a lying IndexFs is never trusted)", async () => {
  const fs = new FakeIndexFs();
  const store = makeStore(fs);
  await store.save(Uint8Array.from([1, 2, 3, 4, 5]));
  const original = fs.readFileBytesRange.bind(fs);
  fs.readFileBytesRange = async (path: string, offset: number, length: number) => (await original(path, offset, length)).slice(0, length - 1);
  await assert.rejects(() => store.loadRange(0, 3), AtomicBinaryStoreError);
});
