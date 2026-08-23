import { AtomicStore, type AtomicStoreFs } from "../engine/atomicStore";
import { EngineError } from "../engine/errors";
import {
  assertLegalPhaseTransition,
  assertValidSuccessorShape,
  isTerminalJobStatus,
  MAX_PERSISTED_JOBS,
  MAX_STORE_SERIALIZED_BYTES,
  parseJobStoreDocumentV1,
  type JobStoreDocumentV1,
  type PersistedJobV1,
  type ProviderPauseV1,
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

  private async loadOrInit(): Promise<JobStoreDocumentV1> {
    if (this.cached) return this.cached;
    const loaded = await this.store.load();
    const doc = loaded ?? { schemaVersion: 1 as const, jobs: [], providerPause: { active: false } };
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
      const jobs = this.withinCap(doc.jobs, 1);
      return { doc: { ...doc, jobs: [...jobs, job] }, resultOf: () => undefined };
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
      const jobs = this.withinCap(doc.jobs, 1);
      const newJobId = job.job.jobId;
      const resultOf = (verified: JobStoreDocumentV1): { job: PersistedJobV1; coalesced: boolean } => ({
        job: verified.jobs.find((entry) => entry.job.jobId === newJobId)!,
        coalesced: false,
      });
      return { doc: { ...doc, jobs: [...jobs, job] }, resultOf };
    });
  }

  /** Shared cap-enforcement/pruning logic used by both `appendJob` and `appendOrCoalesce`. */
  /**
   * `protectedJobIds` (Checkpoint 7 last-contract guard 2): entries whose
   * `jobId` is in this set are NEVER pruned, even if terminal -- used by
   * `supersedeWithSuccessor` to guarantee the just-superseded old job
   * (freshly marked terminal in THIS same commit) always survives cap
   * enforcement, so the `old` job in its result is always well-defined
   * rather than silently absent because it happened to be the
   * oldest-by-`updatedAt` terminal entry at the exact moment it was created.
   */
  private withinCap(jobs: readonly PersistedJobV1[], additional: number, protectedJobIds: ReadonlySet<string> = new Set()): PersistedJobV1[] {
    let result = [...jobs];
    if (result.length + additional > MAX_PERSISTED_JOBS) {
      const terminal = result.filter((entry) => isTerminalJobStatus(entry.status) && !protectedJobIds.has(entry.job.jobId)).sort((a, b) => a.job.updatedAt.localeCompare(b.job.updatedAt));
      const nonTerminal = result.filter((entry) => !isTerminalJobStatus(entry.status) || protectedJobIds.has(entry.job.jobId));
      const keepTerminalCount = Math.max(0, terminal.length - (result.length + additional - MAX_PERSISTED_JOBS));
      result = [...terminal.slice(terminal.length - keepTerminalCount), ...nonTerminal];
      if (result.length + additional > MAX_PERSISTED_JOBS) {
        throw new EngineError("JOB_CAP_EXCEEDED", `Cannot append job: ${result.length} non-prunable jobs already persisted (max ${MAX_PERSISTED_JOBS}).`, {});
      }
    }
    return result;
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
      return { doc: { ...doc, jobs }, resultOf: (verified) => verified.jobs.find((entry) => entry.job.jobId === jobId)! };
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
        return { doc: { ...doc, jobs }, resultOf };
      }
      if (jobs.some((entry) => entry.job.jobId === successor.job.jobId)) {
        throw new EngineError("JOB_SHAPE_INVALID", `Duplicate jobId "${successor.job.jobId}".`, {});
      }
      // `oldJobId` is protected from cap pruning here: it was JUST marked terminal in this same
      // commit and so would otherwise be the prime pruning target (oldest-`updatedAt` terminal
      // entry) the very moment it's created, leaving `resultOf`'s `old` lookup silently empty.
      jobs = this.withinCap(jobs, 1, new Set([oldJobId]));
      const newSuccessorId = successor.job.jobId;
      jobs = [...jobs, successor];
      const resultOf = (verified: JobStoreDocumentV1): { old: PersistedJobV1; successor: PersistedJobV1; coalesced: boolean } => ({
        old: verified.jobs.find((entry) => entry.job.jobId === oldJobId)!,
        successor: verified.jobs.find((entry) => entry.job.jobId === newSuccessorId)!,
        coalesced: false,
      });
      return { doc: { ...doc, jobs }, resultOf };
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
      return { doc: { ...doc, jobs }, resultOf: () => recovered };
    });
  }
}
