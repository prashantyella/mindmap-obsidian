import test from "node:test";
import assert from "node:assert/strict";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, JOB_KIND_PHASES, stableNoteIdentity, type JobPhase } from "../engine/contracts";
import { JobEngine, type JobEngineClock, type JobPhaseRunner, type PhaseStepOutcome } from "./jobEngine";
import { JobStore } from "./jobStore";
import type { PersistedJobV1 } from "./jobTypes";

class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, value);
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
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
    return [...names];
  }
}

class FakeClock implements JobEngineClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

/** A runner whose behavior per call is fully scripted -- pops the next scripted outcome (or a fixed always-return outcome) and records every call. */
class ScriptedRunner implements JobPhaseRunner {
  calls: PersistedJobV1[] = [];
  script: (job: PersistedJobV1) => PhaseStepOutcome | Promise<PhaseStepOutcome>;
  constructor(script: (job: PersistedJobV1) => PhaseStepOutcome | Promise<PhaseStepOutcome>) {
    this.script = script;
  }
  async step(job: PersistedJobV1, _signal: AbortSignal): Promise<PhaseStepOutcome> {
    void _signal;
    this.calls.push(job);
    return this.script(job);
  }
}

/** Advances a job through every phase for its kind, one "advance" per call, then "complete". */
function linearAdvanceScript(kind: "process-note" | "rebuild-index" | "migrate-index") {
  return (job: PersistedJobV1): PhaseStepOutcome => {
    const phases = JOB_KIND_PHASES[kind];
    const index = phases.indexOf(job.job.phase as JobPhase);
    const next = phases[index + 1];
    if (next === undefined || job.job.phase === "complete") return { type: "complete" };
    if (index === phases.length - 2) return { type: "complete" };
    return { type: "advance", nextPhase: next };
  };
}

function makeEngine(runners: Partial<Record<"process-note" | "rebuild-index" | "migrate-index", JobPhaseRunner>>, clock = new FakeClock()) {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const engine = new JobEngine(store, runners, clock);
  return { store, engine, clock };
}

void test("bulk submission creates one atomic root/batch, rejects overlap, and adopts stable children", async () => {
  const { engine, store } = makeEngine({});
  const first = await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  await assert.rejects(() => engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 }), (error: unknown) => (error as { code?: string }).code === "BULK_BATCH_ACTIVE");
  const batch = (await store.getBulkBatches())[0]!;
  assert.equal(batch.rootJobId, first.job.jobId);
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  const child = await engine.submitBulkChild(batch.batchId, { trigger: "manual", kind: "process-note", identity, sourceHash: "a".repeat(64), embeddingModel: "m", pipelineVersion: 1 });
  const duplicate = await engine.submitBulkChild(batch.batchId, { trigger: "manual", kind: "process-note", identity, sourceHash: "a".repeat(64), embeddingModel: "m", pipelineVersion: 1 });
  assert.ok(child); assert.ok(duplicate);
  assert.equal(child.job.jobId, duplicate.job.jobId);
  assert.equal((await store.getBulkBatches())[0]!.items.length, 1);
});

void test("activity subscription emits active before a controlled runner releases and then settles idle", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = new ScriptedRunner(async () => { await gate; return { type: "advance", nextPhase: "embed" }; });
  const { engine, store } = makeEngine({ "process-note": runner });
  const snapshots: string[] = [];
  const unsubscribe = engine.subscribeActivity((snapshot) => snapshots.push(snapshot.state));
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  const dispatch = engine.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(snapshots.includes("running"));
  release();
  await dispatch;
  assert.equal(snapshots[snapshots.length - 1], "running");
  const jobs = await store.list();
  await engine.requestCancel(jobs[0].job.jobId);
  await engine.runOnce();
  assert.equal(snapshots[snapshots.length - 1], "idle");
  unsubscribe();
});

void test("bulk denominator comes only from the committed scope discovery receipt and blocks premature settlement", async () => {
  const { engine, store } = makeEngine({});
  const root = await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  await store.updateJob(root.job.jobId, (current) => ({ ...current, job: { ...current.job, phase: "enqueue" }, receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "b".repeat(64) } }));
  assert.equal((await store.getBulkBatches())[0]!.discoveredTotal, 2);
  await store.updateJob(root.job.jobId, (current) => ({ ...current, status: "completed", job: { ...current.job, phase: "complete" }, receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "b".repeat(64), enqueuedCount: 2 } }));
  const batch = (await store.getBulkBatches())[0]!;
  assert.equal(batch.status, "active");
  assert.equal(batch.discoveredTotal, 2);
});

void test("failed bulk root settles before discovery without inventing a denominator", async () => {
  const { engine, store } = makeEngine({});
  const root = await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  await store.updateJob(root.job.jobId, (current) => ({ ...current, status: "failed", lastFailureCode: "JOB_SHAPE_INVALID", lastFailureClass: "terminal" }));
  const batch = (await store.getBulkBatches())[0]!;
  assert.equal(batch.status, "failed");
  assert.equal(batch.discoveredTotal, undefined);
});

void test("a different scheduled occurrence is blocked by an active manual batch", async () => {
  const { engine } = makeEngine({});
  await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  await assert.rejects(() => engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 }, "d".repeat(64)), (error: unknown) => (error as { code?: string }).code === "BULK_BATCH_ACTIVE");
});

function noteIdentity(path: string) {
  return stableNoteIdentity(canonicalizePath(path));
}

void test("submit coalesces a duplicate manual trigger for the same target/sourceHash/embeddingModel into the existing job", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const input = { trigger: "manual" as const, kind: "process-note" as const, identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 };
  const first = await engine.submit(input);
  const second = await engine.submit(input);
  assert.equal(first.job.jobId, second.job.jobId);
  assert.equal((await store.list()).length, 1);
});

void test("submit coalesces the SAME work across different trigger origins (manual/reading/scheduled/startup), keeping the first trigger as provenance", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const base = { kind: "process-note" as const, identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 };
  const manual = await engine.submit({ ...base, trigger: "manual" });
  const reading = await engine.submit({ ...base, trigger: "reading" });
  const scheduled = await engine.submit({ ...base, trigger: "scheduled" });
  const startup = await engine.submit({ ...base, trigger: "startup" });
  assert.equal(manual.job.jobId, reading.job.jobId);
  assert.equal(manual.job.jobId, scheduled.job.jobId);
  assert.equal(manual.job.jobId, startup.job.jobId);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.getById(manual.job.jobId))?.job.trigger, "manual", "the first-observed trigger is kept as provenance");
});

void test("concurrent identical submits (racing the atomic append-or-coalesce) never both append -- exactly one job is persisted", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const input = { trigger: "manual" as const, kind: "process-note" as const, identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 };
  const [a, b, c] = await Promise.all([engine.submit(input), engine.submit(input), engine.submit(input)]);
  assert.equal(a.job.jobId, b.job.jobId);
  assert.equal(a.job.jobId, c.job.jobId);
  assert.equal((await store.list()).length, 1);
});

void test("submit does NOT coalesce once the prior job is terminal", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const input = { trigger: "manual" as const, kind: "process-note" as const, identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 };
  const first = await engine.submit(input);
  await engine.drain();
  assert.equal((await store.getById(first.job.jobId))?.status, "completed");
  const second = await engine.submit(input);
  assert.notEqual(first.job.jobId, second.job.jobId);
  assert.equal((await store.list()).length, 2);
});

void test("drain() runs a job through every phase to completion, persisting attempt/phase before each step", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.drain();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(runner.calls.length, JOB_KIND_PHASES["process-note"].length - 1);
});

void test("a repeatedly-failing head-of-queue job does not starve a later queued job (fair ordering via backoff)", async () => {
  const failingRunner = new ScriptedRunner(() => ({ type: "retry", failureCode: "EMBEDDING_TIMEOUT" }));
  const succeedingRunner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const clock = new FakeClock();
  let headJobId = "";
  const { engine, store } = makeEngine({ "process-note": { step: async (job, signal) => (job.job.jobId === headJobId ? failingRunner.step(job, signal) : succeedingRunner.step(job, signal)) } }, clock);
  const head = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/Head.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  headJobId = head.job.jobId;
  const later = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/Later.md"), sourceHash: "b".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  await engine.drain();
  const laterFinal = await store.getById(later.job.jobId);
  assert.equal(laterFinal?.status, "completed", "later job must complete even though the head job keeps failing and backing off");
  const headFinal = await store.getById(head.job.jobId);
  assert.equal(headFinal?.status, "queued", "head job stays queued, backing off, not starving anything");
  assert.ok((headFinal?.nextAttemptAtMs ?? 0) > clock.now());
});

void test("a transient failure retries with backoff and eventually fails once attempts are exhausted", async () => {
  const runner = new ScriptedRunner(() => ({ type: "retry", failureCode: "EMBEDDING_TIMEOUT" }));
  const clock = new FakeClock();
  const { engine, store } = makeEngine({ "process-note": runner }, clock);
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  for (let i = 0; i < 25; i += 1) {
    await engine.drain();
    const current = await store.getById(job.job.jobId);
    if (current?.status === "failed") break;
    clock.ms += 60_000;
  }
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureClass, "transient");
  assert.ok(final && final.attempt <= 20);
});

void test("a terminal failure code fails the job immediately without retrying", async () => {
  const runner = new ScriptedRunner(() => ({ type: "retry", failureCode: "EMBEDDING_MODEL_NOT_FOUND" }));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.drain();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureClass, "terminal");
  assert.equal(runner.calls.length, 1);
});

void test("cancellation requested before the irreversible commit phase stops the job with zero runner calls", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.requestCancel(job.job.jobId);
  await engine.drain();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(runner.calls.length, 0);
});

void test("cancellation requested AFTER the note has reached its irreversible write-note phase is ignored -- the job still completes (repairs the overlay rather than leaving it missing forever)", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  // Advance manually one phase at a time until phase === "write-note", then request cancellation.
  let current = job;
  while (current.job.phase !== "write-note") {
    await engine.runOnce();
    current = (await store.getById(job.job.jobId))!;
  }
  await engine.requestCancel(job.job.jobId);
  await engine.drain();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "completed", "cancellation past the irreversible phase must not stop the job");
});

void test("a provider-pause outcome blocks further process-note dispatch but never blocks an unrelated rebuild-index job", async () => {
  const noteRunner = new ScriptedRunner(() => ({ type: "provider-pause", code: "EMBEDDING_ENDPOINT_INVALID" }));
  const rebuildRunner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "process-note": noteRunner, "rebuild-index": rebuildRunner });

  const note = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  const rebuild = await engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });

  await engine.drain();
  const pause = await store.getProviderPause();
  assert.equal(pause.active, true);
  const rebuildFinal = await store.getById(rebuild.job.jobId);
  assert.equal(rebuildFinal?.status, "completed", "an unrelated rebuild job must not be blocked by a process-note provider pause");
  const noteFinal = await store.getById(note.job.jobId);
  assert.equal(noteFinal?.status, "queued", "the paused note job stays queued, not failed");
});

void test("resumeProvider clears the pause and lets a previously-blocked process-note job proceed", async () => {
  let paused = true;
  const noteRunner = new ScriptedRunner((job) => {
    if (paused) return { type: "provider-pause", code: "EMBEDDING_ENDPOINT_INVALID" };
    return linearAdvanceScript("process-note")(job);
  });
  const { engine, store } = makeEngine({ "process-note": noteRunner });
  const note = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.drain();
  assert.equal((await store.getProviderPause()).active, true);

  paused = false;
  await engine.resumeProvider();
  await engine.drain();
  const final = await store.getById(note.job.jobId);
  assert.equal(final?.status, "completed");
});

void test("dispose() resolves immediately even while a runner hangs indefinitely, and prevents any new phase from starting", async () => {
  const hangResolvers: Array<() => void> = [];
  const hangingRunner: JobPhaseRunner = {
    step: (job) =>
      new Promise<PhaseStepOutcome>((resolve) => {
        hangResolvers.push(() => resolve(linearAdvanceScript("process-note")(job)));
      }),
  };
  const { engine, store } = makeEngine({ "process-note": hangingRunner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  engine.start();
  await new Promise((resolve) => setImmediate(resolve));

  const before = Date.now();
  engine.dispose();
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 50, "dispose() must never wait on an in-flight hung phase-step");

  const outcome = await engine.runOnce();
  assert.equal(outcome, "idle", "a disposed engine must never start a new phase");

  // Let the hung step resolve after disposal, just to release the dangling promise; its outcome
  // being applied afterward is documented/acceptable (dispose only guarantees no NEW phase starts).
  for (const resolveHang of hangResolvers) resolveHang();
  await new Promise((resolve) => setImmediate(resolve));
  void job;
  void store;
});

void test("(requirement 15) runner.forget(jobId) is called exactly once on every terminal outcome -- completed, failed, and cancelled -- and never for a still-active/queued job", async () => {
  const forgotten: string[] = [];
  const makeRunner = (script: (job: PersistedJobV1) => PhaseStepOutcome) => ({
    async step(job: PersistedJobV1) {
      return script(job);
    },
    forget(jobId: string) {
      forgotten.push(jobId);
    },
  });
  const { engine: completedEngine } = makeEngine({ "process-note": makeRunner(linearAdvanceScript("process-note")) });
  const completedJob = await completedEngine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await completedEngine.drain();
  assert.deepEqual(forgotten, [completedJob.job.jobId]);
  assert.equal(forgotten.filter((id) => id === completedJob.job.jobId).length, 1, "forget must be called exactly once, not once per phase");

  forgotten.length = 0;
  const { engine: failedEngine } = makeEngine({ "process-note": makeRunner(() => ({ type: "retry", failureCode: "EMBEDDING_MODEL_NOT_FOUND" })) });
  const failedJob = await failedEngine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/B.md"), sourceHash: "b".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await failedEngine.drain();
  assert.deepEqual(forgotten, [failedJob.job.jobId]);

  forgotten.length = 0;
  const { engine: cancelledEngine } = makeEngine({ "process-note": makeRunner(linearAdvanceScript("process-note")) });
  const cancelledJob = await cancelledEngine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/C.md"), sourceHash: "c".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await cancelledEngine.requestCancel(cancelledJob.job.jobId);
  await cancelledEngine.drain();
  assert.deepEqual(forgotten, [cancelledJob.job.jobId]);

  // Never called while the job is merely queued mid-pipeline.
  forgotten.length = 0;
  const { engine: midwayEngine } = makeEngine({ "process-note": makeRunner(linearAdvanceScript("process-note")) });
  await midwayEngine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/D.md"), sourceHash: "d".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await midwayEngine.runOnce();
  assert.deepEqual(forgotten, []);
});

void test("(requirement 15) a runner without forget(), or one whose forget() throws, never breaks the engine's own terminal bookkeeping", async () => {
  const runner: JobPhaseRunner = { step: async (job) => linearAdvanceScript("process-note")(job) };
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.drain();
  assert.equal((await store.getById(job.job.jobId))?.status, "completed");

  const throwingRunner: JobPhaseRunner = {
    step: async (jobArg) => linearAdvanceScript("process-note")(jobArg),
    forget: () => {
      throw new Error("forget must never propagate");
    },
  };
  const { engine: engine2, store: store2 } = makeEngine({ "process-note": throwingRunner });
  const job2 = await engine2.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/B.md"), sourceHash: "b".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine2.drain();
  assert.equal((await store2.getById(job2.job.jobId))?.status, "completed");
});

void test("(requirement 15) post-commit disposal: dispose() called after a phase's advance has already committed prevents any SUBSEQUENT phase from starting, even though the committed phase itself is unaffected", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  await engine.runOnce(); // discover -> embed: this phase's advance is fully committed
  const midway = await store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "embed");

  engine.dispose();
  const outcome = await engine.runOnce();
  assert.equal(outcome, "idle", "no subsequent phase may start after dispose(), even though the prior one's commit is intact");
  const after = await store.getById(job.job.jobId);
  assert.equal(after?.job.phase, "embed", "the last committed phase is left exactly as it was");
  assert.equal(runner.calls.length, 1, "the runner must never be invoked again after dispose()");
});

void test("(requirement 15) pre-commit disposal: dispose() during an in-flight phase-step lets that phase persist its own outcome (never interrupted mid-write), but no phase after it ever runs", async () => {
  let resolveStep: ((outcome: PhaseStepOutcome) => void) | null = null;
  const runner: JobPhaseRunner = {
    step: (job) =>
      new Promise<PhaseStepOutcome>((resolve) => {
        resolveStep = () => resolve(linearAdvanceScript("process-note")(job));
      }),
  };
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  const runOncePromise = engine.runOnce(); // starts the in-flight phase-step, hangs inside runner.step()
  await new Promise((resolve) => setImmediate(resolve));

  // Dispose WHILE the phase-step is still in flight, BEFORE its outcome is ever applied/persisted.
  engine.dispose();

  // The in-flight phase-step is allowed to finish and persist its own single outcome...
  resolveStep!({ type: "advance", nextPhase: "embed" });
  await runOncePromise;
  const afterCommit = await store.getById(job.job.jobId);
  assert.equal(afterCommit?.job.phase, "embed", "the in-flight phase's own outcome still commits");

  // ...but no phase AFTER it may ever run, even via an explicit runOnce()/drain() call post-dispose.
  const outcome = await engine.runOnce();
  assert.equal(outcome, "idle");
  const after = await store.getById(job.job.jobId);
  assert.equal(after?.job.phase, "embed", "no subsequent phase ran");
});

void test("dispose() is single-settlement: repeated calls are no-ops", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const { engine } = makeEngine({ "process-note": runner });
  engine.dispose();
  engine.dispose();
  assert.equal(await engine.runOnce(), "idle");
});

void test("a runner-supplied retry failureCode with a secret-bearing name is redacted to UNKNOWN_TRANSIENT before persistence", async () => {
  const runner = new ScriptedRunner(() => ({ type: "retry", failureCode: "SECRET_TOKEN" }));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.runOnce();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.lastFailureCode, "UNKNOWN_TRANSIENT");
  assert.equal(final?.lastFailureClass, "transient", "an unrecognized code must default transient, never silently terminal");
});

void test("a runner-supplied provider-pause code with a secret-bearing name never activates a global pause -- it is downgraded to an ordinary per-job retry (requirement 11: only the narrow provider-wide allow-list may ever pause)", async () => {
  const runner = new ScriptedRunner(() => ({ type: "provider-pause", code: "SECRET_TOKEN" }));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.runOnce();
  const pause = await store.getProviderPause();
  assert.equal(pause.active, false, "an unrecognized/non-provider-wide code must never activate a global pause");
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "queued");
  assert.equal(final?.lastFailureCode, "UNKNOWN_TRANSIENT");
});

void test("a runner-supplied provider-pause code that IS a real EngineErrorCode but not in the narrow provider-wide allow-list is also downgraded to a per-job retry, never a global pause", async () => {
  const runner = new ScriptedRunner(() => ({ type: "provider-pause", code: "JOB_CAP_EXCEEDED" }));
  const { engine, store } = makeEngine({ "process-note": runner });
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.runOnce();
  const pause = await store.getProviderPause();
  assert.equal(pause.active, false, "a recognized-but-not-provider-wide code must never activate a global pause");
});

void test("a runner-supplied obsolete failureCode with a secret-bearing name is redacted to UNKNOWN_TRANSIENT before persistence", async () => {
  const runner = new ScriptedRunner(() => ({ type: "obsolete", failureCode: "SECRET_TOKEN" }));
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  await engine.runOnce();
  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "UNKNOWN_TRANSIENT");
});

void test("concurrent runOnce()/drain()/start()-pump calls behind a controlled runner never execute two phase-steps at once, and each persisted phase executes exactly once", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const seenPhases: string[] = [];
  const runner: JobPhaseRunner = {
    async step(job) {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      seenPhases.push(job.job.phase);
      await new Promise((resolve) => setImmediate(resolve));
      concurrent -= 1;
      return linearAdvanceScript("process-note")(job);
    },
  };
  const { engine, store } = makeEngine({ "process-note": runner });
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  engine.start();
  await Promise.all([engine.runOnce(), engine.drain(), engine.runOnce(), engine.drain()]);

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(maxConcurrent, 1, "at most one phase-step must ever be in flight, even with overlapping runOnce/drain/pump callers");
  const expectedPhaseCount = JOB_KIND_PHASES["process-note"].length - 1;
  assert.equal(seenPhases.length, expectedPhaseCount, "every persisted phase must execute exactly once -- no double-execution, no skipped phase");
  assert.deepEqual(seenPhases, JOB_KIND_PHASES["process-note"].slice(0, expectedPhaseCount));
});

/** Test-only `JobStore` subclass that lets a test inject a side effect (typically a racing `engine.submit()`) at the exact moment the pump's in-flight `runOnceInner()` has already snapshotted an all-terminal/empty queue but has not yet returned "idle" to `pumpLoop` -- the precise lost-wakeup window from requirement 3. */
class KickDuringIdleCheckStore extends JobStore {
  triggerOnce: (() => Promise<void>) | null = null;
  private sawNoQueuedJob = false;

  async list() {
    const jobs = await super.list();
    this.sawNoQueuedJob = !jobs.some((entry) => entry.status === "queued");
    return jobs;
  }

  async getProviderPause() {
    const pause = await super.getProviderPause();
    if (this.sawNoQueuedJob && this.triggerOnce) {
      const fn = this.triggerOnce;
      this.triggerOnce = null;
      await fn();
    }
    return pause;
  }
}

void test("a submit() racing the pump's in-flight idle check (kick arrives after the queue snapshot but before idle is reported) is never lost -- the background pump still picks up the new job with no external drain()/runOnce()", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const fs = new FakeFs();
  const store = new KickDuringIdleCheckStore(fs, "/root");
  const engine = new JobEngine(store, { "process-note": runner });

  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  let secondSubmitted: PersistedJobV1 | null = null;
  store.triggerOnce = async () => {
    secondSubmitted = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/B.md"), sourceHash: "b".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });
  };

  engine.start();
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.ok(secondSubmitted, "the racing submit must have fired during the idle-check window");
  const secondFinal = await store.getById((secondSubmitted as unknown as PersistedJobV1).job.jobId);
  assert.equal(secondFinal?.status, "completed", "the background pump must not lose the racing kick -- job 2 must complete on its own, without any external drain()/runOnce() call in this test");
});

void test("a JobStore write failure surfacing from the background pump never becomes an unhandled rejection: it stops the pump and records an inspectable fault, notifying onError", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const faults: unknown[] = [];
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock(), (fault) => {
    faults.push(fault);
  });
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  fs.writeFile = async () => {
    throw new Error("simulated disk failure");
  };

  assert.equal(engine.getFault(), null);
  engine.start();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(faults.length, 1, "onError must be notified exactly once");
  assert.ok(engine.getFault(), "the engine must record an inspectable fault rather than silently retrying forever or crashing the process");
});

void test("(requirement 10) JobEngineFault carries only a closed, redacted code + timestamp -- never the raw Error, its message, or any store-internal detail", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const faults: unknown[] = [];
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock(), (fault) => {
    faults.push(fault);
  });
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  const secretPath = "/Users/someone/.secret-vault/private-notes/queue.json";
  fs.writeFile = async () => {
    throw new Error(`EACCES: permission denied, open '${secretPath}'`);
  };

  engine.start();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const fault = engine.getFault();
  assert.ok(fault);
  assert.deepEqual(Object.keys(fault!).sort(), ["atMs", "code"], "the fault object must carry ONLY these two fields");
  // AtomicStore itself wraps the raw filesystem error as EngineError("STORE_WRITE_FAILED", ...,
  // { cause: String(error) }) -- that recognized CODE is what legitimately surfaces here; the
  // secret-bearing message/path lives only in .context.cause, which toFailureCode/JobEngineFault
  // never reads at all (only .code is ever consulted) -- see the assertion below.
  assert.equal(fault!.code, "STORE_WRITE_FAILED");
  assert.equal(typeof fault!.atMs, "number");
  assert.equal(JSON.stringify(fault).includes(secretPath), false, "no path/secret from the underlying error may ever leak through the fault");
  assert.deepEqual(faults[0], fault, "onError must receive the exact same redacted shape");
});

void test("(requirement 10) start() refuses to resume while a fault is still recorded; resetFault() (after confirming store health) is required before the pump can run again", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock());
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  fs.writeFile = async () => {
    throw new Error("simulated disk failure");
  };
  engine.start();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(engine.getFault(), "precondition: engine is faulted");

  // Restore store health, but start() must still silently refuse while the fault is recorded.
  fs.writeFile = async (path: string, contents: string) => {
    fs.files.set(path, contents);
  };
  engine.start();
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  let stillStuck = await store.getById(job.job.jobId);
  assert.notEqual(stillStuck?.status, "completed", "start() must not silently resume dispatch while a stale fault remains recorded");

  engine.resetFault();
  assert.equal(engine.getFault(), null);
  engine.start();
  await engine.drain();
  stillStuck = await store.getById(job.job.jobId);
  assert.equal(stillStuck?.status, "completed", "after resetFault(), start() must resume dispatch normally");
});

void test("(acceptance guard 9) resetFault() called synchronously from onError -- while the pump that just recorded the fault is still in flight -- is rejected as a no-op, not honored", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("process-note"));
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  let resetDuringPumpResult: boolean | undefined;
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock(), () => {
    // Called synchronously from inside pumpLoop(), before its `.finally()` clears `this.pumping`.
    resetDuringPumpResult = engine.resetFault();
  });
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  fs.writeFile = async () => {
    throw new Error("simulated disk failure");
  };
  engine.start();
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(resetDuringPumpResult, false, "resetFault() must return false (no-op) while called from within the still-in-flight pump");
  assert.ok(engine.getFault(), "the fault must remain recorded -- the in-flight reset attempt must not have cleared it");

  // Once the pump has actually settled, resetFault() succeeds normally.
  fs.writeFile = async (path: string, contents: string) => {
    fs.files.set(path, contents);
  };
  const resetAfterSettled = engine.resetFault();
  assert.equal(resetAfterSettled, true);
  assert.equal(engine.getFault(), null);
});

void test("(last-contract guard 4) resetFault() returns false while an explicit runOnce() dispatch is in flight, tracked separately from background pumping", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  let started = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new ScriptedRunner((job) => {
    void job;
    started = true;
    return gate.then((): PhaseStepOutcome => ({ type: "complete" }));
  });
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock());
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  const runOncePromise = engine.runOnce();
  while (!started) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(engine.resetFault(), false, "resetFault() must refuse while an explicit runOnce() dispatch is still active, even with no pump running and no fault set");
  assert.equal(engine.getFault(), null, "no fault was ever set -- this call is purely testing the in-flight guard, not fault clearing");

  release();
  await runOncePromise;

  assert.equal(engine.resetFault(), true, "once the explicit dispatch has resolved, resetFault() succeeds normally");
});

void test("(last-contract guard 4) resetFault() returns false while an explicit drain() dispatch is in flight", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  let started = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = new ScriptedRunner((job) => {
    void job;
    started = true;
    return gate.then((): PhaseStepOutcome => ({ type: "complete" }));
  });
  const engine = new JobEngine(store, { "process-note": runner }, new FakeClock());
  await engine.submit({ trigger: "manual", kind: "process-note", identity: noteIdentity("Notes/A.md"), sourceHash: "a".repeat(64), embeddingModel: "m1", pipelineVersion: 1 });

  const drainPromise = engine.drain();
  while (!started) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(engine.resetFault(), false, "resetFault() must refuse while an explicit drain() dispatch is still active");

  release();
  await drainPromise;

  assert.equal(engine.resetFault(), true);
});

// ---------------------------------------------------------------------------
// Checkpoint 8 requirement 6: crash-safe scheduled occurrence submission
// ---------------------------------------------------------------------------

const OCCURRENCE_ID_A = "a".repeat(64);
const OCCURRENCE_ID_B = "b".repeat(64);

void test("submitScheduledOccurrence rejects a non-scheduled trigger and a malformed occurrenceId", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine } = makeEngine({ "rebuild-index": runner });
  await assert.rejects(
    () => engine.submitScheduledOccurrence({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A),
    (error: unknown) => isEngineErrorLike(error, "JOB_SHAPE_INVALID"),
  );
  await assert.rejects(
    () => engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, "not-hex64"),
    (error: unknown) => isEngineErrorLike(error, "JOB_SHAPE_INVALID"),
  );
});

void test("submitScheduledOccurrence: a synchronous-fast runner completes the job BEFORE the caller ever gets a chance to persist its own outcome -- a retry with the same occurrenceId still returns the SAME terminal job, never a duplicate", async () => {
  // The runner advances a rebuild-index job through every phase synchronously -- by the time
  // submitScheduledOccurrence's own promise resolves, JobEngine's background pump may have ALREADY
  // driven this job all the way to "completed" (kick() fires the pump immediately after append,
  // and drain()'s loop below never waits on wall-clock time). This is exactly the race requirement
  // 6 targets: a scheduler that crashes before persisting its own "submitted" outcome must still
  // find the SAME job on retry.
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "rebuild-index": runner });

  const first = await engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A);
  await engine.drain(); // ensure the pump has fully settled (deterministic instead of racing a background kick)
  const afterFirst = await store.getById(first.job.jobId);
  assert.equal(afterFirst?.status, "completed");

  // Simulate the "crash before ScheduleStore state persisted" retry: identical occurrenceId.
  const retry = await engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A);
  assert.equal(retry.job.jobId, first.job.jobId, "the retry must return the exact same job, not a new one");
  assert.equal(retry.status, "completed");
  assert.equal((await store.list()).length, 1, "at most one job for this occurrence, ever");
});

void test("submitScheduledOccurrence: a DIFFERENT occurrenceId for the same work identity is treated as a genuinely new occurrence (a fresh due instant), not a duplicate coalesce", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "rebuild-index": runner });
  const input = { trigger: "scheduled" as const, kind: "rebuild-index" as const, pipelineVersion: 1 };

  const first = await engine.submitScheduledOccurrence(input, OCCURRENCE_ID_A);
  await engine.drain();
  // Same idempotencyKey (identical work), but the FIRST job is now terminal, so a genuinely new
  // logical occurrence (a new due instant, hence a new occurrenceId) legitimately gets its OWN job
  // -- this is the ordinary "the previous run finished; today's run is new work" case.
  const second = await engine.submitScheduledOccurrence(input, OCCURRENCE_ID_B);
  assert.notEqual(second.job.jobId, first.job.jobId);
  assert.equal((await store.list()).length, 2);
});

void test("submitScheduledOccurrence blocks a new scheduled bulk run behind an active manual batch", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "rebuild-index": runner });

  const manual = await engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  assert.ok(manual);
  await assert.rejects(() => engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A), { code: "BULK_BATCH_ACTIVE" });
  assert.equal((await store.list()).length, 1);
});

void test("acknowledgeScheduledOccurrence is idempotent and safe to call for an unknown occurrenceId", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "rebuild-index": runner });
  await assert.doesNotReject(() => engine.acknowledgeScheduledOccurrence(OCCURRENCE_ID_A));

  const job = await engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A);
  const occurrence = await store.getScheduledOccurrence(OCCURRENCE_ID_A);
  assert.equal(occurrence?.jobId, job.job.jobId);
  assert.equal(occurrence?.acknowledged, false);

  await engine.acknowledgeScheduledOccurrence(OCCURRENCE_ID_A, 2_000_000);
  await engine.acknowledgeScheduledOccurrence(OCCURRENCE_ID_A, 3_000_000); // second ack: idempotent no-op
  const acked = await store.getScheduledOccurrence(OCCURRENCE_ID_A);
  assert.equal(acked?.acknowledged, true);
});

void test("ordinary submit()/manual reruns remain completely unaffected by scheduled-occurrence submission -- a terminal job never blocks a deliberate manual rerun", async () => {
  const runner = new ScriptedRunner(linearAdvanceScript("rebuild-index"));
  const { engine, store } = makeEngine({ "rebuild-index": runner });
  const scheduled = await engine.submitScheduledOccurrence({ trigger: "scheduled", kind: "rebuild-index", pipelineVersion: 1 }, OCCURRENCE_ID_A);
  await engine.drain();
  assert.equal((await store.getById(scheduled.job.jobId))?.status, "completed");

  const manualRerun = await engine.submit({ trigger: "manual", kind: "rebuild-index", pipelineVersion: 1 });
  assert.notEqual(manualRerun.job.jobId, scheduled.job.jobId, "a manual rerun after terminal must create a new job, exactly as before this checkpoint");
  assert.equal((await store.list()).length, 2);
});

function isEngineErrorLike(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === code;
}
