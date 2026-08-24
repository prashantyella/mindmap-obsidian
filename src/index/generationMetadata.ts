import { createHash } from "node:crypto";

import { parseIndexRecordV1, parseNoteIdentityV1, type IndexRecordV1, type NoteIdentityV1 } from "../engine/contracts";
import type { ChunkShardNoteOffset } from "./vectorTypes";

/**
 * Strict parsers/helpers for the two integrity-critical metadata arrays a
 * generation persists alongside its vector matrices: per-note row
 * metadata (which row of the note matrix is which note, and what it was
 * built from) and per-shard chunk offsets (which rows of a chunk shard
 * belong to which note). A vector-matrix checksum alone (`vectorCodec.ts`)
 * only proves the FLOAT bytes are intact; it says nothing about whether
 * this metadata -- the only thing that gives those floats an identity --
 * has been corrupted, truncated, or tampered with. `indexManifest.ts`
 * requires a checksum of each (`noteMetadataChecksum`, per-shard
 * `offsetChecksum`), computed here with `computeMetadataChecksumHex`.
 */

export class GenerationMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationMetadataError";
  }
}

/** Stable string key for a `NoteIdentityV1` -- a `"path"` identity is keyed by its canonical path; an `"apple-annotation"` identity is keyed by its stable annotation id (not its path, which can be regenerated/renamed while the annotation stays the same). Used everywhere two identities need to be compared for "same note" (uniqueness checks, overlay shadowing, the merged committed view). */
export function identityKey(identity: NoteIdentityV1): string {
  return identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
}

/** SHA-256 hex digest of `JSON.stringify(value)` -- used identically for note metadata and shard offset metadata so both integrity checks share one implementation. Deterministic as long as the value's arrays are always constructed in the same order and its objects always built with the same key order (true here: every array below is written in ascending `rowIndex`/`start` order, and every record is built through the same one parser/constructor). */
export function computeMetadataChecksumHex(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** One row of the note-vector matrix's metadata: everything `IndexRecordV1` already carries (identity, sourceHash, embeddingModel, chunkCount) plus which row of the matrix it is. */
export interface NoteRowMetadataV1 extends IndexRecordV1 {
  rowIndex: number;
  /** Which chunk shard owns this note's chunks -- `undefined` for a note with zero chunks. Recorded here (checksummed as part of `noteMetadataChecksum`) specifically so routing "which shard do I need to load for this candidate" never requires reading/decoding any shard file itself -- only shards actually needed for a query's candidates are ever loaded (see `indexStore.ts`'s lazy, at-most-one-shard-resident-at-a-time refinement). */
  shardId?: string;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new GenerationMetadataError(`${field} must be a non-negative integer.`);
  }
  return value;
}

export function parseNoteRowMetadataV1(value: unknown): NoteRowMetadataV1 {
  let record: IndexRecordV1;
  try {
    record = parseIndexRecordV1(value);
  } catch (error) {
    throw new GenerationMetadataError(`note row metadata failed IndexRecordV1 validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawValue = value as { rowIndex?: unknown; shardId?: unknown };
  const rowIndex = requireNonNegativeInteger(rawValue.rowIndex, "rowIndex");
  if (rawValue.shardId !== undefined && (typeof rawValue.shardId !== "string" || rawValue.shardId.trim().length === 0)) {
    throw new GenerationMetadataError("shardId must be a non-empty string when present.");
  }
  if (record.chunkCount === 0 && rawValue.shardId !== undefined) {
    throw new GenerationMetadataError("shardId must be absent for a note with chunkCount 0.");
  }
  if (record.chunkCount > 0 && rawValue.shardId === undefined) {
    throw new GenerationMetadataError("shardId must be present for a note with chunkCount > 0.");
  }
  return { ...record, rowIndex, ...(rawValue.shardId !== undefined ? { shardId: rawValue.shardId } : {}) };
}

/**
 * Parses and strictly validates a generation's complete note metadata
 * array. Fails closed on: a non-array value, a length not exactly
 * `expectedCount`, any entry failing `parseNoteRowMetadataV1`, any entry
 * whose `embeddingModel` doesn't match `expectedModel` (a generation is
 * built with exactly one model; a mismatched entry means the array was
 * assembled from two different generations), a `rowIndex` set that is not
 * an exact permutation of `[0, expectedCount)` (a gap or duplicate would
 * mean some matrix row has no metadata, or two rows claim the same
 * metadata), or a duplicate note identity. Returns the array re-sorted
 * into ascending `rowIndex` order (matching the matrix's own row order),
 * regardless of the input array's order.
 */
export function parseNoteMetadataArrayV1(value: unknown, expectedCount: number, expectedModel: string): NoteRowMetadataV1[] {
  if (!Array.isArray(value)) {
    throw new GenerationMetadataError("note metadata must be an array.");
  }
  if (value.length !== expectedCount) {
    throw new GenerationMetadataError(`note metadata has ${value.length} entries; expected exactly ${expectedCount}.`);
  }
  const rows = value.map((entry) => parseNoteRowMetadataV1(entry));

  const seenRowIndices = new Set<number>();
  const seenIdentities = new Set<string>();
  for (const row of rows) {
    if (row.embeddingModel !== expectedModel) {
      throw new GenerationMetadataError(`note metadata entry embeddingModel "${row.embeddingModel}" does not match the generation's model "${expectedModel}".`);
    }
    if (row.rowIndex >= expectedCount) {
      throw new GenerationMetadataError(`note metadata rowIndex ${row.rowIndex} is out of bounds for ${expectedCount} rows.`);
    }
    if (seenRowIndices.has(row.rowIndex)) {
      throw new GenerationMetadataError(`note metadata has a duplicate rowIndex: ${row.rowIndex}.`);
    }
    seenRowIndices.add(row.rowIndex);
    const key = identityKey(row.identity);
    if (seenIdentities.has(key)) {
      throw new GenerationMetadataError(`note metadata has a duplicate identity: "${key}".`);
    }
    seenIdentities.add(key);
  }
  if (seenRowIndices.size !== expectedCount) {
    throw new GenerationMetadataError(`note metadata rowIndex values do not form an exact permutation of [0, ${expectedCount}).`);
  }

  return [...rows].sort((a, b) => a.rowIndex - b.rowIndex);
}

function parseChunkShardNoteOffset(value: unknown): ChunkShardNoteOffset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GenerationMetadataError("shard offset entry must be an object.");
  }
  const record = value as { identity?: unknown; start?: unknown; length?: unknown };
  const identity = parseNoteIdentityV1(record.identity, "ChunkShardNoteOffset");
  const start = requireNonNegativeInteger(record.start, "start");
  const length = requireNonNegativeInteger(record.length, "length");
  if (length <= 0) {
    throw new GenerationMetadataError("shard offset entry length must be a positive integer.");
  }
  return { identity, start, length };
}

/**
 * Parses and strictly validates one shard's complete offset metadata
 * array. Fails closed on: a non-array value, any entry failing
 * `parseChunkShardNoteOffset`, a duplicate note identity, and -- beyond
 * simple non-overlap -- anything short of an EXACT partition of
 * `[0, expectedShardRowCount)`: sorted by `start`, the first entry must
 * begin at 0, each entry must begin exactly where the previous one ended
 * (no gap, no overlap), and the last entry must end exactly at
 * `expectedShardRowCount`. A gap would mean some shard row belongs to no
 * note (an orphaned, unreachable vector); an overlap would mean two notes
 * claim the same row. Returns the array sorted by `start`.
 */
export function parseShardOffsetsArrayV1(value: unknown, expectedShardRowCount: number): ChunkShardNoteOffset[] {
  if (!Array.isArray(value)) {
    throw new GenerationMetadataError("shard offset metadata must be an array.");
  }
  const offsets = value.map((entry) => parseChunkShardNoteOffset(entry));

  const seenIdentities = new Set<string>();
  for (const offset of offsets) {
    const key = identityKey(offset.identity);
    if (seenIdentities.has(key)) {
      throw new GenerationMetadataError(`shard offset metadata has a duplicate identity: "${key}".`);
    }
    seenIdentities.add(key);
  }

  const sorted = [...offsets].sort((a, b) => a.start - b.start);
  let expectedStart = 0;
  for (const offset of sorted) {
    if (offset.start !== expectedStart) {
      throw new GenerationMetadataError(
        `shard offset metadata does not fully/exactly partition its row space: expected the next range to start at ${expectedStart}, got ${offset.start}.`,
      );
    }
    expectedStart = offset.start + offset.length;
  }
  if (expectedStart !== expectedShardRowCount) {
    throw new GenerationMetadataError(
      `shard offset metadata covers rows [0, ${expectedStart}), which does not exactly match the shard's own row count (${expectedShardRowCount}).`,
    );
  }

  return sorted;
}
