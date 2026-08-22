import test from "node:test";
import assert from "node:assert/strict";

import {
  checksumHex,
  decodeVectorMatrix,
  encodeVectorMatrix,
  HEADER_BYTES,
  MAX_DIMENSION,
  MAX_MATRIX_TOTAL_BYTES,
  MAX_VECTOR_COUNT,
  UNIT_NORM_TOLERANCE,
  VECTOR_MATRIX_MAGIC,
  VectorCodecError,
  type VectorMatrix,
} from "./vectorCodec";

function matrix(kind: "note" | "chunk", dimension: number, rows: number[][]): VectorMatrix {
  const data = new Float32Array(rows.length * dimension);
  rows.forEach((row, i) => data.set(row, i * dimension));
  return { kind, dimension, count: rows.length, data };
}

/** L2-normalizes `values` (through a Float32 round-trip, same as the codec itself) -- used to build valid stored-row fixtures without hand-computing exact normalized constants. */
function unitRow(values: number[]): number[] {
  const raw = Float32Array.from(values);
  let sumSquares = 0;
  for (const v of raw) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares);
  return [...raw].map((v) => v / norm);
}

void test("encodeVectorMatrix/decodeVectorMatrix round-trips exactly (values, dimension, count, kind)", () => {
  const original = matrix("note", 3, [unitRow([1, 0, 0]), unitRow([0.5, 0.5, 0.70710677]), unitRow([-1, -2, -3])]);
  const encoded = encodeVectorMatrix(original);
  const decoded = decodeVectorMatrix(encoded);
  assert.equal(decoded.kind, "note");
  assert.equal(decoded.dimension, 3);
  assert.equal(decoded.count, 3);
  assert.deepEqual([...decoded.data], [...original.data]);
});

void test("encodeVectorMatrix/decodeVectorMatrix round-trips an empty (zero-row) matrix", () => {
  const original: VectorMatrix = { kind: "chunk", dimension: 1024, count: 0, data: new Float32Array(0) };
  const encoded = encodeVectorMatrix(original);
  const decoded = decodeVectorMatrix(encoded);
  assert.equal(decoded.count, 0);
  assert.equal(decoded.dimension, 1024);
  assert.equal(decoded.data.length, 0);
});

void test("golden byte layout: header fields land at their documented offsets, little-endian", () => {
  const original = matrix("chunk", 2, [unitRow([1, -1])]);
  const encoded = encodeVectorMatrix(original);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

  const magic = String.fromCharCode(encoded[0], encoded[1], encoded[2], encoded[3]);
  assert.equal(magic, VECTOR_MATRIX_MAGIC);
  assert.equal(view.getUint8(4), 1, "kind byte must be 1 for a chunk matrix");
  assert.equal(view.getUint8(5), 0, "reserved byte must be 0");
  assert.equal(view.getUint16(6, true), 1, "schemaVersion must be 1");
  assert.equal(view.getUint32(8, true), 2, "dimension");
  assert.equal(view.getUint32(12, true), 1, "count");
  assert.ok(Math.abs(view.getFloat32(HEADER_BYTES, true) - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(view.getFloat32(HEADER_BYTES + 4, true) + Math.SQRT1_2) < 1e-6);
  assert.equal(encoded.length, HEADER_BYTES + 2 * 4 + 32);
});

void test("golden hex: a fixed, complete encoded buffer (header + normalized vector bytes + checksum) matches exactly, not just field offsets", () => {
  const encoded = encodeVectorMatrix({ kind: "note", dimension: 2, count: 1, data: Float32Array.from([1, 0]) });
  const hex = Buffer.from(encoded).toString("hex");
  assert.equal(
    hex,
    "4d5658310000010002000000010000000000803f00000000bdfb1737a28938990b002f4933e299c59d7e1140928721cd4b63fe11120af964",
  );
});

void test("endian proof: a big-endian-interpreted read of the same bytes gives a different (wrong) value, proving the codec is explicitly little-endian", () => {
  const original = matrix("note", 1, [[1]]);
  const encoded = encodeVectorMatrix(original);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const littleEndianValue = view.getFloat32(HEADER_BYTES, true);
  const bigEndianValue = view.getFloat32(HEADER_BYTES, false);
  assert.equal(littleEndianValue, 1);
  assert.notEqual(bigEndianValue, 1, "reading the same bytes as big-endian must NOT reproduce the encoded value");
  // Also prove dimension/count themselves are written little-endian, not just floats.
  assert.equal(view.getUint32(8, true), 1);
  assert.notEqual(view.getUint32(8, false), 1);
});

void test("decodeVectorMatrix rejects a truncated buffer", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const truncated = encoded.subarray(0, encoded.length - 1);
  assert.throws(() => decodeVectorMatrix(truncated), VectorCodecError);
});

void test("decodeVectorMatrix rejects a buffer with trailing bytes", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const withTrailing = new Uint8Array(encoded.length + 1);
  withTrailing.set(encoded);
  assert.throws(() => decodeVectorMatrix(withTrailing), VectorCodecError);
});

void test("decodeVectorMatrix rejects a checksum mismatch (single flipped byte)", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const corrupted = new Uint8Array(encoded);
  corrupted[HEADER_BYTES] ^= 0xff; // flip a byte inside the vector data, checksum no longer matches
  assert.throws(() => decodeVectorMatrix(corrupted), (error: unknown) => error instanceof VectorCodecError && /checksum/.test(error.message));
});

void test("decodeVectorMatrix rejects a wrong magic", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const corrupted = new Uint8Array(encoded);
  corrupted[0] = "X".charCodeAt(0);
  assert.throws(() => decodeVectorMatrix(corrupted), (error: unknown) => error instanceof VectorCodecError && /magic/.test(error.message));
});

void test("decodeVectorMatrix rejects an unsupported schemaVersion", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const corrupted = new Uint8Array(encoded);
  const view = new DataView(corrupted.buffer);
  view.setUint16(6, 99, true);
  assert.throws(() => decodeVectorMatrix(corrupted), (error: unknown) => error instanceof VectorCodecError && /schemaVersion/.test(error.message));
});

void test("decodeVectorMatrix rejects a mismatched expectedKind", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  assert.throws(
    () => decodeVectorMatrix(encoded, { expectedKind: "chunk" }),
    (error: unknown) => error instanceof VectorCodecError && /expected a "chunk"/.test(error.message),
  );
});

void test("decodeVectorMatrix rejects a dimension of 0 and a dimension above the ceiling", () => {
  const encoded = encodeVectorMatrix(matrix("note", 4, [unitRow([1, 2, 3, 4])]));
  const zeroDim = new Uint8Array(encoded);
  new DataView(zeroDim.buffer).setUint32(8, 0, true);
  assert.throws(() => decodeVectorMatrix(zeroDim), VectorCodecError);

  assert.throws(() => encodeVectorMatrix({ kind: "note", dimension: MAX_DIMENSION + 1, count: 0, data: new Float32Array(0) }), VectorCodecError);
});

void test("decodeVectorMatrix rejects a count above the ceiling before allocating", () => {
  // Hand-craft a header claiming an enormous count with a small buffer -- must fail on the
  // bounds check, not attempt to allocate `count * dimension * 4` bytes first.
  const header = new Uint8Array(HEADER_BYTES + 32);
  header.set(Uint8Array.from(VECTOR_MATRIX_MAGIC, (ch) => ch.charCodeAt(0)), 0);
  const view = new DataView(header.buffer);
  view.setUint16(6, 1, true);
  view.setUint32(8, 1024, true);
  view.setUint32(12, MAX_VECTOR_COUNT + 1, true);
  assert.throws(() => decodeVectorMatrix(header), (error: unknown) => error instanceof VectorCodecError && /count/.test(error.message));
});

void test("MAX_MATRIX_TOTAL_BYTES: the design's target chunk matrix (100,000 x 1,024) fits within the ceiling (pure byte-shape arithmetic, no allocation)", () => {
  // The full 100,000 x 1,024 allocation itself (~409.6MB) is exercised only by the opt-in
  // benchmark (`benchmark.test.ts`, gated behind MINDMAP_RUN_INDEX_BENCHMARK=1) -- this default
  // (always-on) test checks the ceiling arithmetic alone, so `npm test` never has to pay for a
  // 409.6MB allocation just to confirm the target shape fits the documented budget.
  const dimension = 1024;
  const count = 100_000;
  const totalBytes = HEADER_BYTES + count * dimension * 4 + 32;
  assert.ok(
    totalBytes <= MAX_MATRIX_TOTAL_BYTES,
    `target chunk matrix (${totalBytes} bytes) must fit within MAX_MATRIX_TOTAL_BYTES (${MAX_MATRIX_TOTAL_BYTES})`,
  );
});

void test("a matrix at the target dimension (1,024) round-trips correctly at a small, cheap-to-allocate row count", () => {
  const dimension = 1024;
  const count = 8;
  const data = new Float32Array(count * dimension);
  for (let row = 0; row < count; row += 1) {
    data[row * dimension] = 1; // exact unit vector (no rounding) per row
  }
  const encoded = encodeVectorMatrix({ kind: "chunk", dimension, count, data });
  assert.equal(encoded.length, HEADER_BYTES + count * dimension * 4 + 32);
  const decoded = decodeVectorMatrix(encoded, { expectedKind: "chunk" });
  assert.equal(decoded.count, count);
  assert.equal(decoded.dimension, dimension);
  assert.deepEqual([...decoded.data], [...data]);
});

void test("MAX_MATRIX_TOTAL_BYTES: an adversarial header combining two individually-in-bounds fields (8192 dims x 2,000,000 count) is rejected before allocating, with VectorCodecError not RangeError/OOM", () => {
  assert.throws(
    () => encodeVectorMatrix({ kind: "note", dimension: MAX_DIMENSION, count: MAX_VECTOR_COUNT, data: new Float32Array(0) }),
    (error: unknown) => error instanceof VectorCodecError && /ceiling/.test(error.message),
  );

  // Hand-craft the decode-side header too -- a tiny buffer claiming the adversarial shape must
  // fail on the ceiling check, never attempt `new Float32Array(count * dimension)`.
  const header = new Uint8Array(HEADER_BYTES + 32);
  header.set(Uint8Array.from(VECTOR_MATRIX_MAGIC, (ch) => ch.charCodeAt(0)), 0);
  const view = new DataView(header.buffer);
  view.setUint16(6, 1, true);
  view.setUint32(8, MAX_DIMENSION, true);
  view.setUint32(12, MAX_VECTOR_COUNT, true);
  assert.throws(() => decodeVectorMatrix(header), (error: unknown) => error instanceof VectorCodecError && /ceiling/.test(error.message));
});

void test("encodeVectorMatrix rejects NaN/Infinity components", () => {
  assert.throws(() => encodeVectorMatrix(matrix("note", 2, [[Number.NaN, 0]])), VectorCodecError);
  assert.throws(() => encodeVectorMatrix(matrix("note", 2, [[Number.POSITIVE_INFINITY, 0]])), VectorCodecError);
  assert.throws(() => encodeVectorMatrix(matrix("note", 2, [[0, Number.NEGATIVE_INFINITY]])), VectorCodecError);
});

void test("decodeVectorMatrix rejects a decoded NaN component even if the checksum happens to match", () => {
  const encoded = encodeVectorMatrix(matrix("note", 1, [[1]]));
  const corrupted = new Uint8Array(encoded);
  const view = new DataView(corrupted.buffer);
  view.setFloat32(HEADER_BYTES, Number.NaN, true);
  // Recompute the checksum over the corrupted bytes so this test isolates the NaN check, not the checksum check.
  const recomputedChecksumHex = checksumHex(corrupted.subarray(0, HEADER_BYTES + 4));
  for (let i = 0; i < 32; i += 1) {
    corrupted[HEADER_BYTES + 4 + i] = parseInt(recomputedChecksumHex.slice(i * 2, i * 2 + 2), 16);
  }
  assert.throws(() => decodeVectorMatrix(corrupted), (error: unknown) => error instanceof VectorCodecError && /finite/.test(error.message));
});

void test("encodeVectorMatrix rejects a data length that does not match dimension * count", () => {
  assert.throws(() => encodeVectorMatrix({ kind: "note", dimension: 4, count: 2, data: new Float32Array(4) }), VectorCodecError);
});

void test("checksumHex is deterministic and content-sensitive", () => {
  const a = encodeVectorMatrix(matrix("note", 2, [unitRow([1, 2])]));
  const b = encodeVectorMatrix(matrix("note", 2, [unitRow([1, 2])]));
  const c = encodeVectorMatrix(matrix("note", 2, [unitRow([1, 3])]));
  assert.equal(checksumHex(a), checksumHex(b));
  assert.notEqual(checksumHex(a), checksumHex(c));
  assert.match(checksumHex(a), /^[0-9a-f]{64}$/);
});

void test("encodeVectorMatrix accepts an empty matrix with no rows to validate", () => {
  const encoded = encodeVectorMatrix({ kind: "note", dimension: 8, count: 0, data: new Float32Array(0) });
  const decoded = decodeVectorMatrix(encoded);
  assert.equal(decoded.count, 0);
});

void test("encodeVectorMatrix rejects a zero-norm row", () => {
  assert.throws(
    () => encodeVectorMatrix(matrix("note", 3, [[0, 0, 0]])),
    (error: unknown) => error instanceof VectorCodecError && /zero norm/.test(error.message),
  );
});

void test("encodeVectorMatrix rejects a materially non-unit-norm row", () => {
  assert.throws(
    () => encodeVectorMatrix(matrix("note", 2, [[1, 1]])), // norm sqrt(2), far outside tolerance
    (error: unknown) => error instanceof VectorCodecError && /norm/.test(error.message),
  );
});

void test("encodeVectorMatrix accepts a row within UNIT_NORM_TOLERANCE of 1 and rejects one just outside it", () => {
  const withinTolerance = 1 + UNIT_NORM_TOLERANCE / 2;
  const outsideTolerance = 1 + UNIT_NORM_TOLERANCE * 5;
  assert.doesNotThrow(() => encodeVectorMatrix(matrix("note", 2, [[withinTolerance, 0]])));
  assert.throws(
    () => encodeVectorMatrix(matrix("note", 2, [[outsideTolerance, 0]])),
    (error: unknown) => error instanceof VectorCodecError && /norm/.test(error.message),
  );
});

void test("decodeVectorMatrix rejects a decoded row whose norm has drifted to zero or materially away from 1, even with a matching checksum", () => {
  const encoded = encodeVectorMatrix(matrix("note", 2, [unitRow([1, 0])]));

  const zeroed = new Uint8Array(encoded);
  new DataView(zeroed.buffer).setFloat32(HEADER_BYTES, 0, true); // both components now 0 -> zero norm
  const zeroedChecksum = checksumHex(zeroed.subarray(0, HEADER_BYTES + 8));
  for (let i = 0; i < 32; i += 1) {
    zeroed[HEADER_BYTES + 8 + i] = parseInt(zeroedChecksum.slice(i * 2, i * 2 + 2), 16);
  }
  assert.throws(() => decodeVectorMatrix(zeroed), (error: unknown) => error instanceof VectorCodecError && /zero norm/.test(error.message));

  const skewed = new Uint8Array(encoded);
  new DataView(skewed.buffer).setFloat32(HEADER_BYTES + 4, 0.5, true); // norm becomes sqrt(1.25), far outside tolerance
  const skewedChecksum = checksumHex(skewed.subarray(0, HEADER_BYTES + 8));
  for (let i = 0; i < 32; i += 1) {
    skewed[HEADER_BYTES + 8 + i] = parseInt(skewedChecksum.slice(i * 2, i * 2 + 2), 16);
  }
  assert.throws(() => decodeVectorMatrix(skewed), (error: unknown) => error instanceof VectorCodecError && /norm/.test(error.message));
});
