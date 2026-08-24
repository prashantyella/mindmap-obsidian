import type { CanonicalPath, NoteIdentityV1, SchemaVersion } from "../engine/contracts";

/**
 * Versioned types for the Chroma-replacement exact vector index: a
 * contiguous note-vector matrix, sharded chunk-vector data with per-note
 * offsets, and a strict versioned manifest -- the design's "deterministic
 * two-tier exact index." Every identifier here is a Checkpoint-1
 * `CanonicalPath`/`NoteIdentityV1`; nothing in this module reads a
 * filesystem, spawns a process, or imports a provider/native/WASM
 * dependency.
 */

/** The only embedding provider this index format supports in 0.3.0 (matches the design's "Ollama is the only embedding provider"). Recorded explicitly in the manifest rather than assumed, so a manifest is self-describing and a future provider addition is a new, explicit value rather than a silent reinterpretation. */
export type EmbeddingProviderId = "ollama";

/** A single row in the note-vector matrix: one L2-normalized embedding per indexed note, plus the bookkeeping needed to detect staleness and reconcile with the vault. Mirrors `IndexRecordV1` (Checkpoint 1) plus the row's position. */
export interface NoteVectorRecordV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  sourceHash: string;
  /** Row index into the paired `Float32Array` matrix this record's vector lives in. */
  rowIndex: number;
  /** Total chunks this note was split into (0 for a note too short to chunk); matches `IndexRecordV1.chunkCount`. */
  chunkCount: number;
}

/** A single row in a chunk-vector shard: one L2-normalized embedding per chunk, tagged with the owning note and its position within that note's chunk sequence. */
export interface ChunkVectorRecordV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  /** 0-based position within the owning note's chunk sequence; `< NoteVectorRecordV1.chunkCount` for the same note. */
  chunkIndex: number;
  /** Row index into the paired `Float32Array` matrix this record's vector lives in. */
  rowIndex: number;
}

/** Contiguous per-note offset range into a chunk shard's row space -- lets chunk refinement bound its work to exactly the rows belonging to a bounded set of note-level candidates without scanning the whole shard. */
export interface ChunkShardNoteOffset {
  identity: NoteIdentityV1;
  /** First row index (inclusive) belonging to this note in the shard's matrix. */
  start: number;
  /** Number of contiguous rows belonging to this note, starting at `start`. */
  length: number;
}

/** One physical chunk-vector shard's metadata, as recorded in the manifest. */
export interface ChunkShardManifestEntryV1 {
  schemaVersion: SchemaVersion;
  shardId: string;
  /** Number of chunk rows this shard contains. */
  count: number;
  /** SHA-256 hex digest of this shard's encoded vector-matrix bytes (see `vectorCodec.ts`). */
  checksum: string;
  /**
   * SHA-256 hex digest of this shard's own per-note offset metadata (its
   * `ChunkShardNoteOffset[]`, on disk as `shard-<id>.offsets.json` --
   * Checkpoint 5). A vector-matrix checksum alone only proves the chunk
   * VECTORS are byte-identical to what was written; it says nothing about
   * whether the offset metadata mapping notes to rows in that matrix has
   * been corrupted/truncated/tampered with. Both are integrity-critical:
   * a corrupt offset table can silently misattribute one note's chunks to
   * another's identity even when the underlying vector bytes are intact.
   */
  offsetChecksum: string;
}

/**
 * Strict, versioned description of one committed index generation: exactly
 * which embedding provider/model/dimension it was built with, how many
 * notes/chunks it covers, which codec version encoded its matrices, their
 * checksums, and when/how it was generated. Never mutated in place --
 * Checkpoint 5's overlay/compaction design produces a new generation
 * (a new manifest) rather than editing this one, so a partially-written
 * manifest is never mistaken for a committed one.
 */
export interface VectorIndexManifestV1 {
  schemaVersion: SchemaVersion;
  /** Monotonically increasing identifier for this generation; stable ordering, never reused. */
  generationId: number;
  generationCreatedAt: string;
  embeddingProvider: EmbeddingProviderId;
  embeddingModel: string;
  dimension: number;
  noteCount: number;
  chunkCount: number;
  /** Version of the binary codec (`vectorCodec.ts`) this generation's matrices were encoded with -- distinct from `schemaVersion` (the manifest's own shape) so the two can evolve independently. */
  codecVersion: number;
  noteMatrixChecksum: string;
  /**
   * SHA-256 hex digest of this generation's note ROW metadata (its
   * `NoteRowMetadataV1[]`, on disk as `notes.meta.json` -- Checkpoint 5):
   * identity, sourceHash, embeddingModel, chunkCount, and rowIndex for
   * every note. `noteMatrixChecksum` alone only proves the note VECTORS
   * are byte-identical to what was written; it says nothing about whether
   * the metadata mapping each row back to a note identity/sourceHash has
   * been corrupted. Both are integrity-critical.
   */
  noteMetadataChecksum: string;
  chunkShards: ChunkShardManifestEntryV1[];
}

/** A ranked note-level or chunk-refined result: a candidate note and its similarity score, before any downstream core/overreach/creative/fill selection (`RelatedCandidateV1`, a later pipeline stage). */
export interface ScoredNote {
  path: CanonicalPath;
  score: number;
}
