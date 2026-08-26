import { AtomicStore, type AtomicStoreFs } from "../engine/atomicStore";
import { EngineError } from "../engine/errors";
import {
  assertLegalPhaseTransition,
  assertScheduledOccurrenceId,
  assertValidSuccessorShape,
  isTerminalJobStatus,
  MAX_PERSISTED_JOBS,
  MAX_SCHEDULED_OCCURRENCES,
  MAX_STORE_SERIALIZED_BYTES,
  parseJobStoreDocumentV1,
  type JobStoreDocumentV1,
  type BulkBatchV1,
  type PersistedJobV1,
  type ProviderPauseV1,
  type ScheduledOccurrenceRecordV1,
} from "./jobTypes";

const JOB_STORE_FILE_NAME = "jobs/queue.json";
const JOB_STORE_SCHEMA_VERSION = 1;

/** Plain-JSON-only deep clone -- every document this store ever holds is already JSON-safe (it round-trips through `parseJobStoreDocumentV1`), so this is exact, never approximate. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively `Object.freeze`s an already-JSON-safe value in place and returns it, so no caller holding a reference into `this.cached` can ever mutate committed/cached state. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The one durable layout for the whole job queue: a single JSON document
 * (`jobs/queue.json`, through the existing `AtomicStore` primitive) holding
 * an ordered array of `PersistedJobV1` plus the provider-wide pause flag.
 * A single-document layout (rather than one file per job) is deliberate --
 * queue ORDER is the array order itself, so recovering "what's next" never
 * requires listing/sorting a directory of per-job files, and a single
 * atomic rename commits every mutation (append, phase advance, status
 * change, provider pause) as one indivisible unit. `AtomicStore` already
 * gives this bounded reads/writes, strict validation, temp cleanup, and
 * atomic replacement; this module adds only the queue-shaped operations
 * (append/update/prune/recover) on top, all serialized through one
 * in-process mutation tail so concurrent callers can never race a
 * read-modify-write.
 *
 * `this.cached` is always a deeply-frozen, JSON-clean document: every
 * mutation builds its result via a fresh `JSON.parse(JSON.stringify(...))`
 * round-trip through `parseJobStoreDocumentV1` before freezing and caching
 * it, and every `updater`/mutation callback operates on a deep-cloned
 * MUTABLE working copy, never on `this.cached` itself. This is what makes
 * "a reader mutates a returned job" and "an updater mutates its `current`
 * argument then throws" both incapable of corrupting committed/cached
 * state -- see `jobStore.test.ts`'s store-ownership tests.
 */
export class JobStore {
  private readonly store: AtomicStore<JobStoreDocumentV1>;
  private cached: JobStoreDocumentV1 | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(fs: AtomicStoreFs, root: string) {
    this.store = new AtomicStore<JobStoreDocumentV1>({
      fs,
      root,
      fileName: JOB_STORE_FILE_NAME,
      schemaVersion: JOB_STORE_SCHEMA_VERSION,
      parse: parseJobStoreDocumentV1,
      maxBytes: MAX_STORE_SERIALIZED_BYTES,
    });
  }

  /** Best-effort cleanup of a prior interrupted `save()`'s leftover temp file. Safe to call any number of times. */
  cleanupStaleTempFiles(): Promise<number> {
    return this.store.cleanupStaleTempFiles();
  }

  /** Read-only: counts leftover temp files without removing them -- for preflight, which must never mutate (Checkpoint 9 requirement 2). */
  countStaleTempFiles(): Promise<number> {
    return this.store.countStaleTempFiles();
  }

  private async loadOrInit(): Promise<JobStoreDocumentV1> {
    if (this.cached) return this.cached;
    const loaded = await this.store.load();
    const doc = loaded ?? { schemaVersion: 1 as const, jobs: [], providerPause: { active: false }, scheduledOccurrences: [], bulkBatches: [] };
    this.cached = deepFreeze(doc);
    return this.cached;
  }

  /**
   * Every mutation goes through this single in-process tail: the next
   * mutation always waits for the previous one to fully settle (its
   * `save()` either completed or threw) before its own callback even
   * starts, so two concurrent callers can never read the same base
   * document and independently write conflicting updates -- the exact
   * lost-update race requirement 2 rules out. A thrown validation/write
   * error propagates to that specific caller only and leaves `cached`
   * (and the committed file) exactly as they were before this mutation.
   *
   * `fn` receives the current FROZEN cached document (read-only structural
   * access is fine and cheap; a caller-supplied `updater` never receives
   * this frozen doc's nested objects directly -- see `updateJob`) and
   * returns the proposed next document plus a `resultOf` selector that is
   * invoked against the freshly-verified, freshly-frozen document that
   * actually gets cached/saved. Deriving the returned value FROM that same
   * frozen document (rather than from whatever transient object `fn`
   * happened to construct) guarantees a caller can never receive a
   * reference that both diverges from, and can mutate, `this.cached`.
   */
  private mutate<T>(fn: (doc: JobStoreDocumentV1) => { doc: JobStoreDocumentV1; resultOf: (verified: JobStoreDocumentV1) => T }): Promise<T> {
    const run = this.tail.then(async () => {
      const doc = await this.loadOrInit();
      const { doc: next, resultOf } = fn(doc);
      // Reference-equality fast path (final-integration requirement 2): a genuine no-op mutation
      // (e.g. acknowledging an already-acknowledged/unknown occurrence) returns the exact SAME
      // `doc` object it was handed -- never a clone -- as its proposed next document. When that's
      // the case there is nothing to persist: skip re-validation/`AtomicStore.save` entirely rather
      // than writing a byte-identical document back to disk. `doc` is already the last committed,
      // frozen, verified document (straight from `loadOrInit`), so returning it as-is is safe.
      if (next === doc) {
        return resultOf(doc);
      }
      const verified = deepFreeze(parseJobStoreDocumentV1(deepClone(next)));
      await this.store.save(verified);
      this.cached = verified;
      return resultOf(verified);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read-only; never touches the mutation tail, so a query concurrent with an in-flight mutation simply observes the last committed document. Returns frozen references into `this.cached`. */
  async list(): Promise<readonly PersistedJobV1[]> {
    const doc = await this.loadOrInit();
    return doc.jobs;
  }

  async getById(jobId: string): Promise<PersistedJobV1 | null> {
    const doc = await this.loadOrInit();
    return doc.jobs.find((entry) => entry.job.jobId === jobId) ?? null;
  }

  /** The single non-terminal job (if any) already queued/active/paused/failed-retryable under this idempotency key. */
  async getActiveByIdempotencyKey(idempotencyKey: string): Promise<PersistedJobV1 | null> {
    const doc = await this.loadOrInit();
    return doc.jobs.find((entry) => entry.job.idempotencyKey === idempotencyKey && !isTerminalJobStatus(entry.status)) ?? null;
  }

  async getProviderPause(): Promise<ProviderPauseV1> {
    const doc = await this.loadOrInit();
    return doc.providerPause;
  }

  async getBulkBatches(): Promise<readonly BulkBatchV1[]> {
    return (await this.loadOrInit()).bulkBatches;
  }

  /** Atomically creates the one active batch and its root job. */
  createBulkBatch(batch: BulkBatchV1, root: PersistedJobV1, occurrenceId?: string): Promise<PersistedJobV1> {
    return this.mutate((doc) => {
      const existingOccurrence = occurrenceId === undefined ? undefined : doc.scheduledOccurrences.find((entry) => entry.occurrenceId === occurrenceId);
      if (existingOccurrence) return { doc, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === existingOccurrence.jobId)! };
      if (doc.bulkBatches.some((entry) => entry.status === "active") || doc.jobs.some((entry) => (entry.job.kind === "scope-refresh" || entry.job.kind === "rebuild-index") && !isTerminalJobStatus(entry.status))) {
        throw new EngineError("BULK_BATCH_ACTIVE", "A bulk batch is already active.", {});
      }
      if (doc.jobs.some((entry) => entry.job.jobId === root.job.jobId)) throw new EngineError("JOB_SHAPE_INVALID", "Duplicate bulk root job id.", {});
      const pruned = this.pruneForCap(doc, 1);
      const occurrence = occurrenceId === undefined ? pruned.scheduledOccurrences : this.withinOccurrenceCap([...pruned.scheduledOccurrences, { schemaVersion: 1, occurrenceId, idempotencyKey: root.job.idempotencyKey, jobId: root.job.jobId, acknowledged: false, createdAt: root.job.createdAt }]);
      return { doc: { ...doc, jobs: [...pruned.jobs, root], scheduledOccurrences: occurrence, bulkBatches: this.pruneBatches([...doc.bulkBatches, batch]) }, resultOf: (verified) => verified.jobs.find((job) => job.job.jobId === root.job.jobId)! };
    });
  }

  /** Atomically adopts a process-note job into the active batch, coalescing when possible. */
  appendOrAdoptBatchChild(batchId: string, job: PersistedJobV1): Promise<PersistedJobV1 | null> {
    return this.mutate((doc) => {
      const batch = doc.bulkBatches.find((entry) => entry.batchId === batchId && entry.status === "active");
      if (!batch) throw new EngineError("JOB_NOT_FOUND", "No active bulk batch.", {});
      if (job.job.kind !== "process-note" || job.job.batchId !== batchId || job.job.batchItemId === undefined) throw new EngineError("JOB_SHAPE_INVALID", "Batch child must carry the active batch id and item id.", {});
      const itemId = job.job.batchItemId;
      const already = batch.items.find((item) => item.batchItemId === itemId);
      if (already) {
        const current = doc.jobs.find((entry) => entry.job.jobId === already.jobId);
        if (!current || current.job.idempotencyKey === job.job.idempotencyKey) return { doc, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === already.jobId) ?? null };
        // Source-change replacement occupies the same stable item slot. The old job remains
        // durable until its caller atomically marks it obsolete; only the ledger pointer moves.
        const pruned = this.pruneForCap(doc, 1, new Set([current.job.jobId]));
        const jobs = [...pruned.jobs, job];
        const bulkBatches = doc.bulkBatches.map((entry) => entry.batchId === batchId ? { ...entry, updatedAt: job.job.updatedAt > entry.updatedAt ? job.job.updatedAt : entry.updatedAt, items: entry.items.map((item) => item.batchItemId === itemId ? { ...item, jobId: job.job.jobId, status: job.status } : item) } : entry);
        return { doc: { ...doc, jobs, scheduledOccurrences: pruned.scheduledOccurrences, bulkBatches }, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === job.job.jobId)! };
      }
      const existing = doc.jobs.find((entry) => entry.job.idempotencyKey === job.job.idempotencyKey && !isTerminalJobStatus(entry.status));
      if (existing && existing.job.batchId !== undefined && existing.job.batchId !== batchId) throw new EngineError("BULK_BATCH_ACTIVE", "The child job belongs to another active batch.", {});
      const child = existing ? { ...existing, job: { ...existing.job, batchId, batchItemId: itemId } } : job;
      const pruned = existing ? undefined : this.pruneForCap(doc, 1);
      const jobs = existing ? doc.jobs.map((entry) => entry.job.jobId === child.job.jobId ? child : entry) : [...pruned!.jobs, child];
      const batches = doc.bulkBatches.map((entry) => entry.batchId === batchId ? { ...entry, updatedAt: job.job.updatedAt > entry.updatedAt ? job.job.updatedAt : entry.updatedAt, items: [...entry.items, { batchItemId: itemId, jobId: child.job.jobId, status: child.status }] } : entry);
      return { doc: { ...doc, jobs, scheduledOccurrences: pruned?.scheduledOccurrences ?? doc.scheduledOccurrences, bulkBatches: batches }, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === child.job.jobId) ?? null };
    });
  }

  private pruneBatches(batches: BulkBatchV1[]): BulkBatchV1[] {
    const active = batches.filter((entry) => entry.status === "active");
    const latestTerminal = batches.filter((entry) => entry.status !== "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return latestTerminal === undefined ? active : [...active, latestTerminal];
  }

  private syncBatches(doc: JobStoreDocumentV1, jobs: PersistedJobV1[]): BulkBatchV1[] {
    return this.pruneBatches(doc.bulkBatches.map((batch) => {
      const root = jobs.find((entry) => entry.job.jobId === batch.rootJobId);
      const items = batch.items.map((item) => {
        const child = jobs.find((entry) => entry.job.jobId === item.jobId);
        return child ? { ...item, status: child.status } : item;
      });
      const discoveredTotal = root?.receipt?.kind === "scope" ? root.receipt.discoveredCount : batch.discoveredTotal;
      if (root && batch.status === "active" && (root.status === "failed" || root.status === "cancelled")) {
        return { ...batch, discoveredTotal, items, status: root.status, updatedAt: root.job.updatedAt > batch.updatedAt ? root.job.updatedAt : batch.updatedAt };
      }
      if (!root || batch.status !== "active" || discoveredTotal === undefined || items.length !== discoveredTotal || !isTerminalJobStatus(root.status) || items.some((item) => !isTerminalJobStatus(item.status))) return { ...batch, discoveredTotal, items };
      const status = root.status === "cancelled" ? "cancelled" : root.status === "failed" ? "failed" : items.some((item) => item.status === "failed" || item.status === "cancelled") ? "completed-with-failures" : "completed";
      return { ...batch, discoveredTotal, items, status, updatedAt: root.job.updatedAt > batch.updatedAt ? root.job.updatedAt : batch.updatedAt };
    }));
  }

  private repointBatch(doc: JobStoreDocumentV1, batchId: string, oldItemId: string | undefined, newJobId: string): BulkBatchV1[] {
    return doc.bulkBatches.map((batch) => batch.batchId !== batchId ? batch : oldItemId === undefined ? { ...batch, rootJobId: newJobId } : { ...batch, items: batch.items.map((item) => item.batchItemId === oldItemId ? { ...item, jobId: newJobId } : item) });
  }

  setProviderPause(pause: ProviderPauseV1): Promise<void> {
    return this.mutate((doc) => ({ doc: { ...doc, providerPause: deepClone(pause) }, resultOf: () => undefined }));
  }

  /**
   * Appends a brand-new job. Rejects (before writing anything) a duplicate
   * `jobId` or a duplicate active `idempotencyKey`. If appending would
   * exceed `MAX_PERSISTED_JOBS`, terminal jobs (oldest `updatedAt` first)
   * are pruned first; only if the cap is still exceeded after pruning every
   * terminal job does this throw `JOB_CAP_EXCEEDED`.
   */
  appendJob(job: PersistedJobV1): Promise<void> {
    return this.mutate((doc) => {
      if (doc.jobs.some((entry) => entry.job.jobId === job.job.jobId)) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate jobId "${job.job.jobId}".`, {});
      }
      if (!isTerminalJobStatus(job.status) && doc.jobs.some((entry) => entry.job.idempotencyKey === job.job.idempotencyKey && !isTerminalJobStatus(entry.status))) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate active idempotencyKey "${job.job.idempotencyKey}".`, {});
      }
      const { jobs, scheduledOccurrences } = this.pruneForCap(doc, 1);
      return { doc: { ...doc, jobs: [...jobs, job], scheduledOccurrences, bulkBatches: this.pruneBatches(doc.bulkBatches) }, resultOf: () => undefined };
    });
  }

  /**
   * The single atomic entry point for "submit or coalesce": within ONE
   * mutation-tail turn, looks up a non-terminal job already carrying
   * `job.job.idempotencyKey` and, if found, returns it unchanged
   * (`coalesced: true`) instead of appending `job`; otherwise appends `job`
   * and returns it (`coalesced: false`). Because the lookup and the append
   * happen inside the same `mutate()` callback -- never as two separate
   * awaited calls -- two concurrent callers racing to submit identical work
   * can never both observe "no existing job" and both append a duplicate:
   * the second caller's turn always runs after the first's append has
   * already committed to `cached`, so it always finds the first job. This
   * is the fix for the coalesce-loses-the-race defect `JobEngine.submit`
   * used to have when it called `getActiveByIdempotencyKey` and `appendJob`
   * as two independently-awaited steps. `job.job.idempotencyKey` no longer
   * includes `trigger` (see `computeJobIdempotencyKey`), so a manual,
   * Reading, scheduled, or startup submit of the exact same work all
   * coalesce here regardless of which origin got there first; the first
   * job's `trigger` is kept as provenance and never overwritten by a
   * later-coalesced submit's trigger.
   */
  appendOrCoalesce(job: PersistedJobV1): Promise<{ job: PersistedJobV1; coalesced: boolean }> {
    return this.mutate((doc) => {
      const existingIndex = doc.jobs.findIndex((entry) => entry.job.idempotencyKey === job.job.idempotencyKey && !isTerminalJobStatus(entry.status));
      if (existingIndex !== -1) {
        const existingId = doc.jobs[existingIndex].job.jobId;
        const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; coalesced: boolean } => ({
          job: verified.jobs.find((entry) => entry.job.jobId === existingId)!,
          coalesced: true,
        });
        return { doc, resultOf };
      }
      if (doc.jobs.some((entry) => entry.job.jobId === job.job.jobId)) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate jobId "${job.job.jobId}".`, {});
      }
      const { jobs, scheduledOccurrences } = this.pruneForCap(doc, 1);
      const newJobId = job.job.jobId;
      const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; coalesced: boolean } => ({
        job: verified.jobs.find((entry) => entry.job.jobId === newJobId)!,
        coalesced: false,
      });
      return { doc: { ...doc, jobs: [...jobs, job], scheduledOccurrences, bulkBatches: this.pruneBatches(doc.bulkBatches) }, resultOf };
    });
  }

  /** Every job any UNACKNOWLEDGED occurrence record still references -- a live crash-recovery receipt, never eligible for terminal-job cap pruning even though the job itself may be terminal. */
  private jobIdsProtectedByPendingOccurrences(doc: JobStoreDocumentV1): ReadonlySet<string> {
    return new Set(doc.scheduledOccurrences.filter((entry) => !entry.acknowledged).map((entry) => entry.jobId));
  }

  /**
   * The ONE cap-enforcement/pruning path every mutation that appends a job
   * goes through -- `appendJob`, `appendOrCoalesce`, `supersedeWithSuccessor`,
   * and `submitScheduledOccurrence`'s "new" branch. Prunes terminal jobs
   * (oldest `updatedAt` first) to make room, same as before, but ALSO keeps
   * the occurrence registry consistent with whatever it just pruned
   * (requirement 1): every job an UNACKNOWLEDGED occurrence still
   * references is protected from pruning (as before); every job an
   * ACKNOWLEDGED occurrence references that DOES get pruned has its
   * occurrence record removed IN THE SAME COMMIT, so this can never
   * propose a document with a dangling occurrence-registry cross-reference
   * -- `parseJobStoreDocumentV1`'s own referential-integrity check would
   * otherwise reject the very document this method is trying to produce.
   *
   * `extraProtectedJobIds` layers in a caller-specific protection on top
   * (e.g. `supersedeWithSuccessor`'s just-superseded `oldJobId`).
   */
  private pruneForCap(
    doc: JobStoreDocumentV1,
    additionalJobs: number,
    extraProtectedJobIds: ReadonlySet<string> = new Set(),
  ): { jobs: PersistedJobV1[]; scheduledOccurrences: ScheduledOccurrenceRecordV1[] } {
    let jobs = [...doc.jobs];
    let scheduledOccurrences = doc.scheduledOccurrences;
    if (jobs.length + additionalJobs > MAX_PERSISTED_JOBS) {
      const retainedBatches = this.pruneBatches(doc.bulkBatches);
      const activeBatchRoots = retainedBatches.map((batch) => batch.rootJobId);
      const protectedJobIds = new Set([...this.jobIdsProtectedByPendingOccurrences(doc), ...activeBatchRoots, ...extraProtectedJobIds]);
      const terminal = jobs.filter((entry) => isTerminalJobStatus(entry.status) && !protectedJobIds.has(entry.job.jobId)).sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt));
      const nonTerminal = jobs.filter((entry) => !isTerminalJobStatus(entry.status) || protectedJobIds.has(entry.job.jobId));
      const keepTerminalCount = Math.max(0, terminal.length - (jobs.length + additionalJobs - MAX_PERSISTED_JOBS));
      const keptTerminal = terminal.slice(terminal.length - keepTerminalCount);
      const prunedTerminal = terminal.slice(0, terminal.length - keepTerminalCount);
      jobs = [...keptTerminal, ...nonTerminal];
      if (jobs.length + additionalJobs > MAX_PERSISTED_JOBS) {
        throw new EngineError("JOB_CAP_EXCEEDED", `Cannot append job: ${jobs.length} non-prunable jobs already persisted (max ${MAX_PERSISTED_JOBS}).`, {});
      }
      if (prunedTerminal.length > 0) {
        const prunedJobIds = new Set(prunedTerminal.map((entry) => entry.job.jobId));
        // Every pruned job's UNACKNOWLEDGED occurrence link is impossible here (those jobs were
        // protected above) -- only ACKNOWLEDGED links can reference a pruned job, and those are
        // dropped together with it so no dangling cross-reference is ever proposed.
        scheduledOccurrences = scheduledOccurrences.filter((entry) => !prunedJobIds.has(entry.jobId));
      }
    }
    return { jobs, scheduledOccurrences };
  }

  /**
   * Bounded, deterministic pruning for the occurrence registry itself
   * (distinct from job-cap pruning above): only ACKNOWLEDGED entries are
   * ever eligible, oldest-`acknowledgedAt`-first. If the registry is still
   * over cap after removing every acknowledged entry -- i.e. it is at
   * capacity with UNACKNOWLEDGED (live crash-recovery) receipts alone --
   * this fails closed with a actionable `JOB_CAP_EXCEEDED`, rather than
   * silently dropping a receipt a crash recovery might still need.
   */
  private withinOccurrenceCap(records: readonly ScheduledOccurrenceRecordV1[]): ScheduledOccurrenceRecordV1[] {
    if (records.length <= MAX_SCHEDULED_OCCURRENCES) return [...records];
    const acknowledged = [...records.filter((entry) => entry.acknowledged)].sort((a, b) => (a.acknowledgedAt as string).localeCompare(b.acknowledgedAt as string));
    const unacknowledged = records.filter((entry) => !entry.acknowledged);
    const overBy = records.length - MAX_SCHEDULED_OCCURRENCES;
    const keepAcknowledgedCount = Math.max(0, acknowledged.length - overBy);
    const result = [...acknowledged.slice(acknowledged.length - keepAcknowledgedCount), ...unacknowledged];
    if (result.length > MAX_SCHEDULED_OCCURRENCES) {
      throw new EngineError(
        "JOB_CAP_EXCEEDED",
        `Cannot record scheduled occurrence: ${unacknowledged.length} unacknowledged occurrence(s) already persisted (max ${MAX_SCHEDULED_OCCURRENCES}) and no more acknowledged entries can be pruned.`,
        {},
      );
    }
    return result;
  }

  async getScheduledOccurrence(occurrenceId: string): Promise<ScheduledOccurrenceRecordV1 | null> {
    assertScheduledOccurrenceId(occurrenceId);
    const doc = await this.loadOrInit();
    return doc.scheduledOccurrences.find((entry) => entry.occurrenceId === occurrenceId) ?? null;
  }

  /**
   * The one atomic entry point for crash-safe scheduled submission
   * (requirement 6). Within ONE `mutate()` turn:
   *  a) If `occurrenceId` already has a registry link, return ITS job --
   *     regardless of that job's current status (terminal included). This
   *     is what makes a retry after a crash between a successful submit
   *     and the caller's own outcome-persist safe: even a job that
   *     completed (or failed) synchronously in between is still found and
   *     returned, never duplicated.
   *  b) Otherwise, if a non-terminal job with the SAME idempotencyKey
   *     already exists (e.g. a concurrent manual/timer submit for the
   *     identical work won the race), atomically link `occurrenceId` to
   *     THAT job instead of appending a new one -- the occurrence registry
   *     always points at whichever job actually represents this work.
   *  c) Otherwise, atomically append `job` AND its occurrence link
   *     together, in this same commit.
   * A fault at any point before this commit lands leaves NEITHER the job
   * nor the occurrence link persisted -- `AtomicStore.save`'s all-or-
   * nothing write guarantees that, same as every other mutation here.
   */
  submitScheduledOccurrence(occurrenceId: string, job: PersistedJobV1, nowIso: string): Promise<{ job: PersistedJobV1; linked: "existing-occurrence" | "existing-work" | "new" }> {
    assertScheduledOccurrenceId(occurrenceId);
    return this.mutate((doc) => {
      const existingOccurrence = doc.scheduledOccurrences.find((entry) => entry.occurrenceId === occurrenceId);
      if (existingOccurrence) {
        const linkedJobId = existingOccurrence.jobId;
        if (!doc.jobs.some((entry) => entry.job.jobId === linkedJobId)) {
          throw new EngineError("JOB_STORE_CORRUPT", `Scheduled occurrence "${occurrenceId}" references a missing job "${linkedJobId}".`, {});
        }
        const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; linked: "existing-occurrence" | "existing-work" | "new" } => ({
          job: verified.jobs.find((entry) => entry.job.jobId === linkedJobId)!,
          linked: "existing-occurrence",
        });
        return { doc, resultOf };
      }

      const existingWork = doc.jobs.find((entry) => entry.job.idempotencyKey === job.job.idempotencyKey && !isTerminalJobStatus(entry.status));
      if (existingWork) {
        const linkedJobId = existingWork.job.jobId;
        const registryRecord: ScheduledOccurrenceRecordV1 = { schemaVersion: 1, occurrenceId, idempotencyKey: job.job.idempotencyKey, jobId: linkedJobId, acknowledged: false, createdAt: nowIso };
        const scheduledOccurrences = this.withinOccurrenceCap([...doc.scheduledOccurrences, registryRecord]);
        const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; linked: "existing-occurrence" | "existing-work" | "new" } => ({
          job: verified.jobs.find((entry) => entry.job.jobId === linkedJobId)!,
          linked: "existing-work",
        });
        return { doc: { ...doc, scheduledOccurrences }, resultOf };
      }

      if (doc.jobs.some((entry) => entry.job.jobId === job.job.jobId)) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate jobId "${job.job.jobId}".`, {});
      }
      const { jobs, scheduledOccurrences: prunedOccurrences } = this.pruneForCap(doc, 1);
      const newJobId = job.job.jobId;
      const registryRecord: ScheduledOccurrenceRecordV1 = { schemaVersion: 1, occurrenceId, idempotencyKey: job.job.idempotencyKey, jobId: newJobId, acknowledged: false, createdAt: nowIso };
      const scheduledOccurrences = this.withinOccurrenceCap([...prunedOccurrences, registryRecord]);
      const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; linked: "existing-occurrence" | "existing-work" | "new" } => ({
        job: verified.jobs.find((entry) => entry.job.jobId === newJobId)!,
        linked: "new",
      });
      return { doc: { ...doc, jobs: [...jobs, job], scheduledOccurrences, bulkBatches: this.pruneBatches(doc.bulkBatches) }, resultOf };
    });
  }

  /**
   * Marks one occurrence record acknowledged -- idempotent (a no-op, never
   * an error, for an unknown or already-acknowledged occurrenceId) so a
   * caller can safely retry it after a crash/failure with no coordination.
   * Purely registry housekeeping (see `ScheduledOccurrenceRecordV1`'s doc
   * comment) -- never load-bearing for crash-safety itself.
   */
  async acknowledgeScheduledOccurrence(occurrenceId: string, nowIso: string): Promise<void> {
    assertScheduledOccurrenceId(occurrenceId);
    // Read-only fast path (final-integration requirement 2): checked against the last COMMITTED
    // document, without ever entering the mutation tail, so a call for an unknown or
    // already-acknowledged occurrenceId (the common case once `reconcileAcknowledgements` has
    // already caught up) costs nothing beyond a read. Racy by nature (another mutation may land
    // between this check and the `mutate()` call below), so it is purely a shortcut -- the
    // `mutate()` callback re-checks the SAME condition against the document actually being
    // mutated, and `mutate()`'s own reference-equality skip (see its doc comment) is what actually
    // guarantees no `AtomicStore.save` happens for a genuine no-op, race or not.
    const cached = await this.loadOrInit();
    const cachedEntry = cached.scheduledOccurrences.find((entry) => entry.occurrenceId === occurrenceId);
    if (!cachedEntry || cachedEntry.acknowledged) return;

    await this.mutate((doc) => {
      const index = doc.scheduledOccurrences.findIndex((entry) => entry.occurrenceId === occurrenceId);
      if (index === -1 || doc.scheduledOccurrences[index].acknowledged) {
        return { doc, resultOf: () => undefined };
      }
      const updated: ScheduledOccurrenceRecordV1 = { ...doc.scheduledOccurrences[index], acknowledged: true, acknowledgedAt: nowIso };
      const scheduledOccurrences = [...doc.scheduledOccurrences];
      scheduledOccurrences[index] = updated;
      return { doc: { ...doc, scheduledOccurrences }, resultOf: () => undefined };
    });
  }

  /**
   * Replaces one persisted job with `next`, produced by `updater(current)`.
   * `current` is a deep-cloned, MUTABLE working copy -- never the frozen
   * object living in `this.cached` -- so an `updater` that mutates `current`
   * in place and then throws only ever corrupts that disposable clone; the
   * thrown error propagates out of `mutate()` before `store.save`/
   * `this.cached` are ever touched, leaving committed/cached state exactly
   * as it was. Enforces: the job exists; `jobId`/`kind`/`trigger`/`target`/
   * `idempotencyKey` never change (identity is immutable once appended);
   * `attempt` never decreases; and the phase transition is legal per
   * `assertLegalPhaseTransition` (same phase, or exactly one step forward
   * -- never a skip, never backward). A caller that would violate any of
   * these gets a thrown `EngineError` and the store is left completely
   * unchanged.
   */
  updateJob(jobId: string, updater: (current: PersistedJobV1) => PersistedJobV1): Promise<PersistedJobV1> {
    return this.mutate((doc) => {
      const index = doc.jobs.findIndex((entry) => entry.job.jobId === jobId);
      if (index === -1) {
        throw new EngineError("JOB_NOT_FOUND", `No persisted job with id "${jobId}".`, {});
      }
      const current = doc.jobs[index];
      const workingCopy = deepClone(current);
      const next = updater(workingCopy);
      if (next.job.jobId !== current.job.jobId) {
        throw new EngineError("JOB_SHAPE_INVALID", "updateJob must not change jobId.", {});
      }
      if (next.job.kind !== current.job.kind || next.job.trigger !== current.job.trigger || next.job.idempotencyKey !== current.job.idempotencyKey) {
        throw new EngineError("JOB_SHAPE_INVALID", "updateJob must not change kind/trigger/idempotencyKey.", {});
      }
      if (next.attempt < current.attempt) {
        throw new EngineError("JOB_SHAPE_INVALID", "updateJob must not decrease attempt.", {});
      }
      assertLegalPhaseTransition(current.job.kind, current.job.phase, next.job.phase);
      if (!isTerminalJobStatus(next.status) && next.job.idempotencyKey !== current.job.idempotencyKey) {
        throw new EngineError("JOB_SHAPE_INVALID", "updateJob must not change idempotencyKey while non-terminal.", {});
      }
      const jobs = [...doc.jobs];
      jobs[index] = next;
      return { doc: { ...doc, jobs, bulkBatches: this.syncBatches(doc, jobs) }, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === jobId)! };
    });
  }

  /**
   * Atomically, in ONE `queue.json` commit: marks `oldJobId` terminal (via
   * `markOldTerminal`, subject to the exact same identity/attempt/
   * phase-transition invariants as `updateJob`, plus a check that the
   * result is actually terminal) AND appends-or-coalesces `successor` --
   * checked against the ALREADY-UPDATED jobs array, so `successor`'s own
   * idempotency-key coalescing check correctly sees `oldJobId` as already
   * terminal within this same transaction, never as a still-active
   * duplicate of itself. This is what lets a job's own same-idempotency-
   * key "restart from scratch" successor be created safely -- doing this
   * as two separate mutations (mark old terminal, THEN separately submit
   * a successor) would have a window where the successor's coalescing
   * check could find the OLD job still non-terminal and coalesce onto the
   * very job it was meant to replace, silently losing the restart intent
   * (Checkpoint 7 acceptance-guard requirement 1).
   *
   * Either both changes land or neither does: if the underlying
   * `AtomicStore.save()` fails, this whole mutation rejects and `oldJobId`
   * is left exactly as it was before the call (typically still `"active"`
   * at its last committed phase) -- safe for `JobStore.recoverInterruptedJobs`
   * to pick up and retry the whole decision again on the next startup.
   */
  supersedeWithSuccessor(
    oldJobId: string,
    markOldTerminal: (current: PersistedJobV1) => PersistedJobV1,
    successor: PersistedJobV1,
  ): Promise<{ old: PersistedJobV1; successor: PersistedJobV1; coalesced: boolean }> {
    return this.mutate((doc) => {
      const oldIndex = doc.jobs.findIndex((entry) => entry.job.jobId === oldJobId);
      if (oldIndex === -1) {
        throw new EngineError("JOB_NOT_FOUND", `No persisted job with id "${oldJobId}".`, {});
      }
      const oldCurrent = doc.jobs[oldIndex];
      const oldWorkingCopy = deepClone(oldCurrent);
      const oldNext = markOldTerminal(oldWorkingCopy);
      if (oldNext.job.jobId !== oldCurrent.job.jobId) {
        throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor must not change the old job's jobId.", {});
      }
      if (oldNext.job.kind !== oldCurrent.job.kind || oldNext.job.trigger !== oldCurrent.job.trigger || oldNext.job.idempotencyKey !== oldCurrent.job.idempotencyKey) {
        throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor must not change the old job's kind/trigger/idempotencyKey.", {});
      }
      if (oldNext.attempt < oldCurrent.attempt) {
        throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor must not decrease the old job's attempt.", {});
      }
      assertLegalPhaseTransition(oldCurrent.job.kind, oldCurrent.job.phase, oldNext.job.phase);
      if (!isTerminalJobStatus(oldNext.status)) {
        throw new EngineError("JOB_SHAPE_INVALID", "supersedeWithSuccessor requires the old job to become terminal.", {});
      }
      // Checkpoint 7 last-contract guard 2: the successor must be exactly "the same work,
      // restarted from scratch" -- validated BEFORE any mutation, regardless of whether it ends
      // up appended or discarded in favor of an already-coalesced job below.
      assertValidSuccessorShape(oldCurrent, successor);

      let jobs = [...doc.jobs];
      jobs[oldIndex] = oldNext;

      // The successor's coalescing check runs against `jobs` AS ALREADY UPDATED above -- oldJobId
      // is terminal in THIS array, so it can never be (re-)coalesced onto by its own successor.
      const existingIndex = jobs.findIndex((entry) => entry.job.idempotencyKey === successor.job.idempotencyKey && !isTerminalJobStatus(entry.status));
      if (existingIndex !== -1) {
        const existingId = jobs[existingIndex].job.jobId;
        const resultOf = (verified: JobStoreDocumentV1): { old: PersistedJobV1; successor: PersistedJobV1; coalesced: boolean } => ({
          old: verified.jobs.find((entry) => entry.job.jobId === oldJobId)!,
          successor: verified.jobs.find((entry) => entry.job.jobId === existingId)!,
          coalesced: true,
        });
        const bulkBatches = oldCurrent.job.batchId === undefined ? this.syncBatches(doc, jobs) : this.syncBatches({ ...doc, bulkBatches: this.repointBatch(doc, oldCurrent.job.batchId, oldCurrent.job.batchItemId, existingId) }, jobs);
        return { doc: { ...doc, jobs, bulkBatches }, resultOf };
      }
      if (jobs.some((entry) => entry.job.jobId === successor.job.jobId)) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate jobId "${successor.job.jobId}".`, {});
      }
      // `oldJobId` is protected from cap pruning here: it was JUST marked terminal in this same
      // commit and so would otherwise be the prime pruning target (oldest-`updatedAt` terminal
      // entry) the very moment it's created, leaving `resultOf`'s `old` lookup silently empty.
      // `pruneForCap` also keeps the occurrence registry consistent with whatever it prunes.
      const pruned = this.pruneForCap({ ...doc, jobs }, 1, new Set([oldJobId]));
      jobs = pruned.jobs;
      const scheduledOccurrences = pruned.scheduledOccurrences;
      const newSuccessorId = successor.job.jobId;
      jobs = [...jobs, successor];
      const resultOf = (verified: JobStoreDocumentV1): { old: PersistedJobV1; successor: PersistedJobV1; coalesced: boolean } => ({
        old: verified.jobs.find((entry) => entry.job.jobId === oldJobId)!,
        successor: verified.jobs.find((entry) => entry.job.jobId === newSuccessorId)!,
        coalesced: false,
      });
      const bulkBatches = oldCurrent.job.batchId === undefined ? this.syncBatches(doc, jobs) : this.syncBatches({ ...doc, bulkBatches: this.repointBatch(doc, oldCurrent.job.batchId, oldCurrent.job.batchItemId, newSuccessorId) }, jobs);
      return { doc: { ...doc, jobs, scheduledOccurrences, bulkBatches }, resultOf };
    });
  }

  /**
   * Startup recovery: every job persisted with status `"active"` (a crash
   * or forced shutdown interrupted it mid-phase) is deterministically
   * converted back to `"queued"` at its CURRENT persisted phase -- never
   * reset to an earlier phase, never advanced. Because `JobEngine` always
   * persists the attempt increment and phase BEFORE doing that phase's
   * external/model work (requirement 2), the persisted phase already names
   * exactly the earliest not-yet-committed step; simply re-running it from
   * `"queued"` is always safe (every phase's own work is idempotent -- see
   * `noteJob.ts`/`rebuildJob.ts`), so this never double-counts an
   * already-committed phase. Idempotent across repeated startups: a second
   * call finds no `"active"` jobs left and changes nothing.
   */
  recoverInterruptedJobs(): Promise<number> {
    return this.mutate((doc) => {
      let recovered = 0;
      const jobs = doc.jobs.map((entry) => {
        if (entry.status !== "active") return entry;
        recovered += 1;
        return { ...entry, status: "queued" as const };
      });
      return { doc: { ...doc, jobs, bulkBatches: this.syncBatches(doc, jobs) }, resultOf: () => recovered };
    });
  }
}
