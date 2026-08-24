import { EngineError, isEngineError } from "../engine/errors";
import {
  buildGeneration,
  discoverUnusedGenerationId,
  generationManifestExists,
  GenerationBuildCancelledError,
  loadCurrentGenerationId,
  verifyGenerationFully,
} from "../index/generationStore";
import type { IndexFs } from "../index/indexFs";
import {
  compactionSnapshotMatchesGeneration,
  describeCompactionSnapshot,
  finalizeCompactionFromSnapshot,
  manifestArtifactFingerprint,
  planCompaction,
  runWithIndexMutationLock,
  type CompactionPlan,
  type CompactionSnapshotDescriptorV1,
} from "../index/indexStore";
import type { JobPhaseRunner, PhaseStepOutcome } from "./jobEngine";
import { toFailureCode, type JobReceiptV1, type PersistedJobV1, type RebuildSnapshotV1 } from "./jobTypes";

export interface RebuildJobDeps {
  fs: IndexFs;
  root: string;
}

type RebuildReceipt = Extract<JobReceiptV1, { kind: "rebuild" }>;

function rebuildReceiptOf(persisted: PersistedJobV1): RebuildReceipt | undefined {
  return persisted.receipt?.kind === "rebuild" ? persisted.receipt : undefined;
}

/** Builds the bounded, content-free `RebuildSnapshotV1` a receipt persists from a freshly-planned `CompactionPlan` -- the exact same descriptor shape `indexStore.ts`'s `CompactionSnapshotDescriptorV1` computes, just re-expressed as the job-store-owned type (`jobTypes.ts` never imports `src/index`; see that module's own doc comment on why). */
function toRebuildSnapshot(plan: CompactionPlan): RebuildSnapshotV1 {
  const descriptor = describeCompactionSnapshot(plan);
  return {
    baseGenerationId: descriptor.baseGenerationId,
    baseFingerprint: descriptor.baseFingerprint,
    dimension: descriptor.dimension,
    embeddingModel: descriptor.embeddingModel,
    overlays: descriptor.overlays,
    fingerprint: descriptor.fingerprint,
  };
}

function toDescriptor(snapshot: RebuildSnapshotV1): CompactionSnapshotDescriptorV1 {
  return {
    baseGenerationId: snapshot.baseGenerationId,
    baseFingerprint: snapshot.baseFingerprint,
    dimension: snapshot.dimension,
    embeddingModel: snapshot.embeddingModel,
    overlays: snapshot.overlays,
    fingerprint: snapshot.fingerprint,
  };
}

/**
 * Implements the strict `discover -> build-generation -> verify-generation
 * -> activate-generation -> complete` phase order for `"rebuild-index"`/
 * `"migrate-index"` jobs (Checkpoint 7 requirement 5), routed entirely
 * through the SAME `planCompaction`/`buildGeneration`/
 * `finalizeCompactionFromSnapshot` functions `IndexStore.compact()` itself
 * uses -- this module never reimplements the base+overlay merge or
 * generation persistence logic.
 *
 * Durability properties this runner adds on top of the base
 * `IndexStore`/`generationStore` primitives:
 *
 * - `build-generation` persists a bounded, content-free `RebuildSnapshotV1`
 *   (every pending overlay's filename/version/fingerprint at planning time,
 *   the BASE generation this plan was built against, plus
 *   dimension/model/fingerprint) in the receipt the moment the target
 *   generation is built. `activate-generation` NEVER recomputes a fresh
 *   `planCompaction` to decide what to delete -- it deletes exactly (and
 *   only) the overlays named in that persisted snapshot, version+
 *   fingerprint-checked, so a generation built from snapshot A can never
 *   activate while deleting overlays from some LATER snapshot B.
 * - `build-generation` discovers its target id considering both the
 *   current pointer AND every unreferenced generation directory already on
 *   disk, and -- if a crash happened AFTER a prior attempt's
 *   staging-to-final rename but BEFORE this job's own receipt update ever
 *   committed -- verifies any already-existing target directory's full
 *   integrity and SEMANTIC fingerprint before adopting it as "already
 *   built" (this adoption is semantic-safe, not byte-exact -- see
 *   `tryAdoptExistingTarget`'s own doc comment); a mismatch or corruption
 *   is treated as a genuine id collision, never overwritten, and a fresh
 *   id is allocated instead (a same-phase recovery transition, never a
 *   backward phase move).
 * - `activate-generation` refuses to activate a target that is no longer
 *   safe to activate: if the current pointer has moved on to something
 *   OTHER than this job's planned base or its own already-activated target
 *   (some other rebuild/compaction committed first), this job marks itself
 *   obsolete and durably enqueues exactly one replacement rebuild rather
 *   than ever rolling the pointer backward or deleting a newer
 *   generation's overlays.
 */
export class RebuildJobRunner implements JobPhaseRunner {
  constructor(private readonly deps: RebuildJobDeps) {}

  async step(persisted: PersistedJobV1, signal: AbortSignal): Promise<PhaseStepOutcome> {
    if ((persisted.job.kind !== "rebuild-index" && persisted.job.kind !== "migrate-index") || persisted.job.target.kind !== "global") {
      throw new EngineError("JOB_SHAPE_INVALID", 'RebuildJobRunner only handles "rebuild-index"/"migrate-index" jobs with a global target.', {});
    }
    const priorReceipt = rebuildReceiptOf(persisted);
    try {
      switch (persisted.job.phase) {
        case "discover":
          return await this.stepDiscover(priorReceipt);
        case "build-generation":
          return await this.stepBuildGeneration(priorReceipt, signal);
        case "verify-generation":
          return await this.stepVerifyGeneration(priorReceipt);
        case "activate-generation":
          return await this.stepActivateGeneration(priorReceipt);
        default:
          throw new EngineError("JOB_TRANSITION_INVALID", `RebuildJobRunner cannot execute phase "${persisted.job.phase}".`, {});
      }
    } catch (error) {
      if (isEngineError(error)) throw error;
      return { type: "retry", failureCode: toFailureCode(error) };
    }
  }

  private async stepDiscover(priorReceipt: RebuildReceipt | undefined): Promise<PhaseStepOutcome> {
    if (priorReceipt?.targetGenerationId !== undefined) {
      // Idempotent resume: keep the SAME target id a prior attempt already chose, rather than
      // rediscovering (which could legitimately pick a different id) -- see stepBuildGeneration's
      // own crash/collision handling for what happens if that id turns out to already be occupied
      // by something that ISN'T this job's own completed work.
      return { type: "advance", nextPhase: "build-generation", receipt: priorReceipt };
    }
    // Considers BOTH the current pointer AND every unreferenced generation directory already on
    // disk (requirement 11) -- a fresh rebuild must never pick an id that collides with an orphan
    // left behind by an earlier crashed/cancelled build.
    const targetGenerationId = await discoverUnusedGenerationId(this.deps.fs, this.deps.root);
    const receipt: RebuildReceipt = { kind: "rebuild", targetGenerationId, built: false, verified: false, activated: false };
    return { type: "advance", nextPhase: "build-generation", receipt };
  }

  private async stepBuildGeneration(priorReceipt: RebuildReceipt | undefined, signal: AbortSignal): Promise<PhaseStepOutcome> {
    if (priorReceipt?.targetGenerationId === undefined) {
      throw new EngineError("JOB_SHAPE_INVALID", "build-generation reached without a targetGenerationId in receipt.", {});
    }
    const targetId = priorReceipt.targetGenerationId;

    let plan: CompactionPlan;
    try {
      plan = await planCompaction(this.deps.fs, this.deps.root);
    } catch (error) {
      return { type: "retry", failureCode: toFailureCode(error) };
    }
    const snapshot = toRebuildSnapshot(plan);

    let targetExists: boolean;
    try {
      targetExists = await generationManifestExists(this.deps.fs, this.deps.root, targetId);
    } catch (error) {
      return { type: "retry", failureCode: toFailureCode(error) };
    }

    if (targetExists) {
      const adoptedFingerprint = await this.tryAdoptExistingTarget(targetId, snapshot);
      if (adoptedFingerprint !== null) {
        const receipt: RebuildReceipt = { ...priorReceipt, built: true, snapshot, builtManifestFingerprint: adoptedFingerprint };
        return { type: "advance", nextPhase: "verify-generation", receipt };
      }
      // A genuine collision: something already occupies `targetId` and it is NOT a verified match
      // for what this exact plan would build (either corrupt/foreign, or a stale prior attempt
      // whose content is no longer what the CURRENT overlay set would produce). Never overwrite or
      // adopt blindly -- allocate a fresh id and restart THIS SAME phase (a legal same-phase
      // transition, never backward) with corrected receipt state.
      let freshId: number;
      try {
        freshId = await discoverUnusedGenerationId(this.deps.fs, this.deps.root);
      } catch (error) {
        return { type: "retry", failureCode: toFailureCode(error) };
      }
      const receipt: RebuildReceipt = { kind: "rebuild", targetGenerationId: freshId, built: false, verified: false, activated: false };
      return { type: "advance", nextPhase: "build-generation", receipt };
    }

    try {
      await buildGeneration(this.deps.fs, this.deps.root, { generationId: targetId, embeddingModel: plan.embeddingModel, dimension: plan.dimension, notes: plan.notes }, { signal });
    } catch (error) {
      if (error instanceof GenerationBuildCancelledError) {
        // Cancellation before (or during) the build: nothing under current.json is referenced by
        // the new id, so the prior pointer is untouched -- exactly "cancellation before
        // activation preserves the prior pointer."
        return { type: "cancelled" };
      }
      return { type: "retry", failureCode: toFailureCode(error) };
    }
    // We just built this ourselves -- capture the ACTUAL manifest's byte-exact fingerprint
    // (never merely the semantic one) so later phases can confirm no corruption occurred since.
    const { manifest } = await verifyGenerationFully(this.deps.fs, this.deps.root, targetId);
    const receipt: RebuildReceipt = { ...priorReceipt, built: true, snapshot, builtManifestFingerprint: manifestArtifactFingerprint(manifest) };
    return { type: "advance", nextPhase: "verify-generation", receipt };
  }

  /**
   * Returns the adopted generation's `manifestArtifactFingerprint` iff
   * `targetId`'s already-on-disk generation passes full-integrity
   * verification AND matches `snapshot` SEMANTICALLY (identity/sourceHash/
   * chunkCount at the same dimension/model) -- i.e. it is very likely this
   * job's own prior, crash-interrupted-before-receipt-persisted attempt.
   * This is a SEMANTIC-SAFE adoption, not a byte-exact one (Checkpoint 7
   * final-closure requirement 5): it does not, and cannot, prove the
   * actual embedded vector bytes are what THIS run would have produced --
   * only that the same (identity, sourceHash, chunkCount) set went in.
   * Once adopted, though, the freshly-computed `manifestArtifactFingerprint`
   * IS captured and carried forward in the receipt, so every LATER phase
   * (verify/activate) that reloads this exact generation can confirm
   * byte-exact stability against THAT captured value from here on.
   * Returns `null` (never throws) on any verification failure or
   * fingerprint mismatch -- both mean the same thing to the caller: "do
   * not adopt this."
   */
  private async tryAdoptExistingTarget(targetId: number, snapshot: RebuildSnapshotV1): Promise<string | null> {
    try {
      const { manifest, noteMetadata } = await verifyGenerationFully(this.deps.fs, this.deps.root, targetId);
      if (!compactionSnapshotMatchesGeneration(toDescriptor(snapshot), manifest, noteMetadata)) return null;
      return manifestArtifactFingerprint(manifest);
    } catch {
      return null;
    }
  }

  private async stepVerifyGeneration(priorReceipt: RebuildReceipt | undefined): Promise<PhaseStepOutcome> {
    if (priorReceipt?.targetGenerationId === undefined || !priorReceipt.built) {
      throw new EngineError("JOB_SHAPE_INVALID", "verify-generation reached without a built generation in receipt.", {});
    }
    if (!priorReceipt.snapshot) {
      throw new EngineError("JOB_SHAPE_INVALID", "verify-generation reached without a build-time snapshot in receipt.", {});
    }
    // The FULL streaming integrity verifier (requirement 12) -- every chunk shard is decoded and
    // checksum-verified, not just the resident note matrix/metadata `loadGeneration` alone would
    // check. `buildGeneration` already ran this once before its rename; this is a second,
    // independently-checkpointed confirmation that survives a crash between build success and here
    // without ever having to redo the expensive rebuild itself.
    let manifest, noteMetadata;
    try {
      ({ manifest, noteMetadata } = await verifyGenerationFully(this.deps.fs, this.deps.root, priorReceipt.targetGenerationId));
    } catch (error) {
      return { type: "retry", failureCode: toFailureCode(error) };
    }
    // Full artifact integrity alone is not enough -- also confirm this generation SEMANTICALLY
    // matches the snapshot this job itself built from (requirement 4), and, since we captured our
    // own build's exact artifact fingerprint, that no BYTE-level corruption occurred since then.
    const mismatch = this.checkSnapshotAndArtifact(priorReceipt.snapshot, priorReceipt.builtManifestFingerprint, manifest, noteMetadata);
    if (mismatch) return mismatch;
    const receipt: RebuildReceipt = { ...priorReceipt, verified: true };
    return { type: "advance", nextPhase: "activate-generation", receipt };
  }

  private checkSnapshotAndArtifact(
    snapshot: RebuildSnapshotV1,
    builtManifestFingerprint: string | undefined,
    manifest: Parameters<typeof compactionSnapshotMatchesGeneration>[1],
    noteMetadata: Parameters<typeof compactionSnapshotMatchesGeneration>[2],
  ): PhaseStepOutcome | undefined {
    if (!compactionSnapshotMatchesGeneration(toDescriptor(snapshot), manifest, noteMetadata)) {
      return { type: "retry", failureCode: "GENERATION_ARTIFACT_MISMATCH" };
    }
    if (builtManifestFingerprint !== undefined && manifestArtifactFingerprint(manifest) !== builtManifestFingerprint) {
      return { type: "retry", failureCode: "GENERATION_ARTIFACT_MISMATCH" };
    }
    return undefined;
  }

  /**
   * The ENTIRE activation transaction -- reading the current pointer,
   * verifying base/target, comparing fingerprints, switching the pointer,
   * and the conditional overlay deletes -- runs under
   * `runWithIndexMutationLock`, the SAME shared per-(fs,root) mutation
   * lock every `IndexStore` instance uses for `upsertNote`/`deleteNote`/
   * `compact` (final-closure requirement 3). Without this, reading the
   * current pointer here and later switching it could interleave with a
   * concurrent `IndexStore` mutation -- e.g. a check/switch or
   * check/unlink race against an `upsertNote`/`compact` call running on a
   * different `IndexStore` instance over the same files.
   */
  private stepActivateGeneration(priorReceipt: RebuildReceipt | undefined): Promise<PhaseStepOutcome> {
    if (priorReceipt?.targetGenerationId === undefined || !priorReceipt.verified) {
      throw new EngineError("JOB_SHAPE_INVALID", "activate-generation reached without a verified generation in receipt.", {});
    }
    if (!priorReceipt.snapshot) {
      throw new EngineError("JOB_SHAPE_INVALID", "activate-generation reached without a build-time snapshot in receipt.", {});
    }
    const targetId = priorReceipt.targetGenerationId;
    const snapshot = priorReceipt.snapshot;
    const builtManifestFingerprint = priorReceipt.builtManifestFingerprint;

    return runWithIndexMutationLock(this.deps.fs, this.deps.root, async (): Promise<PhaseStepOutcome> => {
      let currentId: number | null;
      try {
        currentId = await loadCurrentGenerationId(this.deps.fs, this.deps.root);
      } catch (error) {
        return { type: "retry", failureCode: toFailureCode(error) };
      }

      if (currentId === targetId) {
        // Already activated -- this is a receipt-save or overlay-cleanup retry. The full
        // integrity+artifact recheck below is what makes falling through to the delete loop again
        // safe (final-closure requirement 4): idempotent cleanup is allowed ONLY after that passes.
      } else if (currentId !== snapshot.baseGenerationId) {
        // The pointer has moved on to something OTHER than the base this job planned against, and
        // it is not yet this job's own target either -- some OTHER rebuild/compaction committed a
        // newer generation first. Activating (or deleting this snapshot's overlays) now would risk
        // rolling the pointer backward or deleting overlays a NEWER generation still depends on.
        // Never do that: report this job as superseded (requirement 3).
        return { type: "superseded", failureCode: "REBUILD_SUPERSEDED" };
      } else if (currentId !== null && snapshot.baseFingerprint !== null) {
        // currentId === baseGenerationId: the expected, normal case -- but ALSO verify the base's
        // own artifacts still match what was recorded at planning time (final-closure requirement
        // 4). A same-id base whose actual content changed underneath is exactly as unsafe to
        // activate over as a genuinely different id would be.
        let baseMatches: boolean;
        try {
          const { manifest: baseManifest } = await verifyGenerationFully(this.deps.fs, this.deps.root, currentId);
          baseMatches = manifestArtifactFingerprint(baseManifest) === snapshot.baseFingerprint;
        } catch {
          baseMatches = false;
        }
        if (!baseMatches) {
          return { type: "superseded", failureCode: "REBUILD_SUPERSEDED" };
        }
      }

      // Repeat FULL integrity + snapshot/artifact match on the TARGET immediately before the
      // pointer switch -- catches corruption introduced between verify-generation and now.
      let manifest, noteMetadata;
      try {
        ({ manifest, noteMetadata } = await verifyGenerationFully(this.deps.fs, this.deps.root, targetId));
      } catch (error) {
        return { type: "retry", failureCode: toFailureCode(error) };
      }
      const mismatch = this.checkSnapshotAndArtifact(snapshot, builtManifestFingerprint, manifest, noteMetadata);
      if (mismatch) return mismatch;

      try {
        // Switches current.json, then deletes exactly the overlays `snapshot` was taken from --
        // each version+fingerprint-checked against what was recorded at build-generation time,
        // never a fresh recompute. Once the pointer switch itself has committed, a later
        // overlay-cleanup failure here is reported as a retry (safe: the pointer switch is a no-op
        // on retry, and re-deleting an already-deleted/already-mismatched overlay is a no-op) but
        // never rolls the switch back.
        await finalizeCompactionFromSnapshot(this.deps.fs, this.deps.root, targetId, snapshot.overlays);
      } catch (error) {
        return { type: "retry", failureCode: toFailureCode(error) };
      }
      const receipt: RebuildReceipt = { ...priorReceipt, activated: true };
      return { type: "complete", receipt };
    });
  }
}
