import { createHash } from "node:crypto";

/**
 * Physical binary framing for one overlay/tombstone container -- no
 * base64, no large JSON strings. Layout (all multi-byte integers
 * little-endian):
 *
 * ```
 * offset  size  field
 * 0       4     magic ASCII "MOVL"
 * 4       2     schemaVersion (uint16)
 * 6       1     operation (0 = upsert, 1 = tombstone)
 * 7       1     reserved, must be 0
 * 8       4     metadataLength (uint32)
 * 12      4     noteVectorLength (uint32, 0 for a tombstone)
 * 16      4     chunkVectorLength (uint32, 0 for a tombstone or a chunkless note)
 * 20      M     metadata: UTF-8 JSON, M = metadataLength bytes
 * 20+M    N     noteVector: an encodeVectorMatrix() "note" payload, N = noteVectorLength bytes
 * 20+M+N  32    prefixChecksum: SHA-256 of bytes [0, 20+M+N)
 * 52+M+N  C     chunkVector: an encodeVectorMatrix() "chunk" payload, C = chunkVectorLength bytes
 * 52+M+N+C 32   fullChecksum: SHA-256 of bytes [0, 52+M+N+C)
 * ```
 *
 * The split into two checksums is deliberate: `prefixChecksum` covers
 * exactly the header+metadata+noteVector span, so a caller can read AND
 * FULLY VERIFY that span alone (`decodeOverlayPrefix`) without ever
 * reading the (potentially much larger) chunk-vector bytes that follow it
 * -- the actual I/O-level laziness the merged committed view's ranking
 * pass depends on. `fullChecksum` covers everything up to itself and is
 * checked only by `decodeOverlayFull`, when a candidate's chunk payload is
 * actually needed for refinement.
 */

export class OverlayCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayCodecError";
  }
}

export const OVERLAY_MAGIC = "MOVL";
const MAGIC_BYTES = Uint8Array.from(OVERLAY_MAGIC, (ch) => ch.charCodeAt(0));
export const OVERLAY_CONTAINER_SCHEMA_VERSION = 1;
export const OVERLAY_HEADER_BYTES = 20;
export const OVERLAY_CHECKSUM_BYTES = 32;

export type OverlayContainerOperation = "upsert" | "tombstone";
const OPERATION_TO_BYTE: Readonly<Record<OverlayContainerOperation, number>> = { upsert: 0, tombstone: 1 };
const BYTE_TO_OPERATION: Readonly<Record<number, OverlayContainerOperation>> = { 0: "upsert", 1: "tombstone" };

export interface OverlayContainerParts {
  operation: OverlayContainerOperation;
  metadataJsonBytes: Uint8Array;
  /** Empty for a tombstone. */
  noteVectorBytes: Uint8Array;
  /** Empty for a tombstone or a chunkless note. */
  chunkVectorBytes: Uint8Array;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function encodeOverlayContainer(parts: OverlayContainerParts): Uint8Array {
  if (parts.operation === "tombstone" && (parts.noteVectorBytes.length > 0 || parts.chunkVectorBytes.length > 0)) {
    throw new OverlayCodecError("a tombstone container must have empty noteVectorBytes/chunkVectorBytes.");
  }
  const M = parts.metadataJsonBytes.length;
  const N = parts.noteVectorBytes.length;
  const C = parts.chunkVectorBytes.length;
  const prefixEnd = OVERLAY_HEADER_BYTES + M + N;
  const totalLength = prefixEnd + OVERLAY_CHECKSUM_BYTES + C + OVERLAY_CHECKSUM_BYTES;

  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC_BYTES, 0);
  view.setUint16(4, OVERLAY_CONTAINER_SCHEMA_VERSION, true);
  view.setUint8(6, OPERATION_TO_BYTE[parts.operation]);
  view.setUint8(7, 0);
  view.setUint32(8, M, true);
  view.setUint32(12, N, true);
  view.setUint32(16, C, true);
  bytes.set(parts.metadataJsonBytes, OVERLAY_HEADER_BYTES);
  bytes.set(parts.noteVectorBytes, OVERLAY_HEADER_BYTES + M);
  const prefixChecksum = sha256(bytes.subarray(0, prefixEnd));
  bytes.set(prefixChecksum, prefixEnd);
  bytes.set(parts.chunkVectorBytes, prefixEnd + OVERLAY_CHECKSUM_BYTES);
  const fullChecksumStart = prefixEnd + OVERLAY_CHECKSUM_BYTES + C;
  const fullChecksum = sha256(bytes.subarray(0, fullChecksumStart));
  bytes.set(fullChecksum, fullChecksumStart);

  return bytes;
}

export interface OverlayContainerHeader {
  schemaVersion: number;
  operation: OverlayContainerOperation;
  metadataLength: number;
  noteVectorLength: number;
  chunkVectorLength: number;
}

/** Decodes and validates just the fixed-size `OVERLAY_HEADER_BYTES`-byte header. `headerBytes` must be at least that long (a longer array, e.g. the whole file, is fine -- only the first `OVERLAY_HEADER_BYTES` are read). */
export function decodeOverlayHeader(headerBytes: Uint8Array): OverlayContainerHeader {
  if (headerBytes.length < OVERLAY_HEADER_BYTES) {
    throw new OverlayCodecError("overlay container is too short to contain even a header.");
  }
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) {
    if (headerBytes[i] !== MAGIC_BYTES[i]) {
      throw new OverlayCodecError(`overlay container has bad magic: expected "${OVERLAY_MAGIC}".`);
    }
  }
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const schemaVersion = view.getUint16(4, true);
  if (schemaVersion !== OVERLAY_CONTAINER_SCHEMA_VERSION) {
    throw new OverlayCodecError(`overlay container has unsupported schemaVersion ${schemaVersion}.`);
  }
  if (view.getUint8(7) !== 0) {
    throw new OverlayCodecError("overlay container reserved header byte must be 0.");
  }
  const operationByte = view.getUint8(6);
  const operation = BYTE_TO_OPERATION[operationByte];
  if (!operation) {
    throw new OverlayCodecError(`overlay container has an unrecognized operation byte: ${operationByte}.`);
  }
  const metadataLength = view.getUint32(8, true);
  const noteVectorLength = view.getUint32(12, true);
  const chunkVectorLength = view.getUint32(16, true);
  if (operation === "tombstone" && (noteVectorLength !== 0 || chunkVectorLength !== 0)) {
    throw new OverlayCodecError("overlay container declares a tombstone with nonzero vector lengths.");
  }
  return { schemaVersion, operation, metadataLength, noteVectorLength, chunkVectorLength };
}

/** Number of bytes beyond the header needed for a full lazy-prefix read (metadata + note vector + prefix checksum). */
export function overlayPrefixBodyLength(header: OverlayContainerHeader): number {
  return header.metadataLength + header.noteVectorLength + OVERLAY_CHECKSUM_BYTES;
}

/** The container's EXACT total on-disk byte length, computed from its header fields alone (never requires reading the chunk-vector bytes themselves) -- header + metadata + note vector + prefix checksum + chunk vector + full checksum. */
export function overlayContainerTotalLength(header: OverlayContainerHeader): number {
  return OVERLAY_HEADER_BYTES + header.metadataLength + header.noteVectorLength + OVERLAY_CHECKSUM_BYTES + header.chunkVectorLength + OVERLAY_CHECKSUM_BYTES;
}

export interface OverlayContainerPrefix {
  header: OverlayContainerHeader;
  metadataJsonBytes: Uint8Array;
  noteVectorBytes: Uint8Array;
}

/**
 * Validates and decodes the lazy prefix span: `headerBytes` (exactly
 * `OVERLAY_HEADER_BYTES`) and `bodyBytes` (exactly
 * `overlayPrefixBodyLength(header)`, i.e. metadata + note vector + the
 * 32-byte prefix checksum). Never touches, and does not need, any
 * chunk-vector bytes.
 */
export function decodeOverlayPrefix(headerBytes: Uint8Array, bodyBytes: Uint8Array): OverlayContainerPrefix {
  const header = decodeOverlayHeader(headerBytes);
  const expectedBodyLength = overlayPrefixBodyLength(header);
  if (bodyBytes.length !== expectedBodyLength) {
    throw new OverlayCodecError(`overlay container prefix body has ${bodyBytes.length} bytes; expected ${expectedBodyLength}.`);
  }
  const metadataJsonBytes = bodyBytes.subarray(0, header.metadataLength);
  const noteVectorBytes = bodyBytes.subarray(header.metadataLength, header.metadataLength + header.noteVectorLength);
  const declaredChecksum = bodyBytes.subarray(header.metadataLength + header.noteVectorLength, expectedBodyLength);
  const prefixBytes = new Uint8Array(OVERLAY_HEADER_BYTES + header.metadataLength + header.noteVectorLength);
  prefixBytes.set(headerBytes.subarray(0, OVERLAY_HEADER_BYTES), 0);
  prefixBytes.set(metadataJsonBytes, OVERLAY_HEADER_BYTES);
  prefixBytes.set(noteVectorBytes, OVERLAY_HEADER_BYTES + header.metadataLength);
  const actualChecksum = sha256(prefixBytes);
  if (!bytesEqual(declaredChecksum, actualChecksum)) {
    throw new OverlayCodecError("overlay container prefix checksum mismatch: header/metadata/note-vector bytes are corrupt or tampered.");
  }
  return { header, metadataJsonBytes, noteVectorBytes };
}

/** Validates and decodes the ENTIRE container (`fullBytes` must be the complete file) -- both the prefix checksum and the full checksum (which additionally covers the chunk-vector bytes). */
export function decodeOverlayFull(fullBytes: Uint8Array): OverlayContainerParts & { header: OverlayContainerHeader } {
  const header = decodeOverlayHeader(fullBytes);
  const prefixBodyLength = overlayPrefixBodyLength(header);
  const prefix = decodeOverlayPrefix(fullBytes.subarray(0, OVERLAY_HEADER_BYTES), fullBytes.subarray(OVERLAY_HEADER_BYTES, OVERLAY_HEADER_BYTES + prefixBodyLength));
  const prefixEnd = OVERLAY_HEADER_BYTES + header.metadataLength + header.noteVectorLength;
  const chunkStart = prefixEnd + OVERLAY_CHECKSUM_BYTES;
  const chunkEnd = chunkStart + header.chunkVectorLength;
  const expectedTotalLength = chunkEnd + OVERLAY_CHECKSUM_BYTES;
  if (fullBytes.length !== expectedTotalLength) {
    throw new OverlayCodecError(`overlay container has ${fullBytes.length} bytes; expected exactly ${expectedTotalLength}.`);
  }
  const chunkVectorBytes = fullBytes.subarray(chunkStart, chunkEnd);
  const declaredFullChecksum = fullBytes.subarray(chunkEnd, expectedTotalLength);
  const actualFullChecksum = sha256(fullBytes.subarray(0, chunkEnd));
  if (!bytesEqual(declaredFullChecksum, actualFullChecksum)) {
    throw new OverlayCodecError("overlay container full checksum mismatch: chunk-vector bytes are corrupt or tampered.");
  }
  return { header, operation: header.operation, metadataJsonBytes: prefix.metadataJsonBytes, noteVectorBytes: prefix.noteVectorBytes, chunkVectorBytes };
}
