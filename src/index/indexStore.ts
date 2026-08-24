import { createHash } from "node:crypto";

import type { CanonicalPath, IndexRecordV1, NoteIdentityV1 } from "../engine/contracts";
import { compareScored, CosineIndexError, dotProduct, MAX_RANKING_LIMIT, normalizeVector } from "./cosineIndex";
import { identityKey, type NoteRowMetadataV1 } from "./generationMetadata";
import {
  buildGeneration,
  cleanupStaleStaging,
  countStaleStaging,
  GenerationBuildCancelledError,
  loadCurrentGenerationId,
  loadCurrentGenerationManifest,
  loadGeneration,
  switchCurrentGeneration,
  verifyGenerationFully,
  type BuildGenerationInput,
  type GenerationInputNote,
  type LoadedGeneration,
} from "./generationStore";
import type { IndexFs } from "./indexFs";
import {
  deleteOverlayIfSnapshotMatches,
  listOverlayPrefixes,
  overlayFileName,
  OverlayStoreError,
  readOverlayFull,
  writeTombstoneOverlay,
  writeUpsertOverlay,
  type OverlayPrefixRecord,
} from "./overlayStore";
import type { VectorIndexManifestV1 } from "./vectorTypes";
import {
  BUDGET_DISK_BYTES,
  BUDGET_STEADY_STATE_MEMORY_BYTES,
  computeDiskBytes,
  computeOverlayContainerBytes,
  computeSteadyStateBytes,
  decodedMatrixByteLength,
  MAX_PENDING_OVERLAY_CHUNK_ROWS,
  MAX_PENDING_OVERLAY_COUNT,
} from "./budgets";
import { MAX_MANIFEST_CHUNK_COUNT, MAX_MANIFEST_NOTE_COUNT } from "./indexManifest";
import type { VectorMatrix } from "./vectorCodec";
import type { ChunkShardNoteOffset, ScoredNote } from "./vectorTypes";

/**
 * Top-level orchestrator: the merged, searchable "committed view" (base
 * generation + latest valid overlays/tombstones) is ranked COMPOSITELY --
 * base rows (excluding shadowed/tombstoned identities) are scored
 * directly against the resident base matrix, and overlay note vectors are
 * scored individually, WITHOUT EVER allocating a second full note matrix
 * (see `rankComposite`). Chunk refinement loads at most one base shard's
 * OR one overlay candidate's chunk payload at a time. Mutation/compaction
 * are serialized behind a lightweight in-process queue; `queryRelated`
 * deliberately does not go through it, so a query concurrent with an
 * in-flight compaction simply sees the PRIOR committed generation until
 * the new one's pointer switch commits.
 *
 * A corrupt/unreadable OWNED overlay is never silently skipped: it fails
 * both `queryRelated` and `compact` closed with an actionable
 * `IndexStoreError`, since silently ignoring it could resurrect base
 * state a tombstone was supposed to hide, or let compaction incorporate
 * an upsert whose vectors can no longer be trusted.
 */

export class IndexStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexStoreError";
  }
}

function wrapOverlayError(error: unknown, context: string): IndexStoreError {
  if (error instanceof OverlayStoreError) {
    return new IndexStoreError(`${context}: ${error.message}`);
  }
  return new IndexStoreError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

/** Loads every currently-valid overlay's prefix, wrapping a fail-closed owned-file validation failure into an actionable `IndexStoreError` (never silently skipping it). */
async function loadOverlayPrefixesOrThrow(fs: IndexFs, root: string): Promise<OverlayPrefixRecord[]> {
  try {
    const { records } = await listOverlayPrefixes(fs, root);
    return records;
  } catch (error) {
    throw wrapOverlayError(error, "cannot safely proceed: a pending overlay failed validation");
  }
}

export interface QueryRelatedOptions {
  /** Raw (not necessarily pre-normalized) note-level query vector; normalized here. */
  queryVector: Float32Array;
  /** Raw chunk vectors for refinement; normalized here. Refinement is skipped entirely (note-level ranking only) when empty. */
  queryChunkVectors: Float32Array[];
  excludePath?: CanonicalPath;
  limit: number;
}

interface ShadowInfo {
  /** identityKey -> the overlay record shadowing that identity (upsert OR tombstone). */
  byKey: Map<string, OverlayPrefixRecord>;
}

function buildShadowInfo(overlays: readonly OverlayPrefixRecord[]): ShadowInfo {
  const byKey = new Map<string, OverlayPrefixRecord>();
  for (const overlay of overlays) {
    byKey.set(identityKey(overlay.identity), overlay);
  }
  return { byKey };
}

/**
 * Ranks the composite view (base rows excluding shadowed/tombstoned
 * identities, plus overlay upsert note vectors) directly against
 * `queryVector`, WITHOUT copying base rows into a second full matrix --
 * base rows are scored in place against `generation.noteMatrix.data`,
 * overlay rows are scored individually against their own small resident
 * `Float32Array`. Steady memory for this pass is therefore the base
 * matrix (already resident for shard routing/`loadShard` regardless) plus
 * however many overlay note vectors are currently pending (bounded by
 * `MAX_PENDING_OVERLAY_COUNT`), never a base-sized duplicate.
 */
function rankComposite(
  generation: LoadedGeneration | null,
  overlays: readonly OverlayPrefixRecord[],
  queryVector: Float32Array,
  excludePath: CanonicalPath | undefined,
  limit: number,
): ScoredNote[] {
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RANKING_LIMIT) {
    throw new IndexStoreError(`limit must be an integer in (0, ${MAX_RANKING_LIMIT}].`);
  }
  const shadow = buildShadowInfo(overlays);
  const scored: ScoredNote[] = [];

  if (generation) {
    const { noteMatrix, noteMetadata } = generation;
    if (noteMatrix.data.length !== noteMatrix.count * noteMatrix.dimension) {
      throw new IndexStoreError("base note matrix shape is invalid (data length does not match count * dimension).");
    }
    if (queryVector.length !== noteMatrix.dimension) {
      throw new IndexStoreError(`queryVector dimension (${queryVector.length}) does not match the base generation's dimension (${noteMatrix.dimension}).`);
    }
    noteMetadata.forEach((row, rowIndex) => {
      const key = identityKey(row.identity);
      if (shadow.byKey.has(key)) return; // shadowed by an upsert (scored below) or removed by a tombstone
      const path = row.identity.canonicalPath;
      if (excludePath !== undefined && path === excludePath) return;
      const score = dotProduct(queryVector, noteMatrix.data, 0, rowIndex * noteMatrix.dimension, noteMatrix.dimension);
      if (Number.isFinite(score)) scored.push({ path, score });
    });
  }

  for (const overlay of overlays) {
    if (overlay.operation !== "upsert" || !overlay.noteVector) continue;
    if (queryVector.length !== overlay.noteVector.length) {
      throw new IndexStoreError(`queryVector dimension (${queryVector.length}) does not match overlay note vector dimension (${overlay.noteVector.length}).`);
    }
    const path = overlay.identity.canonicalPath;
    if (excludePath !== undefined && path === excludePath) continue;
    const score = dotProduct(queryVector, overlay.noteVector, 0, 0, overlay.noteVector.length);
    if (Number.isFinite(score)) scored.push({ path, score });
  }

  scored.sort(compareScored);
  return scored.slice(0, limit);
}

/**
 * Queries the current committed view. Loads AT MOST ONE base shard's OR
 * ONE overlay candidate's chunk payload at a time during refinement,
 * sequentially, and never retains more than one such payload at once.
 * Returns `[]` if there is no base generation and no overlays. Throws
 * `IndexStoreError` (fail closed) if any OWNED overlay file is corrupt.
 */
export async function queryRelated(fs: IndexFs, root: string, options: QueryRelatedOptions): Promise<ScoredNote[]> {
  const generationId = await loadCurrentGenerationId(fs, root);
  const generation = generationId === null ? null : await loadGeneration(fs, root, generationId);
  const overlays = await loadOverlayPrefixesOrThrow(fs, root);

  const queryVector = normalizeVector(options.queryVector);
  const candidates = rankComposite(generation, overlays, queryVector, options.excludePath, options.limit);
  if (candidates.length === 0) return [];

  const queryChunkVectors = options.queryChunkVectors.map((v) => normalizeVector(v));
  if (queryChunkVectors.length === 0) return candidates;

  const noteRowByPath = new Map((generation?.noteMetadata ?? []).map((row) => [row.identity.canonicalPath, row]));
  const overlayUpsertByPath = new Map(overlays.filter((o) => o.operation === "upsert").map((o) => [o.identity.canonicalPath, o]));

  const shardIdByCandidatePath = new Map<CanonicalPath, string>();
  const overlayIdentityByCandidatePath = new Map<CanonicalPath, NoteIdentityV1>();
  for (const candidate of candidates) {
    const overlay = overlayUpsertByPath.get(candidate.path);
    if (overlay) {
      overlayIdentityByCandidatePath.set(candidate.path, overlay.identity);
      continue;
    }
    const row = noteRowByPath.get(candidate.path);
    if (row?.shardId) {
      shardIdByCandidatePath.set(candidate.path, row.shardId);
    }
  }

  const refined: ScoredNote[] = [];

  // Overlay-sourced candidates: exactly one candidate's full container loaded at a time.
  for (const [path, identity] of overlayIdentityByCandidatePath) {
    const full = await readOverlayFull(fs, root, identity).catch((error: unknown) => {
      throw wrapOverlayError(error, `cannot refine candidate "${path}": its overlay failed validation`);
    });
    if (!full || !full.chunkMatrix || full.chunkMatrix.count === 0) continue;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let row = 0; row < full.chunkMatrix.count; row += 1) {
      for (const qv of queryChunkVectors) {
        const score = dotProduct(qv, full.chunkMatrix.data, 0, row * full.chunkMatrix.dimension, full.chunkMatrix.dimension);
        if (Number.isFinite(score) && score > bestScore) bestScore = score;
      }
    }
    if (Number.isFinite(bestScore)) refined.push({ path, score: bestScore });
  }

  // Base-sourced candidates: grouped by shard, exactly one shard's matrix resident at a time.
  const byShardId = new Map<string, CanonicalPath[]>();
  for (const [path, shardId] of shardIdByCandidatePath) {
    const list = byShardId.get(shardId) ?? [];
    list.push(path);
    byShardId.set(shardId, list);
  }
  for (const [shardId, paths] of byShardId) {
    if (!generation) continue;
    const shard = await generation.loadShard(shardId);
    const pathSet = new Set(paths);
    const offsetsByKey = new Map(shard.offsets.map((o) => [identityKey(o.identity), o]));
    for (const path of pathSet) {
      const row = generation.noteMetadata.find((r) => r.identity.canonicalPath === path);
      if (!row) continue;
      const offset = offsetsByKey.get(identityKey(row.identity));
      if (!offset) continue;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < offset.length; i += 1) {
        const chunkRow = offset.start + i;
        for (const qv of queryChunkVectors) {
          const score = dotProduct(qv, shard.matrix.data, 0, chunkRow * shard.matrix.dimension, shard.matrix.dimension);
          if (Number.isFinite(score) && score > bestScore) bestScore = score;
        }
      }
      if (Number.isFinite(bestScore)) refined.push({ path, score: bestScore });
    }
  }

  refined.sort(compareScored);
  return refined.slice(0, options.limit);
}

/**
 * Read-only, single-identity lookup of the committed view's current index
 * record (base generation row shadowed by the latest matching overlay, if
 * any) -- an owned-overlay validation failure fails closed exactly like
 * `queryRelated`'s own `loadOverlayPrefixesOrThrow`, never silently
 * skipped. Returns `null` when the identity is not currently indexed
 * (never present, or tombstoned) -- never a fabricated record.
 */
export async function getIndexedRecord(fs: IndexFs, root: string, identity: NoteIdentityV1): Promise<IndexRecordV1 | null> {
  const overlays = await loadOverlayPrefixesOrThrow(fs, root);
  const key = identityKey(identity);
  const overlay = overlays.find((o) => identityKey(o.identity) === key);
  if (overlay) {
    if (overlay.operation !== "upsert" || overlay.sourceHash === undefined || overlay.embeddingModel === undefined || overlay.chunkCount === undefined) {
      return null;
    }
    return { schemaVersion: 1, identity: overlay.identity, sourceHash: overlay.sourceHash, embeddingModel: overlay.embeddingModel, chunkCount: overlay.chunkCount };
  }
  const generationId = await loadCurrentGenerationId(fs, root);
  if (generationId === null) return null;
  const generation = await loadGeneration(fs, root, generationId);
  const row = generation.noteMetadata.find((r) => identityKey(r.identity) === key);
  return row ?? null;
}

export interface IndexedCatalogRecord {
  identity: NoteIdentityV1;
  sourceHash: string;
}

/**
 * Checkpoint 10B PENDING: a fully-verified, read-only snapshot of every
 * identity/sourceHash the committed view currently holds -- the base
 * generation is checked through the SAME `verifyGenerationFully` a real
 * activation runs (checksums, shape/count agreement, every shard
 * cross-checked), never the cheap `loadGeneration` `getIndexedRecord`
 * itself uses, since a pending scanner comparing against this snapshot
 * needs to trust it is real rather than possibly corrupt. Overlays shadow
 * base rows exactly like `queryRelated`/`getIndexedRecord`: a tombstoned
 * or upsert-shadowed base row is never double-counted. Returns `null` --
 * never a partial/fabricated snapshot -- when there is a current
 * generation pointer but its verification fails; returns `[]` (never
 * `null`) when there is genuinely no current generation yet (a fresh,
 * not-yet-built index is a legitimate "nothing indexed", not a failure).
 */
export async function snapshotIndexedCatalog(fs: IndexFs, root: string): Promise<IndexedCatalogRecord[] | null> {
  const generationId = await loadCurrentGenerationId(fs, root);
  let baseRecords: readonly NoteRowMetadataV1[] = [];
  if (generationId !== null) {
    try {
      const { noteMetadata } = await verifyGenerationFully(fs, root, generationId);
      baseRecords = noteMetadata;
    } catch {
      return null;
    }
  }
  const overlays = await loadOverlayPrefixesOrThrow(fs, root);
  const shadow = buildShadowInfo(overlays);
  const result: IndexedCatalogRecord[] = [];
  for (const row of baseRecords) {
    if (shadow.byKey.has(identityKey(row.identity))) continue; // shadowed by a later overlay (tombstone or upsert) -- handled below, or removed
    result.push({ identity: row.identity, sourceHash: row.sourceHash });
  }
  for (const overlay of overlays) {
    if (overlay.operation !== "upsert" || overlay.sourceHash === undefined) continue;
    result.push({ identity: overlay.identity, sourceHash: overlay.sourceHash });
  }
  return result;
}

export interface UpsertNoteInput {
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
  dimension: number;
  noteVector: Float32Array;
  chunkVectors: Float32Array[];
}

/**
 * Serializes every mutation (`upsertNote`, `deleteNote`) and `compact`
 * against a lightweight in-process queue: at most one runs at a time,
 * each waiting for the previous to settle (succeed OR fail) before
 * starting. `queryRelated` deliberately does not go through this queue.
 * See `sharedMutationQueueFor` -- every `IndexStore` over the same
 * (fs, root) pair shares exactly ONE instance of this class, never one
 * per `IndexStore` instance.
 */
export class IndexMutationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface MutationContext {
  generation: LoadedGeneration | null;
  overlays: OverlayPrefixRecord[];
}

async function loadMutationContext(fs: IndexFs, root: string): Promise<MutationContext> {
  const generationId = await loadCurrentGenerationId(fs, root);
  const generation = generationId === null ? null : await loadGeneration(fs, root, generationId);
  const overlays = await loadOverlayPrefixesOrThrow(fs, root);
  return { generation, overlays };
}

/**
 * The pending-overlay-file budget (`MAX_PENDING_OVERLAY_COUNT`/
 * `MAX_PENDING_OVERLAY_CHUNK_ROWS`) applies to EVERY mutation that could
 * create a new overlay file -- including a tombstone for an identity that
 * doesn't already have one pending. No mutation may create the 2001st
 * overlay file, upsert or tombstone alike.
 */
function assertPendingOverlayBudget(overlays: readonly OverlayPrefixRecord[], identity: NoteIdentityV1, newChunkCount: number): void {
  const key = identityKey(identity);
  const existing = overlays.find((r) => identityKey(r.identity) === key);
  const projectedCount = overlays.length + (existing ? 0 : 1);
  if (projectedCount > MAX_PENDING_OVERLAY_COUNT) {
    throw new IndexStoreError(
      `cannot write overlay for "${key}": ${overlays.length} overlays are already pending (max ${MAX_PENDING_OVERLAY_COUNT}); compact before adding more.`,
    );
  }
  const existingChunkRows = existing?.chunkCount ?? 0;
  const currentTotalChunkRows = overlays.reduce((sum, r) => sum + (r.chunkCount ?? 0), 0);
  const projectedChunkRows = currentTotalChunkRows - existingChunkRows + newChunkCount;
  if (projectedChunkRows > MAX_PENDING_OVERLAY_CHUNK_ROWS) {
    throw new IndexStoreError(
      `cannot write overlay for "${key}": pending overlay chunk rows would reach ${projectedChunkRows} (max ${MAX_PENDING_OVERLAY_CHUNK_ROWS}); compact before adding more.`,
    );
  }
}

/** The EFFECTIVE merged-view note/chunk counts (base rows minus shadows/tombstones, plus overlay upserts) -- what would actually be built if `compact()` ran right now. Distinct from, and in addition to, the pending-overlay-FILE budget above: that bounds how many overlay FILES can accumulate; this bounds the CORPUS those files (once compacted) would produce, which is what `MAX_MANIFEST_NOTE_COUNT`/`MAX_MANIFEST_CHUNK_COUNT` actually govern. */
function computeEffectiveCounts(generation: LoadedGeneration | null, overlays: readonly OverlayPrefixRecord[]): { noteCount: number; chunkCount: number; effectiveChunkCountByKey: Map<string, number> } {
  const shadow = buildShadowInfo(overlays);
  const effectiveChunkCountByKey = new Map<string, number>();
  if (generation) {
    for (const row of generation.noteMetadata) {
      const key = identityKey(row.identity);
      if (shadow.byKey.has(key)) continue; // shadowed by an upsert (counted below) or removed by a tombstone
      effectiveChunkCountByKey.set(key, row.chunkCount);
    }
  }
  for (const overlay of overlays) {
    if (overlay.operation !== "upsert") continue;
    effectiveChunkCountByKey.set(identityKey(overlay.identity), overlay.chunkCount ?? 0);
  }
  const noteCount = effectiveChunkCountByKey.size;
  const chunkCount = [...effectiveChunkCountByKey.values()].reduce((sum, count) => sum + count, 0);
  return { noteCount, chunkCount, effectiveChunkCountByKey };
}

/**
 * Rejects an upsert that would push the EFFECTIVE merged corpus (what
 * `compact()` would actually build right now) past the approved
 * `MAX_MANIFEST_NOTE_COUNT`/`MAX_MANIFEST_CHUNK_COUNT` ceilings -- e.g. an
 * upsert for a brand-new identity when the base generation already has
 * exactly 10,000 effective notes is rejected, even though the PENDING
 * OVERLAY count budget alone would have allowed it. Replacing an existing
 * identity (already present, via base or a prior overlay) subtracts its
 * current effective chunk count first, so a pure replacement that doesn't
 * grow the corpus is never blocked by this check.
 */
function assertEffectiveCorpusBudget(generation: LoadedGeneration | null, overlays: readonly OverlayPrefixRecord[], identity: NoteIdentityV1, newChunkCount: number): void {
  const key = identityKey(identity);
  const { noteCount, chunkCount, effectiveChunkCountByKey } = computeEffectiveCounts(generation, overlays);
  const wasPresent = effectiveChunkCountByKey.has(key);
  const oldChunkCount = effectiveChunkCountByKey.get(key) ?? 0;
  const projectedNoteCount = noteCount + (wasPresent ? 0 : 1);
  const projectedChunkCount = chunkCount - oldChunkCount + newChunkCount;
  if (projectedNoteCount > MAX_MANIFEST_NOTE_COUNT) {
    throw new IndexStoreError(`cannot upsert "${key}": the effective merged corpus already has ${noteCount} notes (max ${MAX_MANIFEST_NOTE_COUNT}); this is a new identity, not a replacement.`);
  }
  if (projectedChunkCount > MAX_MANIFEST_CHUNK_COUNT) {
    throw new IndexStoreError(`cannot upsert "${key}": the effective merged corpus's chunk count would reach ${projectedChunkCount} (max ${MAX_MANIFEST_CHUNK_COUNT}).`);
  }
}

/**
 * Enforces exactly ONE embedding dimension/model across the active
 * generation and every pending upsert overlay. With an active
 * generation, every upsert must match its manifest's dimension/model.
 * Without one, the FIRST upsert establishes the dimension/model and every
 * later upsert (until compaction) must match it -- rejected before the
 * write, never discovered later by a query encountering mixed data.
 */
function assertConsistentDimensionAndModel(generation: LoadedGeneration | null, overlays: readonly OverlayPrefixRecord[], input: UpsertNoteInput): void {
  const key = identityKey(input.identity);
  let expectedDimension = generation?.manifest.dimension;
  let expectedModel = generation?.manifest.embeddingModel;
  if (expectedDimension === undefined) {
    const established = overlays.find((o) => o.operation === "upsert" && identityKey(o.identity) !== key && o.dimension !== undefined);
    expectedDimension = established?.dimension;
    expectedModel = established?.embeddingModel;
  }
  if (expectedDimension !== undefined && input.dimension !== expectedDimension) {
    throw new IndexStoreError(`upsertNote dimension (${input.dimension}) does not match the established dimension (${expectedDimension}) for the active generation/pending overlays.`);
  }
  if (expectedModel !== undefined && input.embeddingModel !== expectedModel) {
    throw new IndexStoreError(`upsertNote embeddingModel ("${input.embeddingModel}") does not match the established embeddingModel ("${expectedModel}") for the active generation/pending overlays.`);
  }
}

/** The active generation's shape, or the dimension established by a pending upsert overlay when there is no generation yet (mirrors `assertConsistentDimensionAndModel`'s established-dimension lookup) -- `null` when NEITHER exists, meaning no dimension is established anywhere yet and there is nothing byte-significant to bound. */
interface ActiveManifestShape {
  dimension: number;
  noteCount: number;
  shardCounts: readonly number[];
}

function activeManifestShape(generation: LoadedGeneration | null, overlays: readonly OverlayPrefixRecord[]): ActiveManifestShape | null {
  if (generation) {
    return { dimension: generation.manifest.dimension, noteCount: generation.manifest.noteCount, shardCounts: generation.manifest.chunkShards.map((s) => s.count) };
  }
  const established = overlays.find((o) => o.operation === "upsert" && o.dimension !== undefined);
  if (established?.dimension === undefined) return null;
  return { dimension: established.dimension, noteCount: 0, shardCounts: [] };
}

/** What `assertResourceBudget` computed, before comparing it against the approved budgets -- exposed separately so its arithmetic can be unit-tested against arbitrary shapes without needing to actually build/hold a multi-hundred-MB generation in memory. */
export interface ProjectedOverlayResourceUsage {
  steadyStateBytes: number;
  diskBytes: number;
}

/**
 * Computes the PROJECTED ACTUAL (never a fixed worst-case reservation)
 * steady-state resident bytes and on-disk bytes this mutation (an upsert
 * of `projected.chunkCount` chunks, or a tombstone) would leave the store
 * in, from: the active manifest's real shape (`shape`, `null` when no
 * dimension is established anywhere yet -- nothing to bound); every
 * OTHER currently pending overlay's own ACTUAL resident/disk footprint
 * (each overlay's exact on-disk `containerLength`, and -- for
 * steady-state -- one resident note vector per pending UPSERT, never a
 * tombstone, since chunk vectors are never resident in the merged view);
 * and this mutation's own projected footprint, replacing (not
 * additionally counting) any existing overlay for the same identity. The
 * fixed pending-overlay COUNT/ROW ceilings (`assertPendingOverlayBudget`)
 * bound how many overlay files/chunk rows can exist at all, but -- being
 * dimension-independent -- do not by themselves bound actual bytes at an
 * arbitrary legal dimension or against a base manifest already near its
 * own budget; this is the check that closes that gap. Returns `null` iff
 * `shape` is `null`.
 */
export function computeProjectedOverlayResourceUsage(
  shape: ActiveManifestShape | null,
  overlays: readonly OverlayPrefixRecord[],
  identity: NoteIdentityV1,
  projected: { operation: "upsert"; chunkCount: number } | { operation: "tombstone" },
): ProjectedOverlayResourceUsage | null {
  if (shape === null) return null;
  const { dimension, noteCount, shardCounts } = shape;
  const key = identityKey(identity);
  const otherOverlays = overlays.filter((r) => identityKey(r.identity) !== key);

  const largestShardCount = shardCounts.reduce((max, count) => Math.max(max, count), 0);
  const residentOverlayNoteVectors = otherOverlays.filter((r) => r.operation === "upsert").length + (projected.operation === "upsert" ? 1 : 0);
  const steadyStateBytes = computeSteadyStateBytes({ dimension, noteCount, largestShardCount }) + decodedMatrixByteLength(dimension, residentOverlayNoteVectors);

  const baseDiskBytes = noteCount > 0 || shardCounts.length > 0 ? computeDiskBytes(dimension, noteCount, shardCounts) : 0;
  const otherOverlayDiskBytes = otherOverlays.reduce((sum, r) => sum + r.containerLength, 0);
  const projectedContainerBytes = computeOverlayContainerBytes(dimension, projected.operation === "upsert" ? projected.chunkCount : 0);
  const diskBytes = baseDiskBytes + otherOverlayDiskBytes + projectedContainerBytes;

  return { steadyStateBytes, diskBytes };
}

/**
 * Rejects (before writing anything) if this mutation would push PROJECTED
 * ACTUAL steady-state or disk usage past the approved
 * `BUDGET_STEADY_STATE_MEMORY_BYTES`/`BUDGET_DISK_BYTES` ceilings -- a
 * no-op when no dimension is established anywhere yet (nothing byte-
 * significant to bound). See `computeProjectedOverlayResourceUsage` for
 * the accounting itself.
 */
function assertResourceBudget(
  generation: LoadedGeneration | null,
  overlays: readonly OverlayPrefixRecord[],
  identity: NoteIdentityV1,
  projected: { operation: "upsert"; chunkCount: number } | { operation: "tombstone" },
): void {
  const usage = computeProjectedOverlayResourceUsage(activeManifestShape(generation, overlays), overlays, identity, projected);
  if (usage === null) return;
  const key = identityKey(identity);
  if (usage.steadyStateBytes > BUDGET_STEADY_STATE_MEMORY_BYTES) {
    throw new IndexStoreError(
      `cannot write overlay for "${key}": projected steady-state memory would reach ${usage.steadyStateBytes} bytes (max ${BUDGET_STEADY_STATE_MEMORY_BYTES}); compact before adding more.`,
    );
  }
  if (usage.diskBytes > BUDGET_DISK_BYTES) {
    throw new IndexStoreError(`cannot write overlay for "${key}": projected disk usage would reach ${usage.diskBytes} bytes (max ${BUDGET_DISK_BYTES}); compact before adding more.`);
  }
}

/**
 * Everything `compact()` needs to build a new generation from the current
 * committed view, WITHOUT yet touching `current.json` or deleting any
 * overlay -- the read-only planning half of compaction. Exported (alongside
 * `finalizeCompaction`) so a durable, phase-checkpointed caller (the
 * Checkpoint 7 job engine's rebuild job) can persist a phase transition
 * between "generation built" and "pointer switched" without re-implementing
 * this exact base+overlay merge/streaming logic a second time.
 */
export interface CompactionPlan {
  dimension: number;
  embeddingModel: string;
  notes: GenerationInputNote[];
  /** The overlay snapshot this plan was built from; passed back to `finalizeCompaction` so it deletes exactly these overlays and no overlay written after planning. */
  overlaysSnapshot: OverlayPrefixRecord[];
  /** The current-pointer generation id this plan was built against, or `null` for an initial build with no base generation yet -- captured so a durable caller (the rebuild job) can later detect "the pointer has since moved on to something newer than what I planned against" (Checkpoint 7 final-closure requirement 3). */
  baseGenerationId: number | null;
  /** A bounded fingerprint of the base generation's own manifest (`null` iff `baseGenerationId` is `null`) -- see `manifestArtifactFingerprint`. */
  baseFingerprint: string | null;
}

export async function planCompaction(fs: IndexFs, root: string): Promise<CompactionPlan> {
  const generationId = await loadCurrentGenerationId(fs, root);
  const generation = generationId === null ? null : await loadGeneration(fs, root, generationId);
  const overlaysSnapshot = await loadOverlayPrefixesOrThrow(fs, root);
  const baseGenerationId = generationId;
  const baseFingerprint = generation ? manifestArtifactFingerprint(generation.manifest) : null;

  let dimension: number | undefined = generation?.manifest.dimension;
  let embeddingModel: string | undefined = generation?.manifest.embeddingModel;
  if (dimension === undefined || embeddingModel === undefined) {
    const anyUpsert = overlaysSnapshot.find((o) => o.operation === "upsert" && o.dimension !== undefined);
    if (!anyUpsert) {
      throw new IndexStoreError(
        "cannot compact: no base generation exists and no pending upsert overlay provides a dimension/model. Create an initial generation explicitly via buildGeneration + switchCurrentGeneration with an explicit dimension/embeddingModel first.",
      );
    }
    if (anyUpsert.dimension === undefined || anyUpsert.embeddingModel === undefined) {
      throw new IndexStoreError("cannot compact: matching upsert overlay is missing its dimension/embeddingModel (unreachable for a valid upsert record).");
    }
    dimension = anyUpsert.dimension;
    embeddingModel = anyUpsert.embeddingModel;
  }

  const shadow = buildShadowInfo(overlaysSnapshot);
  const notes: GenerationInputNote[] = [];

  // Streaming source, base side: at most ONE base shard's decoded chunk matrix is ever
  // cached/resident at a time. `buildGeneration` calls each note's `loadChunkVectors()` in
  // its own OUTPUT-shard-plan order (which can interleave notes from different INPUT/base
  // shards) -- this single-slot cache means consecutive notes sharing the same base shard
  // reuse the one already-loaded matrix, and switching to a note from a different base shard
  // simply replaces the cached slot (never holds two base shards at once).
  const baseShardCache: { shardId: string | null; shard: { matrix: VectorMatrix; offsets: ChunkShardNoteOffset[] } | null } = { shardId: null, shard: null };
  async function loadBaseNoteChunkVectors(row: NoteRowMetadataV1): Promise<Float32Array[]> {
    if (!row.shardId) return [];
    if (baseShardCache.shardId !== row.shardId) {
      baseShardCache.shard = await (generation as NonNullable<typeof generation>).loadShard(row.shardId);
      baseShardCache.shardId = row.shardId;
    }
    const shard = baseShardCache.shard as NonNullable<typeof baseShardCache.shard>;
    const offset = shard.offsets.find((o) => identityKey(o.identity) === identityKey(row.identity));
    if (!offset) return [];
    // subarray, not slice: buildGeneration normalizes and copies each row into the new
    // generation's shard/note matrix synchronously, right after this resolves and before the
    // next note's loadChunkVectors() call could ever evict/replace baseShardCache -- so a view
    // into the already-resident cached shard is safe, and never duplicates its bytes.
    return Array.from({ length: offset.length }, (_, i) =>
      shard.matrix.data.subarray((offset.start + i) * shard.matrix.dimension, (offset.start + i + 1) * shard.matrix.dimension),
    );
  }

  if (generation) {
    for (const row of generation.noteMetadata) {
      const key = identityKey(row.identity);
      if (shadow.byKey.has(key)) continue; // shadowed by an upsert (added below) or removed by a tombstone
      notes.push({
        identity: row.identity,
        sourceHash: row.sourceHash,
        // subarray, not slice: the base note matrix stays resident for the whole compact()
        // call regardless, so a view into it costs nothing extra -- a slice here would
        // instead eagerly duplicate the ENTIRE unshadowed base note matrix up front, well
        // before buildGeneration ever starts consuming it.
        vector: generation.noteMatrix.data.subarray(row.rowIndex * generation.noteMatrix.dimension, (row.rowIndex + 1) * generation.noteMatrix.dimension),
        chunkCount: row.chunkCount,
        loadChunkVectors: () => loadBaseNoteChunkVectors(row),
      });
    }
  }

  // Streaming source, overlay side: each overlay's full container (including its chunk
  // payload) is read only when `buildGeneration` actually calls this note's
  // `loadChunkVectors()` -- never eagerly, never more than one at a time.
  for (const overlay of overlaysSnapshot) {
    if (overlay.operation !== "upsert" || !overlay.noteVector) continue;
    const overlayIdentity = overlay.identity;
    const overlayChunkCount = overlay.chunkCount ?? 0;
    notes.push({
      identity: overlayIdentity,
      sourceHash: overlay.sourceHash as string,
      vector: overlay.noteVector,
      chunkCount: overlayChunkCount,
      loadChunkVectors: async () => {
        let full;
        try {
          full = await readOverlayFull(fs, root, overlayIdentity);
        } catch (error) {
          throw wrapOverlayError(error, `compact failed: overlay for "${identityKey(overlayIdentity)}" failed to read in full`);
        }
        if (!full?.chunkMatrix) return [];
        // subarray, not slice: this decoded chunkMatrix is freshly read for this one overlay
        // and consumed synchronously (normalized+copied into the new shard) before this
        // function is ever called again -- a view costs nothing extra here either.
        return Array.from({ length: full.chunkMatrix.count }, (_, row) =>
          (full.chunkMatrix as VectorMatrix).data.subarray(row * (full.chunkMatrix as VectorMatrix).dimension, (row + 1) * (full.chunkMatrix as VectorMatrix).dimension),
        );
      },
    });
  }

  return { dimension, embeddingModel, notes, overlaysSnapshot, baseGenerationId, baseFingerprint };
}

/**
 * Switches `current.json` onto `newGenerationId` (must already exist on
 * disk, built+verified by `buildGeneration` from `plan`) and only then
 * deletes exactly the overlays `plan` was snapshotted from -- but each
 * deletion is version+fingerprint-checked (`deleteOverlayIfSnapshotMatches`),
 * not a blind identity-keyed delete: if an unrelated concurrent mutation (a
 * different `IndexStore`/`upsertNote` call, or another compaction) has
 * REPLACED an identity's overlay since `plan` was captured, that
 * replacement no longer matches the stale snapshot (by version, or by
 * fingerprint if it happens to land back on the same version number -- see
 * `overlayStore.ts`'s own doc comment on version reset) and is left
 * completely untouched. This is what makes calling `planCompaction` and
 * `finalizeCompaction` safe even when they are not the only code mutating
 * overlays for the whole duration in between -- see Checkpoint 7
 * requirement 13 and final-closure requirement 1. A failure here after
 * `buildGeneration` succeeded leaves the new generation on disk but
 * unreferenced -- never partially activated.
 */
export async function finalizeCompaction(fs: IndexFs, root: string, newGenerationId: number, plan: CompactionPlan): Promise<void> {
  await switchCurrentGeneration(fs, root, newGenerationId);
  for (const overlay of plan.overlaysSnapshot) {
    await deleteOverlayIfSnapshotMatches(fs, root, overlayFileName(overlay.identity), overlay.version, overlay.fingerprint);
  }
}

/** One overlay's bounded, content-free identity in a persisted `CompactionSnapshotDescriptorV1` -- its deterministic filename (never the identity object itself, which could carry an arbitrarily long path), the version it was at when the snapshot was taken, and its content fingerprint (see `OverlayPrefixRecord.fingerprint`) -- version alone is not durable identity across a compaction cycle, since an identity's version counter resets to 1 once its prior overlay is deleted. */
export interface CompactionSnapshotOverlayEntry {
  fileName: string;
  version: number;
  fingerprint: string;
}

/**
 * A bounded, content-free descriptor of exactly what a `CompactionPlan`
 * would build, safe to persist verbatim in a durable job receipt
 * (Checkpoint 7 requirement 10): every pending overlay's filename/version/
 * fingerprint at planning time, the established dimension/model, the
 * BASE generation this plan was built against (`baseGenerationId`/
 * `baseFingerprint`, `null` for an initial build -- final-closure
 * requirement 3), and a single `fingerprint` hash summarizing the
 * (identity, sourceHash, chunkCount) SET the resulting generation's notes
 * would contain.
 *
 * This `fingerprint` is a SEMANTIC fingerprint, not a byte-exact artifact
 * checksum: it never reads or hashes any actual vector bytes (final-
 * closure requirement 5), only identity/sourceHash/chunkCount -- two
 * builds that embed the same source text differently (a non-deterministic
 * provider, or a bug) would still match on this fingerprint. It exists to
 * detect "this generation was built from a materially different overlay
 * SET than planned" (a real correctness hazard: stale/skipped/extra
 * notes), not "the embedding provider returned bit-identical floats."
 * Byte-exact artifact verification, where it matters (Checkpoint 7 final-
 * closure requirement 4/5), instead compares `manifestArtifactFingerprint`
 * of the actual generation manifest, which DOES cover every checksum
 * (`noteMatrixChecksum`/`noteMetadataChecksum`/per-shard checksums) already
 * computed over real vector bytes elsewhere in this codebase.
 */
export interface CompactionSnapshotDescriptorV1 {
  baseGenerationId: number | null;
  baseFingerprint: string | null;
  dimension: number;
  embeddingModel: string;
  overlays: CompactionSnapshotOverlayEntry[];
  fingerprint: string;
}

function compactionFingerprint(entries: readonly { key: string; sourceHash: string; chunkCount: number }[], dimension: number, embeddingModel: string): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return createHash("sha256").update(JSON.stringify({ dimension, embeddingModel, entries: sorted })).digest("hex");
}

/**
 * A bounded fingerprint of a generation's ACTUAL persisted artifacts --
 * every checksum its manifest already carries over real vector/metadata
 * bytes (`noteMatrixChecksum`, `noteMetadataChecksum`, and each chunk
 * shard's `checksum`/`offsetChecksum`, in deterministic shard-id order),
 * plus its shape (dimension/model/counts). Unlike `compactionFingerprint`
 * (semantic: identity/sourceHash/chunkCount only), two generations only
 * match this fingerprint if their vector bytes are ACTUALLY identical --
 * this is the byte-exact half of Checkpoint 7 final-closure requirement 5.
 */
export function manifestArtifactFingerprint(manifest: VectorIndexManifestV1): string {
  const shardChecksums = [...manifest.chunkShards]
    .map((shard) => ({ shardId: shard.shardId, count: shard.count, checksum: shard.checksum, offsetChecksum: shard.offsetChecksum }))
    .sort((a, b) => a.shardId.localeCompare(b.shardId));
  const payload = {
    dimension: manifest.dimension,
    embeddingModel: manifest.embeddingModel,
    noteCount: manifest.noteCount,
    chunkCount: manifest.chunkCount,
    noteMatrixChecksum: manifest.noteMatrixChecksum,
    noteMetadataChecksum: manifest.noteMetadataChecksum,
    chunkShards: shardChecksums,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Builds the bounded, content-free snapshot descriptor for `plan` -- see `CompactionSnapshotDescriptorV1`. */
export function describeCompactionSnapshot(plan: CompactionPlan): CompactionSnapshotDescriptorV1 {
  const entries = plan.notes.map((note) => ({ key: identityKey(note.identity), sourceHash: note.sourceHash, chunkCount: note.chunkCount }));
  const overlays = [...plan.overlaysSnapshot]
    .map((overlay) => ({ fileName: overlayFileName(overlay.identity), version: overlay.version, fingerprint: overlay.fingerprint }))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  return {
    baseGenerationId: plan.baseGenerationId,
    baseFingerprint: plan.baseFingerprint,
    dimension: plan.dimension,
    embeddingModel: plan.embeddingModel,
    overlays,
    fingerprint: compactionFingerprint(entries, plan.dimension, plan.embeddingModel),
  };
}

/**
 * `true` iff a generation actually loaded from disk (`manifest` +
 * `noteMetadata`, from `verifyGenerationFully`/`loadGeneration`) contains
 * the SAME (identity, sourceHash, chunkCount) SET `descriptor` was built
 * from, at the same dimension/model -- a SEMANTIC match, never a claim
 * that the actual vector bytes are identical (see
 * `CompactionSnapshotDescriptorV1`'s own doc comment, final-closure
 * requirement 5). Used to decide whether an already-existing
 * `generations/gen-<id>` directory found at `build-generation` time may
 * be safely, SEMANTICALLY adopted (it is very likely this job's own
 * prior, crash-interrupted-before-receipt-persisted attempt) rather than
 * treated as a foreign/stale collision -- see Checkpoint 7 requirement 11.
 * A caller that also needs byte-exact assurance (verify/activate phases
 * reloading a generation THIS job itself already built and fingerprinted)
 * should additionally compare `manifestArtifactFingerprint`.
 */
export function compactionSnapshotMatchesGeneration(descriptor: CompactionSnapshotDescriptorV1, manifest: VectorIndexManifestV1, noteMetadata: readonly NoteRowMetadataV1[]): boolean {
  if (manifest.dimension !== descriptor.dimension || manifest.embeddingModel !== descriptor.embeddingModel) return false;
  const entries = noteMetadata.map((row) => ({ key: identityKey(row.identity), sourceHash: row.sourceHash, chunkCount: row.chunkCount }));
  return compactionFingerprint(entries, manifest.dimension, manifest.embeddingModel) === descriptor.fingerprint;
}

/**
 * The snapshot-based sibling of `finalizeCompaction`, for a caller that can
 * only durably carry a bounded `CompactionSnapshotDescriptorV1` (persisted
 * in a job receipt) across a phase boundary/restart, rather than a live,
 * vector-bearing `CompactionPlan` recomputed fresh (which, per Checkpoint 7
 * requirement 10, is exactly the unsafe thing to do at activation time --
 * overlays can change across phase boundaries/restart). Switches the
 * pointer, then deletes exactly the overlays named in `overlays`, each
 * version+fingerprint-checked (`deleteOverlayIfSnapshotMatches`) against
 * the snapshot -- never a replacement written after planning.
 */
export async function finalizeCompactionFromSnapshot(fs: IndexFs, root: string, newGenerationId: number, overlays: readonly CompactionSnapshotOverlayEntry[]): Promise<void> {
  await switchCurrentGeneration(fs, root, newGenerationId);
  for (const overlay of overlays) {
    await deleteOverlayIfSnapshotMatches(fs, root, overlay.fileName, overlay.version, overlay.fingerprint);
  }
}

/**
 * Every `IndexStore` constructed over the SAME `fs`+`root` pair shares
 * exactly one `IndexMutationQueue` (Checkpoint 7 final-closure requirement
 * 2), keyed first by `fs` object identity (a `WeakMap`, so distinct fake
 * filesystems in unrelated tests never collide and this never leaks
 * process-wide) and then by `root` string. This is what makes a
 * conditional overlay delete (`deleteOverlayIfSnapshotMatches`'s
 * prefix-check-then-unlink) ATOMIC relative to every OTHER
 * plugin-owned mutation against the same store, even one issued through a
 * completely independent `IndexStore` instance -- e.g. one held by the
 * Checkpoint 7 rebuild job and another by ordinary note-processing --
 * closing the TOCTOU window a per-instance queue would otherwise leave
 * open between them.
 *
 * This is a PROCESS-LEVEL guarantee only. It coordinates every mutation
 * this Node process itself issues against `fs`+`root`; it cannot, and
 * does not claim to, coordinate a genuinely EXTERNAL process or tool
 * writing directly to the same files on disk -- true cross-process mutual
 * exclusion would require OS-level file locking, which this module does
 * not implement. Against that kind of external interference, the
 * fail-closed guarantees already in place elsewhere (checksum
 * verification, filename/identity cross-checks, atomic write/rename/fsync
 * discipline in `AtomicStore`/`AtomicBinaryStore`) are what actually
 * apply: a foreign/corrupt write is detected and rejected (or, for
 * `deleteOverlayIfSnapshotMatches`, simply fails to match and is left
 * alone) on a BEST-EFFORT basis, never guaranteed atomic against it.
 */
const SHARED_MUTATION_QUEUES = new WeakMap<IndexFs, Map<string, IndexMutationQueue>>();

function sharedMutationQueueFor(fs: IndexFs, root: string): IndexMutationQueue {
  let byRoot = SHARED_MUTATION_QUEUES.get(fs);
  if (!byRoot) {
    byRoot = new Map();
    SHARED_MUTATION_QUEUES.set(fs, byRoot);
  }
  let queue = byRoot.get(root);
  if (!queue) {
    queue = new IndexMutationQueue();
    byRoot.set(root, queue);
  }
  return queue;
}

/**
 * Runs `fn` under the SAME shared per-(fs,root) mutation lock every
 * `IndexStore` instance's `upsertNote`/`deleteNote`/`compact` already goes
 * through -- exported so a caller OUTSIDE `IndexStore` itself (the
 * Checkpoint 7 rebuild job's activation transaction, which reads the
 * current pointer, verifies artifacts, switches it, and conditionally
 * deletes overlays) can run its entire multi-step transaction with the
 * exact same mutual-exclusion guarantee against every `IndexStore`
 * mutation, closing the check/switch and check/unlink TOCTOU windows a
 * caller acting outside this lock would otherwise leave open
 * (final-closure requirement 3).
 *
 * NEVER call this (directly or indirectly) from within a callback already
 * running under this same lock for the same `(fs, root)` pair -- e.g.
 * from inside an `IndexStore.compact()`/`upsertNote()`/`deleteNote()`
 * call, or from inside another `runWithIndexMutationLock` call for the
 * same pair. `IndexMutationQueue.run` chains onto a tail promise that is
 * only reassigned to depend on the CURRENT call's own result the moment
 * it starts running; a nested call from within an already-running task
 * would therefore wait forever on a tail that cannot advance until that
 * same nested call itself resolves -- a guaranteed deadlock, not merely a
 * slow path. This module's own `upsertNote`/`deleteNote`/`compact`
 * methods never do this, and this function must not be composed in a way
 * that would either.
 */
export function runWithIndexMutationLock<T>(fs: IndexFs, root: string, fn: () => Promise<T>): Promise<T> {
  return sharedMutationQueueFor(fs, root).run(fn);
}

export class IndexStore {
  private readonly queue: IndexMutationQueue;

  constructor(
    private readonly fs: IndexFs,
    private readonly root: string,
  ) {
    this.queue = sharedMutationQueueFor(fs, root);
  }

  queryRelated(options: QueryRelatedOptions): Promise<ScoredNote[]> {
    return queryRelated(this.fs, this.root, options);
  }

  /** Read-only single-identity lookup -- see `getIndexedRecord`'s own doc comment. */
  getRecord(identity: NoteIdentityV1): Promise<IndexRecordV1 | null> {
    return getIndexedRecord(this.fs, this.root, identity);
  }

  /** Read-only, fully-verified catalog snapshot -- see `snapshotIndexedCatalog`'s own doc comment. */
  snapshotCatalog(): Promise<IndexedCatalogRecord[] | null> {
    return snapshotIndexedCatalog(this.fs, this.root);
  }

  /**
   * Read-only, manifest-only note count for the CURRENT committed
   * generation, when one exists (`null` when there is no current
   * pointer yet -- a fresh/empty index, never a fabricated `0`). This is
   * deliberately the CHEAP, NOT-fully-verified count: it confirms a
   * pointer and a manifest exist, never that `notes.mvx`/`notes.meta.json`
   * checksums, shapes, or shard declarations actually check out. A caller
   * that needs to prove the generation is genuinely trustworthy before
   * querying/reporting a count against it must use
   * `verifyCurrentGenerationFully()` instead -- see that method's own doc
   * comment (Checkpoint 9 closure review item 6: "does not prove a current
   * generation is fully verified despite comments/report claims").
   */
  async getCurrentNoteCount(): Promise<number | null> {
    const manifest = await loadCurrentGenerationManifest(this.fs, this.root);
    return manifest ? manifest.noteCount : null;
  }

  /**
   * Read-only, FULLY verified summary of the current committed generation
   * -- runs the exact same integrity check (`verifyGenerationFully`,
   * shared with `switchCurrentGeneration`/`compact`'s own pre-activation
   * verification) a real activation would: checksums for
   * `notes.mvx`/`notes.meta.json` against the manifest, shape/count
   * agreement, every chunk shard's declared ownership cross-checked, and
   * a sample ranking query actually run against the resident data.
   * Returns `null` -- never throws, never a fabricated count -- when
   * there is no current generation yet, OR when verification itself
   * fails for any reason (a corrupt/tampered shard, a checksum mismatch,
   * etc.): a caller that needs "this generation is real and intact"
   * before wiring a query/count into a comparison must treat `null`
   * exactly like "no generation exists", never attempt to partially
   * trust a failed verification. Read-only: never writes/activates
   * anything, unlike `compact()`'s own use of the same underlying check.
   */
  async verifyCurrentGenerationFully(): Promise<{ noteCount: number } | null> {
    const generationId = await loadCurrentGenerationId(this.fs, this.root);
    if (generationId === null) return null;
    try {
      const { manifest } = await verifyGenerationFully(this.fs, this.root, generationId);
      return { noteCount: manifest.noteCount };
    } catch {
      return null;
    }
  }

  /**
   * Rejects (before writing anything) if: the pending-overlay-file budget
   * (`MAX_PENDING_OVERLAY_COUNT`/`MAX_PENDING_OVERLAY_CHUNK_ROWS`) would
   * be exceeded; the EFFECTIVE merged corpus would exceed
   * `MAX_MANIFEST_NOTE_COUNT`/`MAX_MANIFEST_CHUNK_COUNT`; this upsert's
   * dimension/embeddingModel doesn't match the one already established by
   * the active generation or another pending upsert; or the PROJECTED
   * ACTUAL steady-state/disk resource usage (`assertResourceBudget`,
   * accounting for real dimension/shape, never just fixed counts) would
   * exceed the approved budgets. Compact first if any of these trigger.
   */
  upsertNote(input: UpsertNoteInput): Promise<void> {
    return this.queue.run(async () => {
      const { generation, overlays } = await loadMutationContext(this.fs, this.root);
      assertPendingOverlayBudget(overlays, input.identity, input.chunkVectors.length);
      assertConsistentDimensionAndModel(generation, overlays, input);
      assertEffectiveCorpusBudget(generation, overlays, input.identity, input.chunkVectors.length);
      assertResourceBudget(generation, overlays, input.identity, { operation: "upsert", chunkCount: input.chunkVectors.length });
      try {
        await writeUpsertOverlay(this.fs, this.root, input);
      } catch (error) {
        throw wrapOverlayError(error, "upsertNote failed");
      }
    });
  }

  /** Rejects (before writing anything) if the pending-overlay-file budget, or the PROJECTED ACTUAL resource budget (`assertResourceBudget`), would be exceeded -- a tombstone for a brand-new identity still creates a new overlay file and is bounded exactly like an upsert. A tombstone only ever shrinks the effective corpus, so it is never subject to `assertEffectiveCorpusBudget`. */
  deleteNote(identity: NoteIdentityV1): Promise<void> {
    return this.queue.run(async () => {
      const { generation, overlays } = await loadMutationContext(this.fs, this.root);
      assertPendingOverlayBudget(overlays, identity, 0);
      assertResourceBudget(generation, overlays, identity, { operation: "tombstone" });
      try {
        await writeTombstoneOverlay(this.fs, this.root, { identity });
      } catch (error) {
        throw wrapOverlayError(error, "deleteNote failed");
      }
    });
  }

  /**
   * Rebuilds a fresh generation from the current committed view (base +
   * every overlay/tombstone valid at the moment `compact` acquires the
   * mutation queue), verifies and activates it exactly like
   * `generationStore.buildGeneration`/`switchCurrentGeneration` already
   * do, and -- ONLY after the pointer switch has committed -- deletes
   * exactly the overlay files that were part of the snapshot this
   * generation was built from. If the build/verify/pointer-switch fails
   * OR `signal` is aborted (propagated straight through to
   * `buildGeneration`, which checks it at every phase boundary up to and
   * including immediately before the final rename), no overlay is deleted
   * and the previously active generation/pointer/every overlay are left
   * completely unchanged.
   *
   * Throws `IndexStoreError` without mutating anything if there is no
   * base generation AND no pending upsert overlay to infer a
   * dimension/embeddingModel from -- an initial (possibly empty)
   * generation must be created explicitly via `buildGeneration` +
   * `switchCurrentGeneration` with an explicit dimension/model, never
   * invented here.
   */
  compact(newGenerationId: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.queue.run(async () => {
      const plan = await planCompaction(this.fs, this.root);
      const buildInput: BuildGenerationInput = { generationId: newGenerationId, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes };
      await buildGeneration(this.fs, this.root, buildInput, { signal: options.signal });

      // Cancellation checkpoint: buildGeneration has already fully built, verified, and renamed
      // the new generation into generations/ at this point (it exists on disk) -- but the pointer
      // has NOT switched yet. An abort observed here leaves the new generation on disk but
      // simply unreferenced (exactly like any other pointer-switch-skipped build), and the prior
      // pointer/every overlay are left completely unchanged.
      if (options.signal?.aborted) {
        throw new GenerationBuildCancelledError();
      }

      await finalizeCompaction(this.fs, this.root, newGenerationId, plan);
    });
  }

  /** Best-effort startup housekeeping: removes any staging directory left behind by a build that never completed (including a cancelled one). Never touches `generations/`, `current.json`, or `overlays/`. */
  cleanupStaleStaging(): Promise<number> {
    return cleanupStaleStaging(this.fs, this.root);
  }

  /** Read-only: counts stale staging directories without removing them -- for preflight, which must never mutate (Checkpoint 9 requirement 2). */
  countStaleStaging(): Promise<number> {
    return countStaleStaging(this.fs, this.root);
  }
}

export { CosineIndexError, GenerationBuildCancelledError };
