import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as nodeSetTimeout } from "node:timers/promises";
import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { JobEngine, type JobPhaseRunner, type JobRetryTimer } from "./jobEngine";
import { JobStore } from "./jobStore";
import { deriveEngineActivity } from "./jobActivity";
import { FakeFs, FakeClock, linearAdvanceScript } from "./jobEngine.test-support";

class FakeRetryTimer implements JobRetryTimer {
  pending = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;
  constructor(readonly clock: FakeClock) {}
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.serial;
    this.pending.set(id, { at: this.clock.now() + delayMs, callback });
    assert.equal(this.pending.size, 1, "at most one retry timer");
    return () => { this.pending.delete(id); };
  }
  advance(ms: number): void {
    this.clock.ms += ms;
    for (const [id, timer] of this.pending) {
      if (timer.at <= this.clock.now()) { this.pending.delete(id); timer.callback(); }
    }
  }
}

const retryNote = (path = "Notes/retry.md") => ({ trigger: "manual" as const, kind: "process-note" as const, identity: stableNoteIdentity(canonicalizePath(path)), sourceHash: "a".repeat(64), embeddingModel: "model", pipelineVersion: 1 });

void test("background retries use Node timers even when browser timers never fire", async () => {
  const priorWindow = globalThis.window;
  globalThis.window = { setTimeout: () => 1, clearTimeout: () => undefined } as unknown as Window & typeof globalThis;
  const store = new JobStore(new FakeFs(), "/root");
  let calls = 0;
  const engine = new JobEngine(store, { "process-note": { step: async (job) => ++calls === 1 ? { type: "retry", failureCode: "EMBEDDING_TIMEOUT" } : linearAdvanceScript("process-note")(job) } });
  try {
    const job = await engine.submit(retryNote());
    engine.start();
    await engine.whenSettled();
    assert.equal(calls, 1);
    await nodeSetTimeout(20);
    assert.equal(calls, 1, "backoff must not be bypassed");
    const deadline = Date.now() + 2000;
    while ((await store.getById(job.job.jobId))?.status !== "completed" && Date.now() < deadline) await nodeSetTimeout(20);
    assert.equal((await store.getById(job.job.jobId))?.status, "completed");
    assert.ok(calls > 1);
  } finally { engine.dispose(); globalThis.window = priorWindow; }
});

void test("persisted retry deadlines resume after restart, earliest first, without early retries or editing wakeups", async () => {
  const clock = new FakeClock();
  const timers = new FakeRetryTimer(clock);
  const store = new JobStore(new FakeFs(), "/root");
  const calls: string[] = [];
  const runner: JobPhaseRunner = { step: async (job) => {
    calls.push(job.job.jobId);
    return job.job.target.kind === "note" && job.job.target.identity.canonicalPath.endsWith("editing.md") ? { type: "deferred" } : { type: "cancelled" };
  } };
  const original = new JobEngine(store, {}, clock, undefined, timers);
  const later = await original.submit(retryNote("Notes/later.md"));
  const earlier = await original.submit(retryNote("Notes/earlier.md"));
  for (const [job, delay] of [[later, 500], [earlier, 250]] as const) {
    await store.updateJob(job.job.jobId, (entry) => ({ ...entry, nextAttemptAtMs: clock.now() + delay, lastFailureCode: "EMBEDDING_TIMEOUT", lastFailureClass: "transient" }));
  }
  assert.equal(await original.runOnce(), "idle");
  assert.equal(timers.pending.size, 0, "explicit dispatch must not arm background timers");
  original.dispose();
  // Add an actual editing deferral in the restarted engine.
  const engine = new JobEngine(store, { "process-note": runner }, clock, undefined, timers);
  const deferred = await engine.submit(retryNote("Notes/editing.md"));
  engine.start();
  await engine.whenSettled();
  assert.deepEqual(calls, [deferred.job.jobId]);
  timers.advance(249); await engine.whenSettled();
  assert.equal(calls.length, 1);
  timers.advance(1); await engine.whenSettled();
  assert.deepEqual(calls, [deferred.job.jobId, earlier.job.jobId]);
  timers.advance(250); await engine.whenSettled();
  assert.deepEqual(calls, [deferred.job.jobId, earlier.job.jobId, later.job.jobId]);
  assert.equal(timers.pending.size, 0);
  assert.equal((await store.getById(deferred.job.jobId))?.status, "queued", "retry timer must not clear editing deferrals");
  engine.dispose();
});

void test("retry timers respect operator/provider pause, stop, resume and dispose, including stale callbacks", async () => {
  const clock = new FakeClock();
  const timers = new FakeRetryTimer(clock);
  const store = new JobStore(new FakeFs(), "/root");
  let calls = 0;
  const engine = new JobEngine(store, { "process-note": { step: async () => { calls++; return { type: "retry", failureCode: "EMBEDDING_TIMEOUT" }; } } }, clock, undefined, timers);
  await engine.submit(retryNote());
  engine.start(); await engine.whenSettled();
  const stale = [...timers.pending.values()][0].callback;
  await engine.pauseProcessing();
  assert.equal(timers.pending.size, 0);
  timers.advance(250); stale(); await engine.whenSettled();
  assert.equal(calls, 1);
  await engine.resumeProcessing(); await engine.whenSettled();
  assert.equal(calls, 2);
  await store.setProviderPause({ active: true, code: "EMBEDDING_MODEL_NOT_FOUND", pausedAtMs: clock.now() });
  engine.wake(); await engine.whenSettled();
  assert.equal(timers.pending.size, 0);
  timers.advance(500); await engine.whenSettled();
  assert.equal(calls, 2);
  await engine.resumeProvider(); await engine.whenSettled();
  assert.equal(calls, 3);
  engine.stop();
  assert.equal(timers.pending.size, 0);
  timers.advance(1000); await engine.whenSettled();
  assert.equal(calls, 3);
  engine.start(); await engine.whenSettled();
  assert.equal(calls, 4);
  const disposedCallback = [...timers.pending.values()][0].callback;
  engine.dispose();
  assert.equal(timers.pending.size, 0);
  timers.advance(2000); disposedCallback(); await engine.whenSettled();
  assert.equal(calls, 4);
});

void test("retry timer faults stop scheduling; deterministic identity conflicts fail once with redacted status", async () => {
  const clock = new FakeClock();
  const timers = new FakeRetryTimer(clock);
  const store = new JobStore(new FakeFs(), "/root");
  const engine = new JobEngine(store, { "process-note": { step: async () => ({ type: "retry", failureCode: "EMBEDDING_TIMEOUT" }) } }, clock, undefined, timers);
  await engine.submit(retryNote());
  engine.start(); await engine.whenSettled();
  const list = store.list.bind(store);
  let failing = true;
  store.list = async () => { if (failing) { failing = false; throw new Error("private filesystem detail"); } return list(); };
  timers.advance(250); await engine.whenSettled();
  assert.equal(engine.getFault()?.code, "UNKNOWN_TRANSIENT");
  assert.equal(timers.pending.size, 0);
  engine.dispose();

  const conflictStore = new JobStore(new FakeFs(), "/root");
  let attempts = 0;
  const conflict = new JobEngine(conflictStore, { "rebuild-index": { step: async () => { attempts++; throw new EngineError("INDEX_IDENTITY_CONFLICT", "private path and identity"); } } }, clock, undefined, timers);
  const job = await conflict.submit({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 });
  conflict.start(); await conflict.whenSettled();
  assert.equal(attempts, 1);
  assert.equal((await conflictStore.getById(job.job.jobId))?.status, "failed");
  assert.equal((await conflictStore.getById(job.job.jobId))?.lastFailureCode, "INDEX_IDENTITY_CONFLICT");
  assert.equal(timers.pending.size, 0);
  const activity = deriveEngineActivity(await conflictStore.list(), await conflictStore.getBulkBatches(), { active: false }, { active: false }, true, false, undefined);
  assert.equal(activity.latestFailureBatch?.failureCode, "INDEX_IDENTITY_CONFLICT");
  assert.doesNotMatch(JSON.stringify(activity), /private path/);
  conflict.dispose();
});
