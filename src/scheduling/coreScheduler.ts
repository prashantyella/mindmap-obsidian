import type { SubmitJobInput } from "../jobs/jobEngine";
import { isEngineError } from "../engine/errors";
import type { ScheduleStore } from "./scheduleStore";
import { computeNextDueAfter } from "./scheduleTime";
import {
  appendPendingAcknowledgementId,
  computeScheduleOccurrenceId,
  computeScheduleWorkFingerprint,
  MAX_CONSECUTIVE_FAILURES,
  parseScheduleDefinitionV1,
  SCHEDULE_KINDS,
  SCHEDULE_KIND_TO_JOB_KIND,
  type PersistedScheduleV1,
  type ScheduleDefinitionV1,
  type ScheduleFailureCode,
  type ScheduleId,
  type ScheduleOutcome,
  type ScheduleStateV1,
} from "./scheduleTypes";

/**
 * Checkpoint 8's core coordinator: entirely Obsidian-free, driven only by
 * injected seams (`clock`, `registrar`, `store`, `jobSubmitter`). Every
 * timer tick does exactly one thing -- evaluate due state and call
 * `jobSubmitter.submitScheduledOccurrence` -- and NEVER performs note/
 * index/provider work itself; that work lives entirely behind `JobEngine`/
 * its runners, which this module never imports beyond the narrow
 * `SubmitJobInput` shape.
 */

/**
 * The seam every `JobEngine` this scheduler drives against implements --
 * deliberately narrower than the full `JobEngine` class so this module can
 * be tested against a bare fake, and so a future non-JobEngine submitter
 * (unlikely, but not this module's business to rule out) could satisfy it
 * too. Occurrence-based ONLY (requirement 6) -- this module never calls a
 * plain, non-occurrence `submit()`; every submission it ever makes carries
 * a durable `occurrenceId` so a crash between submit and this module's own
 * state persist can never produce a duplicate job. `acknowledgeScheduled
 * Occurrence` failures are the caller's (this module's) responsibility to
 * swallow -- see `CoreScheduler.processSchedule`'s step (d).
 */
export interface JobSubmitter {
  submitScheduledOccurrence(input: SubmitJobInput, occurrenceId: string): Promise<unknown>;
  acknowledgeScheduledOccurrence(occurrenceId: string, atMs: number): Promise<void>;
}

export interface SchedulerClock {
  now(): number;
}

const REAL_CLOCK: SchedulerClock = { now: () => Date.now() };

/** Injected in place of a real `setInterval`/`clearInterval` -- tests substitute a fake that fires synchronously on demand, so every DST/rollover/crash scenario stays deterministic. `registerInterval` returns an opaque handle later passed back to `cancelInterval`; neither this module nor its caller ever inspects the handle's shape. */
export interface IntervalRegistrar {
  registerInterval(callback: () => void, intervalMs: number): unknown;
  cancelInterval(handle: unknown): void;
}

export const DEFAULT_TICK_INTERVAL_MS = 60_000;
const MIN_TICK_INTERVAL_MS = 1_000;
const MAX_TICK_INTERVAL_MS = 60 * 60_000;

/** Bounded, capped exponential backoff for a failed submit's RETRY due instant -- duplicated locally (never imported from `src/jobs/jobEngine.ts`'s own `computeBackoffMs`) so this module's only `src/jobs` dependency stays the narrow `SubmitJobInput` type (`schedulingIsolation.test.ts` enforces this). Capped well under `MIN_INTERVAL_MINUTES` (the shortest legal cadence period) so a retry can never itself overshoot the next natural occurrence for a fast interval cadence -- `processSchedule` additionally clamps to the natural next occurrence explicitly. */
const RETRY_BASE_MS = 30_000; // 30s
const RETRY_CAP_MS = 30 * 60_000; // 30 min

export function computeScheduleRetryBackoffMs(consecutiveFailures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1));
}

function buildSubmitInput(definition: ScheduleDefinitionV1): SubmitJobInput {
  const kind = SCHEDULE_KIND_TO_JOB_KIND[definition.kind];
  const trigger = "scheduled" as const;
  if (kind === "scope-refresh" || kind === "reading-sync") {
    // parseScheduleDefinitionV1 already enforces scopeId is present exactly for these two kinds.
    return { trigger, kind, scopeId: definition.scopeId as string, pipelineVersion: definition.pipelineVersion };
  }
  return { trigger, kind: "rebuild-index", pipelineVersion: definition.pipelineVersion };
}

/** Maps an arbitrary caught submit-time error to the closed, redacted `ScheduleFailureCode` allow-list -- never the raw error/message. */
function classifySubmitError(error: unknown): ScheduleFailureCode {
  if (isEngineError(error)) return "SCHEDULE_SUBMIT_STORE_FAILED";
  return "SCHEDULE_SUBMIT_UNKNOWN";
}

/**
 * A bounded, redacted fault the background pump records when a
 * `ScheduleStore`/clock/registrar/observer seam throws unexpectedly --
 * never a raw caught `Error`/message/stack, which could carry a leaked
 * path or internal detail. Distinct from a schedule's own persisted
 * `"submit-failed"` outcome (which is a normal, tracked, retried condition
 * -- see `computeScheduleRetryBackoffMs`): a `SchedulerFault` is this
 * engine's own health signal, purely observational, and never stops
 * ticking -- a store failure for one schedule must never block the others
 * due in the same tick, or any future tick.
 */
export interface SchedulerFault {
  code: string;
  scheduleId?: ScheduleId;
  atMs: number;
}

/**
 * The closed, scheduler-health-relevant allow-list `SchedulerFault.code` is
 * ever drawn from (final-integration requirement 6) -- deliberately NOT
 * "any `EngineErrorCode`": an unrelated code that happens to bubble up
 * through an unexpected path (a provider/embedding error, a job-content
 * error) is not a scheduler-health signal and must never be surfaced as
 * one. Anything outside this set -- including a non-`EngineError` throw --
 * collapses to `"SCHEDULER_UNKNOWN_FAULT"`.
 */
const SCHEDULER_FAULT_CODES: ReadonlySet<string> = new Set([
  "SCHEDULE_SHAPE_INVALID",
  "SCHEDULE_STORE_CORRUPT",
  "SCHEDULE_NOT_FOUND",
  "SCHEDULE_CAP_EXCEEDED",
  "SCHEDULE_TRANSITION_INVALID",
  "TIMEZONE_INVALID",
  "STORE_PATH_INVALID",
  "STORE_READ_FAILED",
  "STORE_WRITE_FAILED",
  "STORE_SCHEMA_INVALID",
]);

function classifySchedulerFaultCode(error: unknown): string {
  if (isEngineError(error) && SCHEDULER_FAULT_CODES.has(error.code)) return error.code;
  return "SCHEDULER_UNKNOWN_FAULT";
}

export interface CoreSchedulerOptions {
  store: ScheduleStore;
  jobSubmitter: JobSubmitter;
  registrar: IntervalRegistrar;
  clock?: SchedulerClock;
  tickIntervalMs?: number;
  /** Best-effort, synchronous or async-but-never-awaited, and NEVER allowed to throw out of this module -- a throwing observer is caught and swallowed. Observability only. */
  onScheduleError?: (fault: SchedulerFault) => void;
}

export class CoreScheduler {
  private readonly store: ScheduleStore;
  private readonly jobSubmitter: JobSubmitter;
  private readonly registrar: IntervalRegistrar;
  private readonly clock: SchedulerClock;
  private readonly tickIntervalMs: number;
  private readonly onScheduleError?: (fault: SchedulerFault) => void;

  private running = false;
  private disposed = false;
  private intervalHandle: unknown = null;
  /**
   * The ONE exclusive lane every operation this scheduler ever performs
   * against `store`/`jobSubmitter` is serialized through -- every tick
   * (interval-driven or explicit) AND every `configure()` call (final-
   * integration requirement 4). Without this, a `configure()` racing a
   * concurrent tick could interleave between that tick's own multiple
   * `ScheduleStore` commits (e.g. land between step (a)'s pending-intent
   * commit and step (b)'s submit), reconfiguring the schedule's definition
   * out from under a submission already in flight for the OLD definition.
   * Routing both through this single tail makes that interleaving
   * impossible: whichever operation is already running always completes
   * its ENTIRE sequence of commits before the next one even starts.
   */
  private opTail: Promise<void> = Promise.resolve();
  private fault: SchedulerFault | null = null;

  constructor(options: CoreSchedulerOptions) {
    this.store = options.store;
    this.jobSubmitter = options.jobSubmitter;
    this.registrar = options.registrar;
    this.clock = options.clock ?? REAL_CLOCK;
    const requested = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (!Number.isFinite(requested) || requested < MIN_TICK_INTERVAL_MS || requested > MAX_TICK_INTERVAL_MS) {
      throw new RangeError(`tickIntervalMs must be in [${MIN_TICK_INTERVAL_MS}, ${MAX_TICK_INTERVAL_MS}].`);
    }
    this.tickIntervalMs = requested;
    this.onScheduleError = options.onScheduleError;
  }

  /** The last recorded fault, if any -- `null` while healthy. Never thrown/rethrown automatically; a caller/health-check inspects this explicitly. Recording a fault never stops the scheduler -- see this module's `SchedulerFault` doc comment. */
  getFault(): SchedulerFault | null {
    return this.fault;
  }

  /** Explicitly clears the last recorded fault. Idempotent; a no-op if there is none. */
  resetFault(): void {
    this.fault = null;
  }

  /**
   * Creates a schedule (with a freshly-computed first `nextDueAt`, strictly
   * after `now`) if `definition.id` is unseen, or atomically RECONFIGURES
   * the existing schedule (definition + due-state recalculation together,
   * per `ScheduleStore.reconfigure`'s fixed policy -- requirement 1) if it
   * already exists. Routed through the same exclusive operation lane as
   * every tick (requirement 4), so this can never interleave mid-sequence
   * with an in-flight `processSchedule` call for any schedule. Safe to
   * call before or after `start()`.
   */
  configure(definition: ScheduleDefinitionV1): Promise<PersistedScheduleV1> {
    return this.enqueueOp(() => this.configureInner(definition));
  }

  private async configureInner(rawDefinition: ScheduleDefinitionV1): Promise<PersistedScheduleV1> {
    // Validate BEFORE ever touching a field (final-integration requirement 13) -- `rawDefinition`
    // may be a caller-constructed or casted object that only nominally satisfies the TypeScript
    // type; `definition.id` below must never be read from an unvalidated shape. The re-parsed,
    // structurally-verified result is used for every subsequent field access in this method.
    const definition = parseScheduleDefinitionV1(rawDefinition);
    const now = this.clock.now();
    const existing = await this.store.getById(definition.id);
    if (existing) {
      // `ScheduleStore.reconfigure` itself atomically moves an invalidated pending occurrence's
      // id into `state.pendingAcknowledgementIds`, in the SAME commit as the invalidation --
      // last-acceptance requirement 3's "Core configure should not be the only place this
      // invariant is enforced." `reconcileAcknowledgements` (run on every subsequent tick) picks
      // it up from there; this method has nothing further to do.
      return this.store.reconfigure(definition.id, definition, now);
    }
    const nextDueMs = computeNextDueAfter(definition.cadence, definition.timezone, now, undefined);
    const initial: PersistedScheduleV1 = {
      schemaVersion: 1,
      definition,
      state: { nextDueAt: new Date(nextDueMs).toISOString(), consecutiveFailures: 0 },
    };
    return this.store.upsertDefinition(initial, (current) => current);
  }

  /**
   * Loads every persisted schedule and submits AT MOST ONE catch-up job for
   * each one currently overdue (`state.nextDueAt <= now`), then registers
   * the recurring tick interval exactly once. Idempotent: calling while
   * already running is a no-op (never a second interval registration).
   * Refuses silently after `dispose()`. If `registerInterval` itself
   * throws, `start()` rolls back cleanly (never leaves `running`/
   * `intervalHandle` in an inconsistent state) and records a fault rather
   * than throwing or leaving the scheduler half-started. The interval
   * registration itself is UNCONDITIONAL -- a fault during the initial
   * catch-up tick that follows never un-registers it: per-schedule/global
   * store faults are transient health signals, never a reason to stop
   * ticking altogether (see `SchedulerFault`'s doc comment).
   */
  async start(): Promise<void> {
    if (this.disposed || this.running) return;
    this.running = true;
    try {
      this.intervalHandle = this.registrar.registerInterval(() => this.scheduleTick(), this.tickIntervalMs);
    } catch (error) {
      this.running = false;
      this.intervalHandle = null;
      this.recordFault(classifySchedulerFaultCode(error), undefined);
      return;
    }
    // runTick() never throws (every seam it touches -- clock, store, observer -- is caught
    // internally into recordFault), so this can never become an unhandled rejection or propagate
    // a raw error to start()'s caller. The interval stays registered regardless of this tick's
    // outcome.
    await this.tick();
  }

  /**
   * Cancels the interval registration; does not interrupt an in-flight
   * tick. Idempotent. Safe to `start()` again afterward -- exactly one new
   * interval is registered. A throwing `registrar.cancelInterval` (final-
   * integration requirement 5) is caught into a redacted fault -- `running`/
   * `intervalHandle` are still reset to their stopped state regardless,
   * since `intervalHandle` is cleared BEFORE the call that might throw.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalHandle !== null) {
      const handle = this.intervalHandle;
      this.intervalHandle = null;
      try {
        this.registrar.cancelInterval(handle);
      } catch (error) {
        this.recordFault(classifySchedulerFaultCode(error), undefined);
      }
    }
  }

  /**
   * `stop()` (itself safe against a throwing `cancelInterval`) plus a
   * permanent refusal of any further `start()`/tick/`configure()` work --
   * single-settlement, idempotent. Does not interrupt an in-flight tick's
   * CURRENT schedule (no abort signal is threaded through to the
   * store/jobSubmitter calls), but `processSchedule` re-checks `disposed`
   * after every awaited seam (final-integration requirement 5) -- so once
   * the currently-awaited step returns, no later effect within that same
   * schedule's processing, no later schedule in that tick, and no future
   * tick or `configure()` call, ever submits or mutates state again. An
   * already-in-flight external submit call may still finish on its own,
   * but nothing this scheduler does AFTER observing `disposed` ever starts
   * a new one.
   */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  /**
   * Queues `fn` behind whatever is already in `opTail` and returns the
   * resulting promise -- the ONE place `opTail` is ever read and
   * reassigned. Every tick AND every `configure()` call goes through this,
   * so they can never interleave (requirement 4).
   */
  private enqueueOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(fn);
    this.opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Queues a tick behind any already in-flight operation, so two ticks (interval-driven or explicit) -- or a tick and a `configure()` call -- can never interleave their work. Fire-and-forget: the registrar's timer callback has no return value to await. Safe -- `runTick` never rejects. */
  private scheduleTick(): void {
    if (this.disposed || !this.running) return;
    void this.enqueueOp(() => this.runTick());
  }

  /** Explicit, awaitable tick -- used by `start()`'s initial catch-up pass and available to tests/callers that want a deterministic drain rather than waiting on the registrar's fake timer. Serialized against interval-driven ticks and `configure()` calls via the same `opTail`. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.enqueueOp(() => this.runTick());
  }

  /**
   * Records a bounded fault; `this.fault` (inspectable via `getFault()`) is
   * ALWAYS updated -- including its timestamp -- so a caller polling
   * `getFault()` always sees the most recent occurrence. `onScheduleError`
   * itself, however, is notified only when the fault's (code, scheduleId)
   * pair actually CHANGES from the previously recorded one (last-acceptance
   * requirement 10's bounded policy: "keep interval for self-healing but
   * suppress duplicate observer reports until state changes") -- a store
   * that keeps failing with the identical condition tick after tick must
   * never spam the observer once per tick forever; a DIFFERENT fault (a
   * different code, or the same code against a different schedule) is
   * always reported, and `resetFault()` clears the dedup key so the very
   * next occurrence of the SAME fault is reported again after a caller has
   * acknowledged/investigated it. Catches a throwing observer so it can
   * never escape as an unhandled rejection or crash the pump.
   */
  private recordFault(code: string, scheduleId: ScheduleId | undefined): void {
    const isDuplicate = this.fault !== null && this.fault.code === code && this.fault.scheduleId === scheduleId;
    const fault: SchedulerFault = { code, scheduleId, atMs: this.safeNow() };
    this.fault = fault;
    if (isDuplicate) return;
    try {
      this.onScheduleError?.(fault);
    } catch {
      // An observer must never be able to destabilize the scheduler.
    }
  }

  /** `this.clock.now()`, but a throwing clock seam falls back to the real wall clock rather than propagating -- used only for fault timestamping, never for due-state decisions. */
  private safeNow(): number {
    try {
      return this.clock.now();
    } catch {
      return Date.now();
    }
  }

  private async runTick(): Promise<void> {
    if (this.disposed) return;
    let now: number;
    try {
      now = this.clock.now();
    } catch (error) {
      this.recordFault(classifySchedulerFaultCode(error), undefined);
      return;
    }

    // A single whole-document health probe BEFORE the per-schedule loop (final-integration
    // requirement 6): `ScheduleStore` is one JSON document, so a load/parse failure here is
    // inherently GLOBAL, not per-schedule -- every one of the 3 schedules' own `getById` calls
    // below would independently retry the identical failing load and fail identically. Recording
    // one fault and skipping the whole tick avoids spamming the observer 3x for what is really one
    // underlying condition. A successful probe also warms `ScheduleStore`'s cache, so the
    // per-schedule reads below never re-trigger a document load at all.
    try {
      await this.store.list();
    } catch (error) {
      this.recordFault(classifySchedulerFaultCode(error), undefined);
      return;
    }
    if (this.disposed) return;

    // requirement 2: best-effort re-acknowledge every schedule's last successful occurrence before
    // evaluating new due work -- heals a crash between outcome-persist and ack (protocol step c/d)
    // on every subsequent tick, not just at startup.
    await this.reconcileAcknowledgements();

    for (const scheduleId of SCHEDULE_KINDS) {
      if (this.disposed) return;
      try {
        await this.processSchedule(scheduleId, now);
      } catch (error) {
        // A ScheduleStore failure for one schedule must never block the others due in this same
        // tick -- isolate and continue. A job-submit failure never reaches here at all;
        // processSchedule already converts it into a persisted "submit-failed" outcome.
        this.recordFault(classifySchedulerFaultCode(error), scheduleId);
      }
    }
  }

  /**
   * Best-effort, per-schedule: drains `state.pendingAcknowledgementIds` --
   * the bounded, durable queue of occurrenceIds still awaiting
   * acknowledgement in `JobStore` (last-acceptance requirement 1). A
   * schedule with an EMPTY queue (the overwhelmingly common steady-state
   * case) costs exactly one read (`getById`) and ZERO writes -- there is
   * nothing to attempt, so neither `acknowledgeScheduledOccurrence` nor
   * `ScheduleStore.removePendingAcknowledgementId` is ever called. For each
   * id still queued: attempt the ack, and ONLY once that ack call itself
   * resolves without throwing, atomically remove that id from the queue --
   * a crash between the ack succeeding and that removal commit simply
   * re-attempts the (already idempotent, already-acknowledged) ack again on
   * the next tick, which `JobStore.acknowledgeScheduledOccurrence` treats
   * as a harmless zero-write no-op. Never throws -- a failure for one
   * id/schedule is swallowed and retried on a later tick, and never blocks
   * due-work evaluation.
   */
  private async reconcileAcknowledgements(): Promise<void> {
    for (const scheduleId of SCHEDULE_KINDS) {
      if (this.disposed) return;
      let current: PersistedScheduleV1 | null;
      try {
        current = await this.store.getById(scheduleId);
      } catch {
        continue; // best-effort only -- retried on the next tick.
      }
      if (this.disposed) return;
      const pendingIds = current?.state.pendingAcknowledgementIds;
      if (!pendingIds || pendingIds.length === 0) continue;
      for (const occurrenceId of pendingIds) {
        if (this.disposed) return;
        try {
          await this.jobSubmitter.acknowledgeScheduledOccurrence(occurrenceId, this.safeNow());
        } catch {
          continue; // best-effort only -- retried on the next tick; do not remove an id whose ack failed.
        }
        if (this.disposed) return;
        try {
          await this.store.removePendingAcknowledgementId(scheduleId, occurrenceId);
        } catch {
          // Best-effort only -- the ack itself already succeeded and is idempotent, so leaving
          // this id queued (to be re-acked, harmlessly, on a later tick) is completely safe.
        }
      }
    }
  }

  /**
   * Implements the full crash-safe scheduled-occurrence protocol
   * (requirement 6):
   *  (a) durably persist a pending occurrence intent in `ScheduleStore`
   *      BEFORE ever calling the job submitter -- skipped (reused) when a
   *      pending intent already survived from an earlier interrupted
   *      attempt at this exact same occurrence;
   *  (b) submit through `JobSubmitter.submitScheduledOccurrence`, keyed by
   *      that durable `occurrenceId` -- coalesces onto whatever job that
   *      occurrenceId already produced, even a terminal one;
   *  (c) atomically persist the schedule outcome -- success clears the
   *      pending intent (and records `lastOccurrenceId`/`lastWorkFingerprint`
   *      for future ack-reconciliation) and advances to the next natural
   *      due instant; failure keeps the SAME pending intent and schedules a
   *      bounded retry (requirement 5), never a fresh logical occurrence;
   *  (d) only after (c) commits, best-effort acknowledge the occurrence in
   *      `JobStore` -- a failure here is swallowed and retried by
   *      `reconcileAcknowledgements` on a later tick.
   * Crash-recovery cases: a crash before (a) simply re-derives the
   * identical deterministic `occurrenceId` on the next overdue scan; a
   * crash between (a) and (b) retries the persisted pending intent as-is; a
   * crash between (b) and (c) resubmits the SAME occurrenceId and gets back
   * the SAME job (however it resolved) rather than a duplicate; a crash
   * between (c) and (d) leaves a harmless unacknowledged `JobStore`
   * registry entry that `reconcileAcknowledgements` retries.
   *
   * `disposed` is re-checked after every awaited seam (final-integration
   * requirement 5): disposal during (a) means (b) never runs (the pending
   * intent survives, correctly, for a restart to pick up); disposal during
   * (b) means no outcome is ever persisted and no ack is attempted (the
   * pending intent again survives -- a retry after restart finds the SAME
   * occurrence, whether or not the in-flight submit ultimately landed);
   * disposal during (c)'s own commit means (d) never runs (self-heals via
   * `reconcileAcknowledgements` on a later tick, same as any other crash
   * between c and d).
   */
  private async processSchedule(scheduleId: ScheduleId, now: number): Promise<void> {
    const current = await this.store.getById(scheduleId);
    if (this.disposed) return;
    if (!current || !current.definition.enabled) return;
    const dueMs = new Date(current.state.nextDueAt).getTime();
    if (dueMs > now) return;

    let occurrenceId: string;
    let occurrenceDueAtIso: string;
    let workFingerprint: string;

    if (current.state.pendingOccurrenceId !== undefined) {
      // Crash/retry recovery: a pending intent already survived from an earlier interrupted
      // attempt at this SAME logical occurrence -- reuse it exactly, never recompute.
      occurrenceId = current.state.pendingOccurrenceId;
      occurrenceDueAtIso = current.state.pendingDueAt as string;
      workFingerprint = current.state.pendingWorkFingerprint as string;
    } else {
      // A genuinely fresh occurrence: nextDueAt IS this occurrence's logical due instant.
      occurrenceDueAtIso = current.state.nextDueAt;
      workFingerprint = computeScheduleWorkFingerprint(current.definition);
      occurrenceId = computeScheduleOccurrenceId(scheduleId, occurrenceDueAtIso, workFingerprint);
      // Step (a).
      await this.store.setPendingOccurrence(scheduleId, { pendingOccurrenceId: occurrenceId, pendingDueAt: occurrenceDueAtIso, pendingWorkFingerprint: workFingerprint });
      if (this.disposed) return; // disposal during (a): (b) never runs; the pending intent survives.
    }
    const occurrenceDueMs = new Date(occurrenceDueAtIso).getTime();

    // Step (b).
    let outcome: ScheduleOutcome;
    let failureCode: ScheduleFailureCode | undefined;
    try {
      await this.jobSubmitter.submitScheduledOccurrence(buildSubmitInput(current.definition), occurrenceId);
      outcome = "submitted";
    } catch (error) {
      outcome = "submit-failed";
      failureCode = classifySubmitError(error);
    }
    if (this.disposed) return; // disposal during (b): no outcome mutation, no ack; pending intent survives for restart.

    const nowIso = new Date(now).toISOString();

    if (outcome === "submitted") {
      // Step (c), success path: advance to the next NATURAL occurrence after now, phase-locked to
      // the original logical occurrence; clear the now-resolved pending intent; record
      // lastOccurrenceId/lastWorkFingerprint as pure history, and durably enqueue occurrenceId
      // into pendingAcknowledgementIds -- last-acceptance requirement 1 -- IN THIS SAME COMMIT, so
      // a crash immediately after this call still has a durable record that this occurrence still
      // needs acking, without requiring any later tick to unconditionally re-derive that from
      // lastOccurrenceId.
      const nextDueMs = computeNextDueAfter(current.definition.cadence, current.definition.timezone, now, occurrenceDueMs);
      await this.store.updateState(scheduleId, (workingCopy): ScheduleStateV1 => ({
        lastDueAt: occurrenceDueAtIso,
        lastSubmittedAt: nowIso,
        lastOutcome: "submitted",
        lastFailureCode: undefined,
        nextDueAt: new Date(nextDueMs).toISOString(),
        consecutiveFailures: 0,
        pendingOccurrenceId: undefined,
        pendingDueAt: undefined,
        pendingWorkFingerprint: undefined,
        lastOccurrenceId: occurrenceId,
        lastWorkFingerprint: workFingerprint,
        pendingAcknowledgementIds: appendPendingAcknowledgementId(workingCopy.state.pendingAcknowledgementIds, occurrenceId),
      }));
      if (this.disposed) return; // disposal during (c)'s own commit: (d) never runs; self-heals via reconcileAcknowledgements later.
      // Step (d): an immediate best-effort ack attempt -- purely an optimization to resolve the
      // common case within this same tick rather than waiting for the next one. Success removes
      // the id from the durable queue right away; failure leaves it queued exactly as step (c)
      // already committed it, for `reconcileAcknowledgements` to retry on a later tick.
      try {
        await this.jobSubmitter.acknowledgeScheduledOccurrence(occurrenceId, now);
      } catch {
        return; // Harmless: the occurrence stays queued in pendingAcknowledgementIds, retried later.
      }
      if (this.disposed) return;
      try {
        await this.store.removePendingAcknowledgementId(scheduleId, occurrenceId);
      } catch {
        // Best-effort only -- the ack itself already succeeded; leaving the id queued (to be
        // re-acked, harmlessly, on a later tick) is completely safe.
      }
      return;
    }

    // Step (c), failure path: do NOT defer this occurrence until the next natural day/week/
    // interval (requirement 5) -- persist a bounded, capped exponential-backoff RETRY due instant
    // instead, while retaining the SAME pending occurrence identity (never a fresh occurrenceId)
    // across every retry. The retry instant is clamped to never exceed the occurrence's own
    // NATURAL next occurrence. Backoff is capped and strictly positive, so this can never
    // tight-loop. lastOccurrenceId/lastWorkFingerprint/pendingAcknowledgementIds (if any, from an
    // earlier success/invalidation) are carried over untouched -- they describe the LAST SUCCESS
    // or an earlier abandoned occurrence, never this in-flight failure.
    await this.store.updateState(scheduleId, (workingCopy): ScheduleStateV1 => {
      const nextConsecutiveFailures = Math.min(MAX_CONSECUTIVE_FAILURES, workingCopy.state.consecutiveFailures + 1);
      const naturalNextDueMs = computeNextDueAfter(current.definition.cadence, current.definition.timezone, now, occurrenceDueMs);
      const retryDueMs = Math.min(now + computeScheduleRetryBackoffMs(nextConsecutiveFailures), naturalNextDueMs);
      return {
        lastDueAt: occurrenceDueAtIso,
        lastSubmittedAt: workingCopy.state.lastSubmittedAt,
        lastOutcome: "submit-failed",
        lastFailureCode: failureCode,
        nextDueAt: new Date(retryDueMs).toISOString(),
        consecutiveFailures: nextConsecutiveFailures,
        pendingOccurrenceId: occurrenceId,
        pendingDueAt: occurrenceDueAtIso,
        pendingWorkFingerprint: workFingerprint,
        lastOccurrenceId: workingCopy.state.lastOccurrenceId,
        lastWorkFingerprint: workingCopy.state.lastWorkFingerprint,
        pendingAcknowledgementIds: workingCopy.state.pendingAcknowledgementIds,
      };
    });
    if (this.disposed) return; // last-acceptance requirement 4: re-check after the failure-path commit too, even though nothing currently follows it.
  }
}
