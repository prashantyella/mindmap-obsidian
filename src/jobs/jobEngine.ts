import { randomUUID } from "node:crypto";

import {
  computeJobIdempotencyKey,
  JOB_KIND_PHASES,
  type JobKind,
  type JobPhase,
  type JobTargetV1,
  type JobTrigger,
  type NoteIdentityV1,
  type QueueJobV1,
} from "../engine/contracts";
import { EngineError, isEngineError } from "../engine/errors";
import type { JobStore } from "./jobStore";
import {
  assertScheduledOccurrenceId,
  classifyFailureCode,
  isTerminalJobStatus,
  MAX_ATTEMPT_COUNT,
  PROVIDER_WIDE_PAUSE_CODES,
  sanitizeFailureCode,
  toFailureCode,
  type JobReceiptV1,
  type PersistedJobV1,
} from "./jobTypes";

/**
 * The single per-job-kind irreversible-commit phase: strictly BEFORE this
 * phase, a queued cancellation request stops the job with zero writes; AT
 * or after it, `JobEngine` no longer honors `cancelRequested` for the rest
 * of that job's run -- the phase runs to completion instead, since undoing
 * it would mean either rewriting user note bytes (process-note) or rolling
 * back an already-verified generation pointer switch (rebuild/migrate),
 * neither of which this design ever does. Kinds absent from this map have
 * no modeled irreversible phase yet: cancellation is honored at every
 * phase boundary for them.
 */
const IRREVERSIBLE_COMMIT_PHASE: Partial<Record<JobKind, JobPhase>> = {
  "process-note": "write-note",
  "rebuild-index": "activate-generation",
  "migrate-index": "activate-generation",
};

function phaseIndex(kind: JobKind, phase: JobPhase): number {
  return JOB_KIND_PHASES[kind].indexOf(phase);
}

function isAtOrPastIrreversiblePhase(kind: JobKind, phase: JobPhase): boolean {
  const irreversible = IRREVERSIBLE_COMMIT_PHASE[kind];
  if (irreversible === undefined) return false;
  return phaseIndex(kind, phase) >= phaseIndex(kind, irreversible);
}

/**
 * `true` iff `error` reflects the OUTCOME itself being invalid for the
 * job's current persisted state (a genuine runner/caller bug: an illegal
 * phase skip, a shape violation, an unknown jobId) -- these are exactly
 * the codes `JobStore.updateJob`'s OWN invariant checks throw, and are
 * deterministic: retrying (or even just re-attempting the same update)
 * would reproduce the identical failure every time, so failing the job
 * closed is correct. Anything else (a `JobStore`/`AtomicStore` write,
 * read, or schema failure, or any other unexpected error) is a
 * PERSISTENCE failure, not an outcome-validity failure -- see requirement
 * 7's `runPhaseStep`.
 */
function isInvalidOutcomeError(error: unknown): boolean {
  return isEngineError(error) && (error.code === "JOB_TRANSITION_INVALID" || error.code === "JOB_SHAPE_INVALID" || error.code === "JOB_NOT_FOUND");
}

/** Exponential backoff, capped, computed purely from the persisted attempt count -- no wall-clock sleep anywhere in this module. */
export function computeBackoffMs(attempt: number): number {
  const BASE_MS = 250;
  const CAP_MS = 30_000;
  return Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export type PhaseStepOutcome =
  | { type: "advance"; nextPhase: JobPhase; receipt?: JobReceiptV1 }
  | { type: "complete"; receipt?: JobReceiptV1 }
  | { type: "retry"; failureCode: string }
  | { type: "cancelled" }
  | { type: "obsolete"; failureCode: string }
  | {
      /**
       * This job is superseded by its own identical-idempotency-key
       * successor: `JobEngine` atomically (via
       * `JobStore.supersedeWithSuccessor`, ONE `queue.json` commit) marks
       * THIS job terminal AND appends-or-coalesces a fresh successor --
       * same kind/target/pipelineVersion (hence same idempotency key),
       * new jobId, `phase` reset to `JOB_KIND_PHASES[kind][0]`, `attempt`
       * reset to 0. Unlike `NoteJobRunner`'s replacement (whose successor
       * differs by `sourceHash`, so it can never collide with the
       * original), THIS successor shares the exact same idempotency key
       * as the job being superseded -- doing the two updates as separate
       * mutations would leave a window where the successor's own
       * coalescing check could find the original job still non-terminal
       * and coalesce right back onto it, silently losing the restart
       * intent (Checkpoint 7 acceptance-guard requirement 1). If the
       * atomic commit itself fails (a `JobStore` persistence failure),
       * this job is left exactly as it was (typically still `"active"`
       * at its last committed phase) for `JobStore.recoverInterruptedJobs`
       * to retry the whole decision on the next startup -- no
       * best-effort/swallowed step remains in this path.
       */
      type: "superseded";
      failureCode: string;
    }
  | { type: "provider-pause"; code: string };

/**
 * The seam every job kind's phase logic (`noteJob.ts`, `rebuildJob.ts`)
 * implements. `step` executes exactly ONE phase's worth of work for
 * `job.job.phase` and returns what happened -- it never advances more than
 * one phase itself; `JobEngine` is the only thing that persists a phase
 * transition. `signal` is aborted when `JobEngine.dispose()` runs; a
 * well-behaved runner should stop promptly, though `dispose()` itself never
 * waits for that (see its own doc comment).
 */
export interface JobPhaseRunner {
  step(job: PersistedJobV1, signal: AbortSignal): Promise<PhaseStepOutcome>;
  /**
   * Optional: called by `JobEngine` exactly once, on EVERY terminal
   * outcome (`"completed"`/`"failed"`/`"cancelled"`) for `jobId` -- never
   * for a still-queued/active job -- so a runner's per-job in-memory
   * scratch cache (e.g. `NoteJobRunner`'s embed/metadata memory) is
   * released promptly rather than lingering until its own bounded
   * eviction cap happens to reclaim it. Synchronous and best-effort: a
   * runner with no such cache simply omits this.
   */
  forget?(jobId: string): void;
}

export type JobDispatchOutcome = "processed" | "idle";

export interface JobEngineClock {
  now(): number;
}

const REAL_CLOCK: JobEngineClock = { now: () => Date.now() };

export type SubmitJobInput =
  | { trigger: JobTrigger; kind: "process-note"; identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }
  | { trigger: JobTrigger; kind: "reading-sync" | "scope-refresh"; scopeId: string; pipelineVersion: number }
  | { trigger: JobTrigger; kind: "rebuild-index" | "migrate-index"; pipelineVersion: number };

function buildTarget(input: SubmitJobInput): JobTargetV1 {
  if (input.kind === "process-note") return { schemaVersion: 1, kind: "note", identity: input.identity };
  if (input.kind === "reading-sync" || input.kind === "scope-refresh") return { schemaVersion: 1, kind: "scope", scopeId: input.scopeId };
  return { schemaVersion: 1, kind: "global" };
}

/**
 * The one execution coordinator. Serializes every phase-step of every
 * mutation-capable job through a single cooperative pump loop -- at most
 * one phase-step of one job runs at a time, end to end, which trivially
 * satisfies "only one mutation-capable job runs at a time" (requirement 3)
 * without a separate mutation-vs-read-only split inside this module: the
 * read-only operations that must stay concurrently available
 * (`IndexStore.queryRelated`, `JobStore.list`/`getById`) simply never go
 * through this pump at all.
 *
 * Deliberately never calls `setTimeout`/sleeps: `submit()`/a successful
 * phase step "kick" the pump immediately; a job with a future
 * `nextAttemptAtMs` (backoff) or blocked by an active provider-wide pause
 * is skipped over in favor of the next ELIGIBLE queued job (fair,
 * deterministic ordering -- a repeatedly failing head-of-queue job accrues
 * backoff and stops occupying the "next to run" slot, so it can never
 * starve unrelated queued work). Driving the pump on a real wall-clock
 * timer (to eventually retry a backed-off job) is an external caller's
 * responsibility in a later checkpoint, not this module's.
 */
/**
 * Inspectable terminal fault state left behind when the background pump
 * stops itself after a `JobStore` failure -- see `JobEngine`'s class doc
 * and requirement 3. Deliberately carries ONLY a closed, sanitized
 * `code` (the exact same `toFailureCode` allow-list every other persisted
 * failure code goes through) and a timestamp -- never the raw caught
 * `Error` object, its `.message`, or a stack trace, any of which could
 * carry a secret/path/internal-detail leaked from the underlying
 * filesystem error (final-closure requirement 10). `onError` receives
 * this exact same redacted shape.
 */
export interface JobEngineFault {
  code: string;
  atMs: number;
}

export class JobEngine {
  private running = false;
  private disposed = false;
  private pumping: Promise<void> | null = null;
  /** Count of explicit `runOnce()`/`drain()` calls currently in flight (incremented on entry, decremented in a `finally`, before/after routing through `runExclusive`) -- tracked SEPARATELY from `pumping` (Checkpoint 7 last-contract guard 4) so `resetFault()` refuses while EITHER dispatch path is active, not just the background pump. A counter, not a boolean: `drain()`/`runOnce()` can be called concurrently by more than one caller (they simply queue behind each other on `dispatchTail`), and each must keep the guard up until its OWN call resolves. */
  private explicitDispatchCount = 0;
  /** Set synchronously by `kick()` any time it is called while a pump loop is already in flight; checked by that loop right before it would otherwise exit idle -- see requirement 3's lost-wakeup fix. */
  private kickRequested = false;
  /** Serializes every `runOnce`/`drain`/background-pump call through one tail, so no two ever execute a phase-step concurrently -- see requirement 2. */
  private dispatchTail: Promise<void> = Promise.resolve();
  private fault: JobEngineFault | null = null;
  private readonly abortController = new AbortController();
  private readonly clock: JobEngineClock;
  private readonly onError?: (fault: JobEngineFault) => void;

  constructor(
    private readonly store: JobStore,
    private readonly runners: Readonly<Partial<Record<JobKind, JobPhaseRunner>>>,
    clock: JobEngineClock = REAL_CLOCK,
    onError?: (fault: JobEngineFault) => void,
  ) {
    this.clock = clock;
    this.onError = onError;
  }

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** The fault (a `JobStore` failure surfaced from the background pump) that stopped this engine, if any -- `null` while healthy. Never thrown/rethrown automatically; a caller/health-check inspects this explicitly. */
  getFault(): JobEngineFault | null {
    return this.fault;
  }

  /**
   * Explicitly clears a recorded fault once the caller has independently
   * confirmed store health is restored -- `start()` refuses to actually
   * resume the pump while a fault is still recorded (see `start()`), so
   * this is the one required step between "the store came back" and the
   * engine dispatching again. Idempotent; a no-op if there is no fault.
   * Does NOT itself call `start()` -- a caller decides when to resume.
   *
   * Refuses (returns `false`, never throws) while EITHER dispatch path is
   * still active: the background pump (`this.pumping`) OR an explicit
   * `runOnce()`/`drain()` call (`this.explicitDispatchCount`) (Checkpoint 7
   * last-contract guard 4). The background-pump case: `onError` calling
   * this synchronously, from inside the very pump loop iteration that just
   * faulted, must not succeed -- `this.pumping` is still the pending
   * promise for that iteration at that point (it only becomes `null` once
   * the pump loop's own `.finally` runs, strictly after this callback
   * returns), so clearing the fault here would let a caller's immediate
   * `start()` race the pump's own not-yet-finished unwind (Checkpoint 7
   * acceptance-guard requirement 9). The explicit-dispatch case is
   * symmetric: an in-flight `runOnce()`/`drain()` call -- even one
   * unrelated to whatever originally set the fault -- must also block a
   * concurrent reset, since it shares the same `dispatchTail` and a stale
   * "healthy" read here could otherwise race that call's own still-pending
   * outcome.
   */
  resetFault(): boolean {
    if (this.pumping || this.explicitDispatchCount > 0) return false;
    this.fault = null;
    return true;
  }

  /**
   * Every `runOnce`/`drain` call, and the background pump loop, run their
   * actual dispatch work through this single tail so at most one phase-step
   * (of one job, anywhere) is ever in flight at a time -- concurrent
   * `runOnce()`/`drain()`/`start()`-driven-pump calls queue behind each
   * other rather than racing.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.dispatchTail.then(fn);
    this.dispatchTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Coalesces identical WORK (not trigger) by idempotency key, atomically:
   * `JobStore.appendOrCoalesce` performs the lookup-or-append as one
   * indivisible mutation, so two concurrent `submit()` calls for the exact
   * same kind+target+pipelineVersion(+sourceHash+embeddingModel) can never
   * both observe "no existing job" and both append -- the second always
   * finds the first's already-committed job and coalesces onto it. The
   * first trigger observed is kept as provenance on the resulting job;
   * later-coalesced submits' triggers are discarded.
   */
  async submit(input: SubmitJobInput): Promise<PersistedJobV1> {
    if (this.disposed) {
      throw new EngineError("JOB_SHAPE_INVALID", "Cannot submit a job: JobEngine has been disposed.", {});
    }
    const target = buildTarget(input);
    const sourceHash = input.kind === "process-note" ? input.sourceHash : undefined;
    const embeddingModel = input.kind === "process-note" ? input.embeddingModel : undefined;
    const idempotencyKey = computeJobIdempotencyKey(input.kind, target, input.pipelineVersion, sourceHash, embeddingModel);

    const nowIso = this.nowIso();
    const job: QueueJobV1 = {
      schemaVersion: 1,
      jobId: randomUUID(),
      trigger: input.trigger,
      kind: input.kind,
      target,
      sourceHash,
      embeddingModel,
      pipelineVersion: input.pipelineVersion,
      phase: JOB_KIND_PHASES[input.kind][0],
      idempotencyKey,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const persisted: PersistedJobV1 = { schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false };
    const { job: result } = await this.store.appendOrCoalesce(persisted);
    this.kick();
    return result;
  }

  /**
   * The crash-safe scheduled-submission entry point (Checkpoint 8
   * requirement 6). Restricted to `input.trigger === "scheduled"` -- a
   * deliberate manual/Reading/startup submit always goes through the
   * ordinary `submit()` above, which is completely unaffected by this
   * method or the occurrence registry it writes to (terminal jobs still
   * never block a manual rerun). `occurrenceId` must be the caller's
   * deterministic, bounded hex64 occurrence identity (see
   * `src/scheduling/scheduleTypes.ts`'s `computeScheduleOccurrenceId` --
   * this module never computes one itself, only validates its SHAPE).
   *
   * Delegates entirely to `JobStore.submitScheduledOccurrence`'s single
   * atomic commit: a retry with the SAME `occurrenceId` always returns the
   * SAME job, regardless of that job's current status -- including a job
   * that ran synchronously to a terminal status before this call's own
   * caller (`CoreScheduler`) got a chance to persist its own outcome. This
   * is exactly what prevents a duplicate job on a crash-and-restart.
   */
  async submitScheduledOccurrence(input: SubmitJobInput, occurrenceId: string): Promise<PersistedJobV1> {
    if (this.disposed) {
      throw new EngineError("JOB_SHAPE_INVALID", "Cannot submit a scheduled occurrence: JobEngine has been disposed.", {});
    }
    if (input.trigger !== "scheduled") {
      throw new EngineError("JOB_SHAPE_INVALID", 'submitScheduledOccurrence requires input.trigger === "scheduled".', {});
    }
    assertScheduledOccurrenceId(occurrenceId);

    const target = buildTarget(input);
    const sourceHash = input.kind === "process-note" ? input.sourceHash : undefined;
    const embeddingModel = input.kind === "process-note" ? input.embeddingModel : undefined;
    const idempotencyKey = computeJobIdempotencyKey(input.kind, target, input.pipelineVersion, sourceHash, embeddingModel);

    const nowIso = this.nowIso();
    const job: QueueJobV1 = {
      schemaVersion: 1,
      jobId: randomUUID(),
      trigger: input.trigger,
      kind: input.kind,
      target,
      sourceHash,
      embeddingModel,
      pipelineVersion: input.pipelineVersion,
      phase: JOB_KIND_PHASES[input.kind][0],
      idempotencyKey,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const persisted: PersistedJobV1 = { schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false };
    const { job: result } = await this.store.submitScheduledOccurrence(occurrenceId, persisted, nowIso);
    this.kick();
    return result;
  }

  /**
   * Marks one scheduled occurrence acknowledged -- crash protocol step (d):
   * called ONLY after the caller (`CoreScheduler`) has already durably
   * persisted its own "submitted" outcome for this occurrence. Idempotent
   * and safe to call speculatively/repeatedly; a failure here is harmless
   * (see `JobStore.acknowledgeScheduledOccurrence`'s doc comment) and is
   * never load-bearing for correctness -- a caller may swallow a rejection
   * from this method entirely.
   */
  async acknowledgeScheduledOccurrence(occurrenceId: string, atMs?: number): Promise<void> {
    assertScheduledOccurrenceId(occurrenceId);
    const nowIso = atMs !== undefined ? new Date(atMs).toISOString() : this.nowIso();
    await this.store.acknowledgeScheduledOccurrence(occurrenceId, nowIso);
  }

  /** No-op if the job is already terminal (nothing left to cancel). */
  async requestCancel(jobId: string): Promise<PersistedJobV1> {
    const result = await this.store.updateJob(jobId, (current) => (isTerminalJobStatus(current.status) ? current : { ...current, cancelRequested: true }));
    this.kick();
    return result;
  }

  /**
   * Idempotent: calling while already running is a harmless no-op.
   * Refuses to actually start (silently -- never throws) while a fault
   * from a prior `JobStore` failure is still recorded: a caller must
   * explicitly call `resetFault()` first, after confirming store health,
   * so the pump never silently resumes hammering a store that is (as far
   * as this engine's own state can tell) still broken.
   */
  start(): void {
    if (this.disposed || this.fault) return;
    this.running = true;
    this.kick();
  }

  /** Stops kicking new work; does not interrupt an in-flight phase-step. Idempotent. */
  stop(): void {
    this.running = false;
  }

  /**
   * Requests that the background pump run (or keep running). Setting
   * `kickRequested` BEFORE checking `this.pumping` closes the exact
   * lost-wakeup window requirement 3 calls out: a pump loop that has just
   * decided its last `runOnceInner()` came back idle, but whose `.finally`
   * has not yet cleared `this.pumping`, will still observe this flag set
   * (it rechecks `kickRequested` itself right before exiting -- see
   * `pumpLoop`) rather than this call seeing `pumping` truthy and silently
   * doing nothing.
   */
  private kick(): void {
    if (!this.running || this.disposed) return;
    this.kickRequested = true;
    if (this.pumping) return;
    this.pumping = this.runExclusive(() => this.pumpLoop()).finally(() => {
      this.pumping = null;
    });
  }

  /**
   * The background pump's actual loop, run under `runExclusive` for its
   * entire duration (not per-step) so it can never interleave a phase-step
   * with a concurrently-running `runOnce()`/`drain()`/another pump
   * instance. A `JobStore` failure here (as opposed to a runner/outcome
   * failure, which `runPhaseStep` already converts into a persisted
   * retry/failed job rather than throwing) is NOT a per-job condition --
   * the durable queue itself may be unreadable/unwritable -- so this stops
   * the whole engine and records an inspectable `fault` plus notifies
   * `onError`, rather than letting the exception become an unhandled
   * rejection (nothing else ever awaits this background promise).
   */
  private async pumpLoop(): Promise<void> {
    for (;;) {
      this.kickRequested = false;
      if (!this.running || this.disposed) return;
      let outcome: JobDispatchOutcome;
      try {
        outcome = await this.runOnceInner();
      } catch (error) {
        const fault: JobEngineFault = { code: toFailureCode(error), atMs: this.clock.now() };
        this.fault = fault;
        this.running = false;
        this.onError?.(fault);
        return;
      }
      if (outcome === "processed") continue;
      if (this.kickRequested) continue;
      return;
    }
  }

  /**
   * Processes exactly one phase-step of the single most-eligible queued
   * job (scanning queue order, skipping any job whose backoff hasn't
   * elapsed or that is blocked by an active provider-wide pause), or
   * returns `"idle"` immediately without waiting if nothing is eligible
   * right now. Deterministic and safe to call directly in tests without
   * `start()`'s pump. Routed through `runExclusive` so it can never
   * interleave a phase-step with a concurrently-running background pump or
   * another `runOnce()`/`drain()` call -- see requirement 2. A `JobStore`
   * failure propagates normally to this call's own caller (unlike the
   * background pump, an explicit caller here is already in a position to
   * observe/handle a thrown rejection).
   */
  async runOnce(): Promise<JobDispatchOutcome> {
    if (this.disposed) return "idle";
    this.explicitDispatchCount += 1;
    try {
      return await this.runExclusive(() => this.runOnceInner());
    } finally {
      this.explicitDispatchCount -= 1;
    }
  }

  private async runOnceInner(): Promise<JobDispatchOutcome> {
    if (this.disposed) return "idle";
    const jobs = await this.store.list();
    const pause = await this.store.getProviderPause();
    const now = this.clock.now();
    const eligible = jobs.find((entry) => this.isEligibleNow(entry, pause, now));
    if (!eligible) return "idle";
    await this.runPhaseStep(eligible);
    return "processed";
  }

  private isEligibleNow(entry: PersistedJobV1, pause: { active: boolean }, now: number): boolean {
    if (entry.status !== "queued") return false;
    if (entry.nextAttemptAtMs !== undefined && entry.nextAttemptAtMs > now) return false;
    if (pause.active && entry.job.kind === "process-note") return false;
    return true;
  }

  /**
   * Repeatedly processes every currently-eligible job (ignoring only future
   * backoff / an active provider pause) until idle -- deterministic, never
   * waits on wall-clock time. Runs its entire loop under one `runExclusive`
   * acquisition (requirement 2), so it can never interleave phase-steps
   * with a concurrent background pump or another `runOnce()`/`drain()`
   * call; if a pump already drained everything first, this simply finds
   * nothing eligible and returns immediately once it gets its turn.
   */
  async drain(): Promise<void> {
    if (this.disposed) return;
    this.explicitDispatchCount += 1;
    try {
      await this.runExclusive(async () => {
        while (!this.disposed) {
          const outcome = await this.runOnceInner();
          if (outcome === "idle") break;
        }
      });
    } finally {
      this.explicitDispatchCount -= 1;
    }
  }

  /**
   * Aborts the shared signal passed to every runner and stops the pump.
   * Deliberately does NOT await any in-flight phase-step -- a runner that
   * ignores the abort and hangs (a wedged provider call) must never make
   * `dispose()` itself hang. Single-settlement: the first call disposes;
   * every later call is a no-op. Because `kick()`/`pump()` both check
   * `this.disposed` before starting a NEW phase-step, no phase begins after
   * this returns, even though an already-in-flight one may still finish
   * and commit its outcome shortly after.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.abortController.abort();
  }

  private async runPhaseStep(entry: PersistedJobV1): Promise<void> {
    if (entry.cancelRequested && !isAtOrPastIrreversiblePhase(entry.job.kind, entry.job.phase)) {
      await this.store.updateJob(entry.job.jobId, (current) => ({ ...current, status: "cancelled", nextAttemptAtMs: undefined }));
      this.forgetJob(entry.job.kind, entry.job.jobId);
      this.kick();
      return;
    }

    // Persist the attempt increment and phase (unchanged) BEFORE any external/model work --
    // requirement 2. This is the exact "earliest not-yet-committed step" a crash-and-restart
    // recovers to (see JobStore.recoverInterruptedJobs). nextAttemptAtMs is backoff bookkeeping
    // for a QUEUED job only (requirement 12) -- cleared the moment it actually starts running.
    const active = await this.store.updateJob(entry.job.jobId, (current) => ({
      ...current,
      status: "active",
      attempt: current.attempt + 1,
      job: { ...current.job, updatedAt: this.nowIso() },
      nextAttemptAtMs: undefined,
    }));

    const runner = this.runners[active.job.kind];
    if (!runner) {
      await this.store.updateJob(active.job.jobId, (current) => ({
        ...current,
        status: "failed",
        lastFailureCode: "JOB_SHAPE_INVALID",
        lastFailureClass: "terminal",
        nextAttemptAtMs: undefined,
      }));
      return;
    }

    let step: PhaseStepOutcome;
    try {
      step = await runner.step(active, this.abortController.signal);
    } catch (error) {
      step = { type: "retry", failureCode: toFailureCode(error) };
    }
    try {
      await this.applyStepOutcome(active, step);
    } catch (error) {
      if (!isInvalidOutcomeError(error)) {
        // The runner's effect may already be irreversible (e.g. NoteJobRunner's write-note phase
        // already wrote the note) -- what failed here is JobStore's OWN persistence of the
        // advance/receipt (a write/fsync/rename failure, requirement 7), NOT the outcome itself.
        // Running a SECOND update here to mark the job "failed" would discard the receipt and the
        // job's recovery position, and there is no reason to believe THAT update would fare any
        // better against the same failing store. Instead, propagate: runOnceInner's caller (the
        // background pump) treats this as a store-health fault and stops (requirement 3), leaving
        // the LAST ACTUALLY COMMITTED state (still "active" at the pre-advance phase) for
        // `JobStore.recoverInterruptedJobs` to pick up on the next startup -- re-running that one
        // phase is always safe (see the individual runners' own idempotency), so nothing is lost.
        throw error;
      }
      // A runner returning an outcome inconsistent with the persisted phase (e.g. "complete"
      // from a non-penultimate phase) is a genuine caller bug, not a transient condition -- fail
      // this one job closed (never retried, since retrying would repeat the exact same bug) rather
      // than letting the exception escape as an unhandled rejection and take down the whole pump.
      await this.store.updateJob(active.job.jobId, (current) => ({
        ...current,
        status: "failed",
        lastFailureCode: toFailureCode(error),
        lastFailureClass: "terminal",
        nextAttemptAtMs: undefined,
      }));
      this.forgetJob(active.job.kind, active.job.jobId);
    }
  }

  /** Best-effort, synchronous, never throws: a runner without `forget` (or one that throws from it) must never break the engine's own terminal-transition bookkeeping. */
  private forgetJob(kind: JobKind, jobId: string): void {
    try {
      this.runners[kind]?.forget?.(jobId);
    } catch {
      // A runner's cleanup is best-effort housekeeping, never load-bearing for correctness.
    }
  }

  private async applyStepOutcome(entry: PersistedJobV1, step: PhaseStepOutcome): Promise<void> {
    switch (step.type) {
      case "advance": {
        await this.store.updateJob(entry.job.jobId, (current) => ({
          ...current,
          status: "queued",
          job: { ...current.job, phase: step.nextPhase, updatedAt: this.nowIso() },
          receipt: step.receipt ?? current.receipt,
          nextAttemptAtMs: undefined,
          lastFailureCode: undefined,
          lastFailureClass: undefined,
        }));
        this.kick();
        return;
      }
      case "complete": {
        const phases = JOB_KIND_PHASES[entry.job.kind];
        const finalPhase = phases[phases.length - 1];
        await this.store.updateJob(entry.job.jobId, (current) => ({
          ...current,
          status: "completed",
          job: { ...current.job, phase: finalPhase, updatedAt: this.nowIso() },
          receipt: step.receipt ?? current.receipt,
          nextAttemptAtMs: undefined,
          lastFailureCode: undefined,
          lastFailureClass: undefined,
        }));
        this.forgetJob(entry.job.kind, entry.job.jobId);
        this.kick();
        return;
      }
      case "cancelled": {
        await this.store.updateJob(entry.job.jobId, (current) => ({ ...current, status: "cancelled", nextAttemptAtMs: undefined }));
        this.forgetJob(entry.job.kind, entry.job.jobId);
        this.kick();
        return;
      }
      case "obsolete": {
        const failureCode = sanitizeFailureCode(step.failureCode);
        await this.store.updateJob(entry.job.jobId, (current) => ({
          ...current,
          status: "cancelled",
          lastFailureCode: failureCode,
          lastFailureClass: "terminal",
          nextAttemptAtMs: undefined,
        }));
        this.forgetJob(entry.job.kind, entry.job.jobId);
        this.kick();
        return;
      }
      case "superseded": {
        const failureCode = sanitizeFailureCode(step.failureCode);
        const nowIso = this.nowIso();
        const successorJob: QueueJobV1 = {
          schemaVersion: 1,
          jobId: randomUUID(),
          trigger: entry.job.trigger,
          kind: entry.job.kind,
          target: entry.job.target,
          sourceHash: entry.job.sourceHash,
          embeddingModel: entry.job.embeddingModel,
          pipelineVersion: entry.job.pipelineVersion,
          phase: JOB_KIND_PHASES[entry.job.kind][0],
          idempotencyKey: entry.job.idempotencyKey,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const successor: PersistedJobV1 = { schemaVersion: 1, job: successorJob, status: "queued", attempt: 0, cancelRequested: false };
        const markOldTerminal = (current: PersistedJobV1): PersistedJobV1 => ({
          ...current,
          status: "cancelled",
          lastFailureCode: failureCode,
          lastFailureClass: "terminal",
          nextAttemptAtMs: undefined,
        });
        // One atomic queue.json commit -- see JobStore.supersedeWithSuccessor's own doc comment.
        // If this throws (a genuine JobStore persistence failure), it propagates exactly like any
        // other post-effect persistence failure (requirement 7): nothing here is persisted, and
        // this job is left at its last actually-committed "active" state for recovery.
        await this.store.supersedeWithSuccessor(entry.job.jobId, markOldTerminal, successor);
        this.forgetJob(entry.job.kind, entry.job.jobId);
        this.kick();
        return;
      }
      case "provider-pause": {
        // `step.code` is runner-supplied, never trusted directly. Two layers of distrust
        // (requirements 6 and 11): sanitizeFailureCode restricts it to the closed
        // EngineErrorCode/UNKNOWN_TRANSIENT allow-list; PROVIDER_WIDE_PAUSE_CODES further
        // restricts which of THOSE recognized codes may ever escalate to a provider-wide pause.
        // A recognized-but-not-provider-wide code (or an unrecognized one, sanitized down to
        // UNKNOWN_TRANSIENT) is downgraded to an ordinary per-job retry instead -- a runner
        // returning "provider-pause" is caller-supplied code, not a trusted internal decision,
        // so it gets no more authority than an arbitrary caught error would.
        const code = sanitizeFailureCode(step.code);
        if (!PROVIDER_WIDE_PAUSE_CODES.has(code)) {
          return this.applyStepOutcome(entry, { type: "retry", failureCode: code });
        }
        // The provider-wide pause flag itself is what blocks further dispatch (see
        // isEligibleNow) -- this job's own nextAttemptAtMs is deliberately left untouched (never
        // set here) so that once resumeProvider() clears the pause, this job is immediately
        // eligible again rather than also waiting out a redundant per-job backoff.
        await this.store.setProviderPause({ active: true, code, pausedAtMs: this.clock.now() });
        await this.store.updateJob(entry.job.jobId, (current) => ({
          ...current,
          status: "queued",
          lastFailureCode: code,
          lastFailureClass: "transient",
          nextAttemptAtMs: undefined,
        }));
        this.kick();
        return;
      }
      case "retry": {
        const failureCode = sanitizeFailureCode(step.failureCode);
        const failureClass = classifyFailureCode(failureCode);
        if (failureClass === "terminal" || entry.attempt >= MAX_ATTEMPT_COUNT) {
          await this.store.updateJob(entry.job.jobId, (current) => ({
            ...current,
            status: "failed",
            lastFailureCode: failureCode,
            lastFailureClass: failureClass,
            nextAttemptAtMs: undefined,
          }));
          this.forgetJob(entry.job.kind, entry.job.jobId);
        } else {
          await this.store.updateJob(entry.job.jobId, (current) => ({
            ...current,
            status: "queued",
            lastFailureCode: failureCode,
            lastFailureClass: failureClass,
            nextAttemptAtMs: this.clock.now() + computeBackoffMs(current.attempt),
          }));
        }
        this.kick();
        return;
      }
    }
  }

  /** Resolves the current provider-wide pause and clears it -- used once a caller has confirmed the provider is healthy again (e.g. a successful health check). Unrelated (non-`process-note`) queued work was never blocked by the pause in the first place. */
  async resumeProvider(): Promise<void> {
    await this.store.setProviderPause({ active: false });
    this.kick();
  }
}
