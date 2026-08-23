import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeOverlayFull,
  decodeOverlayHeader,
  decodeOverlayPrefix,
  encodeOverlayContainer,
  OVERLAY_HEADER_BYTES,
  OverlayCodecError,
  overlayPrefixBodyLength,
} from "./overlayCodec";

const enc = new TextEncoder();

void test("encode/decode round-trips a full upsert container (metadata + note vector + chunk vector)", () => {
  const metadataJsonBytes = enc.encode(JSON.stringify({ x: 1 }));
  const noteVectorBytes = Uint8Array.from([1, 2, 3, 4]);
  const chunkVectorBytes = Uint8Array.from([5, 6, 7]);
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes, noteVectorBytes, chunkVectorBytes });
  const decoded = decodeOverlayFull(encoded);
  assert.equal(decoded.operation, "upsert");
  assert.deepEqual([...decoded.metadataJsonBytes], [...metadataJsonBytes]);
  assert.deepEqual([...decoded.noteVectorBytes], [...noteVectorBytes]);
  assert.deepEqual([...decoded.chunkVectorBytes], [...chunkVectorBytes]);
});

void test("encode/decode round-trips a tombstone container (no vectors)", () => {
  const metadataJsonBytes = enc.encode(JSON.stringify({ y: 2 }));
  const encoded = encodeOverlayContainer({ operation: "tombstone", metadataJsonBytes, noteVectorBytes: new Uint8Array(0), chunkVectorBytes: new Uint8Array(0) });
  const decoded = decodeOverlayFull(encoded);
  assert.equal(decoded.operation, "tombstone");
  assert.equal(decoded.noteVectorBytes.length, 0);
  assert.equal(decoded.chunkVectorBytes.length, 0);
});

void test("encodeOverlayContainer rejects a tombstone with nonempty vectors", () => {
  assert.throws(
    () => encodeOverlayContainer({ operation: "tombstone", metadataJsonBytes: enc.encode("{}"), noteVectorBytes: Uint8Array.from([1]), chunkVectorBytes: new Uint8Array(0) }),
    OverlayCodecError,
  );
});

void test("decodeOverlayHeader accepts a longer buffer (only reads the fixed header span) and rejects a too-short one", () => {
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes: enc.encode("{}"), noteVectorBytes: Uint8Array.from([1, 2]), chunkVectorBytes: Uint8Array.from([3]) });
  const header = decodeOverlayHeader(encoded); // full file, longer than just the header
  assert.equal(header.operation, "upsert");
  assert.throws(() => decodeOverlayHeader(encoded.subarray(0, OVERLAY_HEADER_BYTES - 1)), OverlayCodecError);
});

void test("decodeOverlayPrefix validates the prefix span WITHOUT reading any chunk-vector bytes", () => {
  const metadataJsonBytes = enc.encode(JSON.stringify({ z: 3 }));
  const noteVectorBytes = Uint8Array.from([9, 9, 9]);
  const chunkVectorBytes = Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]); // deliberately large-ish, never read below
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes, noteVectorBytes, chunkVectorBytes });
  const header = decodeOverlayHeader(encoded);
  const bodyLength = overlayPrefixBodyLength(header);
  const headerBytes = encoded.subarray(0, OVERLAY_HEADER_BYTES);
  const bodyBytes = encoded.subarray(OVERLAY_HEADER_BYTES, OVERLAY_HEADER_BYTES + bodyLength);
  const prefix = decodeOverlayPrefix(headerBytes, bodyBytes);
  assert.deepEqual([...prefix.noteVectorBytes], [...noteVectorBytes]);
  assert.deepEqual([...prefix.metadataJsonBytes], [...metadataJsonBytes]);
});

void test("decodeOverlayFull rejects a bad magic, wrong schemaVersion, and a truncated/trailing-byte buffer", () => {
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes: enc.encode("{}"), noteVectorBytes: Uint8Array.from([1]), chunkVectorBytes: Uint8Array.from([2]) });

  const badMagic = new Uint8Array(encoded);
  badMagic[0] = "X".charCodeAt(0);
  assert.throws(() => decodeOverlayFull(badMagic), (e: unknown) => e instanceof OverlayCodecError && /magic/.test(e.message));

  const badVersion = new Uint8Array(encoded);
  new DataView(badVersion.buffer).setUint16(4, 99, true);
  assert.throws(() => decodeOverlayFull(badVersion), (e: unknown) => e instanceof OverlayCodecError && /schemaVersion/.test(e.message));

  assert.throws(() => decodeOverlayFull(encoded.subarray(0, encoded.length - 1)), OverlayCodecError);
  const withTrailing = new Uint8Array(encoded.length + 1);
  withTrailing.set(encoded);
  assert.throws(() => decodeOverlayFull(withTrailing), OverlayCodecError);
});

void test("decodeOverlayFull/decodeOverlayPrefix reject a single flipped byte anywhere in the covered span", () => {
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes: enc.encode(JSON.stringify({ a: 1 })), noteVectorBytes: Uint8Array.from([1, 2, 3]), chunkVectorBytes: Uint8Array.from([4, 5, 6]) });

  const corruptedMetadata = new Uint8Array(encoded);
  corruptedMetadata[OVERLAY_HEADER_BYTES] ^= 0xff;
  assert.throws(() => decodeOverlayFull(corruptedMetadata), (e: unknown) => e instanceof OverlayCodecError && /prefix checksum/.test(e.message));

  const header = decodeOverlayHeader(encoded);
  const chunkStart = OVERLAY_HEADER_BYTES + header.metadataLength + header.noteVectorLength + 32;
  const corruptedChunk = new Uint8Array(encoded);
  corruptedChunk[chunkStart] ^= 0xff;
  assert.throws(() => decodeOverlayFull(corruptedChunk), (e: unknown) => e instanceof OverlayCodecError && /full checksum/.test(e.message));
});

void test("decodeOverlayHeader rejects a tombstone header claiming nonzero vector lengths", () => {
  const encoded = encodeOverlayContainer({ operation: "upsert", metadataJsonBytes: enc.encode("{}"), noteVectorBytes: Uint8Array.from([1, 2]), chunkVectorBytes: new Uint8Array(0) });
  const tampered = new Uint8Array(encoded);
  new DataView(tampered.buffer).setUint8(6, 1); // flip operation byte to tombstone while lengths still claim vectors
  assert.throws(() => decodeOverlayHeader(tampered), OverlayCodecError);
});
