import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { OVERLAY_METADATA_JSON_MAX_BYTES } from "./budgets";
import { FakeIndexFs } from "./fakeIndexFs.test-support";
import { queryRelated } from "./indexStore";
import { OVERLAY_HEADER_BYTES } from "./overlayCodec";
import { listOverlayPrefixes, overlayFileName, OverlayStoreError, readOverlayPrefix, writeTombstoneOverlay, writeUpsertOverlay } from "./overlayStore";
import { encodedMatrixByteLength, MAX_DIMENSION } from "./vectorCodec";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class GatedFs extends FakeIndexFs {
  gateOffset: number | undefined;
  active = 0;
  peak = 0;
  started: string[] = [];
  gates: ReturnType<typeof deferred>[] = [];
  eightStarted = deferred();

  override async readFileBytesRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    if (offset === 0) this.started.push(path);
    try {
      if (offset === this.gateOffset) {
        const gate = deferred();
        this.gates.push(gate);
        if (this.gates.length === 8) this.eightStarted.resolve();
        await gate.promise;
      }
      return await super.readFileBytesRange(path, offset, length);
    } finally {
      this.active -= 1;
    }
  }

  releaseAll() {
    this.gateOffset = undefined;
    for (const gate of this.gates) gate.resolve();
  }
}

async function seed(fs: FakeIndexFs, count = 19) {
  const identities = [];
  for (let index = 0; index < count; index += 1) {
    const identity = stableNoteIdentity(canonicalizePath(`Notes/${index}.md`));
    identities.push(identity);
    await writeUpsertOverlay(fs, "/root", {
      identity, sourceHash: "d".repeat(64), embeddingModel: "model", dimension: 3,
      noteVector: Float32Array.from([1, index % 3, 0]), chunkVectors: [],
    });
  }
  return identities;
}

void test("bounded prefix reads retain sequential records and ranking despite reverse completion and foreign/missing files", async () => {
  const fs = new GatedFs();
  const identities = await seed(fs);
  await writeTombstoneOverlay(fs, "/root", { identity: identities[10] });
  const expected = [];
  for (const identity of identities) expected.push(await readOverlayPrefix(fs, "/root", identity));
  const options = { queryVector: Float32Array.from([1, 0, 0]), queryChunkVectors: [], limit: 10 };
  const expectedRanking = await queryRelated(fs, "/root", options);
  const readdir = fs.readdir.bind(fs);
  const missing = overlayFileName(stableNoteIdentity(canonicalizePath("Gone.md"))).slice("overlays/".length);
  fs.readdir = async (path) => path === "/root/overlays"
    ? ["notes.txt", ...(await readdir(path)), missing, "../foreign.movl"] : readdir(path);
  fs.started = [];
  fs.peak = 0;
  fs.gateOffset = OVERLAY_HEADER_BYTES;
  const listing = listOverlayPrefixes(fs, "/root");
  await fs.eightStarted.promise;
  assert.equal(fs.started.length, 8);
  fs.gateOffset = undefined;
  for (const gate of [...fs.gates].reverse()) {
    gate.resolve();
    await setImmediate();
  }
  const actual = await listing;
  assert.equal(fs.active, 0);
  assert.equal(fs.peak, 8);
  assert.deepEqual(actual.records, expected);
  assert.deepEqual(actual.foreignFiles, ["notes.txt", "../foreign.movl"]);
  assert.ok(fs.readRangeCalls.every((call) => !call.path.includes("foreign") && !call.path.includes("notes.txt")));
  assert.deepEqual(await queryRelated(fs, "/root", options), expectedRanking);
});

void test("abort settles started I/O, skips pending bodies, and preserves the query abort reason even with corruption", async () => {
  for (const query of [false, true]) {
    const fs = new GatedFs();
    const identities = await seed(fs);
    fs.started = [];
    fs.readRangeCalls = [];
    fs.gateOffset = query ? OVERLAY_HEADER_BYTES : 0;
    if (query) fs.binaryFiles.get(`/root/${overlayFileName(identities[0])}`)![OVERLAY_HEADER_BYTES] ^= 0xff;
    const controller = new AbortController();
    const reason = new Error("cancel prefix loading");
    let settled = false;
    const result = (query
      ? queryRelated(fs, "/root", { queryVector: Float32Array.from([1, 0, 0]), queryChunkVectors: [], limit: 5, signal: controller.signal })
      : listOverlayPrefixes(fs, "/root", controller.signal)).finally(() => { settled = true; });
    const rejected = assert.rejects(result, (error: unknown) => error === reason);
    await fs.eightStarted.promise;
    controller.abort(reason);
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(fs.started.length, 8);
    fs.releaseAll();
    await rejected;
    assert.equal(fs.active, 0);
    assert.equal(fs.started.length, 8);
    assert.equal(fs.readRangeCalls.filter((call) => call.offset === OVERLAY_HEADER_BYTES).length, query ? 8 : 0);
  }
});

void test("pre-aborted listing does no I/O, including when directory listing would fail", async () => {
  const fs = new GatedFs();
  fs.readdir = () => { throw new Error("must not list"); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(listOverlayPrefixes(fs, "/root", controller.signal), { name: "AbortError" });
  assert.deepEqual(fs.started, []);
});

void test("abort during directory I/O propagates cancellation even if readdir fails", async () => {
  const fs = new GatedFs();
  const controller = new AbortController();
  fs.readdir = () => {
    controller.abort();
    return Promise.reject(new Error("directory unavailable"));
  };
  await assert.rejects(listOverlayPrefixes(fs, "/root", controller.signal), { name: "AbortError" });
  assert.deepEqual(fs.started, []);
});

void test("corrupt owned prefix stops scheduling and waits for every started read before rejection", async () => {
  const fs = new GatedFs();
  const identities = await seed(fs);
  fs.started = [];
  fs.gateOffset = OVERLAY_HEADER_BYTES;
  const corruptPath = `/root/${overlayFileName(identities[0])}`;
  const bytes = fs.binaryFiles.get(corruptPath)!;
  bytes[OVERLAY_HEADER_BYTES] ^= 0xff;
  let settled = false;
  const listing = listOverlayPrefixes(fs, "/root").finally(() => { settled = true; });
  const rejected = assert.rejects(listing, OverlayStoreError);
  await fs.eightStarted.promise;
  fs.gates[0].resolve();
  await setImmediate();
  assert.equal(settled, false);
  assert.equal(fs.started.length, 8);
  fs.releaseAll();
  await rejected;
  assert.equal(fs.active, 0);
  assert.equal(fs.started.length, 8);
});

void test("prefix bounds accept maximum dimension and bounded long metadata, reject oversized declarations before body I/O", async () => {
  const fs = new FakeIndexFs();
  const identity = stableNoteIdentity(canonicalizePath(`${"long/".repeat(100)}Note.md`));
  const noteVector = new Float32Array(MAX_DIMENSION);
  noteVector[0] = 1;
  const input = { identity, sourceHash: "a".repeat(64), embeddingModel: "model", dimension: MAX_DIMENSION, noteVector, chunkVectors: [] };
  await writeUpsertOverlay(fs, "/root", input);
  const path = `/root/${overlayFileName(identity)}`;
  const initialBytes = fs.binaryFiles.get(path)!;
  const metadataLength = new DataView(initialBytes.buffer).getUint32(8, true);
  await writeUpsertOverlay(fs, "/root", { ...input, embeddingModel: "m".repeat(OVERLAY_METADATA_JSON_MAX_BYTES - metadataLength + input.embeddingModel.length) });
  assert.equal(new DataView(fs.binaryFiles.get(path)!.buffer).getUint32(8, true), OVERLAY_METADATA_JSON_MAX_BYTES);
  assert.deepEqual((await listOverlayPrefixes(fs, "/root")).records[0].noteVector, noteVector);
  const original = fs.binaryFiles.get(path)!;
  for (const [offset, length] of [[8, OVERLAY_METADATA_JSON_MAX_BYTES + 1], [12, encodedMatrixByteLength(MAX_DIMENSION, 1) + 1]]) {
    const corrupt = original.slice();
    new DataView(corrupt.buffer).setUint32(offset, length, true);
    fs.binaryFiles.set(path, corrupt);
    fs.readRangeCalls = [];
    await assert.rejects(listOverlayPrefixes(fs, "/root"), /prefix exceeds/);
    assert.deepEqual(fs.readRangeCalls.map((call) => call.length), [OVERLAY_HEADER_BYTES]);
  }
});
