import { createHash } from "node:crypto";

import type { MetadataOutputV1, NoteIdentityV1, SourceProjectionV1 } from "../engine/contracts";
import { EngineError, isEngineError } from "../engine/errors";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import type { NoteWriter } from "../engine/noteWriter";
import type { RelatedSectionLink } from "../engine/relatedSectionWriter";
import { projectSource } from "../engine/sourceProjection";
import { isUnitNorm } from "../engine/vectorValidation";
import type { JobPhaseRunner, PhaseStepOutcome } from "./jobEngine";
import { noteIdentityStableKey, PROVIDER_WIDE_PAUSE_CODES, toFailureCode, type JobReceiptV1, type PersistedJobV1 } from "./jobTypes";

/**
 * The vault read seam a note job's `discover`/`embed`/`extract-metadata`/
 * `confirm-source` phases all re-run through. `read` is called with the
 * job's ORIGINAL (queued-against) identity but MUST resolve by that
 * identity's STABLE key -- for an `"apple-annotation"` identity, its
 * `appleAnnotationId` (never blindly `identity.canonicalPath`, which can
 * be stale after a rename); for a `"path"` identity, the path itself is
 * the whole of its stable identity. `null` means the identity no longer
 * resolves to anything (deleted), never a thrown error for the ordinary
 * "not found" case.
 *
 * The returned `identity` is the CURRENT resolved identity (its
 * `canonicalPath` reflecting wherever the note lives right now, which may
 * have changed since the job was queued) -- `NoteJobRunner` uses THIS
 * identity, never the original one, for every projection/metadata/write/
 * index operation from this point forward (Checkpoint 7 requirement 8): a
 * rename mid-job is followed to its new path, never left writing/indexing
 * a stale one.
 */
export interface NoteSourceReader {
  /** `signal`, when provided, is aborted on `JobEngine.dispose()` -- a well-behaved implementation checks it around every underlying vault I/O and any full-catalog annotation scan, stopping promptly rather than working through a large vault regardless. */
  read(identity: NoteIdentityV1, signal?: AbortSignal): Promise<{ identity: NoteIdentityV1; rawContent: string } | null>;
}

export interface EmbeddedNote {
  model: string;
  dimension: number;
  noteVector: Float32Array;
  chunkVectors: Float32Array[];
}

/**
 * Provider/model seams. Deliberately narrow, provider-neutral function
 * contracts -- NOT a direct dependency on `OllamaEmbeddingProvider`'s or
 * `metadataPipeline`'s concrete config shapes, since wiring those concrete
 * providers together is later checkpoints' job (Checkpoint 9's
 * `MindmapEngine` composition). Every result here is used in-memory only
 * for the remainder of this one job run; none of it is ever persisted.
 */
export interface NoteEmbeddingSeam {
  embed(projection: SourceProjectionV1, signal: AbortSignal): Promise<EmbeddedNote>;
}

export interface NoteMetadataSeam {
  extract(projection: SourceProjectionV1, signal: AbortSignal): Promise<MetadataOutputV1>;
}

export interface UpsertNoteOverlaySeam {
  upsertNote(input: {
    identity: NoteIdentityV1;
    sourceHash: string;
    embeddingModel: string;
    dimension: number;
    noteVector: Float32Array;
    chunkVectors: Float32Array[];
  }): Promise<void>;
}

/**
 * Checkpoint 7 requirement 9 (hardened by final-closure requirement 6):
 * when a note's source changes WHILE a job for it is in flight (as
 * opposed to being deleted), the stale job's own results are discarded
 * (it goes `"obsolete"`) but the edit itself must not simply be dropped.
 * REQUIRED, not optional -- a source-change silently producing no
 * replacement would leave an edited note permanently unprocessed.
 * Expected to be backed by `JobEngine.submit`, whose own idempotency-key
 * coalescing makes calling this more than once for the same edit (e.g. a
 * retry after a transient failure, or the same staleness independently
 * detected at more than one phase) safe.
 */
export interface NoteReplacementSeam {
  enqueueReplacement(input: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }): Promise<void>;
}

export interface NoteJobDeps {
  sourceReader: NoteSourceReader;
  embedding: NoteEmbeddingSeam;
  metadata: NoteMetadataSeam;
  noteWriter: NoteWriter;
  indexStore: UpsertNoteOverlaySeam;
  /** Ordinary notes only; Apple-annotation notes always render `related` as wikilinks instead (see `NoteWriter`). Omit to leave the managed related-section body region untouched for this checkpoint's job engine. */
  buildRelatedLinks?: (metadata: MetadataOutputV1) => RelatedSectionLink[];
  mindmapHeading?: string;
  /** See `NoteReplacementSeam`. */
  replacement: NoteReplacementSeam;
}

interface NoteJobMemory {
  projection?: SourceProjectionV1;
  embedded?: EmbeddedNote;
  metadata?: MetadataOutputV1;
  /** The CURRENT resolved identity, refreshed by every `ensureFreshProjection` call -- see `NoteSourceReader`'s doc comment. */
  resolvedIdentity?: NoteIdentityV1;
  /** Set ONLY after `NoteReplacementSeam.enqueueReplacement` has actually SUCCEEDED (never before -- final-closure requirement 6) -- guards it to at most one successful call per job, even if source staleness is independently detected at more than one phase-step. */
  replacementEnqueued?: boolean;
}

/** Bounds the in-memory (never persisted) per-job scratch cache -- oldest entry evicted once the cap is reached, so a pile-up of jobs that never reach a terminal outcome cannot grow this unboundedly. */
const MAX_INFLIGHT_NOTE_JOB_MEMORY = 64;
/** Mirrors `src/index/indexManifest.ts`'s `MAX_MANIFEST_SHARD_ROW_COUNT` -- one note's chunks must fit in a single shard, so bounding chunk count here at the same value fails a malformed/runaway embedding result closed BEFORE it is ever cached, not merely at the overlay-write layer later. Declared independently (not imported) to keep `src/jobs` decoupled from `src/index`'s module graph. */
const MAX_NOTE_CHUNK_COUNT = 10_000;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `true` iff `value` is a dense (never sparse), finite-number vector shape -- either a `Float32Array` or a plain `number[]` -- safe to read `.length`/iterate on without risking a `TypeError` from an unexpected runtime shape (`null`, a hole-bearing array, a non-array object, etc.). Deliberately does NOT check dimension/unit-norm itself; callers still run those checks afterward. */
function isFiniteVectorLike(value: unknown): value is Float32Array | number[] {
  if (value instanceof Float32Array) return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || typeof value[index] !== "number") return false;
  }
  return true;
}

/**
 * Validates an embedding seam's result BEFORE it is ever cached or used to
 * write anything (Checkpoint 7 final-closure requirement 7): the model
 * name must exactly match what this job was queued for (never silently
 * stored under the wrong model), dimension must be a positive integer
 * within `MAX_EMBEDDING_DIMENSION`, the note vector and EVERY chunk vector
 * must have exactly that dimension and pass the shared unit-vector check
 * (`isUnitNorm` -- rejects non-finite, zero, or non-unit-length vectors),
 * and the chunk count must be bounded. Returns the specific terminal
 * outcome to report on the first violation found, or `null` if `embedded`
 * is fully well-formed. Every code returned here is already a member of
 * `KNOWN_TERMINAL_FAILURE_CODES` -- malformed seam output is a structural
 * bug, never something a bare retry could fix.
 *
 * Accepts `unknown`, never the statically-typed `EmbeddedNote` (Checkpoint
 * 7 acceptance guard 6): `embed()` is a caller-supplied seam, so its
 * result's ACTUAL runtime shape carries no more guarantee than any other
 * external input -- `null`/non-object, a non-string `model`, a
 * non-Float32Array/non-array vector, or a sparse/null chunk array must
 * each fail closed with a structured terminal outcome here, never escape
 * as a raw `TypeError` from blind property/`.length` access.
 */
function validateEmbeddedNote(embedded: unknown, expectedModel: string): PhaseStepOutcome | null {
  if (typeof embedded !== "object" || embedded === null || Array.isArray(embedded)) {
    return { type: "retry", failureCode: "EMBEDDING_VECTOR_INVALID" };
  }
  const record = embedded as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model !== expectedModel) {
    return { type: "retry", failureCode: "EMBEDDING_MODEL_MISMATCH" };
  }
  if (typeof record.dimension !== "number" || !Number.isInteger(record.dimension) || record.dimension <= 0 || record.dimension > MAX_EMBEDDING_DIMENSION) {
    return { type: "retry", failureCode: "EMBEDDING_DIMENSION_INVALID" };
  }
  const dimension = record.dimension;
  if (!isFiniteVectorLike(record.noteVector) || record.noteVector.length !== dimension) {
    return { type: "retry", failureCode: "EMBEDDING_DIMENSION_MISMATCH" };
  }
  if (!isUnitNorm(record.noteVector)) {
    return { type: "retry", failureCode: "EMBEDDING_VECTOR_INVALID" };
  }
  if (!Array.isArray(record.chunkVectors)) {
    return { type: "retry", failureCode: "EMBEDDING_COUNT_MISMATCH" };
  }
  if (record.chunkVectors.length > MAX_NOTE_CHUNK_COUNT) {
    return { type: "retry", failureCode: "EMBEDDING_COUNT_MISMATCH" };
  }
  for (const chunk of record.chunkVectors) {
    if (!isFiniteVectorLike(chunk) || chunk.length !== dimension) {
      return { type: "retry", failureCode: "EMBEDDING_DIMENSION_MISMATCH" };
    }
    if (!isUnitNorm(chunk)) {
      return { type: "retry", failureCode: "EMBEDDING_VECTOR_INVALID" };
    }
  }
  return null;
}

/**
 * Implements the strict `discover -> embed -> extract-metadata ->
 * confirm-source -> write-note -> write-overlay -> complete` phase order
 * for `"process-note"` jobs (Checkpoint 7 requirement 4). Every phase
 * (other than `discover`/`confirm-source`, which are the check itself)
 * re-verifies source freshness before doing anything, so a phase reached
 * via ordinary forward progress (fast: everything needed is already
 * resident in `memory`) and the exact same phase reached via a cold
 * restart (memory empty; recomputes whatever prerequisite output is
 * missing) behave identically and are both always safe to simply run --
 * "resumes from the earliest safe recomputation phase" falls out of this
 * naturally, without the engine ever needing to reset a job's persisted
 * phase backward.
 */
export class NoteJobRunner implements JobPhaseRunner {
  private readonly memory = new Map<string, NoteJobMemory>();

  constructor(private readonly deps: NoteJobDeps) {}

  async step(persisted: PersistedJobV1, signal: AbortSignal): Promise<PhaseStepOutcome> {
    if (persisted.job.kind !== "process-note" || persisted.job.target.kind !== "note") {
      throw new EngineError("JOB_SHAPE_INVALID", 'NoteJobRunner only handles "process-note" jobs with a note target.', {});
    }
    const identity = persisted.job.target.identity;
    const expectedSourceHash = persisted.job.sourceHash;
    const embeddingModel = persisted.job.embeddingModel;
    if (expectedSourceHash === undefined || embeddingModel === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", "process-note job is missing sourceHash/embeddingModel.", {});
    }
    const jobId = persisted.job.jobId;
    const pipelineVersion = persisted.job.pipelineVersion;

    try {
      switch (persisted.job.phase) {
        case "discover":
          return await this.stepDiscover(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        case "embed":
          return await this.stepEmbed(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        case "extract-metadata":
          return await this.stepExtractMetadata(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        case "confirm-source":
          return await this.stepConfirmSource(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        case "write-note":
          return await this.stepWriteNote(persisted, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        case "write-overlay":
          return await this.stepWriteOverlay(persisted, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
        default:
          throw new EngineError("JOB_TRANSITION_INVALID", `NoteJobRunner cannot execute phase "${persisted.job.phase}".`, {});
      }
    } catch (error) {
      if (isEngineError(error)) throw error;
      return { type: "retry", failureCode: toFailureCode(error) };
    }
  }

  /** Discards this job's cached (never persisted) embed/metadata scratch state -- called once a job reaches ANY terminal outcome. */
  forget(jobId: string): void {
    this.memory.delete(jobId);
  }

  private memoryFor(jobId: string): NoteJobMemory {
    let entry = this.memory.get(jobId);
    if (!entry) {
      if (this.memory.size >= MAX_INFLIGHT_NOTE_JOB_MEMORY) {
        const oldestKey = this.memory.keys().next().value;
        if (oldestKey !== undefined) this.memory.delete(oldestKey);
      }
      entry = {};
      this.memory.set(jobId, entry);
    }
    return entry;
  }

  /**
   * Attempts to enqueue the replacement job. Never swallows a failure
   * (final-closure requirement 6): if the seam throws, this returns a
   * transient retry outcome so the job stays at its CURRENT (stale) phase
   * and a later retry/restart calls the seam again -- always safe, since
   * `JobEngine.submit`'s own idempotency-key coalescing absorbs a repeated
   * identical enqueue. `replacementEnqueued` is set ONLY after the call
   * has actually succeeded, and only once per job: once set, a later
   * independent detection of the SAME staleness (e.g. a different phase
   * re-checking) skips straight to reporting obsolete without calling the
   * seam again.
   */
  private async tryEnqueueReplacement(jobId: string, identity: NoteIdentityV1, sourceHash: string, embeddingModel: string, pipelineVersion: number): Promise<PhaseStepOutcome | undefined> {
    const mem = this.memoryFor(jobId);
    if (mem.replacementEnqueued) return undefined;
    try {
      await this.deps.replacement.enqueueReplacement({ identity, sourceHash, embeddingModel, pipelineVersion });
    } catch (error) {
      return { type: "retry", failureCode: toFailureCode(error) };
    }
    mem.replacementEnqueued = true;
    return undefined;
  }

  /**
   * Re-reads the current source (via the stable-identity `sourceReader`
   * seam) and recomputes its projection/`sourceHash`, caching both the
   * projection and the freshly RESOLVED identity.
   *
   * Distinguishes three kinds of staleness, per final-closure requirement
   * 6: the note is gone (deleted -- `"obsolete"`/`SOURCE_STALE`, no
   * replacement, matching prior behavior); the resolved identity's stable
   * key does not match what this job was queued for (fails closed --
   * `"obsolete"`/`IDENTITY_INVALID`, a DISTINCT terminal code from
   * `SOURCE_STALE`, no replacement, no write); or the `sourceHash` no
   * longer matches (source edited -- attempts to enqueue a replacement; a
   * failed attempt is a transient retry at the CURRENT phase, never
   * swallowed, and only a SUCCESSFUL enqueue resolves to `"obsolete"`/
   * `SOURCE_STALE`).
   */
  private async ensureFreshProjection(
    jobId: string,
    identity: NoteIdentityV1,
    expectedSourceHash: string,
    embeddingModel: string,
    pipelineVersion: number,
    signal?: AbortSignal,
  ): Promise<{ ok: true; projection: SourceProjectionV1 } | { ok: false; outcome: PhaseStepOutcome }> {
    const found = await this.deps.sourceReader.read(identity, signal);
    if (!found) return { ok: false, outcome: { type: "obsolete", failureCode: "SOURCE_STALE" } };
    if (noteIdentityStableKey(found.identity) !== noteIdentityStableKey(identity)) {
      // The reader resolved to a stable identity this job was never queued for -- fail closed
      // rather than projecting/writing/indexing under an unrelated identity. Distinct code from
      // SOURCE_STALE: this is a routing/identity bug, not an ordinary edit-in-flight race.
      return { ok: false, outcome: { type: "obsolete", failureCode: "IDENTITY_INVALID" } };
    }
    const projection = projectSource(found.identity, found.rawContent);
    if (projection.sourceHash !== expectedSourceHash) {
      const retryOutcome = await this.tryEnqueueReplacement(jobId, found.identity, projection.sourceHash, embeddingModel, pipelineVersion);
      if (retryOutcome) return { ok: false, outcome: retryOutcome };
      return { ok: false, outcome: { type: "obsolete", failureCode: "SOURCE_STALE" } };
    }
    const mem = this.memoryFor(jobId);
    mem.projection = projection;
    mem.resolvedIdentity = found.identity;
    return { ok: true, projection };
  }

  /** The current resolved identity for this job -- the freshest `ensureFreshProjection` result, or the original queued-against identity if none has resolved yet (e.g. the very first call in a phase). */
  private resolvedIdentityFor(jobId: string, fallback: NoteIdentityV1): NoteIdentityV1 {
    return this.memory.get(jobId)?.resolvedIdentity ?? fallback;
  }

  private async stepDiscover(jobId: string, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const result = await this.ensureFreshProjection(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!result.ok) return result.outcome;
    return { type: "advance", nextPhase: "embed" };
  }

  /** Always calls the embedding provider (never consults the cache) -- used by the `embed` phase itself, and by `ensureEmbedded`'s cache-miss path. */
  private async computeEmbedded(
    jobId: string,
    identity: NoteIdentityV1,
    expectedSourceHash: string,
    embeddingModel: string,
    pipelineVersion: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: EmbeddedNote } | { ok: false; outcome: PhaseStepOutcome }> {
    const projectionResult = await this.ensureFreshProjection(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!projectionResult.ok) return projectionResult;
    let embedded: EmbeddedNote;
    try {
      embedded = await this.deps.embedding.embed(projectionResult.projection, signal);
    } catch (error) {
      return { ok: false, outcome: this.providerFailureOutcome(error) };
    }
    const invalid = validateEmbeddedNote(embedded, embeddingModel);
    if (invalid) return { ok: false, outcome: invalid };
    this.memoryFor(jobId).embedded = embedded;
    return { ok: true, value: embedded };
  }

  /** Uses the resident (never persisted) cache if this job already has embed output; recomputes it otherwise -- the exact "earliest safe recomputation" fallback a cold restart (fresh runner instance, empty cache) needs, WITHOUT ever moving the persisted phase backward: a later phase (`write-note`/`write-overlay`) calling this stays at its own phase throughout. */
  private async ensureEmbedded(
    jobId: string,
    identity: NoteIdentityV1,
    expectedSourceHash: string,
    embeddingModel: string,
    pipelineVersion: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: EmbeddedNote } | { ok: false; outcome: PhaseStepOutcome }> {
    const cached = this.memory.get(jobId)?.embedded;
    if (cached) return { ok: true, value: cached };
    return this.computeEmbedded(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
  }

  private async stepEmbed(jobId: string, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const result = await this.computeEmbedded(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!result.ok) return result.outcome;
    return { type: "advance", nextPhase: "extract-metadata" };
  }

  /** Always calls the metadata provider -- used by the `extract-metadata` phase itself, and by `ensureMetadata`'s cache-miss path. */
  private async computeMetadata(
    jobId: string,
    identity: NoteIdentityV1,
    expectedSourceHash: string,
    embeddingModel: string,
    pipelineVersion: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: MetadataOutputV1 } | { ok: false; outcome: PhaseStepOutcome }> {
    const embeddedResult = await this.ensureEmbedded(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!embeddedResult.ok) return embeddedResult;
    const projectionResult = await this.ensureFreshProjection(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!projectionResult.ok) return projectionResult;
    let metadata: MetadataOutputV1;
    try {
      metadata = await this.deps.metadata.extract(projectionResult.projection, signal);
    } catch (error) {
      return { ok: false, outcome: this.providerFailureOutcome(error) };
    }
    this.memoryFor(jobId).metadata = metadata;
    return { ok: true, value: metadata };
  }

  private async ensureMetadata(
    jobId: string,
    identity: NoteIdentityV1,
    expectedSourceHash: string,
    embeddingModel: string,
    pipelineVersion: number,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: MetadataOutputV1 } | { ok: false; outcome: PhaseStepOutcome }> {
    const cached = this.memory.get(jobId)?.metadata;
    if (cached) return { ok: true, value: cached };
    return this.computeMetadata(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
  }

  private async stepExtractMetadata(jobId: string, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const result = await this.computeMetadata(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!result.ok) return result.outcome;
    return { type: "advance", nextPhase: "confirm-source" };
  }

  private async stepConfirmSource(jobId: string, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    // The explicit "re-read/project source immediately before note mutation" checkpoint --
    // requirement 4. A stale source here discards every in-memory embed/metadata result and
    // performs zero note/index write.
    const result = await this.ensureFreshProjection(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!result.ok) return result.outcome;
    return { type: "advance", nextPhase: "write-note" };
  }

  private async stepWriteNote(persisted: PersistedJobV1, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const jobId = persisted.job.jobId;
    // Cache hit on the ordinary forward path; a cold restart landing directly on write-note (empty
    // cache) recomputes embed+metadata here, in place, WITHOUT changing job.phase away from
    // "write-note" -- exactly "resumes from the earliest safe recomputation phase" without ever
    // needing an illegal backward phase transition.
    const metadataResult = await this.ensureMetadata(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!metadataResult.ok) return metadataResult.outcome;
    const metadata = metadataResult.value;
    // Use the CURRENT resolved identity/path (requirement 8) -- never the original queued-against
    // identity, which may now be stale after a rename.
    const resolved = this.resolvedIdentityFor(jobId, identity);
    const isAppleAnnotation = resolved.kind === "apple-annotation";
    let result;
    try {
      result = await this.deps.noteWriter.writeMetadata({
        identity: resolved,
        path: resolved.canonicalPath,
        expectedSourceHash,
        metadata,
        isAppleAnnotation,
        relatedLinks: this.deps.buildRelatedLinks && !isAppleAnnotation ? this.deps.buildRelatedLinks(metadata) : undefined,
        mindmapHeading: this.deps.mindmapHeading,
        writeMindmapSection: !isAppleAnnotation && this.deps.buildRelatedLinks !== undefined,
        removeMindmapSection: false,
      });
    } catch (error) {
      if (isEngineError(error) && error.code === "SOURCE_STALE") {
        return { type: "obsolete", failureCode: "SOURCE_STALE" };
      }
      return this.providerFailureOutcome(error);
    }
    const receipt: JobReceiptV1 = { kind: "note", noteCommitted: true, noteContentHash: sha256Hex(result.content), overlayCommitted: false };
    return { type: "advance", nextPhase: "write-overlay", receipt };
  }

  private async stepWriteOverlay(persisted: PersistedJobV1, identity: NoteIdentityV1, expectedSourceHash: string, embeddingModel: string, pipelineVersion: number, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const jobId = persisted.job.jobId;
    // The note mutation already committed (receipt says so) by the time this phase is ever
    // reached; a cache miss here (cold restart) recomputes embed IN PLACE, never re-running
    // write-note -- the overlay write below is then simply retried, still at phase "write-overlay".
    const embeddedResult = await this.ensureEmbedded(jobId, identity, expectedSourceHash, embeddingModel, pipelineVersion, signal);
    if (!embeddedResult.ok) return embeddedResult.outcome;
    const embedded = embeddedResult.value;
    // Use the CURRENT resolved identity (requirement 8) -- a rename between write-note and
    // write-overlay (or across a restart in between) must index only the new path, never the old.
    const resolved = this.resolvedIdentityFor(jobId, identity);
    try {
      await this.deps.indexStore.upsertNote({
        identity: resolved,
        sourceHash: expectedSourceHash,
        embeddingModel,
        dimension: embedded.dimension,
        noteVector: embedded.noteVector,
        chunkVectors: embedded.chunkVectors,
      });
    } catch (error) {
      return this.providerFailureOutcome(error);
    }
    const priorReceipt = persisted.receipt;
    const receipt: JobReceiptV1 = {
      kind: "note",
      noteCommitted: true,
      noteContentHash: priorReceipt?.kind === "note" ? priorReceipt.noteContentHash : undefined,
      overlayCommitted: true,
    };
    this.forget(jobId);
    return { type: "complete", receipt };
  }

  private providerFailureOutcome(error: unknown): PhaseStepOutcome {
    const code = toFailureCode(error);
    // Provider-wide-pause takes precedence over the terminal/transient classification: these
    // specific codes mean the PROVIDER is unreachable/misconfigured, so failing (or retrying)
    // just this one job would never help -- every other queued note job would hit the identical
    // condition. Pausing dispatch entirely, instead of burning through this job's retry budget,
    // is what lets it resume cleanly once the provider is fixed and `resumeProvider()` is called.
    // PROVIDER_WIDE_PAUSE_CODES is shared with (and re-enforced by) jobEngine.ts -- see that
    // module's own doc comment (final-closure requirement 11).
    if (PROVIDER_WIDE_PAUSE_CODES.has(code)) {
      return { type: "provider-pause", code };
    }
    return { type: "retry", failureCode: code };
  }
}
