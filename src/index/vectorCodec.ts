import { createHash } from "node:crypto";

/**
 * Stable, versioned little-endian binary format for a contiguous matrix of
 * fixed-dimension, L2-NORMALIZED vectors -- the wire format
 * `NoteVectorRecordV1`/`ChunkVectorRecordV1` rows are laid out in (see
 * `vectorTypes.ts`). Used for both the note-vector matrix and each
 * chunk-vector shard; `kind` distinguishes which so a chunk shard can
 * never be mistaken for (or loaded in place of) the note matrix.
 *
 * Layout (all multi-byte integers little-endian):
 *
 * ```
 * offset  size  field
 * 0       4     magic ASCII "MVX1"
 * 4       1     kind (0 = note matrix, 1 = chunk shard)
 * 5       1     reserved, must be 0
 * 6       2     schemaVersion (uint16)
 * 8       4     dimension (uint32)
 * 12      4     count (uint32)
 * 16      N     vectors: count * dimension * 4 bytes, float32 LE, row-major
 * 16+N    32    SHA-256 checksum of bytes [0, 16+N)
 * ```
 *
 * Total size is always exactly `HEADER_BYTES + count * dimension * 4 + CHECKSUM_BYTES`,
 * and that total is itself bounded by `MAX_MATRIX_TOTAL_BYTES` -- checked
 * from the raw header `dimension`/`count` BEFORE `encodedMatrixByteLength` is
 * even computed for the truncation/trailing-byte check, and before any
 * allocation. `MAX_DIMENSION` (8192) and `MAX_VECTOR_COUNT` (2,000,000)
 * individually bound each field, but their PRODUCT can still be enormous
 * even when both are individually within bounds (8192 * 2,000,000 * 4
 * bytes is ~61GB) -- `MAX_MATRIX_TOTAL_BYTES` is the ceiling that actually
 * prevents that combined case from ever reaching an allocation.
 *
 * `decodeVectorMatrix` rejects any buffer that is not exactly the expected
 * length (both truncated and trailing-byte cases), a mismatched
 * magic/schemaVersion/kind, a checksum mismatch, any row containing a
 * NaN/Infinity component, and any row whose L2 norm is not within
 * `UNIT_NORM_TOLERANCE` of 1 (including an exact zero-norm row) -- every
 * stored row is defined to be L2-normalized, and this is enforced on both
 * `encodeVectorMatrix` and `decodeVectorMatrix`, not assumed. An empty
 * (`count === 0`) matrix has no rows to check and is always valid.
 */

export const VECTOR_MATRIX_MAGIC = "MVX1";
const MAGIC_BYTES = Uint8Array.from(VECTOR_MATRIX_MAGIC, (ch) => ch.charCodeAt(0));
export const VECTOR_MATRIX_SCHEMA_VERSION = 1;
export const HEADER_BYTES = 16;
export const CHECKSUM_BYTES = 32;
const BYTES_PER_FLOAT32 = 4;

export type VectorMatrixKind = "note" | "chunk";
const KIND_TO_BYTE: Readonly<Record<VectorMatrixKind, number>> = { note: 0, chunk: 1 };
const BYTE_TO_KIND: Readonly<Record<number, VectorMatrixKind>> = { 0: "note", 1: "chunk" };

/** Generous individual-field ceilings, well beyond the design's target scale (10,000 notes / 100,000 chunks / 1,024 dimensions). Necessary but NOT sufficient on their own -- see `MAX_MATRIX_TOTAL_BYTES`, which bounds their product. */
export const MAX_DIMENSION = 8192;
export const MAX_VECTOR_COUNT = 2_000_000;
/**
 * Hard ceiling on a single encoded matrix's total byte size, checked
 * BEFORE any allocation. 512 MiB comfortably fits the design's target
 * chunk matrix (100,000 chunks * 1,024 dims * 4 bytes ~= 409.6MB, i.e.
 * ~76% of this ceiling) while still rejecting an adversarial header that
 * combines two individually-in-bounds fields (e.g. `MAX_DIMENSION` *
 * `MAX_VECTOR_COUNT` ~= 61GB) into an allocation that would otherwise
 * throw a raw `RangeError`/OOM deep inside `new Float32Array(...)` instead
 * of failing closed with a clear `VectorCodecError` up front.
 */
export const MAX_MATRIX_TOTAL_BYTES = 512 * 1024 * 1024;

/**
 * Every stored row is defined as L2-normalized; this is the tolerance a
 * norm may deviate from exactly 1 and still be accepted. Float32 carries
 * ~7 decimal digits of precision, and accumulating `dimension` (up to
 * `MAX_DIMENSION` = 8192) squared-and-summed Float32 terms before a single
 * `Math.sqrt` can accumulate meaningfully more rounding error than a
 * per-component epsilon would suggest -- 1e-3 is deliberately generous
 * relative to Float32's actual achievable precision for an
 * already-normalized vector re-encoded through this exact pipeline, while
 * still catching a genuinely non-normalized (or accidentally
 * double-normalized, or corrupted) row.
 */
export const UNIT_NORM_TOLERANCE = 1e-3;

export class VectorCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorCodecError";
  }
}

export interface VectorMatrix {
  kind: VectorMatrixKind;
  dimension: number;
  count: number;
  /** Row-major: vector `i`'s components occupy `data[i*dimension .. i*dimension+dimension)`. Every row must be L2-normalized (within `UNIT_NORM_TOLERANCE`). */
  data: Float32Array;
}

/** The exact byte size `encodeVectorMatrix` produces for a matrix of this shape (header + vector bytes + checksum) -- exported so `indexManifest.ts` and the benchmark can compute disk/rebuild byte accounting from a declared shape alone, without needing the actual encoded bytes in hand, and so both always agree with the codec's own arithmetic. */
export function encodedMatrixByteLength(dimension: number, count: number): number {
  return HEADER_BYTES + count * dimension * BYTES_PER_FLOAT32 + CHECKSUM_BYTES;
}

/** L2 norm of one row of `data` -- shared by the codec's row-normalization check and `cosineIndex.ts`'s query-vector validation, so both use exactly the same arithmetic and tolerance. */
export function rowL2Norm(data: Float32Array, rowStart: number, dimension: number): number {
  let sumSquares = 0;
  for (let i = 0; i < dimension; i += 1) {
    const value = data[rowStart + i];
    sumSquares += value * value;
  }
  return Math.sqrt(sumSquares);
}

export function isApproximatelyUnitNorm(norm: number): boolean {
  return Number.isFinite(norm) && Math.abs(norm - 1) <= UNIT_NORM_TOLERANCE;
}

function assertBoundedDimensionAndCount(dimension: number, count: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > MAX_DIMENSION) {
    throw new VectorCodecError(`dimension must be an integer in (0, ${MAX_DIMENSION}].`);
  }
  if (!Number.isInteger(count) || count < 0 || count > MAX_VECTOR_COUNT) {
    throw new VectorCodecError(`count must be an integer in [0, ${MAX_VECTOR_COUNT}].`);
  }
  // dimension * count * 4 must itself stay a safe integer before it's used for allocation sizing --
  // guards the multiplication itself from silently overflowing on an adversarial header.
  const vectorBytes = dimension * count * BYTES_PER_FLOAT32;
  if (!Number.isSafeInteger(vectorBytes)) {
    throw new VectorCodecError("dimension * count would overflow a safe integer; rejected before allocating.");
  }
  const totalBytes = HEADER_BYTES + vectorBytes + CHECKSUM_BYTES;
  if (totalBytes > MAX_MATRIX_TOTAL_BYTES) {
    throw new VectorCodecError(
      `encoded matrix would be ${totalBytes} bytes (dimension=${dimension}, count=${count}), exceeding the ${MAX_MATRIX_TOTAL_BYTES}-byte ceiling; rejected before allocating.`,
    );
  }
}

function assertRowIsUnitNormOrZeroCount(sumSquares: number, row: number): void {
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    throw new VectorCodecError(`row ${row} has zero norm; every stored row must be L2-normalized.`);
  }
  if (!isApproximatelyUnitNorm(norm)) {
    throw new VectorCodecError(`row ${row} has norm ${norm}, which is not within ${UNIT_NORM_TOLERANCE} of 1 (every stored row must be L2-normalized).`);
  }
}

/** Encodes a row-major matrix of L2-normalized vectors into the binary format above. Rejects a non-finite (NaN/Infinity) component, a zero-norm row, or a row whose norm is not within `UNIT_NORM_TOLERANCE` of 1 -- this codec never silently persists an invalid or non-normalized vector. An empty (`count === 0`) matrix is always valid. */
export function encodeVectorMatrix(matrix: VectorMatrix): Uint8Array {
  const { kind, dimension, count, data } = matrix;
  assertBoundedDimensionAndCount(dimension, count);
  if (data.length !== dimension * count) {
    throw new VectorCodecError(`data length (${data.length}) does not match dimension * count (${dimension * count}).`);
  }
  for (let row = 0; row < count; row += 1) {
    let sumSquares = 0;
    for (let d = 0; d < dimension; d += 1) {
      const value = data[row * dimension + d];
      if (!Number.isFinite(value)) {
        throw new VectorCodecError(`component at row ${row}, dimension ${d} is not finite (NaN/Infinity are never encoded).`);
      }
      sumSquares += value * value;
    }
    assertRowIsUnitNormOrZeroCount(sumSquares, row);
  }

  const totalBytes = encodedMatrixByteLength(dimension, count);
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set(MAGIC_BYTES, 0);
  view.setUint8(4, KIND_TO_BYTE[kind]);
  view.setUint8(5, 0);
  view.setUint16(6, VECTOR_MATRIX_SCHEMA_VERSION, true);
  view.setUint32(8, dimension, true);
  view.setUint32(12, count, true);
  for (let i = 0; i < data.length; i += 1) {
    view.setFloat32(HEADER_BYTES + i * BYTES_PER_FLOAT32, data[i], true);
  }

  const checksum = sha256(bytes.subarray(0, HEADER_BYTES + data.length * BYTES_PER_FLOAT32));
  bytes.set(checksum, HEADER_BYTES + data.length * BYTES_PER_FLOAT32);

  return bytes;
}

export interface DecodeVectorMatrixOptions {
  /** When given, the decoded `kind` must match exactly, or decoding fails closed -- lets a caller assert "this must be a chunk shard" instead of accepting either. */
  expectedKind?: VectorMatrixKind;
}

/** Decodes and fully validates a buffer produced by `encodeVectorMatrix`. Every failure mode is a `VectorCodecError`; nothing is ever partially trusted. */
export function decodeVectorMatrix(bytes: Uint8Array, options: DecodeVectorMatrixOptions = {}): VectorMatrix {
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES) {
    throw new VectorCodecError("buffer is too short to contain even an empty vector matrix.");
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== MAGIC_BYTES[i]) {
      throw new VectorCodecError(`bad magic: expected "${VECTOR_MATRIX_MAGIC}".`);
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kindByte = view.getUint8(4);
  const kind = BYTE_TO_KIND[kindByte];
  if (!kind) {
    throw new VectorCodecError(`unrecognized matrix kind byte: ${kindByte}.`);
  }
  if (options.expectedKind && kind !== options.expectedKind) {
    throw new VectorCodecError(`expected a "${options.expectedKind}" matrix, got "${kind}".`);
  }
  if (view.getUint8(5) !== 0) {
    throw new VectorCodecError("reserved header byte must be 0.");
  }
  const schemaVersion = view.getUint16(6, true);
  if (schemaVersion !== VECTOR_MATRIX_SCHEMA_VERSION) {
    throw new VectorCodecError(`unsupported schemaVersion ${schemaVersion}; expected ${VECTOR_MATRIX_SCHEMA_VERSION}.`);
  }
  const dimension = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  // Bounds (including the total-byte ceiling) are checked from the raw header fields BEFORE
  // `encodedMatrixByteLength`/any allocation below -- an adversarial header can never reach `new
  // Float32Array(...)`.
  assertBoundedDimensionAndCount(dimension, count);

  const expectedLength = encodedMatrixByteLength(dimension, count);
  if (bytes.length !== expectedLength) {
    throw new VectorCodecError(
      bytes.length < expectedLength
        ? `buffer is truncated: expected ${expectedLength} bytes, got ${bytes.length}.`
        : `buffer has trailing bytes: expected ${expectedLength} bytes, got ${bytes.length}.`,
    );
  }

  const vectorByteLength = count * dimension * BYTES_PER_FLOAT32;
  const declaredChecksum = bytes.subarray(HEADER_BYTES + vectorByteLength, HEADER_BYTES + vectorByteLength + CHECKSUM_BYTES);
  const actualChecksum = sha256(bytes.subarray(0, HEADER_BYTES + vectorByteLength));
  if (!bytesEqual(declaredChecksum, actualChecksum)) {
    throw new VectorCodecError("checksum mismatch: the vector matrix bytes have been altered or are corrupt.");
  }

  const data = new Float32Array(count * dimension);
  for (let row = 0; row < count; row += 1) {
    let sumSquares = 0;
    for (let d = 0; d < dimension; d += 1) {
      const flatIndex = row * dimension + d;
      const value = view.getFloat32(HEADER_BYTES + flatIndex * BYTES_PER_FLOAT32, true);
      if (!Number.isFinite(value)) {
        throw new VectorCodecError(`decoded component at row ${row}, dimension ${d} is not finite (NaN/Infinity).`);
      }
      data[flatIndex] = value;
      sumSquares += value * value;
    }
    assertRowIsUnitNormOrZeroCount(sumSquares, row);
  }

  return { kind, dimension, count, data };
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Hex-encoded SHA-256 of an encoded matrix's bytes -- what `VectorIndexManifestV1.noteMatrixChecksum`/`ChunkShardManifestEntryV1.checksum` record. */
export function checksumHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
