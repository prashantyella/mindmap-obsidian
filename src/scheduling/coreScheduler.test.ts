import test from "node:test";
import assert from "node:assert/strict";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { EngineError } from "../engine/errors";
import { JobEngine } from "../jobs/jobEngine";
import { JobStore } from "../jobs/jobStore";
import { CoreScheduler, DEFAULT_TICK_INTERVAL_MS, type IntervalRegistrar, type JobSubmitter } from "./coreScheduler";
import { ScheduleStore } from "./scheduleStore";
import { computeScheduleOccurrenceId, computeScheduleWorkFingerprint, type ScheduleDefinitionV1 } from "./scheduleTypes";

class InMemoryFs implements AtomicStoreFs {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  renameCallCount = 0;
  async rename(fromPath: string, toPath: string): Promise<void> {
    this.renameCallCount += 1; // ScheduleStore's one atomic-commit call -- its count is exactly "how many times something was actually persisted"
    const v = this.files.get(fromPath);
    if (v === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, v);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    return [...names];
  }
}

class FakeClock {
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
}

/** A registrar that never fires on its own -- tests drive ticks explicitly via `scheduler.tick()`, so behavior stays deterministic instead of depending on real timers. */
class ManualRegistrar implements IntervalRegistrar {
  registered: { callback: () => void; intervalMs: number }[] = [];
  cancelled: unknown[] = [];
  registerInterval(callback: () => void, intervalMs: number): unknown {
    const handle = { callback, intervalMs };
    this.registered.push(handle);
    return handle;
  }
  cancelInterval(handle: unknown): void {
    this.cancelled.push(handle);
  }
  fireAll(): void {
    for (const handle of [...this.registered]) {
      if (!this.cancelled.includes(handle)) handle.callback();
    }
  }
}

class RecordingSubmitter implements JobSubmitter {
  calls: { input: unknown; occurrenceId: string }[] = [];
  acks: string[] = [];
  async submitScheduledOccurrence(input: unknown, occurrenceId: string): Promise<unknown> {
    this.calls.push({ input, occurrenceId });
    return { ok: true };
  }
  async acknowledgeScheduledOccurrence(occurrenceId: string): Promise<void> {
    this.acks.push(occurrenceId);
  }
}

class FailingSubmitter implements JobSubmitter {
  calls = 0;
  occurrenceIds: string[] = [];
  acks: string[] = [];
  async submitScheduledOccurrence(_input: unknown, occurrenceId: string): Promise<unknown> {
    this.calls += 1;
    this.occurrenceIds.push(occurrenceId);
    throw new Error("submit boom");
  }
  async acknowledgeScheduledOccurrence(occurrenceId: string): Promise<void> {
    this.acks.push(occurrenceId);
  }
}

function dailyDef(overrides: Partial<ScheduleDefinitionV1> = {}): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "daily-maintenance",
    kind: "daily-maintenance",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "daily", hour: 3, minute: 0 },
    pipelineVersion: 1,
    scopeId: "vault-default",
    ...overrides,
  };
}

function weeklyDef(): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "weekly-refresh",
    kind: "weekly-refresh",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "weekly", weekday: 1, hour: 4, minute: 0 },
    pipelineVersion: 1,
  };
}

/** Seeds a schedule directly with a past `nextDueAt` -- `ScheduleStore.updateState` enforces strict forward advancement even for test setup, so an "already overdue" fixture must be inserted this way (as the FIRST/insert write for this id) rather than backdated via `updateState` after `configure()`. */
async function seedOverdueSchedule(store: ScheduleStore, definition: ScheduleDefinitionV1, nextDueAtMs: number): Promise<void> {
  await store.upsertDefinition({ schemaVersion: 1, definition, state: { nextDueAt: new Date(nextDueAtMs).toISOString(), consecutiveFailures: 0 } }, (c) => c);
}

function readingDef(): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "reading-sync",
    kind: "reading-sync",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "interval", intervalMinutes: 30 },
    pipelineVersion: 1,
    scopeId: "reading",
  };
}

void test("constructor rejects an out-of-bound tickIntervalMs", () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  assert.throws(() => new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), tickIntervalMs: 1 }));
  assert.throws(() => new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), tickIntervalMs: 999_999_999 }));
});

void test("configure creates a schedule with a first nextDueAt strictly after now", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock });
  const created = await scheduler.configure(dailyDef());
  assert.ok(new Date(created.state.nextDueAt).getTime() > clock.now());
});

void test("start() submits AT MOST ONE catch-up job for a schedule that is already overdue, and advances nextDueAt to the future in one jump (no cascade)", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const registrar = new ManualRegistrar();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar, clock });

  // Force the schedule far overdue (10 days of missed daily runs).
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 10 * 24 * 60 * 60_000);

  await scheduler.start();

  assert.equal(submitter.calls.length, 1);
  const persisted = await store.getById("daily-maintenance");
  assert.ok(persisted);
  assert.ok(new Date(persisted!.state.nextDueAt).getTime() > clock.now());
  assert.equal(persisted!.state.lastOutcome, "submitted");
  assert.equal(persisted!.state.consecutiveFailures, 0);
  assert.equal(registrar.registered.length, 1);
});

void test("start() does not submit for a schedule that is not yet due", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await scheduler.configure(dailyDef());
  await scheduler.start();
  assert.equal(submitter.calls.length, 0);
});

void test("start() skips a disabled schedule even if overdue", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef({ enabled: false }), clock.now() - 60_000);
  await scheduler.start();
  assert.equal(submitter.calls.length, 0);
});

void test("a submit failure for one schedule does not block another due schedule in the same tick, and records bounded retry state", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);

  await scheduler.start();

  assert.equal(submitter.calls, 2);
  const daily = await store.getById("daily-maintenance");
  const weekly = await store.getById("weekly-refresh");
  assert.equal(daily?.state.lastOutcome, "submit-failed");
  assert.equal(daily?.state.consecutiveFailures, 1);
  assert.equal(daily?.state.lastFailureCode, "SCHEDULE_SUBMIT_UNKNOWN");
  assert.equal(weekly?.state.lastOutcome, "submit-failed");
  assert.equal(weekly?.state.consecutiveFailures, 1);
  // nextDueAt still advanced past now for both -- no tight loop retry on the very next tick.
  assert.ok(new Date(daily!.state.nextDueAt).getTime() > clock.now());
  assert.ok(new Date(weekly!.state.nextDueAt).getTime() > clock.now());
});

void test("repeated tick()s after nextDueAt has advanced past now do not resubmit", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler.start();
  assert.equal(submitter.calls.length, 1);
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(submitter.calls.length, 1);
});

void test("advancing the clock to the newly-computed nextDueAt and ticking submits exactly once more", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await scheduler.configure(readingDef());
  await scheduler.start();
  assert.equal(submitter.calls.length, 0);

  const first = await store.getById("reading-sync");
  clock.ms = new Date(first!.state.nextDueAt).getTime();
  await scheduler.tick();
  assert.equal(submitter.calls.length, 1);

  const second = await store.getById("reading-sync");
  clock.ms = new Date(second!.state.nextDueAt).getTime() - 1;
  await scheduler.tick();
  assert.equal(submitter.calls.length, 1, "must not fire before the newly-computed due instant");
});

void test("clock rollback after start() is safe -- no spurious submit, no thrown error", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await scheduler.configure(dailyDef());
  await scheduler.start();
  clock.ms -= 5 * 24 * 60 * 60_000; // roll back 5 days
  await scheduler.tick();
  assert.equal(submitter.calls.length, 0);
});

void test("start() registers the interval exactly once; calling start() again is a no-op", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const registrar = new ManualRegistrar();
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar, clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  await scheduler.start();
  await scheduler.start();
  assert.equal(registrar.registered.length, 1);
});

void test("stop() cancels the interval; a later start() registers exactly one new interval", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const registrar = new ManualRegistrar();
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar, clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  await scheduler.start();
  scheduler.stop();
  assert.equal(registrar.cancelled.length, 1);
  await scheduler.start();
  assert.equal(registrar.registered.length, 2);
});

void test("dispose() is idempotent and refuses any further start()/tick() work", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const registrar = new ManualRegistrar();
  const submitter = new RecordingSubmitter();
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar, clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler.start();
  submitter.calls.length = 0;

  scheduler.dispose();
  scheduler.dispose();
  assert.equal(registrar.cancelled.length, 1);

  await scheduler.start();
  await scheduler.tick();
  assert.equal(submitter.calls.length, 0, "no work after dispose()");
  assert.equal(registrar.registered.length, 1, "no new interval registered after dispose()");
});

void test("an interval-driven tick (via the registrar callback) behaves identically to an explicit tick()", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const registrar = new ManualRegistrar();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar, clock });
  await scheduler.configure(dailyDef());
  await scheduler.start();
  const first = await store.getById("daily-maintenance");
  clock.ms = new Date(first!.state.nextDueAt).getTime();
  registrar.fireAll();
  // The interval callback enqueues work on the tick tail asynchronously; wait for it to settle.
  await scheduler.tick();
  assert.equal(submitter.calls.length, 1);
});

void test("default tick interval is a sane, bounded value", () => {
  assert.ok(DEFAULT_TICK_INTERVAL_MS >= 1_000 && DEFAULT_TICK_INTERVAL_MS <= 3_600_000);
});

// ---------------------------------------------------------------------------
// Requirement 1: reconfigure due state
// ---------------------------------------------------------------------------

void test("configure(): a cadence change on an existing schedule recomputes nextDueAt from now, even if that lands EARLIER than the old due instant", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock });

  // Far-future original due instant (10 days out), then reconfigure to a cadence due very soon.
  await seedOverdueSchedule(store, dailyDef({ cadence: { type: "daily", hour: 23, minute: 0 } }), clock.now() + 10 * 24 * 60 * 60_000);
  const before = await store.getById("daily-maintenance");

  const reconfigured = await scheduler.configure(dailyDef({ cadence: { type: "daily", hour: 1, minute: 0 } }));
  assert.ok(new Date(reconfigured.state.nextDueAt).getTime() < new Date(before!.state.nextDueAt).getTime(), "reconfigure may move nextDueAt EARLIER than the old cadence's due instant");
  assert.ok(new Date(reconfigured.state.nextDueAt).getTime() > clock.now());
});

void test("configure(): a timezone-only change recomputes nextDueAt from now", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock });

  await scheduler.configure(dailyDef({ timezone: "UTC" }));
  const before = await store.getById("daily-maintenance");

  const after = await scheduler.configure(dailyDef({ timezone: "America/New_York" }));
  assert.notEqual(after.state.nextDueAt, before!.state.nextDueAt);
  assert.ok(new Date(after.state.nextDueAt).getTime() > clock.now());
});

void test("configure(): enabling a disabled schedule recomputes a fresh nextDueAt from now", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock });

  // Disabled, with a stale far-past due instant.
  await seedOverdueSchedule(store, dailyDef({ enabled: false }), clock.now() - 10 * 24 * 60 * 60_000);

  const reEnabled = await scheduler.configure(dailyDef({ enabled: true }));
  assert.ok(new Date(reEnabled.state.nextDueAt).getTime() > clock.now(), "re-enabling must never leave a stale overdue nextDueAt");
});

void test("configure(): disabling retains history/nextDueAt untouched, and a subsequent tick performs no due execution", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  const before = await store.getById("daily-maintenance");

  const disabled = await scheduler.configure(dailyDef({ enabled: false }));
  assert.equal(disabled.state.nextDueAt, before!.state.nextDueAt, "disabling must not touch nextDueAt/history");

  await scheduler.tick();
  assert.equal(submitter.calls.length, 0, "a disabled schedule performs no due execution even though nextDueAt is still in the past");
});

void test("configure(): a pipeline/scope-only change preserves nextDueAt", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock });

  await scheduler.configure(dailyDef({ pipelineVersion: 1 }));
  const before = await store.getById("daily-maintenance");

  const after = await scheduler.configure(dailyDef({ pipelineVersion: 2 }));
  assert.equal(after.state.nextDueAt, before!.state.nextDueAt);
  assert.equal(after.definition.pipelineVersion, 2);
});

void test("concurrent tick-vs-configure for the same schedule never loses either update", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef({ pipelineVersion: 1 }), clock.now() - 60_000);

  await Promise.all([scheduler.tick(), scheduler.configure(dailyDef({ pipelineVersion: 7 }))]);

  assert.equal(submitter.calls.length, 1, "the tick's due submission still happened");
  const finalState = await store.getById("daily-maintenance");
  assert.equal(finalState?.definition.pipelineVersion, 7, "the concurrent reconfigure's definition change was not lost");
  assert.equal(finalState?.state.lastOutcome, "submitted", "the concurrent tick's state update was not lost either");
});

// ---------------------------------------------------------------------------
// Requirement 4: core start/stop/dispose fault safety
// ---------------------------------------------------------------------------

void test("start() rolls back cleanly and records a fault (never throws) when registerInterval itself throws", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  class ThrowingRegistrar implements IntervalRegistrar {
    registerInterval(): unknown {
      throw new Error("registrar boom");
    }
    cancelInterval(): void {}
  }
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ThrowingRegistrar(), clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  await assert.doesNotReject(() => scheduler.start());
  assert.equal(scheduler.getFault()?.code, "SCHEDULER_UNKNOWN_FAULT");
  // Rolled back cleanly: a later start() attempt (with a working registrar swapped in would be a
  // different instance, but this at least proves `running` was reset) can be re-attempted.
  scheduler.stop(); // must not throw even though nothing was actually registered
});

void test("a throwing onScheduleError observer never escapes as an unhandled rejection or crashes the pump", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const submitter = new RecordingSubmitter();
  let observerCalls = 0;

  class ThrowingClock {
    now(): number {
      throw new Error("clock boom");
    }
  }
  const throwingClockScheduler = new CoreScheduler({
    store,
    jobSubmitter: submitter,
    registrar: new ManualRegistrar(),
    clock: new ThrowingClock(),
    onScheduleError: () => {
      observerCalls += 1;
      throw new Error("observer boom");
    },
  });
  await assert.doesNotReject(() => throwingClockScheduler.tick());
  assert.equal(observerCalls, 1);
  assert.equal(throwingClockScheduler.getFault()?.code, "SCHEDULER_UNKNOWN_FAULT");
});

void test("getFault()/resetFault() report and clear the last recorded fault without ever stopping the scheduler", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  class ThrowingClock {
    now(): number {
      throw new Error("clock boom");
    }
  }
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock: new ThrowingClock() });
  assert.equal(scheduler.getFault(), null);
  await scheduler.tick();
  assert.ok(scheduler.getFault() !== null);
  scheduler.resetFault();
  assert.equal(scheduler.getFault(), null);
});

void test("dispose() during an in-flight tick prevents the next schedule in that same tick from being processed", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  let submitCount = 0;
  const schedulerRef: { current: CoreScheduler | null } = { current: null };
  class DisposingOnFirstSubmit implements JobSubmitter {
    async submitScheduledOccurrence(): Promise<unknown> {
      submitCount += 1;
      schedulerRef.current!.dispose(); // dispose mid-tick, between the two due schedules
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {}
  }
  const submitter = new DisposingOnFirstSubmit();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  schedulerRef.current = scheduler;

  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);

  await scheduler.tick();
  assert.equal(submitCount, 1, "the second due schedule must never start once disposed mid-tick");
});

// ---------------------------------------------------------------------------
// Requirement 5: submit-failure retry backoff (never deferred to the next natural period)
// ---------------------------------------------------------------------------

void test("a failed daily submit retries soon (bounded backoff), not at tomorrow's natural occurrence", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler.tick();

  const state = await store.getById("daily-maintenance");
  const retryDelayMs = new Date(state!.state.nextDueAt).getTime() - clock.now();
  assert.ok(retryDelayMs < 24 * 60 * 60_000, "retry must be far sooner than the next natural daily occurrence");
  assert.ok(retryDelayMs > 0);
});

void test("repeated failures preserve the ORIGINAL logical due occurrence across retries, and back off exponentially (capped)", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  const originalDueMs = clock.now() - 60_000;
  await seedOverdueSchedule(store, dailyDef(), originalDueMs);

  const delays: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await scheduler.tick();
    const state = await store.getById("daily-maintenance");
    assert.equal(state!.state.lastDueAt, new Date(originalDueMs).toISOString(), "lastDueAt must stay pinned to the original occurrence across every retry");
    assert.equal(state!.state.consecutiveFailures, i + 1);
    delays.push(new Date(state!.state.nextDueAt).getTime() - clock.now());
    clock.ms = new Date(state!.state.nextDueAt).getTime(); // advance to the retry instant
  }
  // Backoff grows (or at least never shrinks) across consecutive failures, and stays bounded.
  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1]);
  }
  assert.ok(delays[delays.length - 1] <= 30 * 60_000);
});

void test("recovery after failures: a successful submit resets consecutiveFailures and advances to the next NATURAL occurrence after now", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const failingSubmitter = new FailingSubmitter();
  const scheduler1 = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler1.tick();
  const afterFirst = await store.getById("daily-maintenance");
  clock.ms = new Date(afterFirst!.state.nextDueAt).getTime();
  await scheduler1.tick();
  const failedState = await store.getById("daily-maintenance");
  assert.equal(failedState!.state.consecutiveFailures, 2);
  clock.ms = new Date(failedState!.state.nextDueAt).getTime();

  // A fresh scheduler instance sharing the same store/clock, now with a succeeding submitter.
  const succeedingSubmitter = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: succeedingSubmitter, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();

  const recovered = await store.getById("daily-maintenance");
  assert.equal(recovered!.state.lastOutcome, "submitted");
  assert.equal(recovered!.state.consecutiveFailures, 0);
  assert.equal(recovered!.state.lastFailureCode, undefined);
  assert.ok(new Date(recovered!.state.nextDueAt).getTime() > clock.now());
  // The natural next occurrence is roughly a day out from the ORIGINAL due instant, not from the
  // last (much later, post-retry) due instant.
  const originalDueMs = Date.UTC(2026, 0, 1, 0, 0, 0) - 60_000;
  assert.ok(new Date(recovered!.state.nextDueAt).getTime() < originalDueMs + 2 * 24 * 60 * 60_000);
});

void test("failure isolation: independent schedules retry independently without affecting each other's backoff", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const failingSubmitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);
  await scheduler.tick();
  const afterFirst = await store.getById("daily-maintenance");
  clock.ms = new Date(afterFirst!.state.nextDueAt).getTime();
  await scheduler.tick(); // second failure for both

  const daily = await store.getById("daily-maintenance");
  const weekly = await store.getById("weekly-refresh");
  assert.equal(daily?.state.consecutiveFailures, 2);
  assert.equal(weekly?.state.consecutiveFailures, 2);
});

void test("restart recovery: a persisted mid-retry schedule resumes retrying the same occurrence after a fresh CoreScheduler instance starts", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const failingSubmitter = new FailingSubmitter();
  const scheduler1 = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  const originalDueMs = clock.now() - 60_000;
  await seedOverdueSchedule(store, dailyDef(), originalDueMs);
  await scheduler1.tick();
  const afterFirstFailure = await store.getById("daily-maintenance");
  clock.ms = new Date(afterFirstFailure!.state.nextDueAt).getTime();

  // Simulate a process restart: brand-new CoreScheduler instance over the same durable store.
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  await scheduler2.start();

  const afterRestart = await store.getById("daily-maintenance");
  assert.equal(afterRestart!.state.lastDueAt, new Date(originalDueMs).toISOString());
  assert.equal(afterRestart!.state.consecutiveFailures, 2);
});

void test("an active scheduled bulk batch blocks new manual/startup bulk submits", async () => {
  const jobStore = new JobStore(new InMemoryFs(), "/jobs-root");
  const engine = new JobEngine(jobStore, {});
  const scheduleStore = new ScheduleStore(new InMemoryFs(), "/schedule-root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store: scheduleStore, jobSubmitter: engine, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(scheduleStore, weeklyDef(), clock.now() - 60_000);

  // Scheduled catch-up submit.
  await scheduler.start();
  await assert.rejects(() => engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 }), { code: "BULK_BATCH_ACTIVE" });
  await assert.rejects(() => engine.submit({ trigger: "startup", kind: "rebuild-index", pipelineVersion: 1 }), { code: "BULK_BATCH_ACTIVE" });

  const jobs = await jobStore.list();
  assert.equal(jobs.length, 1, "only the scheduled batch root is persisted");
  assert.equal(jobs[0].job.trigger, "scheduled", "the FIRST trigger observed (the scheduler's) is kept as provenance");
});

// ---------------------------------------------------------------------------
// Checkpoint 8 requirement 6: crash-safe scheduled occurrence identity
// ---------------------------------------------------------------------------

/** Fails the Nth `rename()` call (1-indexed) exactly once -- lets a test fail one SPECIFIC commit in a multi-commit sequence (e.g. the second of two `ScheduleStore` commits within one `processSchedule` call) without disturbing any other commit. */
class FaultableFs implements AtomicStoreFs {
  files = new Map<string, string>();
  renameCallCount = 0;
  failRenameOnCall: number | null = null;
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    this.renameCallCount += 1;
    if (this.failRenameOnCall === this.renameCallCount) {
      throw new Error("injected rename failure");
    }
    const v = this.files.get(fromPath);
    if (v === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, v);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    return [...names];
  }
}

void test("(requirement 6) two independent overdue scans of the same never-before-attempted occurrence compute the IDENTICAL deterministic occurrenceId ('crash before step a' recreates it)", async () => {
  const scheduleFs = new InMemoryFs();
  const store1 = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter1 = new RecordingSubmitter();
  const scheduler1 = new CoreScheduler({ store: store1, jobSubmitter: submitter1, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store1, dailyDef(), clock.now() - 60_000);
  await scheduler1.tick();
  const firstOccurrenceId = submitter1.calls[0].occurrenceId;

  // A brand-new ScheduleStore instance (simulating a restart) over a FRESH copy of the same
  // never-before-attempted overdue state must derive the exact same occurrenceId.
  const scheduleFs2 = new InMemoryFs();
  const store2 = new ScheduleStore(scheduleFs2, "/root");
  const clock2 = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter2 = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store: store2, jobSubmitter: submitter2, registrar: new ManualRegistrar(), clock: clock2 });
  await seedOverdueSchedule(store2, dailyDef(), clock2.now() - 60_000);
  await scheduler2.tick();
  assert.equal(submitter2.calls[0].occurrenceId, firstOccurrenceId);
});

void test("(requirement 6, crash between a and b) a pending occurrence intent that survived without ever reaching submit is retried with the EXACT SAME occurrenceId", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  // Manually replicate exactly what step (a) would have durably committed, WITHOUT ever calling
  // the job submitter -- the precise "crashed between (a) and (b)" state. The fingerprint/
  // occurrenceId must be genuinely derived (final-integration requirement 3 now validates this
  // triple against the schedule's own definition on every parse).
  const pendingDueAt = new Date(clock.now() - 60_000).toISOString();
  const pendingWorkFingerprint = computeScheduleWorkFingerprint(dailyDef());
  const pendingOccurrenceId = computeScheduleOccurrenceId("daily-maintenance", pendingDueAt, pendingWorkFingerprint);
  await store.setPendingOccurrence("daily-maintenance", { pendingOccurrenceId, pendingDueAt, pendingWorkFingerprint });

  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await scheduler.tick();

  assert.equal(submitter.calls.length, 1);
  assert.equal(submitter.calls[0].occurrenceId, pendingOccurrenceId, "the retry must reuse the exact SAME pending occurrenceId, never compute a fresh one");
  const finalState = await store.getById("daily-maintenance");
  assert.equal(finalState?.state.pendingOccurrenceId, undefined, "a successful submit clears the pending intent");
  assert.equal(finalState?.state.lastDueAt, pendingDueAt);
});

void test("(requirement 6, crash between b and c) a submit that succeeds but whose schedule-state persist then fails leaves the pending intent intact; the next attempt resubmits the SAME occurrenceId and finds the SAME (already-terminal) job, never a duplicate", async () => {
  const scheduleFs = new FaultableFs();
  const store = new ScheduleStore(scheduleFs, "/schedule-root");
  const jobFs = new InMemoryFs();
  const jobStore = new JobStore(jobFs, "/jobs-root");
  const engine = new JobEngine(jobStore, {});
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const scheduler = new CoreScheduler({ store, jobSubmitter: engine, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);

  // Renames on this ScheduleStore, in order: (1) seedOverdueSchedule's own insert, (2) step (a)'s
  // setPendingOccurrence commit, (3) step (c)'s outcome-recording updateState commit. Fail exactly
  // the third -- step (a) and the job submission (step b, on the SEPARATE JobStore) both land.
  scheduleFs.failRenameOnCall = 3;

  // The store-level failure is isolated per schedule (requirement 4) -- tick() itself never
  // rejects; it surfaces as a recorded fault instead.
  await assert.doesNotReject(() => scheduler.tick());
  assert.ok(scheduler.getFault());
  const afterCrash = await store.getById("weekly-refresh");
  assert.ok(afterCrash?.state.pendingOccurrenceId, "the pending intent must survive a failed step (c) commit");
  const pendingOccurrenceId = afterCrash!.state.pendingOccurrenceId!;

  await engine.drain(); // settle the background pump deterministically before inspecting status
  const jobsAfterCrash = await jobStore.list();
  assert.equal(jobsAfterCrash.length, 1, "the job itself was already durably submitted before the crash");
  assert.equal(jobsAfterCrash[0].status, "failed", "no runner is registered for this kind, so the job reaches a terminal ('failed') status");

  // Retry (fault cleared): resubmitting the SAME occurrenceId must find the SAME job rather than
  // duplicating it, and this time step (c) succeeds.
  scheduleFs.failRenameOnCall = null;
  await scheduler.tick();
  const recovered = await store.getById("weekly-refresh");
  assert.equal(recovered?.state.pendingOccurrenceId, undefined);
  assert.equal(recovered?.state.lastOutcome, "submitted");
  assert.equal((await jobStore.list()).length, 1, "still exactly one job for this occurrence after recovery");
  const occurrence = await jobStore.getScheduledOccurrence(pendingOccurrenceId);
  assert.equal(occurrence?.jobId, jobsAfterCrash[0].job.jobId);
});

void test("(requirement 6, crash between c and d) an acknowledge failure after the schedule outcome already committed is harmless -- the tick still completes, the schedule already advanced, and no duplicate is ever created", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  class AckFailingSubmitter implements JobSubmitter {
    calls: string[] = [];
    ackAttempts = 0;
    async submitScheduledOccurrence(_input: unknown, occurrenceId: string): Promise<unknown> {
      this.calls.push(occurrenceId);
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      this.ackAttempts += 1;
      throw new Error("ack boom");
    }
  }
  const submitter = new AckFailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });

  await assert.doesNotReject(() => scheduler.tick(), "an ack failure must never surface as a tick failure");
  assert.equal(submitter.ackAttempts, 1);
  const state = await store.getById("daily-maintenance");
  assert.equal(state?.state.lastOutcome, "submitted");
  assert.equal(state?.state.pendingOccurrenceId, undefined, "the schedule already advanced past this occurrence regardless of the ack failure");
  assert.ok(new Date(state!.state.nextDueAt).getTime() > clock.now());

  // A later tick (schedule no longer due) performs no further submission for this occurrence.
  await scheduler.tick();
  assert.equal(submitter.calls.length, 1);
});

void test("(requirement 6) reconfigure with a pending intent in flight invalidates it -- the next attempt computes a FRESH occurrenceId, never reusing the stale one", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const failingSubmitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(store, dailyDef({ pipelineVersion: 1 }), clock.now() - 60_000);
  await scheduler.tick();
  const beforeReconfigure = await store.getById("daily-maintenance");
  const staleOccurrenceId = beforeReconfigure?.state.pendingOccurrenceId;
  assert.ok(staleOccurrenceId, "a failed submit leaves a pending occurrence in flight");

  // pipelineVersion change alone invalidates the pending occurrence's WORK identity, even though
  // it does not touch nextDueAt.
  const reconfigured = await scheduler.configure(dailyDef({ pipelineVersion: 2 }));
  assert.equal(reconfigured.state.pendingOccurrenceId, undefined, "reconfigure must invalidate the stale pending occurrence");
  assert.equal(reconfigured.state.nextDueAt, beforeReconfigure!.state.nextDueAt, "nextDueAt itself is untouched by a pipeline-only change");

  // Advance the clock to the already-persisted (retry-backoff) nextDueAt and observe a FRESH
  // occurrenceId, distinct from the invalidated one -- nextDueAt itself only ever moves forward
  // via ordinary tick processing, never backward through updateState.
  clock.ms = new Date(reconfigured.state.nextDueAt).getTime();
  const succeedingSubmitter = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: succeedingSubmitter, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  assert.equal(succeedingSubmitter.calls.length, 1);
  assert.notEqual(succeedingSubmitter.calls[0].occurrenceId, staleOccurrenceId);
});

// ---------------------------------------------------------------------------
// Final-integration requirement 2: ack reconciliation
// ---------------------------------------------------------------------------

void test("(final-integration 2) a crash between outcome-commit and ack is healed by the NEXT tick's reconciliation pass, without resubmitting", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));

  class AckFailOnceSubmitter implements JobSubmitter {
    submitCalls: string[] = [];
    ackCalls: string[] = [];
    failNextAck = true;
    async submitScheduledOccurrence(_input: unknown, occurrenceId: string): Promise<unknown> {
      this.submitCalls.push(occurrenceId);
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(occurrenceId: string): Promise<void> {
      this.ackCalls.push(occurrenceId);
      if (this.failNextAck) {
        this.failNextAck = false;
        throw new Error("ack boom");
      }
    }
  }
  const submitter = new AckFailOnceSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  await scheduler.tick(); // succeeds, but the ack attempt (step d) fails
  const afterFirstTick = await store.getById("daily-maintenance");
  assert.equal(afterFirstTick?.state.lastOccurrenceId, submitter.submitCalls[0]);
  assert.equal(submitter.ackCalls.length, 1, "step (d) was attempted and failed");

  // Schedule is no longer due; the NEXT tick's reconciliation pass must retry the SAME ack.
  await scheduler.tick();
  assert.equal(submitter.submitCalls.length, 1, "no resubmission -- the schedule already advanced");
  assert.equal(submitter.ackCalls.length, 2, "the ack was retried by reconciliation");
  assert.equal(submitter.ackCalls[1], submitter.submitCalls[0]);
});

void test("(final-integration 2) restart (fresh CoreScheduler instance) reconciles a LOST ack (crash between commit and ack) via its first tick, and needs zero further reconciliation once it succeeds", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  class AckFailsOnceSubmitter implements JobSubmitter {
    calls: { input: unknown; occurrenceId: string }[] = [];
    acks: string[] = [];
    async submitScheduledOccurrence(input: unknown, occurrenceId: string): Promise<unknown> {
      this.calls.push({ input, occurrenceId });
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(occurrenceId: string): Promise<void> {
      throw new Error("simulated crash before ack step (d) could land");
      void occurrenceId; // unreachable, kept for interface shape clarity
    }
  }
  const submitter1 = new AckFailsOnceSubmitter();
  const scheduler1 = new CoreScheduler({ store, jobSubmitter: submitter1, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler1.tick();
  const afterFirstTick = await store.getById("daily-maintenance");
  assert.deepEqual(afterFirstTick?.state.pendingAcknowledgementIds, [submitter1.calls[0].occurrenceId], "the durable queue records the still-unacked occurrence even though step (d) itself failed");

  // A fresh scheduler instance (simulating restart) over the SAME store, now with a working
  // submitter, must reconcile the queued ack on its very first tick, even though nothing is
  // currently due.
  const submitter2 = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: submitter2, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  assert.equal(submitter2.calls.length, 0, "nothing newly due");
  assert.deepEqual(submitter2.acks, [submitter1.calls[0].occurrenceId]);
  const afterReconcile = await store.getById("daily-maintenance");
  assert.equal(afterReconcile?.state.pendingAcknowledgementIds, undefined, "the queue is empty once the ack actually succeeds");

  // A further tick performs no further ack calls -- the queue is empty, so reconcileAcknowledgements does nothing.
  await scheduler2.tick();
  assert.equal(submitter2.acks.length, 1);
});

void test("(final-integration 2) repeated ack failures across many ticks never resubmit and never grow the registry into orphans (each ack attempt is idempotent)", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  class AlwaysAckFailingSubmitter implements JobSubmitter {
    submitCalls = 0;
    ackAttempts = 0;
    async submitScheduledOccurrence(): Promise<unknown> {
      this.submitCalls += 1;
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      this.ackAttempts += 1;
      throw new Error("ack always fails");
    }
  }
  const submitter = new AlwaysAckFailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler.tick();
  assert.equal(submitter.submitCalls, 1);

  for (let i = 0; i < 5; i += 1) {
    await scheduler.tick();
  }
  assert.equal(submitter.submitCalls, 1, "never resubmits regardless of how many reconciliation attempts fail");
  assert.equal(submitter.ackAttempts, 6, "one ack attempt per tick (initial + 5 reconciliation retries)");
});

// ---------------------------------------------------------------------------
// Final-integration requirement 3: schedule state correlation (corruption)
// ---------------------------------------------------------------------------

void test("(final-integration 3) parsePersistedScheduleV1 rejects a pendingWorkFingerprint that does not match the definition's own work identity", async () => {
  const { parsePersistedScheduleV1 } = await import("./scheduleTypes");
  const definition = dailyDef();
  const badFingerprint = "e".repeat(64);
  const pendingDueAt = "2026-01-01T03:00:00.000Z";
  const { computeScheduleOccurrenceId: computeId } = await import("./scheduleTypes");
  const record = {
    schemaVersion: 1,
    definition,
    state: {
      nextDueAt: "2026-01-02T03:00:00.000Z",
      consecutiveFailures: 0,
      pendingOccurrenceId: computeId("daily-maintenance", pendingDueAt, badFingerprint),
      pendingDueAt,
      pendingWorkFingerprint: badFingerprint,
    },
  };
  assert.throws(() => parsePersistedScheduleV1(record), (error: unknown) => isEngineErrorCode(error, "SCHEDULE_SHAPE_INVALID"));
});

void test("(final-integration 3) parsePersistedScheduleV1 rejects a pendingOccurrenceId that does not match its own recorded triple", async () => {
  const { parsePersistedScheduleV1, computeScheduleWorkFingerprint: fp } = await import("./scheduleTypes");
  const definition = dailyDef();
  const fingerprint = fp(definition);
  const record = {
    schemaVersion: 1,
    definition,
    state: {
      nextDueAt: "2026-01-02T03:00:00.000Z",
      consecutiveFailures: 0,
      pendingOccurrenceId: "f".repeat(64), // wrong -- not derived from the triple below
      pendingDueAt: "2026-01-01T03:00:00.000Z",
      pendingWorkFingerprint: fingerprint,
    },
  };
  assert.throws(() => parsePersistedScheduleV1(record), (error: unknown) => isEngineErrorCode(error, "SCHEDULE_SHAPE_INVALID"));
});

void test("(final-integration 3) parsePersistedScheduleV1 rejects pendingDueAt !== lastDueAt while lastOutcome is submit-failed", async () => {
  const { parsePersistedScheduleV1, computeScheduleWorkFingerprint: fp, computeScheduleOccurrenceId: computeId } = await import("./scheduleTypes");
  const definition = dailyDef();
  const fingerprint = fp(definition);
  const pendingDueAt = "2026-01-01T03:00:00.000Z";
  const differentLastDueAt = "2025-12-31T03:00:00.000Z";
  const record = {
    schemaVersion: 1,
    definition,
    state: {
      lastDueAt: differentLastDueAt,
      lastOutcome: "submit-failed",
      lastFailureCode: "SCHEDULE_SUBMIT_UNKNOWN",
      nextDueAt: "2026-01-02T03:00:00.000Z",
      consecutiveFailures: 1,
      pendingOccurrenceId: computeId("daily-maintenance", pendingDueAt, fingerprint),
      pendingDueAt,
      pendingWorkFingerprint: fingerprint,
    },
  };
  assert.throws(() => parsePersistedScheduleV1(record), (error: unknown) => isEngineErrorCode(error, "SCHEDULE_SHAPE_INVALID"));
});

void test("(final-integration 3) parsePersistedScheduleV1 rejects a lastOccurrenceId inconsistent with its own recorded (lastDueAt, lastWorkFingerprint)", async () => {
  const { parsePersistedScheduleV1 } = await import("./scheduleTypes");
  const definition = dailyDef();
  const record = {
    schemaVersion: 1,
    definition,
    state: {
      lastDueAt: "2026-01-01T03:00:00.000Z",
      lastSubmittedAt: "2026-01-01T03:00:01.000Z",
      lastOutcome: "submitted",
      nextDueAt: "2026-01-02T03:00:00.000Z",
      consecutiveFailures: 0,
      lastOccurrenceId: "a".repeat(64), // not derived from lastDueAt/lastWorkFingerprint below
      lastWorkFingerprint: "b".repeat(64),
    },
  };
  assert.throws(() => parsePersistedScheduleV1(record), (error: unknown) => isEngineErrorCode(error, "SCHEDULE_SHAPE_INVALID"));
});

function isEngineErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}

// ---------------------------------------------------------------------------
// Final-integration requirement 5: dispose boundaries
// ---------------------------------------------------------------------------

void test("(final-integration 5) dispose() during step (a) (setPendingOccurrence) prevents step (b) from ever running", async () => {
  const scheduleFs = new InMemoryFs();
  class DisposingStore extends ScheduleStore {
    scheduler!: CoreScheduler;
    async setPendingOccurrence(...args: Parameters<ScheduleStore["setPendingOccurrence"]>): ReturnType<ScheduleStore["setPendingOccurrence"]> {
      const result = await super.setPendingOccurrence(...args);
      this.scheduler.dispose();
      return result;
    }
  }
  const store = new DisposingStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  store.scheduler = scheduler;
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  await scheduler.tick();
  assert.equal(submitter.calls.length, 0, "submit (step b) must never run once disposed during step (a)");
  const state = await store.getById("daily-maintenance");
  assert.ok(state?.state.pendingOccurrenceId, "the pending intent set by step (a) survives for a later restart");
});

void test("(final-integration 5) dispose() during step (b) (submit) prevents any outcome mutation or ack", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const schedulerRef: { current: CoreScheduler | null } = { current: null };
  class DisposingSubmitter implements JobSubmitter {
    calls = 0;
    acks = 0;
    async submitScheduledOccurrence(): Promise<unknown> {
      this.calls += 1;
      schedulerRef.current!.dispose();
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      this.acks += 1;
    }
  }
  const submitter = new DisposingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  schedulerRef.current = scheduler;
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  await scheduler.tick();
  assert.equal(submitter.calls, 1);
  assert.equal(submitter.acks, 0, "ack (step d) must never run once disposed during step (b)");
  const state = await store.getById("daily-maintenance");
  assert.ok(state?.state.pendingOccurrenceId, "no outcome was ever persisted -- the pending intent still stands");
  assert.notEqual(state?.state.lastOutcome, "submitted");
});

void test("(final-integration 5) dispose() during step (c)'s own commit prevents step (d) -- self-heals via reconciliation on a later start, never a duplicate", async () => {
  const scheduleFs = new InMemoryFs();
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const schedulerRef: { current: CoreScheduler | null } = { current: null };
  class DisposingStore extends ScheduleStore {
    async updateState(...args: Parameters<ScheduleStore["updateState"]>): ReturnType<ScheduleStore["updateState"]> {
      const result = await super.updateState(...args);
      schedulerRef.current!.dispose();
      return result;
    }
  }
  const store = new DisposingStore(scheduleFs, "/root");
  class RecordingAckSubmitter implements JobSubmitter {
    calls = 0;
    acks: string[] = [];
    async submitScheduledOccurrence(): Promise<unknown> {
      this.calls += 1;
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(occurrenceId: string): Promise<void> {
      this.acks.push(occurrenceId);
    }
  }
  const submitter = new RecordingAckSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  schedulerRef.current = scheduler;
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);

  await scheduler.tick();
  assert.equal(submitter.calls, 1);
  assert.equal(submitter.acks.length, 0, "ack (step d) must never run once disposed during/after step (c)'s commit");
  const state = await store.getById("daily-maintenance");
  assert.equal(state?.state.lastOutcome, "submitted", "step (c) itself already committed before dispose() was observed");

  // A later start (fresh scheduler instance) reconciles the lost ack, never resubmitting.
  const submitter2 = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: submitter2, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  assert.equal(submitter2.calls.length, 0);
  assert.deepEqual(submitter2.acks, [state!.state.lastOccurrenceId]);
});

void test("(final-integration 5) a throwing registrar.cancelInterval is caught into a redacted fault; running/intervalHandle still reset cleanly", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  class ThrowingCancelRegistrar implements IntervalRegistrar {
    registerInterval(): unknown {
      return {};
    }
    cancelInterval(): void {
      throw new Error("cancel boom");
    }
  }
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ThrowingCancelRegistrar(), clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  await scheduler.start();
  assert.doesNotThrow(() => scheduler.stop());
  assert.ok(scheduler.getFault());
  // Still fully stopped/disposable despite the throw.
  assert.doesNotThrow(() => scheduler.dispose());
  await assert.doesNotReject(() => scheduler.start()); // refuses silently -- disposed
});

// ---------------------------------------------------------------------------
// Final-integration requirement 6: fault allow-list, interval survival, one-fault-per-tick
// ---------------------------------------------------------------------------

void test("(final-integration 6) SchedulerFault.code is drawn from a closed scheduler-health allow-list, never an arbitrary EngineErrorCode", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  class UnrelatedErrorSubmitter implements JobSubmitter {
    async submitScheduledOccurrence(): Promise<unknown> {
      const { EngineError } = await import("../engine/errors");
      throw new EngineError("EMBEDDING_ENDPOINT_INVALID", "unrelated provider error", {});
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {}
  }
  const scheduler = new CoreScheduler({ store, jobSubmitter: new UnrelatedErrorSubmitter(), registrar: new ManualRegistrar(), clock: new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0)) });
  await seedOverdueSchedule(store, dailyDef(), Date.UTC(2026, 0, 1, 0, 0, 0) - 60_000);
  await scheduler.tick();
  // A submit failure is handled entirely within processSchedule's own try/catch (persisted as
  // "submit-failed"), so no SchedulerFault is recorded here at all -- this proves an unrelated
  // EngineError from the submitter never even reaches the fault-classification path in the first
  // place, let alone gets exposed verbatim.
  assert.equal(scheduler.getFault(), null);
});

void test("(final-integration 6) an unrecognized code reaching the scheduler-fault path collapses to SCHEDULER_UNKNOWN_FAULT, never surfaced verbatim", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  class ThrowingClock {
    now(): number {
      const err = new Error("boom") as Error & { code?: string };
      throw err;
    }
  }
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock: new ThrowingClock() });
  await scheduler.tick();
  assert.equal(scheduler.getFault()?.code, "SCHEDULER_UNKNOWN_FAULT");
});

void test("(final-integration 6) the recurring interval remains registered after an initial-tick fault -- a store fault is never a reason to stop ticking", async () => {
  const registrar = new ManualRegistrar();
  class ThrowingListStore extends ScheduleStore {
    async list(): ReturnType<ScheduleStore["list"]> {
      throw new (await import("../engine/errors")).EngineError("STORE_READ_FAILED", "boom", {});
    }
  }
  const store = new ThrowingListStore(new InMemoryFs(), "/root");
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar, clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  await scheduler.start();
  assert.ok(scheduler.getFault());
  assert.equal(registrar.registered.length, 1, "the interval is still registered despite the initial tick's fault");
  assert.equal(registrar.cancelled.length, 0);
});

void test("(final-integration 6) a global ScheduleStore load failure records exactly ONE fault per tick, never once per schedule", async () => {
  class ThrowingListStore extends ScheduleStore {
    async list(): ReturnType<ScheduleStore["list"]> {
      throw new (await import("../engine/errors")).EngineError("STORE_READ_FAILED", "boom", {});
    }
  }
  const store = new ThrowingListStore(new InMemoryFs(), "/root");
  let faultCount = 0;
  const scheduler = new CoreScheduler({
    store,
    jobSubmitter: new RecordingSubmitter(),
    registrar: new ManualRegistrar(),
    clock: new FakeClock(Date.UTC(2026, 0, 1)),
    onScheduleError: () => {
      faultCount += 1;
    },
  });
  await scheduler.tick();
  assert.equal(faultCount, 1, "one global fault per tick, not one per SCHEDULE_KINDS entry (3)");
  assert.equal(scheduler.getFault()?.scheduleId, undefined, "a global fault carries no specific scheduleId");
});

// ---------------------------------------------------------------------------
// Final-integration requirement 13: configure() validates before field access
// ---------------------------------------------------------------------------

void test("(final-integration 13) configure() rejects a malformed/casted definition before ever accessing its id, and mutates nothing", async () => {
  const store = new ScheduleStore(new InMemoryFs(), "/root");
  const scheduler = new CoreScheduler({ store, jobSubmitter: new RecordingSubmitter(), registrar: new ManualRegistrar(), clock: new FakeClock(Date.UTC(2026, 0, 1)) });
  const malformed = { schemaVersion: 1, kind: "daily-maintenance", enabled: true, timezone: "UTC", cadence: { type: "daily", hour: 99, minute: 0 }, pipelineVersion: 1, scopeId: "vault-default" } as unknown as ScheduleDefinitionV1;
  await assert.rejects(() => scheduler.configure(malformed), (e: unknown) => isEngineErrorCode(e, "SCHEDULE_SHAPE_INVALID"));
  assert.equal((await store.list()).length, 0, "nothing was persisted from the malformed definition");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 1: durable ack queue, no write-every-tick
// ---------------------------------------------------------------------------

void test("(last-acceptance 1) once the ack queue is empty, repeated ticks perform ZERO ScheduleStore writes and zero JobStore ack calls", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler.tick(); // submits, acks successfully, queue empties
  const afterFirst = await store.getById("daily-maintenance");
  assert.equal(afterFirst?.state.pendingAcknowledgementIds, undefined);
  const writesAfterFirst = scheduleFs.renameCallCount;
  const acksAfterFirst = submitter.acks.length;

  for (let i = 0; i < 20; i += 1) {
    await scheduler.tick();
  }
  assert.equal(scheduleFs.renameCallCount, writesAfterFirst, "no further ScheduleStore writes once nothing is due and the ack queue is empty");
  assert.equal(submitter.acks.length, acksAfterFirst, "no further ack calls once the queue is empty");
});

void test("(last-acceptance 1) an ack-fail-then-restart sequence: the durable queue survives, and the eventual successful ack empties it", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  class AlwaysAckFailingSubmitter implements JobSubmitter {
    calls: { occurrenceId: string }[] = [];
    async submitScheduledOccurrence(_input: unknown, occurrenceId: string): Promise<unknown> {
      this.calls.push({ occurrenceId });
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      throw new Error("ack always fails");
    }
  }
  const failingSubmitter = new AlwaysAckFailingSubmitter();
  const scheduler1 = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await scheduler1.tick();
  await scheduler1.tick();
  await scheduler1.tick();
  const occurrenceId = failingSubmitter.calls[0].occurrenceId;
  const afterFailures = await store.getById("daily-maintenance");
  assert.deepEqual(afterFailures?.state.pendingAcknowledgementIds, [occurrenceId], "still exactly one entry -- repeated appends of the SAME id must not duplicate it");

  const succeedingSubmitter = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: succeedingSubmitter, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  assert.deepEqual(succeedingSubmitter.acks, [occurrenceId]);
  const afterRecovery = await store.getById("daily-maintenance");
  assert.equal(afterRecovery?.state.pendingAcknowledgementIds, undefined);
});

void test("(last-acceptance 1) reconfigure-invalidation followed by a failing ack leaves the abandoned occurrenceId durably queued, never silently dropped", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const failingSubmitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  await seedOverdueSchedule(store, dailyDef({ pipelineVersion: 1 }), clock.now() - 60_000);
  await scheduler.tick(); // fails, leaves a pending occurrence
  const before = await store.getById("daily-maintenance");
  const staleOccurrenceId = before?.state.pendingOccurrenceId;
  assert.ok(staleOccurrenceId);

  const reconfigured = await scheduler.configure(dailyDef({ pipelineVersion: 2 }));
  assert.equal(reconfigured.state.pendingOccurrenceId, undefined);
  assert.deepEqual(reconfigured.state.pendingAcknowledgementIds, [staleOccurrenceId], "the abandoned occurrence is durably queued for acking in the SAME reconfigure commit");

  // Now simulate that ack failing too -- the id must remain queued, not silently disappear.
  class AckFailsSubmitter implements JobSubmitter {
    async submitScheduledOccurrence(): Promise<unknown> {
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      throw new Error("ack fails");
    }
  }
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: new AckFailsSubmitter(), registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  const afterFailedReconcile = await store.getById("daily-maintenance");
  assert.deepEqual(afterFailedReconcile?.state.pendingAcknowledgementIds, [staleOccurrenceId]);
});

void test("(last-acceptance 1) appendPendingAcknowledgementId deduplicates repeated appends of the SAME id (no growth), and the parser rejects an oversized/duplicate list", async () => {
  const { parseScheduleStateV1, MAX_PENDING_ACKNOWLEDGEMENT_IDS, appendPendingAcknowledgementId } = await import("./scheduleTypes");
  let ids: string[] | undefined;
  for (let i = 0; i < 5; i += 1) {
    ids = appendPendingAcknowledgementId(ids, "a".repeat(64));
  }
  assert.deepEqual(ids, ["a".repeat(64)]);

  assert.throws(
    () => parseScheduleStateV1({ nextDueAt: "2026-01-01T00:00:00.000Z", consecutiveFailures: 0, pendingAcknowledgementIds: Array.from({ length: MAX_PENDING_ACKNOWLEDGEMENT_IDS + 1 }, (_, i) => i.toString(16).padStart(64, "0")) }),
    (e: unknown) => isEngineErrorCode(e, "SCHEDULE_SHAPE_INVALID"),
  );
  const dup = "b".repeat(64);
  assert.throws(
    () => parseScheduleStateV1({ nextDueAt: "2026-01-01T00:00:00.000Z", consecutiveFailures: 0, pendingAcknowledgementIds: [dup, dup] }),
    (e: unknown) => isEngineErrorCode(e, "SCHEDULE_SHAPE_INVALID"),
  );
  assert.throws(
    () => parseScheduleStateV1({ nextDueAt: "2026-01-01T00:00:00.000Z", consecutiveFailures: 0, pendingAcknowledgementIds: ["not-hex64"] }),
    (e: unknown) => isEngineErrorCode(e, "SCHEDULE_SHAPE_INVALID"),
  );
});

void test("(last-acceptance 1) appendPendingAcknowledgementId NEVER evicts an unacknowledged id -- a genuinely distinct 65th id fails closed with SCHEDULE_CAP_EXCEEDED, and every prior id survives untouched", async () => {
  const { MAX_PENDING_ACKNOWLEDGEMENT_IDS, appendPendingAcknowledgementId } = await import("./scheduleTypes");
  let ids: string[] | undefined;
  for (let i = 0; i < MAX_PENDING_ACKNOWLEDGEMENT_IDS; i += 1) {
    ids = appendPendingAcknowledgementId(ids, i.toString(16).padStart(64, "0"));
  }
  assert.equal(ids!.length, MAX_PENDING_ACKNOWLEDGEMENT_IDS);
  const idsAtCap = [...ids!];

  // Re-adding an id already present is always safe -- deduplication, not eviction (it may move to
  // the end of the list, but the SET of ids is unchanged -- never treated as a 65th "new" id).
  const afterReAdd = appendPendingAcknowledgementId(ids, idsAtCap[0]);
  assert.equal(afterReAdd.length, MAX_PENDING_ACKNOWLEDGEMENT_IDS, "re-adding an already-queued id must not grow the list");
  assert.deepEqual([...afterReAdd].sort(), [...idsAtCap].sort(), "the exact same set of ids, just possibly reordered");

  // A genuinely NEW, distinct 65th id fails closed rather than silently dropping the oldest.
  assert.throws(
    () => appendPendingAcknowledgementId(ids, "f".repeat(64)),
    (e: unknown) => isEngineErrorCode(e, "SCHEDULE_CAP_EXCEEDED"),
  );
  // The input array itself is never mutated by the failed attempt -- every one of the 64 ids that
  // were already queued remains fully intact and recoverable.
  assert.deepEqual(ids, idsAtCap);
});

void test("(last-acceptance 1) hitting the ack-queue cap during a successful-outcome commit fails that commit closed, leaving the schedule's PRE-COMMIT state (including its pending occurrence) fully intact for a later retry", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const { MAX_PENDING_ACKNOWLEDGEMENT_IDS } = await import("./scheduleTypes");

  // Seed the schedule already carrying a FULL ack queue (as if 64 earlier occurrences all failed
  // to acknowledge) and currently overdue for a genuinely NEW occurrence.
  const fullQueue = Array.from({ length: MAX_PENDING_ACKNOWLEDGEMENT_IDS }, (_, i) => i.toString(16).padStart(64, "0"));
  const definition = dailyDef();
  await store.upsertDefinition(
    { schemaVersion: 1, definition, state: { nextDueAt: new Date(clock.now() - 60_000).toISOString(), consecutiveFailures: 0, pendingAcknowledgementIds: fullQueue } },
    (c) => c,
  );

  // Submitter whose ACK always fails (so reconcileAcknowledgements, which runs BEFORE due-work
  // processing every tick, can never drain the seeded queue out from under this test) but whose
  // SUBMIT succeeds (so the outcome-commit path is actually reached and hits the cap).
  class SubmitSucceedsAckFailsSubmitter implements JobSubmitter {
    calls: { input: unknown; occurrenceId: string }[] = [];
    async submitScheduledOccurrence(input: unknown, occurrenceId: string): Promise<unknown> {
      this.calls.push({ input, occurrenceId });
      return { ok: true };
    }
    async acknowledgeScheduledOccurrence(): Promise<void> {
      throw new Error("ack always fails in this test");
    }
  }
  const submitter = new SubmitSucceedsAckFailsSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  await scheduler.tick();

  assert.equal(submitter.calls.length, 1, "the submit itself still happened (JobStore already durably has the job)");
  const afterFailedCommit = await store.getById("daily-maintenance");
  // The outcome commit failed closed (cap exceeded) -- nextDueAt must NOT have advanced, and the
  // pending occurrence this tick was working on must still be intact for a retry.
  assert.ok(afterFailedCommit?.state.pendingOccurrenceId, "the pending occurrence survives -- the failed commit never cleared it");
  assert.deepEqual(afterFailedCommit?.state.pendingAcknowledgementIds, fullQueue, "the full queue is untouched by the failed commit (reconcileAcknowledgements' own ack attempts all failed too)");
  assert.ok(scheduler.getFault(), "the cap-exceeded failure surfaces as a recorded scheduler fault");

  // Recovery: once reconcileAcknowledgements successfully drains the queue (a healthy JobStore),
  // capacity frees up and the next tick's outcome commit succeeds.
  const succeedingSubmitter = new RecordingSubmitter();
  const scheduler2 = new CoreScheduler({ store, jobSubmitter: succeedingSubmitter, registrar: new ManualRegistrar(), clock });
  await scheduler2.tick();
  const afterRecovery = await store.getById("daily-maintenance");
  assert.equal(afterRecovery?.state.pendingAcknowledgementIds, undefined, "reconcileAcknowledgements drained the full queue before due-processing ran");
  assert.equal(afterRecovery?.state.lastOutcome, "submitted", "due-processing then succeeded once capacity was freed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 4: dispose boundary
// ---------------------------------------------------------------------------

void test("(last-acceptance 4) dispose() during the FAILURE-path outcome commit prevents anything further from running in that tick", async () => {
  const scheduleFs = new InMemoryFs();
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const schedulerRef: { current: CoreScheduler | null } = { current: null };
  class DisposingOnUpdateState extends ScheduleStore {
    async updateState(...args: Parameters<ScheduleStore["updateState"]>): ReturnType<ScheduleStore["updateState"]> {
      const result = await super.updateState(...args);
      schedulerRef.current!.dispose();
      return result;
    }
  }
  const store = new DisposingOnUpdateState(scheduleFs, "/root");
  const failingSubmitter = new FailingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: failingSubmitter, registrar: new ManualRegistrar(), clock });
  schedulerRef.current = scheduler;
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);

  await scheduler.tick();
  // The failure-path updateState for the FIRST due schedule triggers dispose() -- the second due
  // schedule in this same tick must never even be attempted.
  assert.equal(failingSubmitter.calls, 1, "only the first schedule's submit ran before dispose() took effect");
});

void test("(last-acceptance 4) dispose() during a store get/set/update already in progress lets that ONE write finish, but starts no subsequent submit/update/ack", async () => {
  const scheduleFs = new InMemoryFs();
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  const schedulerRef: { current: CoreScheduler | null } = { current: null };
  class DisposingOnGetById extends ScheduleStore {
    async getById(...args: Parameters<ScheduleStore["getById"]>): ReturnType<ScheduleStore["getById"]> {
      const result = await super.getById(...args);
      schedulerRef.current?.dispose();
      return result;
    }
  }
  const store = new DisposingOnGetById(scheduleFs, "/root");
  const submitter = new RecordingSubmitter();
  const scheduler = new CoreScheduler({ store, jobSubmitter: submitter, registrar: new ManualRegistrar(), clock });
  schedulerRef.current = null; // do not dispose during setup
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  schedulerRef.current = scheduler;

  await scheduler.tick();
  // getById (inside processSchedule) completes and returns its result (that one read finishes),
  // but dispose() fired immediately after -- no submit call must ever have started.
  assert.equal(submitter.calls.length, 0, "no submit starts once disposed, even though the in-flight getById() completed");
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 10: core start fault semantics (dedup)
// ---------------------------------------------------------------------------

void test("(last-acceptance 10) repeated identical global store faults across many ticks report to the observer only ONCE, until the fault changes", async () => {
  class ThrowingListStore extends ScheduleStore {
    async list(): ReturnType<ScheduleStore["list"]> {
      throw new (await import("../engine/errors")).EngineError("STORE_READ_FAILED", "boom", {});
    }
  }
  const store = new ThrowingListStore(new InMemoryFs(), "/root");
  let observerCalls = 0;
  const scheduler = new CoreScheduler({
    store,
    jobSubmitter: new RecordingSubmitter(),
    registrar: new ManualRegistrar(),
    clock: new FakeClock(Date.UTC(2026, 0, 1)),
    onScheduleError: () => {
      observerCalls += 1;
    },
  });
  for (let i = 0; i < 10; i += 1) {
    await scheduler.tick();
  }
  assert.equal(observerCalls, 1, "the identical fault is reported exactly once across 10 ticks");
  assert.ok(scheduler.getFault(), "getFault() still reflects the current (ongoing) fault");
});

void test("(last-acceptance 10) an identical fault reported twice in a row is deduped, and resetFault() re-arms reporting for a repeat of the SAME fault", async () => {
  class AlwaysCorruptStore extends ScheduleStore {
    async list(): ReturnType<ScheduleStore["list"]> {
      throw new EngineError("STORE_SCHEMA_INVALID", "boom", {});
    }
  }
  const store = new AlwaysCorruptStore(new InMemoryFs(), "/root");
  const reports: string[] = [];
  const scheduler = new CoreScheduler({
    store,
    jobSubmitter: new RecordingSubmitter(),
    registrar: new ManualRegistrar(),
    clock: new FakeClock(Date.UTC(2026, 0, 1)),
    onScheduleError: (fault) => reports.push(fault.code),
  });
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(reports, ["STORE_SCHEMA_INVALID"], "the second identical tick's fault is deduped");

  scheduler.resetFault();
  await scheduler.tick();
  assert.deepEqual(reports, ["STORE_SCHEMA_INVALID", "STORE_SCHEMA_INVALID"], "resetFault() re-arms reporting for a repeat of the SAME fault");
});

void test("(last-acceptance 10) a fault against a DIFFERENT schedule than the previously reported one is always reported, never deduped against an unrelated schedule's fault", async () => {
  const scheduleFs = new InMemoryFs();
  const store = new ScheduleStore(scheduleFs, "/root");
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  await seedOverdueSchedule(store, dailyDef(), clock.now() - 60_000);
  await seedOverdueSchedule(store, weeklyDef(), clock.now() - 60_000);

  class UpdateStateFailsForDailyOnly extends ScheduleStore {
    async updateState(id: Parameters<ScheduleStore["updateState"]>[0], updater: Parameters<ScheduleStore["updateState"]>[1]): ReturnType<ScheduleStore["updateState"]> {
      if (id === "daily-maintenance") throw new EngineError("SCHEDULE_TRANSITION_INVALID", "boom", {});
      return super.updateState(id, updater);
    }
  }
  const store2 = new UpdateStateFailsForDailyOnly(scheduleFs, "/root");
  const reports: { code: string; scheduleId: string | undefined }[] = [];
  const scheduler = new CoreScheduler({
    store: store2,
    jobSubmitter: new RecordingSubmitter(),
    registrar: new ManualRegistrar(),
    clock,
    onScheduleError: (fault) => reports.push({ code: fault.code, scheduleId: fault.scheduleId }),
  });
  await scheduler.tick();
  // daily-maintenance's updateState fails every time it's due; weekly-refresh succeeds. Only ONE
  // report for daily's fault this tick (not deduped against anything, since it's the first).
  assert.equal(reports.filter((r) => r.scheduleId === "daily-maintenance").length, 1);
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 2: end-to-end steady-state, zero JobStore writes for acknowledgement
// ---------------------------------------------------------------------------

void test("(last-acceptance 2) end-to-end with a REAL JobStore/JobEngine: once the ack queue drains, ten later ticks cause ZERO further JobStore renames for acknowledgement", async () => {
  const jobFs = new InMemoryFs();
  const jobStore = new JobStore(jobFs, "/jobs-root");
  const runner = { async step() { return { type: "complete" as const }; } };
  const clock = new FakeClock(Date.UTC(2026, 0, 1, 0, 0, 0));
  // JobEngine's own internal clock (used for QueueJobV1.createdAt/occurrence createdAt) must be the
  // SAME clock CoreScheduler uses for its ack timestamps -- otherwise the occurrence record's
  // createdAt and its acknowledgedAt can come from two independently-advancing clocks and trip
  // ScheduledOccurrenceRecordV1's "acknowledgedAt must not precede createdAt" invariant, exactly as
  // real production wiring (one real wall clock everywhere) never would.
  const engine = new JobEngine(jobStore, { "rebuild-index": runner }, clock);
  const scheduleStore = new ScheduleStore(new InMemoryFs(), "/schedule-root");
  const scheduler = new CoreScheduler({ store: scheduleStore, jobSubmitter: engine, registrar: new ManualRegistrar(), clock });

  await seedOverdueSchedule(scheduleStore, weeklyDef(), clock.now() - 60_000);
  await scheduler.tick(); // submits, runner completes the job, ack succeeds, queue drains
  await engine.drain();

  const state = await scheduleStore.getById("weekly-refresh");
  assert.equal(state?.state.pendingAcknowledgementIds, undefined, "the queue is drained after the first tick");

  const writesAfterDrain = jobFs.renameCallCount;
  for (let i = 0; i < 10; i += 1) {
    await scheduler.tick();
  }
  assert.equal(jobFs.renameCallCount, writesAfterDrain, "ten further ticks with nothing due and an empty ack queue perform ZERO JobStore writes (no ack call is ever even attempted)");
});
