import { createHash } from "node:crypto";

import { joinRelative } from "../engine/atomicStore";
import { AtomicBinaryStore } from "./atomicBinaryStore";
import { normalizeVector } from "./cosineIndex";
import { OVERLAY_METADATA_JSON_MAX_BYTES } from "./budgets";
import { identityKey } from "./generationMetadata";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "./indexManifest";
import type { IndexFs } from "./indexFs";
import {
  decodeOverlayFull,
  decodeOverlayHeader,
  decodeOverlayPrefix,
  encodeOverlayContainer,
  overlayContainerTotalLength,
  overlayPrefixBodyLength,
  OVERLAY_HEADER_BYTES,
  OverlayCodecError,
  type OverlayContainerOperation,
} from "./overlayCodec";
import { MAX_MATRIX_TOTAL_BYTES, decodeVectorMatrix, encodeVectorMatrix, type VectorMatrix } from "./vectorCodec";
import type { NoteIdentityV1 } from "../engine/contracts";
import { parseNoteIdentityV1 } from "../engine/contracts";

/**
 * One atomic, checksummed per-note overlay/tombstone container, physically
 * a single raw binary file (`overlayCodec.ts`) -- how a note is upserted
 * or deleted between full generation rebuilds without touching the
 * immutable base generation at all. Each identity's overlay lives at its
 * own file (`overlays/<sha256(identityKey)>.movl`), written through
 * `AtomicBinaryStore` exactly like a generation's `.mvx` files, so writing
 * one note's overlay can never partially clobber another's and is itself
 * crash-safe (fsync + byte-for-byte write-back verify + atomic rename).
 *
 * VERSIONING: `version` is a small, PER-PENDING-OVERLAY counter this
 * module assigns and owns entirely -- callers never supply it. It exists
 * only to reject a write racing an already-in-flight write for the same
 * identity (a caller must serialize its own calls per identity; see
 * `IndexStore`'s mutation queue); it is NOT a durable, globally
 * monotonic mutation history. Once an overlay is incorporated into a new
 * generation by compaction, its file is deleted -- a subsequent new
 * overlay for the same identity starts back at version 1. This is
 * deliberate, not a bug: the prior mutation is already durably captured
 * in the generation compaction produced, so there is nothing stale left
 * to protect against for a brand new pending overlay.
 *
 * LAZY READS: `readOverlayPrefix` reads and fully validates ONLY the
 * header+metadata+note-vector span (via `IndexFs.readFileBytesRange`,
 * never touching whatever chunk-vector bytes follow on disk) -- this is
 * what the merged committed view's ranking pass uses for every overlay.
 * `readOverlayFull` reads and validates the complete file, including
 * chunk vectors, and is used only when a specific candidate's chunk
 * payload is actually needed for refinement.
 */

export class OverlayStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayStoreError";
  }
}

const MAX_OVERLAY_BYTES = MAX_MATRIX_TOTAL_BYTES;
const OVERLAY_EXTENSION = ".movl";
/** A file's basename matches this pattern if and only if it is a name `overlayFileName` could have produced -- i.e. it is OWNED by this store. Anything else found under `overlays/` is foreign and is reported/ignored, never deleted, never treated as a fail-closed integrity failure. */
const OWNED_OVERLAY_FILENAME_PATTERN = /^[0-9a-f]{64}\.movl$/;

export type OverlayOperation = OverlayContainerOperation;

/** Deterministic, collision-safe (SHA-256, full 64 hex chars) overlay filename for a note identity -- one identity always maps to exactly one file, so "the same identity replaces only its own overlay" is a structural property of the layout, not a runtime check. */
export function overlayFileName(identity: NoteIdentityV1): string {
  return `overlays/${createHash("sha256").update(identityKey(identity)).digest("hex")}${OVERLAY_EXTENSION}`;
}

/** `true` iff `basename` (no directory component) is a filename this store's own `overlayFileName` could have produced. */
export function isOwnedOverlayFileName(basename: string): boolean {
  return OWNED_OVERLAY_FILENAME_PATTERN.test(basename);
}

interface OverlayMetadataV1 {
  identity: NoteIdentityV1;
  operation: OverlayOperation;
  version: number;
  recordedAt: string;
  sourceHash?: string;
  embeddingModel?: string;
  dimension?: number;
  chunkCount?: number;
}

/**
 * Encodes an overlay's metadata as UTF-8 JSON and enforces
 * `OVERLAY_METADATA_JSON_MAX_BYTES` (imported from `budgets.ts`, the exact
 * constant the disk-budget accounting formula assumes) BEFORE ever
 * writing anything -- the budget's assumption and reality can never
 * drift apart, since the write itself fails closed the moment they would.
 */
function encodeMetadataJsonOrThrow(metadata: OverlayMetadataV1): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (bytes.length > OVERLAY_METADATA_JSON_MAX_BYTES) {
    throw new OverlayStoreError(
      `overlay metadata JSON is ${bytes.length} bytes, exceeding the enforced maximum of ${OVERLAY_METADATA_JSON_MAX_BYTES} bytes (identity "${identityKey(metadata.identity)}").`,
    );
  }
  return bytes;
}

function parseOverlayMetadataJson(bytes: Uint8Array, expectedFileName: string): OverlayMetadataV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new OverlayStoreError(`overlay metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OverlayStoreError("overlay metadata must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const identity = parseNoteIdentityV1(record.identity, "OverlayMetadataV1");
  const actualFileName = overlayFileName(identity);
  if (actualFileName !== expectedFileName) {
    throw new OverlayStoreError(`overlay's identity hashes to "${actualFileName}", but it was read from "${expectedFileName}" -- filename/content identity mismatch.`);
  }
  if (record.operation !== "upsert" && record.operation !== "tombstone") {
    throw new OverlayStoreError(`overlay metadata operation must be "upsert" or "tombstone"; got ${String(record.operation)}.`);
  }
  if (typeof record.version !== "number" || !Number.isInteger(record.version) || record.version < 1) {
    throw new OverlayStoreError("overlay metadata version must be a positive integer.");
  }
  if (typeof record.recordedAt !== "string") {
    throw new OverlayStoreError("overlay metadata recordedAt must be a string.");
  }
  const parsedDate = new Date(record.recordedAt);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString() !== record.recordedAt) {
    throw new OverlayStoreError("overlay metadata recordedAt must be a canonical UTC ISO-8601 timestamp.");
  }

  if (record.operation === "tombstone") {
    for (const field of ["sourceHash", "embeddingModel", "dimension", "chunkCount"] as const) {
      if (record[field] !== undefined) {
        throw new OverlayStoreError(`overlay metadata field "${field}" must be absent for a tombstone.`);
      }
    }
    return { identity, operation: "tombstone", version: record.version, recordedAt: record.recordedAt };
  }

  if (typeof record.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(record.sourceHash)) {
    throw new OverlayStoreError("overlay metadata sourceHash must be a 64-character lowercase hex digest.");
  }
  if (typeof record.embeddingModel !== "string" || record.embeddingModel.trim().length === 0) {
    throw new OverlayStoreError("overlay metadata embeddingModel must be a non-empty string.");
  }
  if (typeof record.dimension !== "number" || !Number.isInteger(record.dimension) || record.dimension < 1) {
    throw new OverlayStoreError("overlay metadata dimension must be a positive integer.");
  }
  if (typeof record.chunkCount !== "number" || !Number.isInteger(record.chunkCount) || record.chunkCount < 0) {
    throw new OverlayStoreError("overlay metadata chunkCount must be a non-negative integer.");
  }
  // A single overlay's chunk payload must fit the same bounded chunk-refinement workspace as one
  // shard -- enforced at parse time too, not just at write time, so a corrupted/foreign file
  // claiming an oversized chunkCount is rejected before its chunk vector is ever decoded.
  if (record.chunkCount > MAX_MANIFEST_SHARD_ROW_COUNT) {
    throw new OverlayStoreError(`overlay metadata chunkCount (${record.chunkCount}) exceeds the maximum shard row count (${MAX_MANIFEST_SHARD_ROW_COUNT}).`);
  }
  return {
    identity,
    operation: "upsert",
    version: record.version,
    recordedAt: record.recordedAt,
    sourceHash: record.sourceHash,
    embeddingModel: record.embeddingModel,
    dimension: record.dimension,
    chunkCount: record.chunkCount,
  };
}

/** What the merged committed view's ranking pass needs, and nothing more -- no chunk-vector bytes are ever read to produce this. */
export interface OverlayPrefixRecord {
  identity: NoteIdentityV1;
  operation: OverlayOperation;
  version: number;
  recordedAt: string;
  sourceHash?: string;
  embeddingModel?: string;
  dimension?: number;
  chunkCount?: number;
  /** `undefined` for a tombstone. */
  noteVector?: Float32Array;
  /** This overlay container's exact total on-disk byte length (header + both checksums + metadata JSON + note-vector bytes + chunk-vector bytes) -- known from the header alone (`overlayContainerTotalLength`), never requiring a full read. Used for actual (not worst-case-reserved) disk-budget accounting -- see `indexStore.ts`'s per-mutation resource-budget check. */
  containerLength: number;
}

/** Everything in a full overlay, including its (possibly large) decoded chunk-vector matrix. */
export interface OverlayFullRecord extends OverlayPrefixRecord {
  /** `undefined` for a tombstone or a chunkless note. */
  chunkMatrix?: VectorMatrix;
}

function binaryStoreFor(fs: IndexFs, root: string, fileName: string): AtomicBinaryStore {
  return new AtomicBinaryStore({ fs, root, fileName, maxBytes: MAX_OVERLAY_BYTES });
}

/**
 * Reads and fully validates ONLY the header+metadata+note-vector prefix of
 * one identity's overlay file -- via two bounded range reads
 * (`IndexFs.readFileBytesRange`), never the chunk-vector bytes that may
 * follow. Returns `null` if no overlay exists for this identity. Throws
 * `OverlayStoreError` on any corruption, filename/identity mismatch, or
 * prefix checksum failure.
 */
export async function readOverlayPrefix(fs: IndexFs, root: string, identity: NoteIdentityV1): Promise<OverlayPrefixRecord | null> {
  const fileName = overlayFileName(identity);
  return readOverlayPrefixByFileName(fs, root, fileName);
}

async function readOverlayPrefixByFileName(fs: IndexFs, root: string, fileName: string): Promise<OverlayPrefixRecord | null> {
  const store = binaryStoreFor(fs, root, fileName);
  const headerBytes = await readHeaderOrNull(fs, root, fileName);
  if (headerBytes === null) return null;

  let header;
  try {
    header = decodeOverlayHeader(headerBytes);
  } catch (error) {
    throw new OverlayStoreError(`overlay "${fileName}" has an invalid header: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bodyLength = overlayPrefixBodyLength(header);
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await store.loadRange(OVERLAY_HEADER_BYTES, bodyLength);
  } catch (error) {
    throw new OverlayStoreError(`overlay "${fileName}" prefix body failed to read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let prefix;
  try {
    prefix = decodeOverlayPrefix(headerBytes, bodyBytes);
  } catch (error) {
    throw new OverlayStoreError(`overlay "${fileName}" failed prefix validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = parseOverlayMetadataJson(prefix.metadataJsonBytes, fileName);

  let noteVector: Float32Array | undefined;
  if (metadata.operation === "upsert") {
    let noteMatrix: VectorMatrix;
    try {
      noteMatrix = decodeVectorMatrix(prefix.noteVectorBytes, { expectedKind: "note" });
    } catch (error) {
      throw new OverlayStoreError(`overlay "${fileName}" note vector failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (noteMatrix.count !== 1 || noteMatrix.dimension !== metadata.dimension) {
      throw new OverlayStoreError(`overlay "${fileName}" note vector shape does not match its declared dimension.`);
    }
    noteVector = noteMatrix.data;
  }

  return { ...metadata, noteVector, containerLength: overlayContainerTotalLength(header) };
}

async function readHeaderOrNull(fs: IndexFs, root: string, fileName: string): Promise<Uint8Array | null> {
  const store = binaryStoreFor(fs, root, fileName);
  try {
    return await store.loadRange(0, OVERLAY_HEADER_BYTES);
  } catch (error) {
    if (error instanceof Error && /does not exist/.test(error.message)) {
      return null;
    }
    throw new OverlayStoreError(`overlay "${fileName}" header failed to read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads and fully validates the ENTIRE overlay file (both the prefix and full checksums), including its chunk-vector payload. Returns `null` if no overlay exists for this identity. */
export async function readOverlayFull(fs: IndexFs, root: string, identity: NoteIdentityV1): Promise<OverlayFullRecord | null> {
  const fileName = overlayFileName(identity);
  const store = binaryStoreFor(fs, root, fileName);
  const bytes = await store.load();
  if (bytes === null) return null;

  let decoded;
  try {
    decoded = decodeOverlayFull(bytes);
  } catch (error) {
    throw new OverlayStoreError(`overlay "${fileName}" failed full validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = parseOverlayMetadataJson(decoded.metadataJsonBytes, fileName);
  let noteVector: Float32Array | undefined;
  let chunkMatrix: VectorMatrix | undefined;
  if (metadata.operation === "upsert") {
    try {
      noteVector = decodeVectorMatrix(decoded.noteVectorBytes, { expectedKind: "note" }).data;
      chunkMatrix = decodeVectorMatrix(decoded.chunkVectorBytes, { expectedKind: "chunk" });
    } catch (error) {
      throw new OverlayStoreError(`overlay "${fileName}" vectors failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (chunkMatrix.count !== metadata.chunkCount) {
      throw new OverlayStoreError(`overlay "${fileName}" declares chunkCount ${metadata.chunkCount} but its chunk matrix has ${chunkMatrix.count} rows.`);
    }
  }
  return { ...metadata, noteVector, chunkMatrix, containerLength: bytes.length };
}

export interface UpsertOverlayInput {
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
  dimension: number;
  /** Raw (not necessarily pre-normalized) note embedding; normalized here. */
  noteVector: Float32Array;
  /** Raw chunk embeddings, in chunk order; normalized here. */
  chunkVectors: Float32Array[];
  now?: () => Date;
}

async function nextVersion(fs: IndexFs, root: string, identity: NoteIdentityV1): Promise<number> {
  const current = await readOverlayPrefix(fs, root, identity);
  return (current?.version ?? 0) + 1;
}

/**
 * Writes (or replaces) the `"upsert"` overlay for one note identity,
 * atomically. Assigns the next version itself (see the module doc for
 * what "version" does and does not guarantee). Callers must serialize
 * their own writes per identity (e.g. via `IndexStore`'s mutation queue)
 * -- this function does not itself provide mutual exclusion across
 * concurrent calls for the same identity.
 */
export async function writeUpsertOverlay(fs: IndexFs, root: string, input: UpsertOverlayInput): Promise<OverlayPrefixRecord> {
  const noteVector = normalizeVector(input.noteVector);
  if (noteVector.length !== input.dimension) {
    throw new OverlayStoreError(`overlay note vector has dimension ${noteVector.length}, expected ${input.dimension}.`);
  }
  if (input.chunkVectors.length > MAX_MANIFEST_SHARD_ROW_COUNT) {
    throw new OverlayStoreError(
      `overlay for "${identityKey(input.identity)}" has ${input.chunkVectors.length} chunks, exceeding the maximum shard row count (${MAX_MANIFEST_SHARD_ROW_COUNT}) -- one overlay's chunk payload must fit the same bounded workspace as one shard.`,
    );
  }
  const chunkVectors = input.chunkVectors.map((v) => normalizeVector(v));
  for (const [i, v] of chunkVectors.entries()) {
    if (v.length !== input.dimension) {
      throw new OverlayStoreError(`overlay chunk vector ${i} has dimension ${v.length}, expected ${input.dimension}.`);
    }
  }

  const version = await nextVersion(fs, root, input.identity);
  const recordedAt = (input.now ?? (() => new Date()))().toISOString();
  const metadata: OverlayMetadataV1 = {
    identity: input.identity,
    operation: "upsert",
    version,
    recordedAt,
    sourceHash: input.sourceHash,
    embeddingModel: input.embeddingModel,
    dimension: input.dimension,
    chunkCount: chunkVectors.length,
  };

  const noteMatrixEncoded = encodeVectorMatrix({ kind: "note", dimension: input.dimension, count: 1, data: noteVector });
  const chunkData = new Float32Array(chunkVectors.length * input.dimension);
  chunkVectors.forEach((v, i) => chunkData.set(v, i * input.dimension));
  const chunkMatrixEncoded = encodeVectorMatrix({ kind: "chunk", dimension: input.dimension, count: chunkVectors.length, data: chunkData });

  const container = encodeOverlayContainer({
    operation: "upsert",
    metadataJsonBytes: encodeMetadataJsonOrThrow(metadata),
    noteVectorBytes: noteMatrixEncoded,
    chunkVectorBytes: chunkMatrixEncoded,
  });

  const fileName = overlayFileName(input.identity);
  await binaryStoreFor(fs, root, fileName).save(container);
  return { ...metadata, noteVector, containerLength: container.length };
}

export interface TombstoneOverlayInput {
  identity: NoteIdentityV1;
  now?: () => Date;
}

/** Writes (or replaces) the `"tombstone"` overlay for one note identity, atomically. Assigns the next version itself. */
export async function writeTombstoneOverlay(fs: IndexFs, root: string, input: TombstoneOverlayInput): Promise<OverlayPrefixRecord> {
  const version = await nextVersion(fs, root, input.identity);
  const recordedAt = (input.now ?? (() => new Date()))().toISOString();
  const metadata: OverlayMetadataV1 = { identity: input.identity, operation: "tombstone", version, recordedAt };
  const container = encodeOverlayContainer({
    operation: "tombstone",
    metadataJsonBytes: encodeMetadataJsonOrThrow(metadata),
    noteVectorBytes: new Uint8Array(0),
    chunkVectorBytes: new Uint8Array(0),
  });
  const fileName = overlayFileName(input.identity);
  await binaryStoreFor(fs, root, fileName).save(container);
  return { ...metadata, containerLength: container.length };
}

/**
 * Permanently deletes exactly one overlay file by identity. Callers
 * (compaction) must only call this once a rebuilt generation containing
 * that overlay's operation has already been committed (pointer switched)
 * -- this function itself does not check that. A missing file is treated
 * as already-deleted (not an error). Deletes by the identity's exact,
 * deterministically DERIVED owned path (`overlayFileName`) using only
 * `exists` + `unlink` -- never reads the overlay's payload again (by the
 * time compaction calls this, the overlay has already been fully read and
 * incorporated into the new generation exactly once).
 */
export async function deleteOverlay(fs: IndexFs, root: string, identity: NoteIdentityV1): Promise<void> {
  const fileName = overlayFileName(identity);
  const absolutePath = joinRelative(root, fileName);
  if (!(await fs.exists(absolutePath))) return;
  await deleteOverlayFile(fs, root, fileName);
}

async function deleteOverlayFile(fs: IndexFs, root: string, fileName: string): Promise<void> {
  const absolutePath = joinRelative(root, fileName);
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if (!(await fs.exists(absolutePath))) return;
    throw new OverlayStoreError(`failed to delete overlay "${fileName}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ListOverlayPrefixesResult {
  records: OverlayPrefixRecord[];
  /** Basenames under `overlays/` that do NOT match this store's own filename pattern -- reported, never deleted, never treated as a validation failure. */
  foreignFiles: string[];
}

/**
 * Lists and lazily validates every OWNED overlay file's prefix (never a
 * chunk-vector byte is read). Fails closed: if ANY file whose name
 * matches this store's own naming pattern (`isOwnedOverlayFileName`)
 * fails validation for any reason (corrupt, truncated, foreign content at
 * an owned path, filename/identity mismatch, checksum mismatch), this
 * throws `OverlayStoreError` immediately rather than silently skipping
 * it -- a corrupt/unreadable OWNED overlay must never let base state
 * silently resurface (if it were a tombstone) or let compaction
 * incorporate stale data (if it were an upsert). A file that does NOT
 * match the naming pattern at all is foreign (never something this store
 * wrote) and is reported in `foreignFiles`, not treated as an error.
 */
export async function listOverlayPrefixes(fs: IndexFs, root: string): Promise<ListOverlayPrefixesResult> {
  const overlaysDir = joinRelative(root, "overlays");
  let entries: string[];
  try {
    entries = await fs.readdir(overlaysDir);
  } catch {
    return { records: [], foreignFiles: [] };
  }
  const records: OverlayPrefixRecord[] = [];
  const foreignFiles: string[] = [];
  for (const entry of entries) {
    if (!isOwnedOverlayFileName(entry)) {
      foreignFiles.push(entry);
      continue;
    }
    const fileName = `overlays/${entry}`;
    let record: OverlayPrefixRecord | null;
    try {
      record = await readOverlayPrefixByFileName(fs, root, fileName);
    } catch (error) {
      throw new OverlayStoreError(
        `owned overlay "${entry}" failed validation and cannot be safely skipped (doing so could resurrect stale base state or let compaction incorporate stale data): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (record) records.push(record);
  }
  return { records, foreignFiles };
}

export { OverlayCodecError };
