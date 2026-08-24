import { AtomicStore, joinRelative } from "../engine/atomicStore";
import type { CanonicalPath, NoteIdentityV1 } from "../engine/contracts";
import { AtomicBinaryStore } from "./atomicBinaryStore";
import { CosineIndexError, normalizeVector, normalizeVectorInto, rankNotes, refineWithChunks } from "./cosineIndex";
import {
  computeMetadataChecksumHex,
  identityKey,
  parseNoteMetadataArrayV1,
  parseShardOffsetsArrayV1,
  type NoteRowMetadataV1,
} from "./generationMetadata";
import { MAX_MANIFEST_CHUNK_COUNT, MAX_MANIFEST_NOTE_COUNT, MAX_MANIFEST_SHARD_ROW_COUNT, parseVectorIndexManifestV1 } from "./indexManifest";
import type { IndexFs } from "./indexFs";
import { checksumHex, decodeVectorMatrix, encodeVectorMatrix, MAX_MATRIX_TOTAL_BYTES, VECTOR_MATRIX_SCHEMA_VERSION, type VectorMatrix } from "./vectorCodec";
import type { ChunkShardNoteOffset, VectorIndexManifestV1 } from "./vectorTypes";

/**
 * Persists/loads one immutable, verified index generation under an owned
 * root directory:
 *
 * ```
 * <root>/
 *   current.json          -- CurrentPointerV1 (this file)
 *   generations/gen-<id>/
 *     manifest.json         -- VectorIndexManifestV1 (indexManifest.ts), JSON
 *     notes.mvx              -- raw encodeVectorMatrix() note-matrix bytes, PHYSICAL BINARY
 *     notes.meta.json        -- NoteRowMetadataV1[], JSON
 *     shards/shard-<n>.mvx          -- raw encodeVectorMatrix() chunk-matrix bytes, PHYSICAL BINARY
 *     shards/shard-<n>.offsets.json -- ChunkShardNoteOffset[], JSON
 *   staging/<token>/       -- same internal layout, used only while building
 * ```
 *
 * Vector matrices are stored as raw binary files (`.mvx`), never
 * base64-in-JSON -- written/read through `AtomicBinaryStore` (byte-for-byte
 * write-back verification, fsync, atomic rename, exactly `AtomicStore`'s
 * discipline applied to raw bytes). Metadata (small, human-diffable) stays
 * JSON through `AtomicStore`. The manifest's checksums cover every
 * artifact directly -- `noteMatrixChecksum`/`chunkShards[].checksum`
 * against the `.mvx` bytes, `noteMetadataChecksum`/`chunkShards[].offsetChecksum`
 * against the metadata JSON.
 *
 * A generation is built entirely under `staging/<token>`, exhaustively
 * re-verified there by an independent full-load pass
 * (`verifyStagedGeneration`), and only THEN renamed in one atomic
 * directory-rename onto its final `generations/gen-<id>` path.
 * `current.json` is updated only by `switchCurrentGeneration`, which
 * first fully loads and verifies the target generation -- the pointer can
 * never be made to reference a missing, corrupt, or unverified
 * generation. Any failure or cancellation before the staging rename
 * leaves `generations/` and `current.json` completely untouched; a
 * pointer-save failure after a successful rename leaves the new
 * generation on disk but simply unreferenced (never auto-activated).
 */

export class GenerationStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationStoreError";
  }
}

/** Thrown when `signal.aborted` is observed at a phase boundary inside `buildGeneration`. Distinguishes a deliberate cancellation from any other build/verification failure, though both leave the same guarantee: nothing under `generations/`/`current.json` changes, and staging is left for `cleanupStaleStaging`. */
export class GenerationBuildCancelledError extends GenerationStoreError {
  constructor() {
    super("generation build was cancelled.");
    this.name = "GenerationBuildCancelledError";
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new GenerationBuildCancelledError();
  }
}

const POINTER_FILE = "current.json";
const POINTER_STORE_SCHEMA_VERSION = 1;
const MANIFEST_STORE_SCHEMA_VERSION = 1;
const NOTES_META_STORE_SCHEMA_VERSION = 1;
const SHARD_OFFSETS_STORE_SCHEMA_VERSION = 1;
/** Generous bound on any single JSON metadata artifact this layer writes. Binary `.mvx` artifacts are bounded separately by the codec's own `MAX_MATRIX_TOTAL_BYTES`. */
const MAX_METADATA_ARTIFACT_BYTES = 16 * 1024 * 1024;

export function generationDirPath(generationId: number): string {
  return `generations/gen-${generationId}`;
}

const GENERATION_DIR_NAME_PATTERN = /^gen-(\d+)$/;

/**
 * Every generation id currently present under `generations/` on disk,
 * whether or not it is the one `current.json` references -- an
 * "unreferenced" (orphaned) generation directory from a build that
 * completed its rename but was never activated (crashed before the
 * pointer switch, or a cancelled `compact()`/rebuild) is just as much a
 * potential id COLLISION for a future build as the currently-referenced
 * one is. Never trusts a listed name past this pattern (`isSafeDirEntryName`-
 * style discipline): unrecognized entries under `generations/` are
 * ignored, not parsed.
 */
export async function listGenerationIds(fs: IndexFs, root: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(joinRelative(root, "generations"));
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const entry of entries) {
    const match = GENERATION_DIR_NAME_PATTERN.exec(entry);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isInteger(id) && id >= 0) ids.push(id);
  }
  return ids;
}

/** `true` iff `generations/gen-<generationId>/manifest.json` exists -- the cheapest possible "does this id already have SOMETHING on disk" check, without reading or validating its contents. */
export async function generationManifestExists(fs: IndexFs, root: string, generationId: number): Promise<boolean> {
  return fs.exists(joinRelative(root, manifestFileName(generationDirPath(generationId))));
}

/**
 * The next SAFE-TO-USE generation id: strictly greater than both the
 * current pointer's id (if any) AND every id already present under
 * `generations/`, referenced or not. Considering unreferenced directories
 * too (not just `current.json`) is what prevents a fresh rebuild from
 * picking an id that collides with an orphaned generation left behind by
 * an earlier crashed/cancelled build -- see Checkpoint 7 requirement 11.
 */
export async function discoverUnusedGenerationId(fs: IndexFs, root: string): Promise<number> {
  const [currentId, existingIds] = await Promise.all([loadCurrentGenerationId(fs, root), listGenerationIds(fs, root)]);
  const highest = existingIds.reduce((max, id) => Math.max(max, id), currentId ?? 0);
  return highest + 1;
}

function manifestFileName(dirPath: string): string {
  return `${dirPath}/manifest.json`;
}

function notesVectorFileName(dirPath: string): string {
  return `${dirPath}/notes.mvx`;
}

function notesMetaFileName(dirPath: string): string {
  return `${dirPath}/notes.meta.json`;
}

function shardVectorFileName(dirPath: string, shardId: string): string {
  return `${dirPath}/shards/${shardId}.mvx`;
}

function shardOffsetsFileName(dirPath: string, shardId: string): string {
  return `${dirPath}/shards/${shardId}.offsets.json`;
}

interface CurrentPointerV1 {
  generationId: number;
}

function parseCurrentPointerV1(value: unknown): CurrentPointerV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GenerationStoreError("current pointer must be a JSON object.");
  }
  const record = value as { generationId?: unknown };
  if (typeof record.generationId !== "number" || !Number.isInteger(record.generationId) || record.generationId < 0) {
    throw new GenerationStoreError("current pointer generationId must be a non-negative integer.");
  }
  return { generationId: record.generationId };
}

function pointerStore(fs: IndexFs, root: string): AtomicStore<CurrentPointerV1> {
  return new AtomicStore<CurrentPointerV1>({
    fs,
    root,
    fileName: POINTER_FILE,
    schemaVersion: POINTER_STORE_SCHEMA_VERSION,
    parse: parseCurrentPointerV1,
    maxBytes: 4096,
  });
}

/**
 * The current generation id, or `null` if no generation has ever been
 * activated. Fails closed (throws `GenerationStoreError`) on a corrupt or
 * malformed pointer file -- NEVER falls back to scanning `generations/`
 * for "the last one that looks valid"; a corrupt pointer is a hard error
 * a caller must surface, not something this layer silently guesses past.
 */
export async function loadCurrentGenerationId(fs: IndexFs, root: string): Promise<number | null> {
  let pointer: CurrentPointerV1 | null;
  try {
    pointer = await pointerStore(fs, root).load();
  } catch (error) {
    throw new GenerationStoreError(`current pointer is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return pointer ? pointer.generationId : null;
}

/** Writes the pointer directly, WITHOUT verifying `generationId` exists or loads cleanly. Never exported -- every external caller must go through `switchCurrentGeneration`, which verifies first. Exists only so `switchCurrentGeneration` and tests that specifically exercise pointer-write failure modes share one implementation. */
async function switchCurrentGenerationUnsafe(fs: IndexFs, root: string, generationId: number): Promise<void> {
  await pointerStore(fs, root).save({ generationId });
}

/**
 * Atomically switches the current-generation pointer to `generationId` --
 * but only after fully, streamingly verifying EVERY artifact of that
 * generation first (`verifyGenerationIntegrity`, the exact same
 * full-corpus check `buildGeneration` runs against a freshly staged
 * generation before its rename -- not the lazy `loadGeneration`, which
 * never touches a shard's bytes until a query actually asks for it). A
 * corruption in any artifact -- the note matrix, note metadata, ANY chunk
 * shard's vectors or offsets (including one the bounded sample query never
 * happens to touch), or the manifest itself -- fails this closed: the
 * pointer is never touched and the verification error propagates
 * unchanged.
 */
export async function switchCurrentGeneration(fs: IndexFs, root: string, generationId: number): Promise<void> {
  await verifyGenerationIntegrity(fs, root, generationDirPath(generationId), generationId);
  await switchCurrentGenerationUnsafe(fs, root, generationId);
}

export interface GenerationInputNote {
  identity: NoteIdentityV1;
  sourceHash: string;
  /** Raw (not necessarily pre-normalized) note embedding; normalized here. Note vectors are always fully resident (bounded by `MAX_MANIFEST_NOTE_COUNT`), so this is eager, unlike chunk vectors. */
  vector: Float32Array;
  /** Must equal exactly how many vectors `loadChunkVectors()` resolves to -- known upfront (for shard planning) without ever calling the loader. */
  chunkCount: number;
  /**
   * Called AT MOST ONCE, lazily, only when this note's OUTPUT shard is
   * actually being built -- this is what makes `buildGeneration` (and,
   * through it, `IndexStore.compact`) genuinely streaming: at no point
   * does it hold more than one output shard's worth of chunk vectors
   * (bounded by `MAX_MANIFEST_SHARD_ROW_COUNT`) resident, regardless of
   * how many total chunks the whole generation has. Raw (not necessarily
   * pre-normalized) vectors, in chunk order; normalized here. Must
   * resolve to exactly `chunkCount` vectors.
   */
  loadChunkVectors: () => Promise<Float32Array[]>;
}

export interface BuildGenerationInput {
  generationId: number;
  embeddingModel: string;
  dimension: number;
  notes: GenerationInputNote[];
}

export interface BuildGenerationOptions {
  /** Checked at every phase boundary (after normalization, after each artifact write, before verification, and -- critically -- immediately before the final staging->generations rename). An abort observed before the rename throws `GenerationBuildCancelledError` and leaves `generations/`/`current.json` completely untouched; the (possibly partially written) staging directory is left for `cleanupStaleStaging`. An abort observed AFTER the rename has already started is not honored -- the rename either completes or fails on its own terms, never left half-done. */
  signal?: AbortSignal;
}

interface ShardPlan {
  shardId: string;
  notes: GenerationInputNote[];
  rowCount: number;
}

/** Greedily bins notes into shards FROM CHUNK COUNTS ONLY (never calling any `loadChunkVectors`), preserving per-note contiguity (a note's chunks are never split across shards) and never exceeding `MAX_MANIFEST_SHARD_ROW_COUNT` rows per shard. Notes with zero chunks contribute nothing and are skipped. */
function planShards(sortedNotes: readonly GenerationInputNote[]): ShardPlan[] {
  const plans: ShardPlan[] = [];
  let current: GenerationInputNote[] = [];
  let currentRows = 0;
  for (const note of sortedNotes) {
    const chunkCount = note.chunkCount;
    if (chunkCount === 0) continue;
    if (chunkCount > MAX_MANIFEST_SHARD_ROW_COUNT) {
      throw new GenerationStoreError(
        `note "${identityKey(note.identity)}" has ${chunkCount} chunks, exceeding the maximum shard row count (${MAX_MANIFEST_SHARD_ROW_COUNT}); it cannot be sharded.`,
      );
    }
    if (currentRows + chunkCount > MAX_MANIFEST_SHARD_ROW_COUNT) {
      plans.push({ shardId: `shard-${plans.length}`, notes: current, rowCount: currentRows });
      current = [];
      currentRows = 0;
    }
    current.push(note);
    currentRows += chunkCount;
  }
  if (current.length > 0) {
    plans.push({ shardId: `shard-${plans.length}`, notes: current, rowCount: currentRows });
  }
  return plans;
}

function notesVectorStore(fs: IndexFs, root: string, dirPath: string): AtomicBinaryStore {
  return new AtomicBinaryStore({ fs, root, fileName: notesVectorFileName(dirPath), maxBytes: MAX_MATRIX_TOTAL_BYTES });
}

function notesMetaStore(fs: IndexFs, root: string, dirPath: string, expectedModel: string): AtomicStore<NoteRowMetadataV1[]> {
  return new AtomicStore<NoteRowMetadataV1[]>({
    fs,
    root,
    fileName: notesMetaFileName(dirPath),
    schemaVersion: NOTES_META_STORE_SCHEMA_VERSION,
    maxBytes: MAX_METADATA_ARTIFACT_BYTES,
    // expectedCount is validated against the actual decoded matrix count by the caller, not here
    // -- this parser only knows the metadata array itself, so it self-validates internal
    // consistency (rowIndex permutation over the array's OWN length, identity uniqueness, shardId
    // presence rules, one shared embeddingModel) and defers the cross-check against notes.mvx's
    // actual row count to whoever loads both files together.
    parse: (value) => {
      if (!Array.isArray(value)) {
        throw new GenerationStoreError("notes.meta.json must be an array.");
      }
      try {
        return parseNoteMetadataArrayV1(value, value.length, expectedModel);
      } catch (error) {
        throw new GenerationStoreError(`notes.meta.json failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

function shardVectorStore(fs: IndexFs, root: string, dirPath: string, shardId: string): AtomicBinaryStore {
  return new AtomicBinaryStore({ fs, root, fileName: shardVectorFileName(dirPath, shardId), maxBytes: MAX_MATRIX_TOTAL_BYTES });
}

function shardOffsetsStore(fs: IndexFs, root: string, dirPath: string, shardId: string, expectedCount: number): AtomicStore<ChunkShardNoteOffset[]> {
  return new AtomicStore<ChunkShardNoteOffset[]>({
    fs,
    root,
    fileName: shardOffsetsFileName(dirPath, shardId),
    schemaVersion: SHARD_OFFSETS_STORE_SCHEMA_VERSION,
    maxBytes: MAX_METADATA_ARTIFACT_BYTES,
    parse: (value) => {
      try {
        return parseShardOffsetsArrayV1(value, expectedCount);
      } catch (error) {
        throw new GenerationStoreError(`${shardId}.offsets.json failed validation: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

function manifestStore(fs: IndexFs, root: string, dirPath: string): AtomicStore<VectorIndexManifestV1> {
  return new AtomicStore<VectorIndexManifestV1>({
    fs,
    root,
    fileName: manifestFileName(dirPath),
    schemaVersion: MANIFEST_STORE_SCHEMA_VERSION,
    maxBytes: MAX_METADATA_ARTIFACT_BYTES,
    parse: parseVectorIndexManifestV1,
  });
}

function randomStagingToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Every `.load()` call in this module (JSON or binary) goes through here so a failure -- corrupt bytes, a failing `parse()`, a bounded-size violation, or an injected filesystem fault -- always surfaces as one consistent `GenerationStoreError`. */
async function loadOrThrow<T>(store: { load(): Promise<T | null> }, context: string): Promise<T> {
  let value: T | null;
  try {
    value = await store.load();
  } catch (error) {
    throw new GenerationStoreError(`${context} failed to load: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null) {
    throw new GenerationStoreError(`${context} is missing.`);
  }
  return value;
}

/**
 * Builds one new immutable generation from scratch: normalizes every
 * vector, shards chunks by note-contiguous bins bounded at
 * `MAX_MANIFEST_SHARD_ROW_COUNT` rows/shard, writes every artifact (raw
 * `.mvx` binary + JSON metadata) into a fresh `staging/<token>` directory
 * (each write already fsync'd and read-back-verified), performs one more
 * independent full-load verification pass over the freshly staged files
 * (decoding every matrix, recomputing and comparing every checksum,
 * cross-checking manifest counts/dimension/model against the actual
 * decoded data, and -- unless the generation is empty -- running one real
 * `rankNotes`/`refineWithChunks` sample query end-to-end), and only then
 * renames the staging directory onto its immutable final path. Does NOT
 * update the current-generation pointer -- call `switchCurrentGeneration`
 * separately once the caller is satisfied.
 *
 * Throws (leaving `generations/` and `current.json` untouched) on:
 * `notes.length`/total chunk count beyond the approved ceilings, a
 * duplicate note identity, a note with more chunks than a single shard can
 * hold, a zero-norm vector, any write/verification failure, or (via
 * `GenerationBuildCancelledError`) `options.signal` being aborted at any
 * phase boundary before the final rename.
 */
export async function buildGeneration(fs: IndexFs, root: string, input: BuildGenerationInput, options: BuildGenerationOptions = {}): Promise<VectorIndexManifestV1> {
  const { signal } = options;
  if (input.notes.length > MAX_MANIFEST_NOTE_COUNT) {
    throw new GenerationStoreError(`generation has ${input.notes.length} notes, exceeding the approved ceiling of ${MAX_MANIFEST_NOTE_COUNT}.`);
  }
  // Chunk-count ceiling is checked from `chunkCount` alone -- no loader is ever called just to
  // validate a total.
  const totalChunks = input.notes.reduce((sum, note) => sum + note.chunkCount, 0);
  if (totalChunks > MAX_MANIFEST_CHUNK_COUNT) {
    throw new GenerationStoreError(`generation has ${totalChunks} chunks, exceeding the approved ceiling of ${MAX_MANIFEST_CHUNK_COUNT}.`);
  }
  const seenIdentities = new Set<string>();
  for (const note of input.notes) {
    const key = identityKey(note.identity);
    if (seenIdentities.has(key)) {
      throw new GenerationStoreError(`duplicate note identity in build input: "${key}".`);
    }
    seenIdentities.add(key);
  }

  const sortedNotes = [...input.notes].sort((a, b) => identityKey(a.identity).localeCompare(identityKey(b.identity)));

  checkAborted(signal);

  // Plan shards FROM CHUNK COUNTS ONLY (never calling a loader), so each note's owning shardId
  // can be recorded directly in its metadata row -- routing (`indexStore.ts`'s "which shard does
  // this candidate need") then only ever requires the already-resident note metadata, never
  // reading/decoding any shard file itself.
  const shardPlans = planShards(sortedNotes);
  const shardIdByIdentityKey = new Map<string, string>();
  for (const plan of shardPlans) {
    for (const note of plan.notes) {
      shardIdByIdentityKey.set(identityKey(note.identity), plan.shardId);
    }
  }

  // Note vectors are always fully resident (bounded by MAX_MANIFEST_NOTE_COUNT) -- only chunk
  // vectors need to stream. Each note is normalized DIRECTLY into its own row of noteMatrixData
  // (via normalizeVectorInto) -- never into a separate same-size array of normalized vectors that
  // would then just be copied into noteMatrixData a second time.
  const noteMatrixData = new Float32Array(sortedNotes.length * input.dimension);
  const noteMetadata: NoteRowMetadataV1[] = [];
  sortedNotes.forEach((note, rowIndex) => {
    if (note.vector.length !== input.dimension) {
      throw new GenerationStoreError(`note "${identityKey(note.identity)}" vector has dimension ${note.vector.length}, expected ${input.dimension}.`);
    }
    try {
      normalizeVectorInto(note.vector, noteMatrixData, rowIndex * input.dimension);
    } catch (error) {
      throw new GenerationStoreError(
        `failed to normalize a note vector (likely a zero vector) for "${identityKey(note.identity)}": ${error instanceof CosineIndexError ? error.message : String(error)}`,
      );
    }
    const shardId = shardIdByIdentityKey.get(identityKey(note.identity));
    noteMetadata.push({
      schemaVersion: 1,
      identity: note.identity,
      sourceHash: note.sourceHash,
      embeddingModel: input.embeddingModel,
      chunkCount: note.chunkCount,
      rowIndex,
      ...(shardId !== undefined ? { shardId } : {}),
    });
  });
  const noteMatrix: VectorMatrix = { kind: "note", dimension: input.dimension, count: sortedNotes.length, data: noteMatrixData };
  const noteMatrixEncoded = encodeVectorMatrix(noteMatrix);
  const noteMatrixChecksum = checksumHex(noteMatrixEncoded);
  const noteMetadataChecksum = computeMetadataChecksumHex(noteMetadata);

  const stagingDir = `staging/${randomStagingToken()}`;
  let manifest: VectorIndexManifestV1;
  try {
    checkAborted(signal);
    await fs.mkdir(joinRelative(root, stagingDir));
    if (shardPlans.length > 0) {
      await fs.mkdir(joinRelative(root, `${stagingDir}/shards`));
    }

    checkAborted(signal);
    await notesVectorStore(fs, root, stagingDir).save(noteMatrixEncoded);
    await notesMetaStore(fs, root, stagingDir, input.embeddingModel).save(noteMetadata);

    // STREAMING: one output shard at a time. Each plan's chunk vectors are loaded (via each
    // note's lazy `loadChunkVectors`), normalized, packed, encoded, and written to disk BEFORE
    // the next plan starts -- `shardData`/the loaded raw vectors are never referenced again once
    // this iteration ends, so at most `MAX_MANIFEST_SHARD_ROW_COUNT` chunk rows are ever resident
    // at once, regardless of the generation's total chunk count.
    const shardManifestEntries: { shardId: string; count: number; checksum: string; offsetChecksum: string }[] = [];
    for (const plan of shardPlans) {
      checkAborted(signal);
      const shardData = new Float32Array(plan.rowCount * input.dimension);
      const offsets: ChunkShardNoteOffset[] = [];
      let cursor = 0;
      for (const note of plan.notes) {
        let rawChunkVectors: Float32Array[];
        try {
          rawChunkVectors = await note.loadChunkVectors();
        } catch (error) {
          throw new GenerationStoreError(`failed to load chunk vectors for note "${identityKey(note.identity)}": ${error instanceof Error ? error.message : String(error)}`);
        }
        if (rawChunkVectors.length !== note.chunkCount) {
          throw new GenerationStoreError(
            `note "${identityKey(note.identity)}" declared chunkCount ${note.chunkCount} but loadChunkVectors() returned ${rawChunkVectors.length}.`,
          );
        }
        for (let i = 0; i < rawChunkVectors.length; i += 1) {
          let normalized: Float32Array;
          try {
            normalized = normalizeVector(rawChunkVectors[i]);
          } catch (error) {
            throw new GenerationStoreError(
              `failed to normalize chunk ${i} of note "${identityKey(note.identity)}" (likely a zero vector): ${error instanceof CosineIndexError ? error.message : String(error)}`,
            );
          }
          if (normalized.length !== input.dimension) {
            throw new GenerationStoreError(`note "${identityKey(note.identity)}" chunk ${i} has dimension ${normalized.length}, expected ${input.dimension}.`);
          }
          shardData.set(normalized, (cursor + i) * input.dimension);
        }
        offsets.push({ identity: note.identity, start: cursor, length: rawChunkVectors.length });
        cursor += rawChunkVectors.length;
      }
      const shardMatrix: VectorMatrix = { kind: "chunk", dimension: input.dimension, count: plan.rowCount, data: shardData };
      const shardEncoded = encodeVectorMatrix(shardMatrix);
      const checksum = checksumHex(shardEncoded);
      const offsetChecksum = computeMetadataChecksumHex(offsets);
      await shardVectorStore(fs, root, stagingDir, plan.shardId).save(shardEncoded);
      await shardOffsetsStore(fs, root, stagingDir, plan.shardId, plan.rowCount).save(offsets);
      shardManifestEntries.push({ shardId: plan.shardId, count: plan.rowCount, checksum, offsetChecksum });
      // shardData/shardEncoded/offsets/rawChunkVectors all go out of scope here -- nothing
      // beyond this iteration retains a reference to this shard's chunk data.
    }

    manifest = parseVectorIndexManifestV1({
      schemaVersion: 1,
      generationId: input.generationId,
      generationCreatedAt: new Date().toISOString(),
      embeddingProvider: "ollama",
      embeddingModel: input.embeddingModel,
      dimension: input.dimension,
      noteCount: sortedNotes.length,
      chunkCount: totalChunks,
      codecVersion: VECTOR_MATRIX_SCHEMA_VERSION,
      noteMatrixChecksum,
      noteMetadataChecksum,
      chunkShards: shardManifestEntries.map((entry) => ({ schemaVersion: 1, ...entry })),
    });

    checkAborted(signal);
    await manifestStore(fs, root, stagingDir).save(manifest);

    checkAborted(signal);
    await verifyGenerationIntegrity(fs, root, stagingDir, input.generationId);

    // Last cancellation checkpoint: once past this point, the rename either fully completes or
    // fails on its own terms (a rename is a single atomic filesystem operation and is never left
    // half-done) -- an abort signalled DURING the rename call itself is not observed.
    checkAborted(signal);
    const finalDir = generationDirPath(input.generationId);
    await fs.rename(joinRelative(root, stagingDir), joinRelative(root, finalDir));
  } catch (error) {
    if (error instanceof GenerationBuildCancelledError) {
      throw error;
    }
    throw new GenerationStoreError(`failed to build generation ${input.generationId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return manifest;
}

/**
 * Full-corpus, STREAMING integrity verification of every artifact under
 * `dirPath` -- the note matrix + note metadata (checksum-verified and kept
 * resident, as everywhere else in this module), and then EVERY chunk
 * shard, one at a time: decoded, checksum-verified (both its vector matrix
 * and its offsets), cross-checked against the resident note metadata, and
 * then allowed to go out of scope before the next shard is even read --
 * NO decoded shard is EVER retained across a loop iteration, sample shard
 * included: the one-shard sample query this function also runs is
 * evaluated INSIDE that shard's own iteration (see `sampleShardId` below),
 * using its still-in-scope `shardMatrix`/`offsets` directly, so at most one
 * shard's decoded bytes are ever resident at any point in time, regardless
 * of how many shards (or how many total chunks) the generation has. The
 * sample query's note-level half (`rankNotes`, which only needs the
 * already-resident note matrix) is computed once, BEFORE the shard loop
 * starts, so the loop body only ever has to run the chunk-level refinement
 * half against whichever shard happens to be the sample.
 *
 * Shared by both call sites that must never let an unverified generation
 * become reachable: `buildGeneration` runs this against a freshly staged
 * `staging/<token>` directory before its final rename, and
 * `switchCurrentGeneration` runs it again against the target
 * `generations/gen-<id>` directory before ever writing `current.json` --
 * so a corruption in ANY shard (including one the bounded sample query
 * never happens to touch) fails closed in both places, not just the one
 * where the corpus was originally built.
 */
async function verifyGenerationIntegrity(
  fs: IndexFs,
  root: string,
  dirPath: string,
  expectedGenerationId?: number,
): Promise<{ manifest: VectorIndexManifestV1; noteMetadata: NoteRowMetadataV1[] }> {
  const loadedManifest = await loadOrThrow(manifestStore(fs, root, dirPath), "manifest.json");
  if (expectedGenerationId !== undefined && loadedManifest.generationId !== expectedGenerationId) {
    throw new GenerationStoreError(`generation ${expectedGenerationId}'s manifest declares a different generationId (${loadedManifest.generationId}).`);
  }
  const noteVectorBytes = await loadOrThrow(notesVectorStore(fs, root, dirPath), "notes.mvx");
  const noteMetadata = await loadOrThrow(notesMetaStore(fs, root, dirPath, loadedManifest.embeddingModel), "notes.meta.json");
  let noteMatrix: VectorMatrix;
  try {
    noteMatrix = decodeVectorMatrix(noteVectorBytes, { expectedKind: "note" });
  } catch (error) {
    throw new GenerationStoreError(`notes.mvx failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (noteMetadata.length !== noteMatrix.count) {
    throw new GenerationStoreError(`notes.meta.json has ${noteMetadata.length} entries; notes.mvx has ${noteMatrix.count} rows.`);
  }
  if (noteMatrix.count !== loadedManifest.noteCount || noteMatrix.dimension !== loadedManifest.dimension) {
    throw new GenerationStoreError("notes.mvx shape does not match manifest noteCount/dimension.");
  }
  if (checksumHex(noteVectorBytes) !== loadedManifest.noteMatrixChecksum) {
    throw new GenerationStoreError("notes.mvx checksum does not match manifest.noteMatrixChecksum.");
  }
  if (computeMetadataChecksumHex(noteMetadata) !== loadedManifest.noteMetadataChecksum) {
    throw new GenerationStoreError("notes.meta.json checksum does not match manifest.noteMetadataChecksum.");
  }

  const noteKeys = new Set(noteMetadata.map((row) => identityKey(row.identity)));
  // Each note's OWN declared owning shard, straight from the already-resident, already-verified
  // note metadata -- the authoritative source every shard's offsets are cross-checked against
  // below, never inferred from which shard happens to contain a matching offset.
  const declaredShardIdByKey = new Map<string, string | undefined>(noteMetadata.map((row) => [identityKey(row.identity), row.shardId]));
  const manifestShardIds = new Set(loadedManifest.chunkShards.map((entry) => entry.shardId));
  for (const row of noteMetadata) {
    if (row.chunkCount > 0 && (row.shardId === undefined || !manifestShardIds.has(row.shardId))) {
      throw new GenerationStoreError(`note "${identityKey(row.identity)}" declares chunkCount ${row.chunkCount} with shardId "${row.shardId}", which is not a shard in the manifest.`);
    }
  }

  // Which shard's decoded {matrix, offsets} the end-to-end sample query runs against -- the FIRST
  // shard, exactly as before, but now the query is run WHILE that shard is the loop's current
  // iteration rather than retained afterward.
  const sampleShardId = loadedManifest.chunkShards[0]?.shardId;

  // Note-level half of the sample query, computed ONCE before the shard loop -- needs only the
  // already-resident note matrix, never a shard's chunk data.
  const ids = noteMetadata.map((row) => row.identity.canonicalPath);
  let sampleQueryVector: Float32Array | undefined;
  let sampleCandidates: ReturnType<typeof rankNotes> | undefined;
  if (noteMatrix.count > 0) {
    sampleQueryVector = noteMatrix.data.slice(0, noteMatrix.dimension);
    try {
      sampleCandidates = rankNotes({ queryVector: sampleQueryVector, matrix: noteMatrix, ids, limit: Math.min(10, noteMatrix.count) });
    } catch (error) {
      throw new GenerationStoreError(`sample rankNotes query failed against the staged generation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const identityKeyByPath = new Map(noteMetadata.map((row) => [row.identity.canonicalPath, identityKey(row.identity)]));

  const chunksByIdentity = new Map<string, number>();
  const shardIdByIdentity = new Map<string, string>();
  let totalCoveredChunkRows = 0;
  for (const shardEntry of loadedManifest.chunkShards) {
    const shardBytes = await loadOrThrow(shardVectorStore(fs, root, dirPath, shardEntry.shardId), `${shardEntry.shardId}.mvx`);
    const offsets = await loadOrThrow(shardOffsetsStore(fs, root, dirPath, shardEntry.shardId, shardEntry.count), `${shardEntry.shardId}.offsets.json`);
    let shardMatrix: VectorMatrix;
    try {
      shardMatrix = decodeVectorMatrix(shardBytes, { expectedKind: "chunk" });
    } catch (error) {
      throw new GenerationStoreError(`${shardEntry.shardId}.mvx failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (shardMatrix.dimension !== loadedManifest.dimension) {
      throw new GenerationStoreError(`${shardEntry.shardId}.mvx dimension (${shardMatrix.dimension}) does not match manifest.dimension (${loadedManifest.dimension}).`);
    }
    if (shardMatrix.count !== shardEntry.count) {
      throw new GenerationStoreError(`${shardEntry.shardId}.mvx declares ${shardMatrix.count} rows; manifest expects ${shardEntry.count}.`);
    }
    if (checksumHex(shardBytes) !== shardEntry.checksum) {
      throw new GenerationStoreError(`${shardEntry.shardId}.mvx checksum does not match manifest.`);
    }
    if (computeMetadataChecksumHex(offsets) !== shardEntry.offsetChecksum) {
      throw new GenerationStoreError(`${shardEntry.shardId}.offsets.json checksum does not match manifest.`);
    }
    for (const offset of offsets) {
      const key = identityKey(offset.identity);
      if (!noteKeys.has(key)) {
        throw new GenerationStoreError(`${shardEntry.shardId}.offsets.json references a note identity not present in notes.meta.json.`);
      }
      const existingShardId = shardIdByIdentity.get(key);
      if (existingShardId !== undefined) {
        throw new GenerationStoreError(`note identity "${key}" has chunk offsets in more than one shard ("${existingShardId}" and "${shardEntry.shardId}").`);
      }
      if (declaredShardIdByKey.get(key) !== shardEntry.shardId) {
        throw new GenerationStoreError(
          `note "${key}" has chunk offsets in "${shardEntry.shardId}", but notes.meta.json declares its shardId as "${declaredShardIdByKey.get(key) ?? "undefined"}".`,
        );
      }
      shardIdByIdentity.set(key, shardEntry.shardId);
      chunksByIdentity.set(key, offset.length);
      totalCoveredChunkRows += offset.length;
    }

    // Chunk-level half of the sample query -- run HERE, while this shard's decoded matrix/offsets
    // are still this iteration's local variables, so nothing is retained once the iteration ends.
    if (shardEntry.shardId === sampleShardId && sampleQueryVector !== undefined && sampleCandidates !== undefined && sampleCandidates.length > 0) {
      const sampleShardIdentityKeys = new Set(offsets.map((o) => identityKey(o.identity)));
      const relevantCandidates = sampleCandidates.filter((c) => {
        const key = identityKeyByPath.get(c.path);
        return key !== undefined && sampleShardIdentityKeys.has(key);
      });
      if (relevantCandidates.length > 0) {
        try {
          refineWithChunks({
            queryChunkVectors: [sampleQueryVector],
            candidates: relevantCandidates,
            chunkMatrix: shardMatrix,
            noteOffsets: offsets,
            limit: Math.min(10, relevantCandidates.length),
          });
        } catch (error) {
          throw new GenerationStoreError(`sample refineWithChunks query failed against the staged generation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    // shardBytes/shardMatrix/offsets go out of scope here -- nothing beyond this iteration
    // (sample shard included) retains a reference to them.
  }

  // Every note's chunkCount in metadata must be covered by exactly that many shard offset rows (0 chunks -> no offset entry at all, in any shard).
  for (const row of noteMetadata) {
    const covered = chunksByIdentity.get(identityKey(row.identity)) ?? 0;
    if (covered !== row.chunkCount) {
      throw new GenerationStoreError(`note "${identityKey(row.identity)}" declares chunkCount ${row.chunkCount} but shard offsets cover ${covered} rows.`);
    }
  }
  if (totalCoveredChunkRows !== loadedManifest.chunkCount) {
    throw new GenerationStoreError(`total chunk rows covered by shard offsets (${totalCoveredChunkRows}) does not match manifest.chunkCount (${loadedManifest.chunkCount}).`);
  }
  return { manifest: loadedManifest, noteMetadata };
}

/**
 * Production, read-only entry point for a FULL streaming integrity pass
 * over an already-activated (or about to be activated) generation --
 * exactly the same exhaustive per-shard verification `buildGeneration`
 * and `switchCurrentGeneration` already run, exported so a durable,
 * phase-checkpointed caller (the Checkpoint 7 rebuild job's
 * `verify-generation` phase) can run it as its own independent,
 * resumable checkpoint WITHOUT going through a pointer switch. Unlike
 * `loadGeneration` (which never touches a shard's bytes until a query
 * actually asks for it), this decodes and checksum-verifies EVERY chunk
 * shard -- a corruption in a shard no query has happened to touch yet is
 * caught here, not silently left resident until some future query hits it.
 */
export async function verifyGenerationFully(fs: IndexFs, root: string, generationId: number): Promise<{ manifest: VectorIndexManifestV1; noteMetadata: NoteRowMetadataV1[] }> {
  return verifyGenerationIntegrity(fs, root, generationDirPath(generationId), generationId);
}

/** A fully loaded, resident generation: manifest + note matrix + note metadata are all small enough to keep resident; chunk shards are loaded lazily and on demand (see `loadShard`), never all at once. */
export interface LoadedGeneration {
  manifest: VectorIndexManifestV1;
  noteMatrix: VectorMatrix;
  noteMetadata: NoteRowMetadataV1[];
  ids: CanonicalPath[];
  /** Note identity key -> the shardId that owns its chunks, or `undefined` if the note has no chunks. Built from the already-resident, already-checksum-verified note metadata -- never by reading any shard file, which would defeat lazy shard loading. */
  shardIdByNoteKey: ReadonlyMap<string, string>;
  /** Decodes and returns exactly one shard's chunk matrix + offsets, freshly from disk, re-validating both its matrix and offsets checksums against the manifest on every call. Callers are responsible for not retaining more than one shard's decoded matrix at a time (see `queryRelated` in `indexStore.ts`, which enforces this structurally). */
  loadShard(shardId: string): Promise<{ matrix: VectorMatrix; offsets: ChunkShardNoteOffset[] }>;
}

/**
 * Loads a generation by id: reads and validates its manifest, note matrix,
 * and note metadata (all resident afterward), and builds a routing index
 * from the note metadata's own `shardId` fields (also resident -- small)
 * without decoding any shard's actual chunk vectors yet. Throws
 * `GenerationStoreError` on any missing/corrupt/checksum-mismatched
 * artifact -- never partially trusts a generation.
 */
export async function loadGeneration(fs: IndexFs, root: string, generationId: number): Promise<LoadedGeneration> {
  const dirPath = generationDirPath(generationId);
  const manifest = await loadOrThrow(manifestStore(fs, root, dirPath), `generation ${generationId} manifest.json`);
  if (manifest.generationId !== generationId) {
    throw new GenerationStoreError(`generation ${generationId}'s manifest declares a different generationId (${manifest.generationId}).`);
  }
  const noteVectorBytes = await loadOrThrow(notesVectorStore(fs, root, dirPath), `generation ${generationId} notes.mvx`);
  const noteMetadata = await loadOrThrow(notesMetaStore(fs, root, dirPath, manifest.embeddingModel), `generation ${generationId} notes.meta.json`);
  let noteMatrix: VectorMatrix;
  try {
    noteMatrix = decodeVectorMatrix(noteVectorBytes, { expectedKind: "note" });
  } catch (error) {
    throw new GenerationStoreError(`generation ${generationId}'s notes.mvx failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (noteMetadata.length !== noteMatrix.count) {
    throw new GenerationStoreError(`generation ${generationId}'s notes.meta.json has ${noteMetadata.length} entries; notes.mvx has ${noteMatrix.count} rows.`);
  }
  if (noteMatrix.count !== manifest.noteCount || noteMatrix.dimension !== manifest.dimension) {
    throw new GenerationStoreError(`generation ${generationId}'s notes.mvx shape does not match its manifest.`);
  }
  if (checksumHex(noteVectorBytes) !== manifest.noteMatrixChecksum) {
    throw new GenerationStoreError(`generation ${generationId}'s notes.mvx checksum does not match its manifest.`);
  }
  if (computeMetadataChecksumHex(noteMetadata) !== manifest.noteMetadataChecksum) {
    throw new GenerationStoreError(`generation ${generationId}'s notes.meta.json checksum does not match its manifest.`);
  }

  const shardIdByNoteKey = new Map<string, string>();
  const validShardIds = new Set(manifest.chunkShards.map((entry) => entry.shardId));
  for (const row of noteMetadata) {
    if (row.shardId === undefined) continue;
    if (!validShardIds.has(row.shardId)) {
      throw new GenerationStoreError(`generation ${generationId}'s notes.meta.json references shardId "${row.shardId}", which is not in its manifest.`);
    }
    shardIdByNoteKey.set(identityKey(row.identity), row.shardId);
  }

  return {
    manifest,
    noteMatrix,
    noteMetadata,
    ids: noteMetadata.map((row) => row.identity.canonicalPath),
    shardIdByNoteKey,
    async loadShard(shardId: string) {
      const shardEntry = manifest.chunkShards.find((entry) => entry.shardId === shardId);
      if (!shardEntry) {
        throw new GenerationStoreError(`generation ${generationId} has no shard "${shardId}".`);
      }
      const shardBytes = await loadOrThrow(shardVectorStore(fs, root, dirPath, shardId), `generation ${generationId} ${shardId}.mvx`);
      const offsets = await loadOrThrow(shardOffsetsStore(fs, root, dirPath, shardId, shardEntry.count), `generation ${generationId} ${shardId}.offsets.json`);
      let shardMatrix: VectorMatrix;
      try {
        shardMatrix = decodeVectorMatrix(shardBytes, { expectedKind: "chunk" });
      } catch (error) {
        throw new GenerationStoreError(`generation ${generationId}'s ${shardId}.mvx failed codec validation: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (shardMatrix.dimension !== manifest.dimension) {
        throw new GenerationStoreError(`generation ${generationId}'s ${shardId}.mvx dimension (${shardMatrix.dimension}) does not match manifest.dimension (${manifest.dimension}).`);
      }
      if (shardMatrix.count !== shardEntry.count) {
        throw new GenerationStoreError(`generation ${generationId}'s ${shardId}.mvx declares ${shardMatrix.count} rows; manifest expects ${shardEntry.count}.`);
      }
      if (checksumHex(shardBytes) !== shardEntry.checksum) {
        throw new GenerationStoreError(`generation ${generationId}'s ${shardId}.mvx checksum does not match its manifest.`);
      }
      if (computeMetadataChecksumHex(offsets) !== shardEntry.offsetChecksum) {
        throw new GenerationStoreError(`generation ${generationId}'s ${shardId}.offsets.json checksum does not match its manifest.`);
      }
      return { matrix: shardMatrix, offsets };
    },
  };
}

/**
 * Best-effort removal of every file AND now-empty directory under any
 * `staging/<token>` directory -- a completed `buildGeneration` always
 * renames its staging directory away, so ANYTHING still under `staging/`
 * at call time is leftover from an interrupted (including cancelled)
 * build and is always safe to remove, without needing to inspect its
 * contents. Never touches `generations/` or `current.json`. Returns the
 * number of files/directories actually removed; a failed removal is
 * simply left for a later cleanup pass, never counted as removed and
 * never thrown.
 */
export async function cleanupStaleStaging(fs: IndexFs, root: string): Promise<number> {
  const stagingRoot = joinRelative(root, "staging");
  let tokens: string[];
  try {
    tokens = await fs.readdir(stagingRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const token of tokens) {
    if (!isSafeDirEntryName(token)) continue; // never trust a listed name enough to join+delete it without this check
    removed += await removeStagingEntryRecursively(fs, joinRelative(stagingRoot, token));
  }
  return removed;
}

/** A `readdir` entry is trusted to be a bare basename (real filesystems can't produce one containing `/` or `..` as a distinct segment) -- but this is the one place in the module where a directory LISTING (not a path this code itself constructed) feeds directly into a delete, so it's defensively re-checked rather than assumed. */
function isSafeDirEntryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

/**
 * Removes `path`, whether it's a file or a directory, WITHOUT ever calling
 * `unlink` on a directory (real `fs.promises.unlink` rejects that, unlike
 * a naive recursive-delete that assumes every leaf is a file). Tries
 * `unlink` first -- if `path` is a file, that's the whole job. If it
 * fails, `path` is treated as a possible directory: every child is removed
 * first (files before subdirectories falls out naturally, since each
 * subdirectory only becomes empty once its own children are gone), then
 * `fs.rmdir` removes `path` itself now that it's empty. A path that is
 * neither a file nor a readable directory (or whose removal fails for any
 * other reason) is simply left for a later cleanup pass.
 */
async function removeStagingEntryRecursively(fs: IndexFs, path: string): Promise<number> {
  try {
    await fs.unlink(path);
    return 1;
  } catch {
    // Not a file (or removable as one) -- fall through and try it as a directory.
  }
  let entries: string[];
  try {
    entries = await fs.readdir(path);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!isSafeDirEntryName(entry)) continue;
    removed += await removeStagingEntryRecursively(fs, joinRelative(path, entry));
  }
  try {
    await fs.rmdir(path);
    removed += 1;
  } catch {
    // Non-empty (a child failed to remove) or removal failed for another reason -- leave it for a
    // later cleanup pass rather than throwing.
  }
  return removed;
}
