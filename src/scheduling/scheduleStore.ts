import { AtomicStore, type AtomicStoreFs } from "../engine/atomicStore";
import { EngineError } from "../engine/errors";
import { computeNextDueAfter } from "./scheduleTime";
import {
  appendPendingAcknowledgementId,
  assertNextDueAtAdvances,
  assertScheduleIdentityUnchanged,
  computeScheduleWorkFingerprint,
  MAX_SCHEDULE_COUNT,
  MAX_STORE_SERIALIZED_BYTES,
  parseScheduleStoreDocumentV1,
  type PersistedScheduleV1,
  type ScheduleDefinitionV1,
  type ScheduleId,
  type ScheduleStoreDocumentV1,
} from "./scheduleTypes";

const SCHEDULE_STORE_FILE_NAME = "schedules/schedule.json";
const SCHEDULE_STORE_SCHEMA_VERSION = 1;

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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
 * The durable layout for every Checkpoint 8 schedule: one JSON document
 * (`schedules/schedule.json`, through the same `AtomicStore` primitive
 * `JobStore` uses) holding every schedule's definition and state together.
 * A single-document layout keeps "configure a schedule" and "record an
 * outcome/advance nextDueAt" both atomic without any cross-file consistency
 * concern -- exactly the same reasoning `jobStore.ts`'s own doc comment
 * gives for `jobs/queue.json`.
 *
 * `this.cached` is always a deeply-frozen, JSON-clean document, and every
 * mutation callback works on a deep-cloned mutable copy -- mirrors
 * `JobStore` field-for-field so ownership/corruption-safety guarantees stay
 * identical between the two stores.
 */
export class ScheduleStore {
  private readonly store: AtomicStore<ScheduleStoreDocumentV1>;
  private cached: ScheduleStoreDocumentV1 | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(fs: AtomicStoreFs, root: string) {
    this.store = new AtomicStore<ScheduleStoreDocumentV1>({
      fs,
      root,
      fileName: SCHEDULE_STORE_FILE_NAME,
      schemaVersion: SCHEDULE_STORE_SCHEMA_VERSION,
      parse: parseScheduleStoreDocumentV1,
      maxBytes: MAX_STORE_SERIALIZED_BYTES,
    });
  }

  cleanupStaleTempFiles(): Promise<number> {
    return this.store.cleanupStaleTempFiles();
  }

  private async loadOrInit(): Promise<ScheduleStoreDocumentV1> {
    if (this.cached) return this.cached;
    const loaded = await this.store.load();
    const doc = loaded ?? { schemaVersion: 1 as const, schedules: [] };
    this.cached = deepFreeze(doc);
    return this.cached;
  }

  /** Serializes every mutation through one in-process tail -- see `JobStore.mutate`'s doc comment; the same reasoning applies verbatim. */
  private mutate<T>(fn: (doc: ScheduleStoreDocumentV1) => { doc: ScheduleStoreDocumentV1; resultOf: (verified: ScheduleStoreDocumentV1) => T }): Promise<T> {
    const run = this.tail.then(async () => {
      const doc = await this.loadOrInit();
      const { doc: next, resultOf } = fn(doc);
      // Reference-equality skip (mirrors `JobStore.mutate`'s identical fast path) -- a genuine
      // no-op (e.g. removing an occurrenceId that's already gone from `pendingAcknowledgementIds`)
      // returns the exact same `doc` object, so there is nothing to persist.
      if (next === doc) {
        return resultOf(doc);
      }
      const verified = deepFreeze(parseScheduleStoreDocumentV1(deepClone(next)));
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

  /** Read-only; observes the last committed document, never blocks on or is blocked by an in-flight mutation. */
  async list(): Promise<readonly PersistedScheduleV1[]> {
    const doc = await this.loadOrInit();
    return doc.schedules;
  }

  async getById(id: ScheduleId): Promise<PersistedScheduleV1 | null> {
    const doc = await this.loadOrInit();
    return doc.schedules.find((entry) => entry.definition.id === id) ?? null;
  }

  /**
   * Inserts `schedule` if no schedule with its id exists yet; otherwise
   * updates the existing schedule's `definition` in place via
   * `configure` (its `state` is left untouched -- configuring a schedule's
   * cadence/enabled flag never resets its due-tracking progress). Either
   * way this is one atomic commit, so a concurrent `recordOutcome`/
   * `markDue` call for the same schedule can never interleave with it.
   */
  upsertDefinition(schedule: PersistedScheduleV1, configure: (current: PersistedScheduleV1) => PersistedScheduleV1): Promise<PersistedScheduleV1> {
    return this.mutate((doc) => {
      const index = doc.schedules.findIndex((entry) => entry.definition.id === schedule.definition.id);
      if (index === -1) {
        if (doc.schedules.length + 1 > MAX_SCHEDULE_COUNT) {
          throw new EngineError("SCHEDULE_CAP_EXCEEDED", `Cannot add schedule: ${doc.schedules.length} already persisted (max ${MAX_SCHEDULE_COUNT}).`, {});
        }
        const newId = schedule.definition.id;
        return { doc: { ...doc, schedules: [...doc.schedules, schedule] }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === newId)! };
      }
      const current = doc.schedules[index];
      const workingCopy = deepClone(current);
      const next = configure(workingCopy);
      assertScheduleIdentityUnchanged(current.definition, next.definition);
      if (JSON.stringify(next.state) !== JSON.stringify(current.state)) {
        throw new EngineError("SCHEDULE_TRANSITION_INVALID", "upsertDefinition's configure callback must not change state; use recordOutcome/markDue for that.", {});
      }
      const schedules = [...doc.schedules];
      schedules[index] = next;
      const id = schedule.definition.id;
      return { doc: { ...doc, schedules }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
    });
  }

  /**
   * Replaces one schedule's `state` with `updater(current.state)`; the
   * `definition` is left completely untouched. Enforces `nextDueAt` strict
   * advancement (requirement 2) so no caller -- outcome recording, due
   * marking, or a future reconcile pass -- can ever regress it, even by
   * accident.
   */
  updateState(id: ScheduleId, updater: (current: PersistedScheduleV1) => PersistedScheduleV1["state"]): Promise<PersistedScheduleV1> {
    return this.mutate((doc) => {
      const index = doc.schedules.findIndex((entry) => entry.definition.id === id);
      if (index === -1) {
        throw new EngineError("SCHEDULE_NOT_FOUND", `No persisted schedule with id "${id}".`, {});
      }
      const current = doc.schedules[index];
      const workingCopy = deepClone(current);
      const nextState = updater(workingCopy);
      assertNextDueAtAdvances(current.state, nextState);
      const next: PersistedScheduleV1 = { ...current, state: nextState };
      const schedules = [...doc.schedules];
      schedules[index] = next;
      return { doc: { ...doc, schedules }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
    });
  }

  /**
   * Crash protocol step (a) (requirement 6): durably records a not-yet-
   * finished scheduled occurrence's identity BEFORE the caller ever submits
   * it. Patches ONLY the three `pending*` fields -- `nextDueAt` (and every
   * other field) is left completely untouched, so this deliberately never
   * calls `assertNextDueAtAdvances` (nothing it would check has changed).
   * Idempotent in effect: calling it again with the exact same pending
   * triple before the occurrence resolves is a harmless no-op write.
   */
  setPendingOccurrence(id: ScheduleId, pending: { pendingOccurrenceId: string; pendingDueAt: string; pendingWorkFingerprint: string }): Promise<PersistedScheduleV1> {
    return this.mutate((doc) => {
      const index = doc.schedules.findIndex((entry) => entry.definition.id === id);
      if (index === -1) {
        throw new EngineError("SCHEDULE_NOT_FOUND", `No persisted schedule with id "${id}".`, {});
      }
      const current = doc.schedules[index];
      const next: PersistedScheduleV1 = { ...current, state: { ...current.state, ...pending } };
      const schedules = [...doc.schedules];
      schedules[index] = next;
      return { doc: { ...doc, schedules }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
    });
  }

  /**
   * Removes exactly one occurrenceId from `pendingAcknowledgementIds`, once
   * `CoreScheduler.reconcileAcknowledgements` has confirmed the
   * corresponding `JobStore` ack actually succeeded (last-acceptance
   * requirement 1). Patches ONLY that one field -- `nextDueAt` (and every
   * other field) is left untouched, so this never calls
   * `assertNextDueAtAdvances`. A no-op (via `mutate`'s reference-equality
   * skip, see its own doc comment) if the id is already absent -- safe to
   * call speculatively/repeatedly with no coordination.
   */
  removePendingAcknowledgementId(id: ScheduleId, occurrenceId: string): Promise<PersistedScheduleV1> {
    return this.mutate((doc) => {
      const index = doc.schedules.findIndex((entry) => entry.definition.id === id);
      if (index === -1) {
        throw new EngineError("SCHEDULE_NOT_FOUND", `No persisted schedule with id "${id}".`, {});
      }
      const current = doc.schedules[index];
      const existingIds = current.state.pendingAcknowledgementIds;
      if (existingIds === undefined || !existingIds.includes(occurrenceId)) {
        return { doc, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
      }
      const nextIds = existingIds.filter((entry) => entry !== occurrenceId);
      const next: PersistedScheduleV1 = { ...current, state: { ...current.state, pendingAcknowledgementIds: nextIds.length > 0 ? nextIds : undefined } };
      const schedules = [...doc.schedules];
      schedules[index] = next;
      return { doc: { ...doc, schedules }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
    });
  }

  /**
   * The one atomic reconfigure operation (requirement 1): replaces an
   * existing schedule's `definition` with `nextDefinition` AND recalculates
   * `state.nextDueAt` in the SAME commit, per a fixed policy --
   *  - cadence or timezone changed: recompute `nextDueAt` fresh from `nowMs`
   *    under the NEW definition (never phase-locked to the old cadence's
   *    prior due instant -- a materially different cadence has no
   *    meaningful "prior occurrence" to stay locked to).
   *  - disabled -> enabled: recompute a fresh `nextDueAt` from `nowMs` too,
   *    so a schedule that was disabled while overdue doesn't immediately
   *    fire the instant it's re-enabled with a stale due instant.
   *  - anything else (pipeline/scope-only change, enabled -> disabled, or
   *    no material change): `nextDueAt` -- and the rest of `state` -- is
   *    left completely untouched; disabling retains full history but
   *    produces no due execution (`CoreScheduler.processSchedule` already
   *    gates on `definition.enabled` regardless of `nextDueAt`).
   * This is the ONE allowed transition where the recomputed `nextDueAt` may
   * land EARLIER than the previous definition's `nextDueAt` -- deliberately
   * bypasses `assertNextDueAtAdvances` (never calls it), since a
   * reconfigure is a fresh statement of what's next, not an outcome
   * advancing forward from what was already committed. Serialized through
   * the same mutation tail as every other operation on this store, so a
   * `configure()` call racing a concurrent tick's `updateState()` for the
   * SAME schedule can never lose either update -- whichever commits second
   * simply reads the first's already-committed result as its own base.
   *
   * ALSO atomically invalidates a not-yet-finished pending occurrence
   * (requirement 6's last bullet) whenever the reconfigure changes anything
   * that pending occurrence's identity depended on: its due-state basis
   * (cadence/timezone/enabling, the same conditions that recompute
   * `nextDueAt` above) OR its work identity (`pipelineVersion`/`scopeId`,
   * compared via `computeScheduleWorkFingerprint`). A pipeline/scope-only
   * change alone still invalidates pending state even though it does NOT
   * touch `nextDueAt` -- the due INSTANT may be unaffected while the WORK
   * that instant would submit has changed underneath it. If that pending
   * occurrence's job was already durably submitted before this reconfigure
   * lands, its occurrenceId is moved into `state.pendingAcknowledgementIds`
   * in this SAME commit (never dropped, never left for the caller to
   * remember) -- `CoreScheduler.reconcileAcknowledgements` retries
   * acknowledging it on every subsequent tick until `JobStore` confirms
   * the ack actually succeeded, exactly like any other queued occurrence.
   */
  reconfigure(id: ScheduleId, nextDefinition: ScheduleDefinitionV1, nowMs: number): Promise<PersistedScheduleV1> {
    return this.mutate((doc) => {
      const index = doc.schedules.findIndex((entry) => entry.definition.id === id);
      if (index === -1) {
        throw new EngineError("SCHEDULE_NOT_FOUND", `No persisted schedule with id "${id}".`, {});
      }
      const current = doc.schedules[index];
      assertScheduleIdentityUnchanged(current.definition, nextDefinition);

      const cadenceChanged = JSON.stringify(current.definition.cadence) !== JSON.stringify(nextDefinition.cadence);
      const timezoneChanged = current.definition.timezone !== nextDefinition.timezone;
      const enablingNow = !current.definition.enabled && nextDefinition.enabled;
      const dueStateChanged = cadenceChanged || timezoneChanged || enablingNow;
      const workIdentityChanged = computeScheduleWorkFingerprint(current.definition) !== computeScheduleWorkFingerprint(nextDefinition);

      let nextState = dueStateChanged
        ? { ...current.state, nextDueAt: new Date(computeNextDueAfter(nextDefinition.cadence, nextDefinition.timezone, nowMs, undefined)).toISOString() }
        : current.state;

      if (nextState.pendingOccurrenceId !== undefined && (dueStateChanged || workIdentityChanged)) {
        // Invalidating the pending occurrence also retires its retry history: `lastOutcome`/
        // `lastFailureCode`/`consecutiveFailures` described THAT (now-abandoned) attempt, and a
        // freshly-computed pending occurrence for a different due instant/work identity is not a
        // continuation of it -- carrying them forward would make a later `submit-failed` retry's
        // own `pendingDueAt === lastDueAt` invariant (requirement 3) impossible to satisfy, since
        // `lastDueAt` would still name the abandoned occurrence, not the new one. `lastDueAt`/
        // `lastSubmittedAt`/`lastOccurrenceId`/`lastWorkFingerprint` are left untouched -- they are
        // a pure historical record of the last SUCCESS (if any), never touched by reconfigure.
        //
        // The abandoned occurrenceId is moved into `pendingAcknowledgementIds` IN THIS SAME COMMIT
        // (last-acceptance requirement 3) -- never left to a separate, later write, and never only
        // enforced by the caller (`CoreScheduler.configure`): if that occurrence's job was already
        // durably submitted before this reconfigure landed, its `JobStore` registry entry must
        // still eventually get acknowledged, and this is the one place that invalidation and that
        // durable record of "still needs acking" can never come apart.
        nextState = {
          ...nextState,
          pendingOccurrenceId: undefined,
          pendingDueAt: undefined,
          pendingWorkFingerprint: undefined,
          lastOutcome: undefined,
          lastFailureCode: undefined,
          consecutiveFailures: 0,
          pendingAcknowledgementIds: appendPendingAcknowledgementId(nextState.pendingAcknowledgementIds, nextState.pendingOccurrenceId),
        };
      }

      const next: PersistedScheduleV1 = { ...current, definition: nextDefinition, state: nextState };
      const schedules = [...doc.schedules];
      schedules[index] = next;
      return { doc: { ...doc, schedules }, resultOf: (verified) => verified.schedules.find((entry) => entry.definition.id === id)! };
    });
  }
}
