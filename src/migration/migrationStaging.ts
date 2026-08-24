import { createHash } from "node:crypto";

import { joinRelative } from "../engine/atomicStore";
import { isEngineError } from "../engine/errors";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import type { NoteIdentityV1 } from "../engine/contracts";
import { parseNoteIdentityV1 } from "../engine/contracts";
import { AtomicStore, type AtomicStoreFs } from "../engine/atomicStore";
import { AtomicBinaryStore } from "../index/atomicBinaryStore";
import { identityKey } from "../index/generationMetadata";
import type { GenerationInputNote } from "../index/generationStore";
import type { IndexFs } from "../index/indexFs";
import { MAX_MANIFEST_NOTE_COUNT, MAX_MANIFEST_SHARD_ROW_COUNT } from "../index/indexManifest";
import { decodeVectorMatrix, encodeVectorMatrix, MAX_MATRIX_TOTAL_BYTES } from "../index/vectorCodec";

/**
 * Review item 3: `true` iff `error` carries a TYPED errno code meaning
 * "the path was genuinely never there" -- NEVER inferred from free-text
 * `.message` (a genuine, non-missing failure whose message happens to
 * CONTAIN the substring "ENOENT" -- e.g. a permission-denied error on a
 * path that itself contains that text -- must never be misclassified as
 * "safe to swallow" by a naive substring match). Works across both the
 * real filesystem seam (`NodeOwnedFs`, whose `redact()` carries the real
 * syscall `code` in `EngineError.context`) and the in-memory test double
 * (`FakeIndexFs`, which now attaches a real `NodeJS.ErrnoException`-shaped
 * `.code` to its own genuinely-missing-path errors -- see
 * `missingPathError` there -- while an injected fault deliberately carries
 * NO code, so it is correctly classified as a genuine failure here, not a
 * missing one). ANY failure without a recognized missing-path code (an
 * injected fault, permission denied, I/O error, or any other unknown
 * failure) is treated as genuine and must abort the caller's operation,
 * never be silently swallowed.
 */
function isMissingPathError(error: unknown): boolean {
  const code = isEngineError(error) ? (error.context as { code?: unknown } | undefined)?.code : (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Checkpoint 10A review blocker item 4: migration must be able to ingest
 * up to the approved `MAX_MANIFEST_NOTE_COUNT` (10,000) notes /
 * `MAX_MANIFEST_CHUNK_COUNT` (100,000) chunks WITHOUT ever going through
 * `IndexStore.upsertNote`'s pending-overlay namespace, which is budget-
 * capped at `MAX_PENDING_OVERLAY_COUNT` (2,000) -- far below the approved
 * corpus. This module is a SEPARATE, migration-owned, bounded, atomic
 * staging artifact store: one binary vector-matrix file per note (via the
 * SAME `encodeVectorMatrix`/`decodeVectorMatrix`/`AtomicBinaryStore`
 * primitives `generations/`/`overlays/` themselves use, reused directly
 * rather than reimplemented) plus one small bounded JSON metadata file,
 * all under `migration/staging/<runId>/` -- physically distinct from
 * `overlays/`, so nothing here is ever subject to the overlay budget, and
 * nothing here is ever read by `IndexStore`'s own merged-committed-view
 * query path. `buildGenerationInputNotes` assembles the SAME lazy,
 * streaming `GenerationInputNote[]` shape `generationStore.buildGeneration`
 * already consumes (one shard's worth of chunk vectors resident at a
 * time, never the whole corpus) directly from staged artifacts.
 *
 * Index-only: this module never touches a vault note or calls
 * `NoteWriter` -- it only ever reads/writes files under
 * `migration/staging/<runId>/`, exactly like every other Checkpoint 5
 * persistence module reads/writes only its own owned subtree.
 */

export class MigrationStagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationStagingError";
  }
}

const STAGING_META_SCHEMA_VERSION = 1;
/** A JSON metadata document this small (identity + a handful of bounded scalars) can never legitimately approach this size; generous headroom against a corrupt/foreign file. */
const MAX_STAGING_META_BYTES = 16 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STAGED_NOTE_KEY_PATTERN = /^[0-9a-f]{64}$/;

export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new MigrationStagingError("runId must be a short, bounded, control-character-free token.");
  }
}

export function stagingDirPath(runId: string): string {
  assertValidRunId(runId);
  return `migration/staging/${runId}`;
}

/** Deterministic, collision-safe (SHA-256, full 64 hex chars) staging key for a note identity -- mirrors `overlayStore.ts`'s own `overlayFileName` hashing scheme exactly, just rooted under `migration/staging/<runId>/` instead of `overlays/`. */
export function stagedNoteKey(identity: NoteIdentityV1): string {
  return createHash("sha256").update(identityKey(identity)).digest("hex");
}

function metaFileName(runId: string, key: string): string {
  return `${stagingDirPath(runId)}/${key}.meta.json`;
}
function noteVectorFileName(runId: string, key: string): string {
  return `${stagingDirPath(runId)}/${key}.note.mvx`;
}
function chunkVectorFileName(runId: string, key: string): string {
  return `${stagingDirPath(runId)}/${key}.chunks.mvx`;
}

export interface StagedNoteMetaV1 {
  schemaVersion: 1;
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
  dimension: number;
  chunkCount: number;
}

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

function parseStagedNoteMetaV1(value: unknown): StagedNoteMetaV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MigrationStagingError("Staged note metadata must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "identity", "sourceHash", "embeddingModel", "dimension", "chunkCount"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new MigrationStagingError("Staged note metadata has an unrecognized field.");
  }
  if (record.schemaVersion !== 1) throw new MigrationStagingError("Staged note metadata has an unrecognized schemaVersion.");
  const identity = parseNoteIdentityV1(record.identity, "StagedNoteMetaV1");
  if (typeof record.sourceHash !== "string" || !HEX_64_PATTERN.test(record.sourceHash)) {
    throw new MigrationStagingError("Staged note metadata sourceHash must be a lowercase hex64 hash.");
  }
  if (typeof record.embeddingModel !== "string" || record.embeddingModel.trim().length === 0 || record.embeddingModel.length > 200) {
    throw new MigrationStagingError("Staged note metadata embeddingModel must be a short, non-empty string.");
  }
  if (typeof record.dimension !== "number" || !Number.isInteger(record.dimension) || record.dimension < 1 || record.dimension > MAX_EMBEDDING_DIMENSION) {
    throw new MigrationStagingError(`Staged note metadata dimension must be an integer in [1, ${MAX_EMBEDDING_DIMENSION}].`);
  }
  if (typeof record.chunkCount !== "number" || !Number.isInteger(record.chunkCount) || record.chunkCount < 0 || record.chunkCount > MAX_MANIFEST_SHARD_ROW_COUNT) {
    throw new MigrationStagingError(`Staged note metadata chunkCount must be an integer in [0, ${MAX_MANIFEST_SHARD_ROW_COUNT}].`);
  }
  return { schemaVersion: 1, identity, sourceHash: record.sourceHash, embeddingModel: record.embeddingModel, dimension: record.dimension, chunkCount: record.chunkCount };
}

function metaStore(fs: AtomicStoreFs, root: string, runId: string, key: string): AtomicStore<StagedNoteMetaV1> {
  return new AtomicStore<StagedNoteMetaV1>({
    fs,
    root,
    fileName: metaFileName(runId, key),
    schemaVersion: STAGING_META_SCHEMA_VERSION,
    parse: parseStagedNoteMetaV1,
    maxBytes: MAX_STAGING_META_BYTES,
  });
}

export interface WriteStagedNoteInput {
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
  dimension: number;
  noteVector: Float32Array;
  chunkVectors: readonly Float32Array[];
}

/**
 * Review item 4 ("staged artifact torn-set bug"): writes one note's staged
 * artifacts in a specific order chosen so a crash at ANY point never
 * leaves a stale-but-parse-valid `.meta.json` pointing at a binary pair it
 * does not actually describe:
 *
 * 1. FIRST, the EXISTING `.meta.json` (if any -- i.e. this is a
 *    re-ingestion of an identity already staged by a prior attempt) is
 *    removed. This is the commit marker; removing it FIRST means a crash
 *    during steps 2/3 below leaves NO metadata file at all, which
 *    `loadStagedNoteMeta`/`listStagedNotes` already treat identically to
 *    "never staged" -- a clean, unambiguous re-ingest next time, never a
 *    torn old-metadata/new-binary (or old-binary/new-metadata) pairing.
 * 2. The binary note-vector matrix is written.
 * 3. The binary chunk-vector matrix (possibly zero rows) is written.
 * 4. The fresh `.meta.json` is written LAST, once both binaries it
 *    describes are known to be durably on disk.
 *
 * Idempotent: re-staging the same identity (e.g. a resumed/retried
 * migration run) simply repeats this same sequence -- `AtomicBinaryStore`/
 * `AtomicStore` are themselves already atomic per file (temp+rename), so a
 * concurrent read of a not-yet-fully-rewritten entry sees either the fully
 * OLD state (metadata not yet removed) or the fully NEW state (metadata
 * freshly written), never anything in between.
 */
export async function writeStagedNote(fs: IndexFs, root: string, runId: string, input: WriteStagedNoteInput): Promise<void> {
  if (input.noteVector.length !== input.dimension) {
    throw new MigrationStagingError("noteVector length does not match dimension.");
  }
  if (input.chunkVectors.length > MAX_MANIFEST_SHARD_ROW_COUNT) {
    throw new MigrationStagingError(`chunkVectors length exceeds the maximum shard row count (${MAX_MANIFEST_SHARD_ROW_COUNT}).`);
  }
  for (const chunk of input.chunkVectors) {
    if (chunk.length !== input.dimension) {
      throw new MigrationStagingError("a chunk vector's length does not match dimension.");
    }
  }
  const key = stagedNoteKey(input.identity);
  const dirPath = joinRelative(root, stagingDirPath(runId));
  await fs.mkdir(dirPath);

  try {
    await fs.unlink(joinRelative(root, metaFileName(runId, key)));
  } catch (error) {
    // Review item 2: ONLY a genuinely-missing marker is tolerated (the ordinary first-ingestion
    // case) -- any OTHER unlink failure (permission denied, I/O error, an injected fault) must
    // abort BEFORE either binary is touched, never be silently swallowed and papered over.
    if (!isMissingPathError(error)) throw error;
  }
  // Review item 2: fsync the parent directory AFTER the marker is confirmed gone, BEFORE either
  // binary write begins -- on a filesystem where directory-entry removal isn't durable until its
  // directory is fsync'd, a crash between the unlink above and this point could otherwise let an
  // OS-level journal replay resurrect the OLD metadata entry over freshly-written NEW binaries.
  // Best-effort/optional (mirrors every other `fsyncDir` call in this codebase): absent on an
  // adapter that doesn't support it, never required for correctness on ordinary clean shutdown.
  if (fs.fsyncDir) {
    await fs.fsyncDir(dirPath);
  }

  const noteMatrixBytes = encodeVectorMatrix({ kind: "note", dimension: input.dimension, count: 1, data: input.noteVector });
  const chunkData = new Float32Array(input.chunkVectors.length * input.dimension);
  input.chunkVectors.forEach((chunk, index) => chunkData.set(chunk, index * input.dimension));
  const chunkMatrixBytes = encodeVectorMatrix({ kind: "chunk", dimension: input.dimension, count: input.chunkVectors.length, data: chunkData });

  await new AtomicBinaryStore({ fs, root, fileName: noteVectorFileName(runId, key), maxBytes: MAX_MATRIX_TOTAL_BYTES }).save(noteMatrixBytes);
  await new AtomicBinaryStore({ fs, root, fileName: chunkVectorFileName(runId, key), maxBytes: MAX_MATRIX_TOTAL_BYTES }).save(chunkMatrixBytes);
  await metaStore(fs, root, runId, key).save({
    schemaVersion: 1,
    identity: input.identity,
    sourceHash: input.sourceHash,
    embeddingModel: input.embeddingModel,
    dimension: input.dimension,
    chunkCount: input.chunkVectors.length,
  });
}

/** O(1) per-identity lookup (a single file load, never a directory scan) -- the metadata-only half of an adoption check. `null` for both "never staged" and "staged metadata file is corrupt". Callers that are about to ADOPT (skip re-ingesting) an entry based on this must ALSO call `verifyStagedNoteArtifact` -- this function alone proves nothing about the two binary files metadata claims to describe (review item 4: "adoption must prove the complete artifact, not JSON only"). */
export async function loadStagedNoteMeta(fs: IndexFs, root: string, runId: string, identity: NoteIdentityV1): Promise<StagedNoteMetaV1 | null> {
  const key = stagedNoteKey(identity);
  try {
    return await metaStore(fs, root, runId, key).load();
  } catch {
    return null;
  }
}

/**
 * Review item 4: proves the COMPLETE staged artifact for `meta` -- both
 * binary files fully decode (each already carries and self-verifies its
 * own SHA-256 checksum via `decodeVectorMatrix`, so bit-level corruption
 * within a single file is always caught) AND their decoded shapes
 * (dimension/count) agree with what `meta` itself claims. Never throws --
 * `false` for ANY failure (missing file, checksum mismatch, shape
 * mismatch), exactly as unadoptable as a missing artifact. This is the
 * ONE check an adoption decision (skip re-ingesting) must pass; JSON
 * metadata validity alone is never sufficient.
 */
export async function verifyStagedNoteArtifact(fs: IndexFs, root: string, runId: string, meta: StagedNoteMetaV1): Promise<boolean> {
  try {
    await readStagedNoteVector(fs, root, runId, meta);
    await readStagedChunkVectors(fs, root, runId, meta);
    return true;
  } catch {
    return false;
  }
}

const OWNED_META_FILENAME_PATTERN = /^([0-9a-f]{64})\.meta\.json$/;

/**
 * Every fully-staged note's metadata, sorted by staging key (deterministic,
 * matches `generationStore.buildGeneration`'s own "sort before sharding"
 * discipline). A `.meta.json`-shaped file that fails to parse is a
 * genuine corruption signal (item 4: "restart adopts valid staged
 * artifacts and rejects corruption") -- this throws `MigrationStagingError`
 * rather than silently skipping it, since silently skipping could produce
 * an incomplete, under-counted generation with no signal that anything
 * was lost. A non-owned filename under the staging directory is ignored
 * (never treated as a shape violation), mirroring `overlayStore.ts`'s own
 * "foreign entries are ignored, never deleted" discipline.
 */
export async function listStagedNotes(fs: IndexFs, root: string, runId: string): Promise<StagedNoteMetaV1[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(joinRelative(root, stagingDirPath(runId)));
  } catch {
    return [];
  }
  const keys = entries
    .map((entry) => OWNED_META_FILENAME_PATTERN.exec(entry)?.[1])
    .filter((key): key is string => key !== undefined && STAGED_NOTE_KEY_PATTERN.test(key))
    .sort();
  const metas: StagedNoteMetaV1[] = [];
  for (const key of keys) {
    const meta = await metaStore(fs, root, runId, key).load();
    if (!meta) continue; // a listed file that vanished between readdir and load -- benign race, not corruption
    metas.push(meta);
  }
  if (metas.length > MAX_MANIFEST_NOTE_COUNT) {
    throw new MigrationStagingError(`staged note count (${metas.length}) exceeds the approved ceiling of ${MAX_MANIFEST_NOTE_COUNT}.`);
  }
  return metas;
}

async function readStagedChunkVectors(fs: IndexFs, root: string, runId: string, meta: StagedNoteMetaV1): Promise<Float32Array[]> {
  const key = stagedNoteKey(meta.identity);
  const bytes = await new AtomicBinaryStore({ fs, root, fileName: chunkVectorFileName(runId, key), maxBytes: MAX_MATRIX_TOTAL_BYTES }).load();
  if (!bytes) {
    throw new MigrationStagingError(`staged chunk-vector artifact is missing for a listed note (runId "${runId}").`);
  }
  const matrix = decodeVectorMatrix(bytes, { expectedKind: "chunk" });
  if (matrix.count !== meta.chunkCount || matrix.dimension !== meta.dimension) {
    throw new MigrationStagingError("staged chunk-vector artifact's shape does not match its metadata.");
  }
  const chunks: Float32Array[] = [];
  for (let i = 0; i < matrix.count; i += 1) {
    chunks.push(matrix.data.slice(i * matrix.dimension, (i + 1) * matrix.dimension));
  }
  return chunks;
}

async function readStagedNoteVector(fs: IndexFs, root: string, runId: string, meta: StagedNoteMetaV1): Promise<Float32Array> {
  const key = stagedNoteKey(meta.identity);
  const bytes = await new AtomicBinaryStore({ fs, root, fileName: noteVectorFileName(runId, key), maxBytes: MAX_MATRIX_TOTAL_BYTES }).load();
  if (!bytes) {
    throw new MigrationStagingError(`staged note-vector artifact is missing for a listed note (runId "${runId}").`);
  }
  const matrix = decodeVectorMatrix(bytes, { expectedKind: "note" });
  if (matrix.count !== 1 || matrix.dimension !== meta.dimension) {
    throw new MigrationStagingError("staged note-vector artifact's shape does not match its metadata.");
  }
  return matrix.data.slice(0, matrix.dimension);
}

/**
 * Assembles the exact lazy, streaming `GenerationInputNote[]` shape
 * `generationStore.buildGeneration` consumes directly from staged
 * artifacts -- note vectors are read eagerly here (small, bounded by
 * dimension, exactly as `GenerationInputNote` itself requires), but each
 * entry's `loadChunkVectors` closure defers its (potentially much larger)
 * chunk-vector read until `buildGeneration` actually shards and writes
 * it, so at no point does this module hold more than one note's staged
 * chunk payload resident at a time regardless of total corpus size.
 */
export async function buildGenerationInputNotes(fs: IndexFs, root: string, runId: string, metas: readonly StagedNoteMetaV1[]): Promise<GenerationInputNote[]> {
  const notes: GenerationInputNote[] = [];
  for (const meta of metas) {
    const vector = await readStagedNoteVector(fs, root, runId, meta);
    notes.push({
      identity: meta.identity,
      sourceHash: meta.sourceHash,
      vector,
      chunkCount: meta.chunkCount,
      loadChunkVectors: () => readStagedChunkVectors(fs, root, runId, meta),
    });
  }
  return notes;
}

/**
 * Review item 1: deletes every artifact under `migration/staging/<runId>/`,
 * then the (now-empty) directory itself, and reports whether the
 * directory ends up GENUINELY ABSENT -- never silently swallows a partial
 * failure. `false` means at least one entry could not be removed; the
 * caller (`MigrationRunner.retryCleanup`) MUST treat that as "not done
 * yet" and retry later, and MUST NOT go on to delete the plan artifact in
 * that case (deleting the plan first would orphan the leftover staging
 * files with no plan left to ever reference/re-sweep them by).
 */
export async function clearStaging(fs: IndexFs, root: string, runId: string): Promise<boolean> {
  const dirPath = joinRelative(root, stagingDirPath(runId));
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    // Review item 1: ONLY a genuinely-missing directory means "nothing to clear" -- a permission
    // denied / I/O / unknown readdir failure must be reported as NOT cleared (`false`), never
    // silently treated the same as "already gone".
    return isMissingPathError(error);
  }
  let allRemoved = true;
  for (const entry of entries) {
    try {
      await fs.unlink(joinRelative(dirPath, entry));
    } catch (error) {
      if (!isMissingPathError(error)) allRemoved = false;
      // a file that vanished between readdir and unlink is fine; a genuine failure leaves it for
      // the NEXT clearStaging() call, and is reported below rather than silently swallowed.
    }
  }
  if (!allRemoved) return false;
  try {
    await fs.rmdir(dirPath);
  } catch {
    // non-empty (a concurrent write raced this cleanup) or already gone -- re-checked below rather
    // than assumed either way.
  }
  const stillExists = await fs.exists(dirPath).catch(() => true);
  return !stillExists;
}

/** Every runId with an on-disk `migration/staging/<runId>/` directory -- foreign (non-runId-shaped) entries under `migration/staging/` are ignored, never reported or touched. Used together with `migrationPlan.ts`'s `listMigrationRunIds` so a sweep sees the UNION of both (review item 1): a run whose plan.json was already cleared but whose staging directory survived a partial cleanup failure must still be discoverable and recoverable. */
export async function listStagingRunIds(fs: IndexFs, root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(joinRelative(root, "migration/staging"));
  } catch {
    return [];
  }
  return entries.filter((entry) => RUN_ID_PATTERN.test(entry));
}
