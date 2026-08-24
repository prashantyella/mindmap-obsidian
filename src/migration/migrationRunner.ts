import { createHash, randomUUID } from "node:crypto";

import { joinRelative } from "../engine/atomicStore";
import { EngineError, isEngineError } from "../engine/errors";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { BUDGET_DISK_BYTES, BUDGET_REBUILD_PEAK_MEMORY_BYTES, computeDiskBytes, computeRebuildPeakBytes } from "../index/budgets";
import {
  buildGeneration,
  discoverUnusedGenerationId,
  generationDirPath,
  GenerationBuildCancelledError,
  loadCurrentGenerationId,
  verifyGenerationFully,
  switchCurrentGeneration,
} from "../index/generationStore";
import type { NoteRowMetadataV1 } from "../index/generationMetadata";
import type { IndexFs } from "../index/indexFs";
import { MAX_MANIFEST_CHUNK_COUNT, MAX_MANIFEST_SHARD_ROW_COUNT } from "../index/indexManifest";
import { manifestArtifactFingerprint, runWithIndexMutationLock } from "../index/indexStore";
import type { VectorIndexManifestV1 } from "../index/vectorTypes";
import { toFailureCode } from "../jobs/jobTypes";
import type { ScopeDiscoveryItem, ScopeDiscoverySeam } from "../jobs/scopeJob";
import { isTerminalMigrationPhase, type MigrationMessageCode, type MigrationPhase, type MigrationStatusV1 } from "./migrationContract";
import type { MigrationIngestionDeps } from "./migrationIngest";
import { commitStagedNote, prepareIngestEntry } from "./migrationIngest";
import { buildMigrationRecordV1, toPublicMigrationStatus, type BuildMigrationRecordExtra, type MigrationRecordV1 } from "./migrationRecord";
import { buildGenerationInputNotes, clearStaging, listStagingRunIds, loadStagedNoteMeta, verifyStagedNoteArtifact, type StagedNoteMetaV1 } from "./migrationStaging";
import {
  buildMigrationPlanV1,
  clearMigrationPlan,
  computePlanFingerprint,
  listMigrationRunIds,
  MigrationPlanStore,
  sortPlanEntries,
  type MigrationBaseGenerationState,
  type MigrationPlanEntryV1,
  type MigrationPlanV1,
  type PlanFingerprintContext,
} from "./migrationPlan";
import type { MigrationStore } from "./migrationStore";

export interface MigrationRunnerDeps {
  store: MigrationStore;
  discovery: ScopeDiscoverySeam;
  /** Resolve-by-identity + Ollama-only embed -- see `migrationIngest.ts`. Never a `JobEngine`/`NoteWriter`/metadata seam. */
  ingestion: MigrationIngestionDeps;
  fs: IndexFs;
  dataRoot: string;
  embeddingModel: string;
  dimension?: number;
  pipelineVersion: number;
  clock?: () => number;
  /** Item 1: mints a fresh, opaque `runId` every time a NEW migration run begins. Defaults to `randomUUID()`; injectable for deterministic tests. */
  runIdFactory?: () => string;
  /** Whole-engine-disposal signal -- honored between phase boundaries AND (combined with this run's own cancellation controller) inside a single in-flight discovery/ingest/build call. */
  signal?: AbortSignal;
  /** Bounded batch of plan entries ingested per `reconcile()` tick while in `"build"` phase -- never the whole plan. Defaults to 1; a test driving a large corpus may raise this to keep runtime reasonable. */
  ingestBatchSize?: number;
}

const MIGRATION_SCOPE_ID = "migration:full-vault";
/** Review item 14: bounded per-call cap on how many abandoned run directories a single sweep touches -- keeps a sweep call itself O(1)-bounded rather than proportional to however many failed/cancelled runs have accumulated. Any remainder is picked up by the NEXT sweep (every fresh `start()`). */
const MAX_ABANDONED_RUNS_SWEPT_PER_CALL = 5;

function nowIso(clock: (() => number) | undefined): string {
  return new Date((clock ?? Date.now)()).toISOString();
}

/** Isolates a caller-supplied subscriber -- a throwing listener must never break the notify loop or affect any other subscriber (mirrors `mindmapEngine.ts`'s own `safelyNotify` pattern). */
function safelyNotify(listener: (status: MigrationStatusV1) => void, status: MigrationStatusV1): void {
  try {
    listener(status);
  } catch {
    // A throwing subscriber cannot leak past this boundary.
  }
}

function toPlanEntries(items: readonly ScopeDiscoveryItem[]): MigrationPlanEntryV1[] {
  return sortPlanEntries(items.map((item) => ({ identity: item.identity, sourceHash: item.sourceHash, embeddingModel: item.embeddingModel })));
}

function rawManifestPath(dataRoot: string, generationId: number): string {
  return joinRelative(dataRoot, `${generationDirPath(generationId)}/manifest.json`);
}

/** A conservative (never-under-counting) estimate of how `totalChunkCount` chunk rows would be binned into shards -- mirrors `generationStore.ts`'s own `planShards` greedy `MAX_MANIFEST_SHARD_ROW_COUNT`-per-shard binning closely enough for a byte-budget projection (review item 6): the same total row count split into AT LEAST this many shards, so `computeDiskBytes`'s per-shard framing overhead is never under-estimated. */
function estimateShardCounts(totalChunkCount: number): number[] {
  const shards: number[] = [];
  let remaining = totalChunkCount;
  while (remaining > 0) {
    const take = Math.min(remaining, MAX_MANIFEST_SHARD_ROW_COUNT);
    shards.push(take);
    remaining -= take;
  }
  return shards;
}

interface BaseGenerationSnapshot {
  state: MigrationBaseGenerationState;
  baseGenerationId?: number;
  baseGenerationFingerprint?: string;
  baseManifestRawFingerprint?: string;
}

/**
 * Review item 12: ONE reconcile/cancel/start "effect lane" per (in-process)
 * data root -- every `MigrationRunner` instance constructed over the SAME
 * `dataRoot` shares this queue, so two instances (e.g. a stale not-yet-
 * disposed one racing a freshly-constructed one) can never have
 * overlapping in-flight ingest/build/activate effects. Mirrors
 * `migrationStore.ts`'s own `sharedRootTails` pattern exactly. NEVER call
 * `withRootLock` from within a callback already running under it for the
 * SAME root (guaranteed deadlock, same hazard `runWithIndexMutationLock`'s
 * own doc comment describes) -- every INTERNAL recursive call between
 * `start()`/`reconcile()`/`cancel()`'s own phase handlers uses the
 * unlocked `*Locked`-suffixed inner methods, never the public locked
 * entry points.
 */
const migrationReconcileLocks = new Map<string, Promise<void>>();

function withRootLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = migrationReconcileLocks.get(root) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  migrationReconcileLocks.set(
    root,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Checkpoint 10A sub-milestone B (+ review-fix pass): the restart-safe,
 * SELF-CONTAINED coordinator for the 0.2.x -> TypeScript index migration.
 * Depends on NEITHER `JobEngine` NOR `JobStore` -- there is no per-note
 * `"process-note"` job, no `"migrate-index"` job, no `NoteWriter`, and no
 * metadata-inference call anywhere in this module. Every effect this class
 * can have is one of exactly three things:
 *
 * 1. Write/overwrite one note's artifacts under
 *    `migration/staging/<stagingRunId>/` (`migrationIngest.ts` ->
 *    `migrationStaging.ts`'s `writeStagedNote`) -- never an active overlay.
 * 2. Write the durable plan artifact under
 *    `migration/runs/<runId>/plan.json` (`migrationPlan.ts`).
 * 3. Build a brand-new index generation from the staged notes and, under
 *    the SAME shared `runWithIndexMutationLock` every ordinary
 *    `IndexStore`/rebuild mutation goes through, switch the current
 *    generation pointer to it EXACTLY ONCE.
 *
 * Ingestion proceeds ONE BOUNDED BATCH of plan entries per `reconcile()`
 * tick (`"build"` phase) -- there is no 10,000-entry id collection
 * anywhere; progress is a single persisted `cursorIndex` into the plan's
 * canonically sorted entries. A restart re-derives trust in that cursor
 * from actual staged artifact verification (`trustedCursorFor`), never
 * blindly trusting a persisted integer alone (review item 5).
 *
 * Full-vault discovery happens AT MOST once per phase transition, never
 * once per note: `"plan"` discovers once; `"build"` discovers ZERO times
 * during its ingestion loop (relying on each entry's own resolve+
 * sourceHash check, exactly like an ordinary `NoteJobRunner`'s own
 * `ensureFreshProjection`) and only re-discovers if a SPECIFIC entry's
 * ingestion itself reports drift; `"verify"`/`"activate"` each discover
 * once more as their own pre-build/pre-switch drift checks (review item
 * 3) -- a stable run therefore performs O(1) full discoveries total, never
 * O(noteCount).
 */
export class MigrationRunner {
  private readonly listeners = new Set<(status: MigrationStatusV1) => void>();
  private disposed = false;
  /** This run's own cancellation controller -- `cancel()` aborts it immediately (synchronously), interrupting any in-flight discovery/ingest/build call combined with it (`combinedSignal()`) without waiting for the current `reconcile()` tick to reach its next phase-boundary check. Reset to a fresh controller every time `start()` mints a brand-new run. */
  private cancelController: AbortController | null = null;
  /** Review item 5/3: per-runId high-water mark of how far this INSTANCE has itself established (by actually verifying staged artifacts) that `cursorIndex` can be trusted. Companion `trustedStagedChunkCount` holds the chunk-count total AT that same high-water mark -- the persisted `stagedChunkCount` aggregate is never trusted on its own; it is always reconstructed from verified metadata after a genuine restart, and spot-checked (the single most-recently-committed entry) on every tick even within one continuous instance run. */
  private readonly cursorTrustHighWaterMark = new Map<string, number>();
  private readonly trustedStagedChunkCount = new Map<string, number>();

  constructor(private readonly deps: MigrationRunnerDeps) {}

  /** Fanout subscription -- returns an unsubscribe function. A throwing listener never breaks another subscriber or this call. Safe to call after `dispose()` (silently returns a no-op unsubscribe). */
  subscribe(listener: (status: MigrationStatusV1) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Releases every subscriber. Idempotent. Does not touch persisted state -- a later `MigrationRunner` instance over the same `MigrationStore` picks up exactly where this one left off. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private notify(status: MigrationStatusV1): void {
    for (const listener of this.listeners) safelyNotify(listener, status);
  }

  private synthesizedNotStarted(): MigrationRecordV1 {
    return buildMigrationRecordV1("not-started", "NOT_STARTED", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, nowIso(this.deps.clock));
  }

  private async getRecord(): Promise<MigrationRecordV1> {
    const persisted = await this.deps.store.load();
    return persisted ?? this.synthesizedNotStarted();
  }

  /** Current persisted status, or a synthesized `"not-started"` status when nothing has ever been persisted for this data root (a fresh install). Never throws for the ordinary "nothing yet" case. Read-only -- does not go through the reconcile lock. */
  async getStatus(): Promise<MigrationStatusV1> {
    return toPublicMigrationStatus(await this.getRecord());
  }

  private combinedSignal(): { signal: AbortSignal; cleanup: () => void } {
    const runSignal = this.cancelController?.signal;
    const outer = this.deps.signal;
    if (!runSignal) return { signal: outer ?? new AbortController().signal, cleanup: () => undefined };
    if (!outer) return { signal: runSignal, cleanup: () => undefined };
    if (runSignal.aborted || outer.aborted) {
      const controller = new AbortController();
      controller.abort();
      return { signal: controller.signal, cleanup: () => undefined };
    }
    // Review item 11: listeners are added ONLY in this two-signal-combining branch (the common
    // case, deps.signal undefined, never reaches here) and are ALWAYS removed by the returned
    // cleanup -- every call site wraps its use in try/finally so a 10,000-entry run never
    // accumulates unbounded listeners on the long-lived underlying signals.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    runSignal.addEventListener("abort", onAbort, { once: true });
    outer.addEventListener("abort", onAbort, { once: true });
    return {
      signal: controller.signal,
      cleanup: () => {
        runSignal.removeEventListener("abort", onAbort);
        outer.removeEventListener("abort", onAbort);
      },
    };
  }

  private currentCounts(record: MigrationRecordV1): { discoveredCount: number; processedCount: number; failedCount: number } {
    return { discoveredCount: record.discoveredCount, processedCount: record.processedCount, failedCount: record.failedCount };
  }

  /** Item 1: carries THIS run's own runId/drift-snapshot/cursor fields forward into the NEXT persisted record unchanged, optionally overlaid with `patch`. */
  private carry(current: MigrationRecordV1, patch?: BuildMigrationRecordExtra): BuildMigrationRecordExtra {
    return {
      runId: current.runId,
      desiredEmbeddingModel: current.desiredEmbeddingModel,
      desiredDimension: current.desiredDimension,
      desiredPipelineVersion: current.desiredPipelineVersion,
      planFingerprint: current.planFingerprint,
      baseGenerationState: current.baseGenerationState,
      baseGenerationId: current.baseGenerationId,
      baseGenerationFingerprint: current.baseGenerationFingerprint,
      baseManifestRawFingerprint: current.baseManifestRawFingerprint,
      stagingRunId: current.stagingRunId,
      cursorIndex: current.cursorIndex,
      stagedChunkCount: current.stagedChunkCount,
      activationGenerationId: current.activationGenerationId,
      builtGenerationFingerprint: current.builtGenerationFingerprint,
      cancellationRequested: current.cancellationRequested,
      cleanupPending: current.cleanupPending,
      ...patch,
    };
  }

  /**
   * Review item 12: a compare-and-set write against `current.revision`. On
   * a conflict (another writer committed since `current` was read), this
   * NEVER throws and NEVER overwrites -- it simply returns whatever that
   * other writer actually committed, so the caller's own effect this tick
   * is safely abandoned in favor of already-advanced state.
   */
  private async persist(current: MigrationRecordV1, phase: MigrationPhase, messageCode: MigrationMessageCode, counts: { discoveredCount: number; processedCount: number; failedCount: number }, extra?: BuildMigrationRecordExtra): Promise<MigrationRecordV1> {
    try {
      const record = await this.deps.store.setPhase(phase, messageCode, counts, nowIso(this.deps.clock), extra, current.revision);
      this.notify(toPublicMigrationStatus(record));
      return record;
    } catch (error) {
      if (isEngineError(error) && error.code === "MIGRATION_REVISION_CONFLICT") {
        const fresh = await this.getRecord();
        this.notify(toPublicMigrationStatus(fresh));
        return fresh;
      }
      throw error;
    }
  }

  private async discoverItems(): Promise<ScopeDiscoveryItem[]> {
    const { signal, cleanup } = this.combinedSignal();
    try {
      return await this.deps.discovery.discover(MIGRATION_SCOPE_ID, signal);
    } finally {
      cleanup();
    }
  }

  /** Review item 5: the desired-config context every `computePlanFingerprint` call in this class hashes ALONGSIDE the entry set -- the SAME formula is used for the already-up-to-date check and every drift check, so "the note set matches" and "the config matches" can never be checked inconsistently against each other. Only ever called once `this.deps.dimension` is known to be defined (every phase past `"not-started"` requires it -- see `beginFreshRun`'s own guard). */
  private planContext(): PlanFingerprintContext {
    return { desiredEmbeddingModel: this.deps.embeddingModel, desiredDimension: this.deps.dimension as number, desiredPipelineVersion: this.deps.pipelineVersion };
  }

  /** Review item 1: FULL verification, and an EXACT canonical-fingerprint comparison between the current generation's own committed note set (from `verifyGenerationFully`'s `noteMetadata`, never the manifest's counts alone) and `freshEntries` -- a stale, missing, extra, or sourceHash-mismatched row is never silently accepted as "up to date". */
  private async currentGenerationFullyMatchesDesired(freshEntries: readonly MigrationPlanEntryV1[]): Promise<boolean> {
    const currentId = await loadCurrentGenerationId(this.deps.fs, this.deps.dataRoot).catch(() => null);
    if (currentId === null) return false;
    let manifest: VectorIndexManifestV1;
    let noteMetadata: NoteRowMetadataV1[];
    try {
      ({ manifest, noteMetadata } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, currentId));
    } catch {
      return false;
    }
    if (manifest.embeddingModel !== this.deps.embeddingModel) return false;
    if (this.deps.dimension !== undefined && manifest.dimension !== this.deps.dimension) return false;
    const rows: MigrationPlanEntryV1[] = noteMetadata.map((row) => ({ identity: row.identity, sourceHash: row.sourceHash, embeddingModel: row.embeddingModel }));
    const context = this.planContext();
    return computePlanFingerprint(context, sortPlanEntries(rows)) === computePlanFingerprint(context, sortPlanEntries(freshEntries));
  }

  /**
   * Review item 8: captures an explicit tri-state snapshot of whatever
   * generation is current right now -- see `MigrationBaseGenerationState`'s
   * own doc comment. Review item 4: an `"unverifiable"` base MUST carry a
   * raw fingerprint -- if the manifest bytes cannot even be READ (let
   * alone parsed), this THROWS rather than returning a fingerprint-less
   * "unverifiable" snapshot, which would leave every later drift check
   * with nothing to compare against but the id alone (exactly the
   * acceptance gap this item closes). The caller (`commitPlan`) surfaces
   * this as an ordinary retryable failure.
   */
  private async captureBaseGenerationSnapshot(): Promise<BaseGenerationSnapshot> {
    const currentId = await loadCurrentGenerationId(this.deps.fs, this.deps.dataRoot).catch(() => null);
    if (currentId === null) return { state: "none" };
    try {
      const { manifest } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, currentId);
      return { state: "verified", baseGenerationId: currentId, baseGenerationFingerprint: manifestArtifactFingerprint(manifest) };
    } catch {
      // fall through to a raw, unverified snapshot below.
    }
    try {
      const raw = await this.deps.fs.readFile(rawManifestPath(this.deps.dataRoot, currentId));
      const baseManifestRawFingerprint = createHash("sha256").update(raw, "utf8").digest("hex");
      return { state: "unverifiable", baseGenerationId: currentId, baseManifestRawFingerprint };
    } catch (error) {
      throw new EngineError("STORE_READ_FAILED", "Could not read the current generation's manifest to capture a base snapshot.", { cause: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Review item 8/4: re-checks a previously captured base snapshot against ground truth right now. `"unverifiable"` NEVER passes on id-match alone -- it ALWAYS requires the SAME raw manifest bytes (never a fingerprint-less pass, and never "both currently unreadable counts as unchanged"): a base that was corrupt at plan time and is STILL the exact same corrupt bytes now is treated as unchanged, but a base that changed to something ELSE (even something else also unverifiable, or one that has since become entirely unreadable) is correctly treated as drift. */
  private async baseGenerationStillMatches(snapshot: { baseGenerationState?: MigrationBaseGenerationState; baseGenerationId?: number; baseGenerationFingerprint?: string; baseManifestRawFingerprint?: string }): Promise<boolean> {
    const state = snapshot.baseGenerationState ?? "none";
    const currentId = await loadCurrentGenerationId(this.deps.fs, this.deps.dataRoot).catch(() => null);
    if (state === "none") return currentId === null;
    if (currentId !== (snapshot.baseGenerationId ?? null)) return false;
    if (state === "verified") {
      try {
        const { manifest } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, currentId!);
        return manifestArtifactFingerprint(manifest) === snapshot.baseGenerationFingerprint;
      } catch {
        return false;
      }
    }
    if (snapshot.baseManifestRawFingerprint === undefined) return false; // never "id match is sufficient"
    try {
      const raw = await this.deps.fs.readFile(rawManifestPath(this.deps.dataRoot, currentId!));
      const rawFingerprint = createHash("sha256").update(raw, "utf8").digest("hex");
      return rawFingerprint === snapshot.baseManifestRawFingerprint;
    } catch {
      return false; // can no longer even read it -- treated as changed, never "probably still fine"
    }
  }

  /**
   * Review item 14/1: best-effort, bounded, ownership-validated cleanup of
   * every OTHER run's leftover artifacts -- safe to call unconditionally
   * right before minting a fresh run, since `start()` only ever reaches
   * this when NO run is currently in flight (a completed run already
   * cleared its own directories; anything else left over is, by
   * construction, abandoned). Enumerates the UNION of runIds under
   * `migration/runs/` AND `migration/staging/` (review item 1) -- a run
   * whose plan.json was already removed by a partial prior cleanup but
   * whose staging directory survived must still be found and swept, never
   * left permanently orphaned just because it no longer has a plan to be
   * listed by. Never touches the run about to be created, never touches a
   * foreign (non-runId-shaped) entry, never touches
   * `generations/`/`current.json`/anything Chroma-shaped. Staging is
   * always cleared BEFORE the plan for each candidate (review item 1) --
   * a candidate whose staging cleanup fails is simply left for the NEXT
   * sweep, its plan untouched, rather than orphaning its own leftovers.
   */
  private async sweepAbandonedRuns(excludeRunId: string): Promise<void> {
    let runIds: string[];
    let stagingIds: string[];
    try {
      [runIds, stagingIds] = await Promise.all([listMigrationRunIds(this.deps.fs, this.deps.dataRoot), listStagingRunIds(this.deps.fs, this.deps.dataRoot)]);
    } catch {
      return;
    }
    const union = new Set([...runIds, ...stagingIds]);
    union.delete(excludeRunId);
    const candidates = [...union].slice(0, MAX_ABANDONED_RUNS_SWEPT_PER_CALL);
    for (const runId of candidates) {
      const stagingCleared = await clearStaging(this.deps.fs, this.deps.dataRoot, runId).catch(() => false);
      if (!stagingCleared) continue;
      await clearMigrationPlan(this.deps.fs, this.deps.dataRoot, runId).catch(() => false);
    }
  }

  private configMatches(current: MigrationRecordV1): boolean {
    return current.desiredEmbeddingModel === this.deps.embeddingModel && current.desiredDimension === this.deps.dimension && current.desiredPipelineVersion === this.deps.pipelineVersion;
  }

  /**
   * Starts a fresh migration run, or returns the current status unchanged
   * if one is already in flight (idempotent -- never restarts an
   * in-progress run).
   */
  async start(): Promise<MigrationStatusV1> {
    return withRootLock(this.deps.dataRoot, () => this.startLocked());
  }

  private async startLocked(): Promise<MigrationStatusV1> {
    const current = await this.getRecord();
    const canStart = current.phase === "not-started" || current.phase === "cancelled" || current.phase === "failed" || current.phase === "complete";
    if (!canStart) {
      return toPublicMigrationStatus(current); // already running -- reconcile() advances it, start() never restarts in-flight work
    }
    return this.beginFreshRun(current);
  }

  /**
   * Mints a brand-new run under this instance's CURRENT `deps` config and
   * begins reconciling it. Item 9: refuses (fails closed) if the
   * embedding model is blank or the dimension is not an explicit bounded
   * positive integer -- never guesses either. Item 2: this is also the ONE
   * path a mid-run config-drift detection (`reconcileLocked`) uses to
   * abandon an in-flight run and begin fresh -- unlike `startLocked()`,
   * it does NOT gate on `canStart`, since the caller has already decided
   * (via config mismatch) that the CURRENT in-flight run's own phase must
   * be abandoned regardless of what it is.
   */
  private async beginFreshRun(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    if (!this.deps.embeddingModel || this.deps.embeddingModel.trim().length === 0) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, { lastFailureCode: "MIGRATION_NOT_STARTABLE" }));
    }
    // Review item 9: an explicit, bounded, positive dimension is required BEFORE start -- for
    // every corpus size, not merely the empty-corpus case -- so migration never guesses one.
    if (this.deps.dimension === undefined || !Number.isInteger(this.deps.dimension) || this.deps.dimension < 1 || this.deps.dimension > MAX_EMBEDDING_DIMENSION) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, { lastFailureCode: "MIGRATION_NOT_STARTABLE" }));
    }
    // Review item 1: no shallow "already complete" shortcut here -- every fresh run proceeds
    // through the real discover -> plan pass, whose OWN full-verify + exact-fingerprint check
    // (`currentGenerationFullyMatchesDesired`) is the ONE place that decides ALREADY_UP_TO_DATE.
    const runId = (this.deps.runIdFactory ?? randomUUID)();
    await this.sweepAbandonedRuns(runId);
    this.cancelController = new AbortController();
    const started = await this.persist(current, "discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, {
      runId,
      stagingRunId: runId,
      desiredEmbeddingModel: this.deps.embeddingModel,
      desiredDimension: this.deps.dimension,
      desiredPipelineVersion: this.deps.pipelineVersion,
      cursorIndex: 0,
      stagedChunkCount: 0,
      cancellationRequested: false,
      cleanupPending: false,
    });
    if (started.runId !== runId) return toPublicMigrationStatus(started); // lost a concurrent-start race -- yield to whichever run actually landed
    return this.reconcileLocked();
  }

  /** Alias for `start()` -- valid only when `canRetry` (phase `"failed"`). */
  retry(): Promise<MigrationStatusV1> {
    return this.start();
  }

  /**
   * Requests cancellation. Item 4/7: persists `cancellationRequested: true`
   * FIRST, then aborts this run's own cancellation controller so any
   * in-flight discovery/ingest/build call stops promptly. Once
   * `"activate"` (the locked pointer-switch phase) has begun, cancellation
   * is no longer honored.
   */
  async cancel(): Promise<MigrationStatusV1> {
    return withRootLock(this.deps.dataRoot, () => this.cancelLocked());
  }

  private async cancelLocked(): Promise<MigrationStatusV1> {
    const current = await this.getRecord();
    if (isTerminalMigrationPhase(current.phase) || current.phase === "activate") return toPublicMigrationStatus(current);
    let withIntent = current;
    if (!current.cancellationRequested) {
      withIntent = await this.persist(current, current.phase, current.messageCode, this.currentCounts(current), this.carry(current, { cancellationRequested: true }));
    }
    this.cancelController?.abort();
    if (withIntent.phase !== current.phase && withIntent.phase !== "cancelled") return toPublicMigrationStatus(withIntent); // a concurrent writer already moved this on
    return this.reconcileLocked();
  }

  /**
   * Review item 2: builds the plan from an ALREADY-discovered item set
   * (never re-discovers) -- the ONE path both the ordinary `"plan"` phase
   * and a mid-run drift-triggered replan funnel through, so a replan never
   * costs a second discovery pass beyond the one that detected the drift.
   */
  private async commitPlan(current: MigrationRecordV1, items: readonly ScopeDiscoveryItem[]): Promise<MigrationStatusV1> {
    const entries = toPlanEntries(items);
    if (await this.currentGenerationFullyMatchesDesired(entries)) {
      return toPublicMigrationStatus(await this.persist(current, "complete", "ALREADY_UP_TO_DATE", { discoveredCount: entries.length, processedCount: entries.length, failedCount: 0 }, this.carry(current, { activationGenerationId: undefined, builtGenerationFingerprint: undefined, cleanupPending: false })));
    }
    const runId = current.runId;
    if (!runId || current.desiredDimension === undefined) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: entries.length, processedCount: 0, failedCount: 0 }, this.carry(current, { lastFailureCode: "MIGRATION_STATE_CORRUPT" })));
    }
    let baseSnapshot: BaseGenerationSnapshot;
    try {
      baseSnapshot = await this.captureBaseGenerationSnapshot();
    } catch (error) {
      // Review item 4: an unverifiable base that could not even be raw-fingerprinted fails closed
      // here -- retryable, never silently planned/activated over.
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: entries.length, processedCount: 0, failedCount: 0 }, this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    const plan = buildMigrationPlanV1({
      runId,
      desiredEmbeddingModel: this.deps.embeddingModel,
      desiredDimension: current.desiredDimension,
      desiredPipelineVersion: this.deps.pipelineVersion,
      baseGenerationState: baseSnapshot.state,
      baseGenerationId: baseSnapshot.baseGenerationId,
      baseGenerationFingerprint: baseSnapshot.baseGenerationFingerprint,
      baseManifestRawFingerprint: baseSnapshot.baseManifestRawFingerprint,
      entries,
    });
    try {
      await new MigrationPlanStore(this.deps.fs, this.deps.dataRoot, runId).save(plan);
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: entries.length, processedCount: 0, failedCount: 0 }, this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    this.cursorTrustHighWaterMark.set(runId, 0);
    this.trustedStagedChunkCount.set(runId, 0);
    return toPublicMigrationStatus(
      await this.persist(current, "build", "BUILDING_INDEX", { discoveredCount: entries.length, processedCount: 0, failedCount: 0 }, this.carry(current, {
        planFingerprint: plan.planFingerprint,
        baseGenerationState: baseSnapshot.state,
        baseGenerationId: baseSnapshot.baseGenerationId,
        baseGenerationFingerprint: baseSnapshot.baseGenerationFingerprint,
        baseManifestRawFingerprint: baseSnapshot.baseManifestRawFingerprint,
        stagingRunId: runId,
        cursorIndex: 0,
        stagedChunkCount: 0,
        activationGenerationId: undefined,
        builtGenerationFingerprint: undefined,
      })),
    );
  }

  private async replanFromDrift(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    let items: ScopeDiscoveryItem[];
    try {
      items = await this.discoverItems();
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    return this.commitPlan(current, items);
  }

  /**
   * Advances the state machine by reconciling against CURRENT persisted
   * state and, where relevant, freshly re-discovered/re-verified
   * ground-truth -- never against any cached in-memory assumption. Safe to
   * call any number of times, including immediately after a crash.
   */
  async reconcile(): Promise<MigrationStatusV1> {
    return withRootLock(this.deps.dataRoot, () => this.reconcileLocked());
  }

  private async reconcileLocked(): Promise<MigrationStatusV1> {
    const current = await this.getRecord();
    if (isTerminalMigrationPhase(current.phase)) {
      // Review item 6: a terminal "complete" record whose best-effort cleanup did not yet finish
      // is still resumable -- retried here, NEVER by re-entering activation.
      if (current.phase === "complete" && current.cleanupPending) {
        return this.retryCleanup(current);
      }
      return toPublicMigrationStatus(current);
    }
    // Item 4/7: a cancellation already durably requested settles immediately, before any further
    // effect -- except once "activate" has begun, which is irreversible.
    if (current.cancellationRequested && current.phase !== "activate") {
      return toPublicMigrationStatus(await this.persist(current, "cancelled", "CANCELLED", this.currentCounts(current), this.carry(current)));
    }
    // Review item 2: a mid-run config change (embedding model/dimension/pipeline) is detected here,
    // at every reconcile boundary -- the in-flight run is abandoned (its artifacts left for the
    // NEXT start()'s sweep) and a fresh run begins under the CURRENT config. Never finishes the old
    // run, never fails it as an ordinary embedding mismatch.
    if (current.phase !== "not-started" && !this.configMatches(current)) {
      return this.beginFreshRun(current);
    }

    switch (current.phase) {
      case "discover":
        return this.reconcileDiscover(current);
      case "plan":
        return this.reconcilePlan(current);
      case "build":
        return this.reconcileBuild(current);
      case "verify":
        return this.reconcileVerify(current);
      case "activate":
        return this.reconcileActivate(current);
      default:
        return toPublicMigrationStatus(current);
    }
  }

  /**
   * Review item 1: cleanup is only ever reported (and `cleanupPending`
   * only ever cleared) once BOTH staging and the plan artifact are
   * CONFIRMED absent -- `clearStaging`/`clearMigrationPlan` now report
   * truthfully rather than swallowing a partial failure. Staging is
   * always attempted, and confirmed, BEFORE the plan: a failed partial
   * staging cleanup must never let the plan be deleted first, which would
   * orphan the remaining staging files with nothing left to identify or
   * re-discover them by (the UNION-based sweep in `sweepAbandonedRuns`
   * covers that residual case regardless, but this ordering avoids ever
   * relying on it for an ordinary same-run cleanup). If either step is
   * not yet complete, `cleanupPending` stays `true` and this run's record
   * is left otherwise unchanged -- the NEXT `reconcileLocked()` call
   * (terminal-phase handling) retries.
   */
  private async retryCleanup(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    const runId = current.stagingRunId ?? current.runId;
    if (!runId) return toPublicMigrationStatus(current);
    const stagingCleared = await clearStaging(this.deps.fs, this.deps.dataRoot, runId).catch(() => false);
    if (!stagingCleared) return toPublicMigrationStatus(current);
    const planCleared = await clearMigrationPlan(this.deps.fs, this.deps.dataRoot, runId).catch(() => false);
    if (!planCleared) return toPublicMigrationStatus(current);
    return toPublicMigrationStatus(await this.persist(current, "complete", current.messageCode, this.currentCounts(current), this.carry(current, { cleanupPending: false })));
  }

  /** A cheap pass-through -- all real discovery happens in `"plan"`. */
  private async reconcileDiscover(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    const next = await this.persist(current, "plan", "PLANNING", this.currentCounts(current), this.carry(current));
    if (next.phase !== "plan") return toPublicMigrationStatus(next);
    return this.reconcileLocked();
  }

  private async reconcilePlan(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    let items: ScopeDiscoveryItem[];
    try {
      items = await this.discoverItems();
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    return this.commitPlan(current, items);
  }

  private async loadPlanOrFail(current: MigrationRecordV1): Promise<{ ok: true; plan: MigrationPlanV1 } | { ok: false; outcome: MigrationStatusV1 }> {
    const runId = current.stagingRunId ?? current.runId;
    if (!runId) return { ok: false, outcome: toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "MIGRATION_STATE_CORRUPT" }))) };
    let plan: MigrationPlanV1 | null;
    try {
      plan = await new MigrationPlanStore(this.deps.fs, this.deps.dataRoot, runId).load();
    } catch (error) {
      return { ok: false, outcome: toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) }))) };
    }
    if (!plan) return { ok: false, outcome: toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "MIGRATION_PLAN_CORRUPT" }))) };
    return { ok: true, plan };
  }

  /** Review item 3/5: proves plan entry `plan.entries[index]` is fully, validly staged -- metadata matches the entry EXACTLY (sourceHash/model/dimension) AND both binaries fully decode/checksum-verify (`verifyStagedNoteArtifact`, never JSON-only). Returns the verified metadata, or `null` for ANY failure. */
  private async verifyPlanEntryStaged(plan: MigrationPlanV1, index: number): Promise<StagedNoteMetaV1 | null> {
    const entry = plan.entries[index];
    const meta = await loadStagedNoteMeta(this.deps.fs, this.deps.dataRoot, plan.runId, entry.identity);
    if (!meta || meta.sourceHash !== entry.sourceHash || meta.embeddingModel !== entry.embeddingModel || meta.dimension !== plan.desiredDimension) return null;
    return (await verifyStagedNoteArtifact(this.deps.fs, this.deps.dataRoot, plan.runId, meta)) ? meta : null;
  }

  /**
   * Review item 3: establishes how far `plan.entries[0, cursor)` can
   * ACTUALLY be trusted as fully, validly staged -- never blindly the
   * persisted `cursorIndex`, and never a persisted `stagedChunkCount`
   * trusted without independent verification either.
   *
   * Two paths:
   * - The FAST path (persisted cursor unchanged since this instance last
   *   trusted it): spot-checks the SINGLE most-recently-committed entry
   *   EVERY tick (bounded O(1) cost) -- corruption introduced after this
   *   instance already trusted a prefix must not go undetected forever
   *   just because the cursor itself hasn't advanced since.
   * - The FULL rescan path (a genuine restart -- this instance has never
   *   trusted anything yet -- OR the spot-check above just failed):
   *   re-verifies EVERY entry from 0 up to the persisted cursor and
   *   reconstructs `stagedChunkCount` from scratch by summing the
   *   verified metadata's own `chunkCount` -- the persisted aggregate is
   *   NEVER trusted on its own in this path, exactly the "tampered but
   *   bounded persisted aggregate" gap this item closes. Cost is O(cursor)
   *   once per restart/corruption event, never once per tick.
   */
  private async trustedCursorFor(plan: MigrationPlanV1, persistedCursor: number): Promise<{ cursor: number; stagedChunkCount: number }> {
    const trustedCursor = this.cursorTrustHighWaterMark.get(plan.runId) ?? 0;
    const trustedChunks = this.trustedStagedChunkCount.get(plan.runId) ?? 0;

    if (persistedCursor === trustedCursor) {
      if (persistedCursor === 0) return { cursor: 0, stagedChunkCount: 0 };
      const stillValid = await this.verifyPlanEntryStaged(plan, persistedCursor - 1);
      if (stillValid) return { cursor: persistedCursor, stagedChunkCount: trustedChunks };
      // The spot-checked entry no longer verifies -- fall through to a full rescan; nothing in the
      // previously "trusted" prefix is assumed correct any further.
    }

    let verifiedUpTo = 0;
    let stagedChunkCount = 0;
    for (let i = 0; i < persistedCursor; i += 1) {
      const meta = await this.verifyPlanEntryStaged(plan, i);
      if (!meta) break;
      stagedChunkCount += meta.chunkCount;
      verifiedUpTo = i + 1;
    }
    this.cursorTrustHighWaterMark.set(plan.runId, verifiedUpTo);
    this.trustedStagedChunkCount.set(plan.runId, stagedChunkCount);
    return { cursor: verifiedUpTo, stagedChunkCount };
  }

  /** Review item 6: rejects (before advancing past the entry that would cross it) a PROJECTED disk or rebuild-peak-memory usage beyond the approved shared budgets -- note/chunk COUNT bounds alone are dimension-independent and can massively understate real bytes at a high configured dimension. Uses the shared `budgets.ts` helpers, the SAME ones `indexStore.ts`'s own overlay-write budget check uses, with a conservative (never-under-counting) shard-split estimate. */
  private projectedBudgetExceeded(dimension: number, noteCount: number, totalChunkCount: number): boolean {
    const shardCounts = estimateShardCounts(totalChunkCount);
    const diskBytes = computeDiskBytes(dimension, noteCount, shardCounts);
    if (diskBytes > BUDGET_DISK_BYTES) return true;
    const largestShardCount = shardCounts.reduce((max, count) => Math.max(max, count), 0);
    const rebuildPeakBytes = computeRebuildPeakBytes({ dimension, noteCount, largestShardCount });
    return rebuildPeakBytes > BUDGET_REBUILD_PEAK_MEMORY_BYTES;
  }

  private async reconcileBuild(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    const planResult = await this.loadPlanOrFail(current);
    if (!planResult.ok) return planResult.outcome;
    const plan = planResult.plan;

    // Review item 2: preflight the MINIMUM possible footprint (every planned note, zero chunks --
    // just the note-vector matrix itself) BEFORE any ingestion is ever attempted. A plan that is
    // already impossible at this floor fails closed immediately, with ZERO staged files ever
    // written for it -- never discovered only after some entries are already on disk.
    if (this.projectedBudgetExceeded(plan.desiredDimension, plan.entries.length, 0)) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "JOB_CAP_EXCEEDED" })));
    }

    const persistedCursor = current.cursorIndex ?? 0;
    const trust = await this.trustedCursorFor(plan, persistedCursor);
    let cursor = trust.cursor;
    let stagedChunkCount = trust.stagedChunkCount;
    let processedCount = current.processedCount;

    if (cursor < persistedCursor) {
      // The cursor-trust re-check found the persisted cursor ahead of what is actually staged --
      // correct processedCount/cursorIndex/stagedChunkCount durably BEFORE doing anything else.
      processedCount = Math.min(processedCount, cursor);
      current = await this.persist(current, "build", "BUILDING_INDEX", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount }, this.carry(current, { cursorIndex: cursor, stagedChunkCount }));
      if (current.phase !== "build") return toPublicMigrationStatus(current); // a concurrent writer already moved this on
    }

    const { signal, cleanup } = this.combinedSignal();
    try {
      const batchSize = Math.max(1, this.deps.ingestBatchSize ?? 1);
      let batchCount = 0;
      let failureCode: string | undefined;
      let capExceeded = false;
      let budgetExceeded = false;

      while (cursor < plan.entries.length && batchCount < batchSize) {
        if (signal.aborted) break;
        const entry = plan.entries[cursor];
        const existing = await loadStagedNoteMeta(this.deps.fs, this.deps.dataRoot, plan.runId, entry.identity);
        const metaMatches = existing !== null && existing.sourceHash === entry.sourceHash && existing.embeddingModel === entry.embeddingModel && existing.dimension === plan.desiredDimension;
        const alreadyValid = metaMatches && (await verifyStagedNoteArtifact(this.deps.fs, this.deps.dataRoot, plan.runId, existing));

        // Review item 2: for a NOT-already-staged entry, PREPARE (resolve/project/embed/validate)
        // first -- this writes NOTHING to disk. The real chunk count is known only once it
        // returns; the budget is checked with that real count BEFORE `commitStagedNote` ever
        // touches disk, so an entry that would cross the budget is never written in the first
        // place. For an already-validly-staged entry, the same check runs against its own already-
        // known (and independently re-verified) chunk count -- nothing is written either way.
        let chunkCount: number;
        let prepared: Awaited<ReturnType<typeof prepareIngestEntry>> | undefined;
        if (alreadyValid) {
          chunkCount = existing.chunkCount;
        } else {
          prepared = await prepareIngestEntry(this.deps.ingestion, entry, plan.desiredDimension, signal);
          if (prepared.type === "drift") {
            this.cursorTrustHighWaterMark.set(plan.runId, cursor);
            this.trustedStagedChunkCount.set(plan.runId, stagedChunkCount);
            return this.replanFromDrift(current);
          }
          if (prepared.type === "failed") {
            failureCode = prepared.failureCode;
            break;
          }
          chunkCount = prepared.embedded.chunkVectors.length;
        }

        if (stagedChunkCount + chunkCount > MAX_MANIFEST_CHUNK_COUNT) {
          capExceeded = true;
          break;
        }
        if (this.projectedBudgetExceeded(plan.desiredDimension, processedCount + 1, stagedChunkCount + chunkCount)) {
          budgetExceeded = true;
          break;
        }

        if (prepared && prepared.type === "prepared") {
          const committed = await commitStagedNote(this.deps.fs, this.deps.dataRoot, plan.runId, entry, prepared.embedded);
          if (committed.type === "failed") {
            failureCode = committed.failureCode;
            break;
          }
        }
        stagedChunkCount += chunkCount;
        processedCount += 1;
        cursor += 1;
        batchCount += 1;
        this.cursorTrustHighWaterMark.set(plan.runId, cursor);
        this.trustedStagedChunkCount.set(plan.runId, stagedChunkCount);
      }

      if (signal.aborted) {
        return toPublicMigrationStatus(await this.persist(current, "cancelled", "CANCELLED", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount }, this.carry(current, { cursorIndex: cursor, stagedChunkCount })));
      }
      if (capExceeded || budgetExceeded) {
        return toPublicMigrationStatus(
          await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount }, this.carry(current, { cursorIndex: cursor, stagedChunkCount, lastFailureCode: "JOB_CAP_EXCEEDED" })),
        );
      }
      if (failureCode !== undefined) {
        return toPublicMigrationStatus(
          await this.persist(current, "failed", "FAILED_RETRYABLE", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount + 1 }, this.carry(current, { cursorIndex: cursor, stagedChunkCount, lastFailureCode: failureCode })),
        );
      }
      if (cursor < plan.entries.length) {
        return toPublicMigrationStatus(await this.persist(current, "build", "BUILDING_INDEX", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount }, this.carry(current, { cursorIndex: cursor, stagedChunkCount })));
      }
      return toPublicMigrationStatus(await this.persist(current, "verify", "VERIFYING_GENERATION", { discoveredCount: plan.entries.length, processedCount, failedCount: current.failedCount }, this.carry(current, { cursorIndex: cursor, stagedChunkCount })));
    } finally {
      cleanup();
    }
  }

  private async reconcileVerify(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    const planResult = await this.loadPlanOrFail(current);
    if (!planResult.ok) return planResult.outcome;
    const plan = planResult.plan;
    const runId = plan.runId;

    let freshItems: ScopeDiscoveryItem[];
    try {
      freshItems = await this.discoverItems();
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    const freshFingerprint = computePlanFingerprint(this.planContext(), toPlanEntries(freshItems));
    if (freshFingerprint !== plan.planFingerprint) return this.commitPlan(current, freshItems);
    if (!(await this.baseGenerationStillMatches(plan))) return this.commitPlan(current, freshItems);

    // A prior crash may have already built (but not yet activated) a target generation for this
    // exact run -- adopt it if it still verifies and matches, rather than building a second one.
    if (current.activationGenerationId !== undefined && current.builtGenerationFingerprint !== undefined) {
      try {
        const { manifest } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, current.activationGenerationId);
        if (manifestArtifactFingerprint(manifest) === current.builtGenerationFingerprint) {
          return toPublicMigrationStatus(await this.persist(current, "activate", "ACTIVATING_GENERATION", this.currentCounts(current), this.carry(current)));
        }
      } catch {
        // fall through -- rebuild under a fresh id below.
      }
    }

    // Review item 3/4: FULLY re-verifies EVERY plan entry's staged artifact again here (not merely
    // its metadata) immediately before building the generation from it -- `verifyPlanEntryStaged`
    // checks both the exact metadata match AND full binary decode/checksum. Any failure (missing,
    // corrupt, or metadata-mismatched) routes back to "build" with the cursor/trust reset so it is
    // rebuilt/re-ingested, never silently skipped and never a terminal failure for a replaceable
    // corruption.
    const validMetas: StagedNoteMetaV1[] = [];
    let allValid = true;
    for (let i = 0; i < plan.entries.length; i += 1) {
      const meta = await this.verifyPlanEntryStaged(plan, i);
      if (!meta) {
        allValid = false;
        break;
      }
      validMetas.push(meta);
    }
    if (!allValid) {
      this.cursorTrustHighWaterMark.set(plan.runId, 0);
      this.trustedStagedChunkCount.set(plan.runId, 0);
      return toPublicMigrationStatus(await this.persist(current, "build", "BUILDING_INDEX", { discoveredCount: plan.entries.length, processedCount: validMetas.length, failedCount: current.failedCount }, this.carry(current, { cursorIndex: 0, stagedChunkCount: 0 })));
    }

    const totalChunks = validMetas.reduce((sum, meta) => sum + meta.chunkCount, 0);
    if (totalChunks > MAX_MANIFEST_CHUNK_COUNT || this.projectedBudgetExceeded(plan.desiredDimension, validMetas.length, totalChunks)) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "JOB_CAP_EXCEEDED" })));
    }

    let targetId: number;
    try {
      targetId = await discoverUnusedGenerationId(this.deps.fs, this.deps.dataRoot);
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    const notes = await buildGenerationInputNotes(this.deps.fs, this.deps.dataRoot, runId, validMetas);
    const { signal, cleanup } = this.combinedSignal();
    try {
      await buildGeneration(this.deps.fs, this.deps.dataRoot, { generationId: targetId, embeddingModel: plan.desiredEmbeddingModel, dimension: plan.desiredDimension, notes }, { signal });
    } catch (error) {
      if (error instanceof GenerationBuildCancelledError) {
        return toPublicMigrationStatus(await this.persist(current, "cancelled", "CANCELLED", this.currentCounts(current), this.carry(current)));
      }
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) })));
    } finally {
      cleanup();
    }
    let builtManifest: VectorIndexManifestV1;
    try {
      ({ manifest: builtManifest } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, targetId));
    } catch (error) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: toFailureCode(error) })));
    }
    const fingerprint = manifestArtifactFingerprint(builtManifest);
    return toPublicMigrationStatus(
      await this.persist(current, "activate", "ACTIVATING_GENERATION", this.currentCounts(current), this.carry(current, { activationGenerationId: targetId, builtGenerationFingerprint: fingerprint })),
    );
  }

  /**
   * The ENTIRE activation transaction runs under `runWithIndexMutationLock`.
   * Review item 7: the target generation's fingerprint is ALWAYS compared
   * against `builtFingerprint` -- including the idempotent
   * `currentId === targetId` retry path, which previously skipped this
   * check entirely (a different-but-valid generation happening to reuse
   * the same id could otherwise have been silently accepted).
   */
  private async reconcileActivate(current: MigrationRecordV1): Promise<MigrationStatusV1> {
    if (current.activationGenerationId === undefined || current.builtGenerationFingerprint === undefined) {
      return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "MIGRATION_STATE_CORRUPT" })));
    }
    const targetId = current.activationGenerationId;
    const builtFingerprint = current.builtGenerationFingerprint;
    const runId = current.stagingRunId ?? current.runId;
    if (!runId) return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: "MIGRATION_STATE_CORRUPT" })));

    type ActivationOutcome = { kind: "switched" } | { kind: "switched-unverified" } | { kind: "replan"; items: ScopeDiscoveryItem[] } | { kind: "failed"; code: string };

    const outcome = await runWithIndexMutationLock(this.deps.fs, this.deps.dataRoot, async (): Promise<ActivationOutcome> => {
      const planResult = await new MigrationPlanStore(this.deps.fs, this.deps.dataRoot, runId).load();
      if (!planResult) return { kind: "failed", code: "MIGRATION_PLAN_CORRUPT" };

      let currentId: number | null;
      try {
        currentId = await loadCurrentGenerationId(this.deps.fs, this.deps.dataRoot);
      } catch (error) {
        return { kind: "failed", code: toFailureCode(error) };
      }

      if (currentId !== targetId) {
        // Not yet switched (or a stale run whose own earlier switch attempt never landed) -- the
        // FULL drift check runs HERE, immediately before the switch itself (review item 4). On the
        // idempotent already-switched retry path below (currentId === targetId), re-running this
        // same check would incorrectly flag OUR OWN prior switch as "the base changed" -- it must
        // only ever run when a switch is actually about to happen.
        let freshItems: ScopeDiscoveryItem[];
        try {
          freshItems = await this.discoverItems();
        } catch (error) {
          return { kind: "failed", code: toFailureCode(error) };
        }
        const freshFingerprint = computePlanFingerprint(this.planContext(), toPlanEntries(freshItems));
        if (freshFingerprint !== planResult.planFingerprint) return { kind: "replan", items: freshItems };
        if (!(await this.baseGenerationStillMatches(planResult))) return { kind: "replan", items: freshItems };
        if (currentId !== (planResult.baseGenerationId ?? null)) {
          return { kind: "replan", items: freshItems };
        }
        try {
          await switchCurrentGeneration(this.deps.fs, this.deps.dataRoot, targetId);
        } catch (error) {
          return { kind: "failed", code: toFailureCode(error) };
        }
      }

      // Review item 7: ALWAYS re-verify + compare the fingerprint, even on the idempotent
      // already-switched retry path -- never trust "same id" alone.
      let manifest: VectorIndexManifestV1;
      try {
        ({ manifest } = await verifyGenerationFully(this.deps.fs, this.deps.dataRoot, targetId));
      } catch {
        return { kind: "switched-unverified" };
      }
      if (manifestArtifactFingerprint(manifest) !== builtFingerprint) {
        return { kind: "failed", code: "GENERATION_ARTIFACT_MISMATCH" };
      }
      return { kind: "switched" };
    });

    if (outcome.kind === "replan") return this.commitPlan(current, outcome.items);
    if (outcome.kind === "failed") return toPublicMigrationStatus(await this.persist(current, "failed", "FAILED_RETRYABLE", this.currentCounts(current), this.carry(current, { lastFailureCode: outcome.code })));
    if (outcome.kind === "switched-unverified") {
      return toPublicMigrationStatus(await this.persist(current, "activate", "ACTIVATING_GENERATION", this.currentCounts(current), this.carry(current)));
    }

    // Review item 6: persist "complete" DURABLY FIRST (with cleanupPending: true), THEN attempt
    // best-effort cleanup, THEN persist cleanupPending: false -- a crash/store-save failure at any
    // point between the switch and full cleanup leaves a genuinely terminal "complete" record that
    // `reconcileLocked()`'s own terminal-phase handling will retry cleanup for, NEVER a stuck
    // "activate" record that would fail MIGRATION_PLAN_CORRUPT on the next reconcile.
    const completed = await this.persist(current, "complete", "COMPLETE", this.currentCounts(current), this.carry(current, { cleanupPending: true }));
    if (completed.phase !== "complete") return toPublicMigrationStatus(completed);
    return this.retryCleanup(completed);
  }
}
