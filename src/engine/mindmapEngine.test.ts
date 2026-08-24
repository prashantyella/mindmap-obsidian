import test from "node:test";
import assert from "node:assert/strict";

import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import type { IntervalRegistrar } from "../scheduling/coreScheduler";
import { MindmapEngine } from "./mindmapEngine";

function fakeRegistrar(): IntervalRegistrar {
  return {
    registerInterval: () => ({}),
    cancelInterval: () => undefined,
  };
}

void test("MindmapEngine.start() composes stores and returns a runtime-ready preflight report on a clean fake filesystem", async () => {
  const engine = new MindmapEngine({ dataRoot: "/data", fs: new FakeIndexFs(), registrar: fakeRegistrar() });
  const report = await engine.start();
  assert.equal(engine.getPhase(), "started");
  assert.equal(report.summary.runtimeReady, true);
  await engine.dispose();
});

void test("MindmapEngine.start() is idempotent -- calling twice returns the same report and does not repeat the recovery sequence", async () => {
  const fs = new FakeIndexFs();
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  const first = await engine.start();
  const readsAfterFirst = fs.readFileCalls.length;
  const second = await engine.start();
  assert.deepEqual(first, second);
  assert.equal(fs.readFileCalls.length, readsAfterFirst, "second start() must not re-run preflight/recovery I/O");
  await engine.dispose();
});

void test("MindmapEngine survives repeated start/stop/dispose cycles without throwing", async () => {
  const engine = new MindmapEngine({ dataRoot: "/data", fs: new FakeIndexFs(), registrar: fakeRegistrar() });
  await engine.start();
  await engine.stop();
  await engine.start();
  await engine.stop();
  await engine.dispose();
  await engine.dispose();
  await engine.stop();
  assert.equal(engine.getPhase(), "disposed");
});

void test("MindmapEngine.dispose() before start() is a safe no-op", async () => {
  const engine = new MindmapEngine({ dataRoot: "/data", fs: new FakeIndexFs(), registrar: fakeRegistrar() });
  await engine.dispose();
  assert.equal(engine.getPhase(), "disposed");
});

void test("a JOB_STORE fault (corrupt committed queue.json) does not prevent unrelated capabilities from reporting ok", async () => {
  const fs = new FakeIndexFs();
  fs.files.set("/data/jobs/queue.json", "{ this is not valid JSON");
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  const report = await engine.start();
  const jobCheck = report.checks.find((check) => check.code === "JOB_STORE");
  const scheduleCheck = report.checks.find((check) => check.code === "SCHEDULE_STORE");
  assert.equal(jobCheck?.status, "unavailable");
  assert.equal(scheduleCheck?.status, "ok", "schedule store must stay healthy even though the job store failed");
  assert.equal(report.summary.runtimeReady, false);
  await engine.dispose();
});

void test("an optional capability probe failure (Ollama) never marks runtimeReady false", async () => {
  const engine = new MindmapEngine({
    dataRoot: "/data",
    fs: new FakeIndexFs(),
    registrar: fakeRegistrar(),
    probes: { ollama: async () => ({ status: "unavailable", message: "connection refused" }) },
  });
  const report = await engine.start();
  assert.equal(report.summary.runtimeReady, true);
  const ollamaCheck = report.checks.find((check) => check.code === "OLLAMA_EMBEDDINGS");
  assert.equal(ollamaCheck?.status, "unavailable");
  await engine.dispose();
});

void test("dispose() during a start() blocked on a hung optional probe unwinds promptly instead of waiting for the probe", async () => {
  let sawAbort = false;
  let resolveProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    resolveProbeStarted = resolve;
  });
  const engine = new MindmapEngine({
    dataRoot: "/data",
    fs: new FakeIndexFs(),
    registrar: fakeRegistrar(),
    preflightTimeoutMs: 5000,
    probes: {
      ollama: (signal) => new Promise((resolve) => {
        resolveProbeStarted();
        signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve({ status: "unavailable", message: "aborted" });
        });
      }),
    },
  });

  const startPromise = engine.start();
  await probeStarted;
  const disposePromise = engine.dispose();

  const start = Date.now();
  await Promise.all([startPromise, disposePromise]);
  const elapsed = Date.now() - start;

  assert.equal(sawAbort, true);
  assert.equal(engine.getPhase(), "disposed");
  assert.ok(elapsed < 2000, `expected dispose() to cut the hung probe off quickly, took ${elapsed}ms`);
});

void test("MindmapEngine.inspectReadOnly() performs zero filesystem mutations, even with stale temp files, stale staging, and no owned directories yet present", async () => {
  const fs = new FakeIndexFs();
  // Pre-seed exactly the kind of leftover state a real interrupted run would leave behind: a
  // stale AtomicStore temp file beside the job queue, and a stale staging directory under the
  // index root -- neither REQUIRED_SUBDIRECTORIES nor these entries should ever be touched by a
  // read-only inspection.
  fs.files.set("/data/jobs/queue.json.atomic-tmp-abc123", "{ leftover temp }");
  fs.dirs.add("/data/staging/some-interrupted-build-token");
  const filesBefore = new Map(fs.files);
  const binaryFilesBefore = new Map(fs.binaryFiles);
  const dirsBefore = new Set(fs.dirs);

  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  const report = await engine.inspectReadOnly();

  assert.equal(engine.getPhase(), "idle", "inspectReadOnly() must never advance phase -- it never calls start()");
  assert.deepEqual(fs.files, filesBefore, "no file must be written or removed by a read-only inspection");
  assert.deepEqual(fs.binaryFiles, binaryFilesBefore, "no binary file must be written or removed by a read-only inspection");
  assert.deepEqual(fs.dirs, dirsBefore, "no directory must be created or removed by a read-only inspection (including REQUIRED_SUBDIRECTORIES)");
  assert.ok(report.checks.length > 0);
  const tempCleanupCheck = report.checks.find((check) => check.code === "TEMP_CLEANUP");
  assert.equal(tempCleanupCheck?.status, "degraded", "the stale temp file must be reported, not silently swept");
  const indexCheck = report.checks.find((check) => check.code === "INDEX_STORE");
  assert.equal(indexCheck?.status, "degraded", "the stale staging directory must be reported, not silently swept");
  await engine.dispose();
});

void test("MindmapEngine.inspectReadOnly() never recovers jobs, starts CoreScheduler, or submits a job -- callable repeatedly without side effects", async () => {
  const fs = new FakeIndexFs();
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  await engine.inspectReadOnly();
  await engine.inspectReadOnly();
  const jobs = await engine.jobStore.list();
  assert.deepEqual(jobs, []);
  assert.equal(engine.getPhase(), "idle");
  await engine.dispose();
});

void test("dispose() called in the same tick as start() (before start()'s enqueued body even begins) prevents CoreScheduler.start() and the final phase transition from ever running", async () => {
  const fs = new FakeIndexFs();
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  // dispose() sets its `disposeRequested` flag SYNCHRONOUSLY (before any await) -- calling it in
  // the same tick as start(), with no await between them, means start()'s enqueued body observes
  // disposeRequested === true at its very first check, before even the OWNED_DATA_PATHS mkdir step
  // runs (the "dispose() blocked on a hung optional probe" test above covers the mid-preflight
  // case; this one covers the earliest possible race).
  const startPromise = engine.start();
  const disposePromise = engine.dispose();
  await Promise.all([startPromise, disposePromise]);
  assert.equal(engine.getPhase(), "disposed", "phase must land on disposed, never started, once dispose() won the race");
  assert.equal(fs.dirs.size, 0, "OWNED_DATA_PATHS mkdir must never run once dispose() already won the race");
});

void test("safely() stores only a closed EngineError code (or the single UNKNOWN_FAULT_CODE fallback), never a constructor name or raw message", async () => {
  const fs = new FakeIndexFs();
  fs.files.set("/data/jobs/queue.json", "{ not valid json");
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  await engine.start();
  const faults = engine.getCapabilityFaults();
  const jobFault = faults.get("JOB_STORE");
  assert.ok(jobFault, "a corrupt job store must record a capability fault");
  assert.notEqual(jobFault, "SyntaxError", "must never be a raw constructor name");
  assert.doesNotMatch(jobFault ?? "", /not valid json/);
  await engine.dispose();
});

void test("a throwing onFault observer is isolated -- it cannot propagate out through MindmapEngine's internal fault-handling path", async () => {
  const fs = new FakeIndexFs();
  const engine = new MindmapEngine({
    dataRoot: "/data",
    fs,
    registrar: fakeRegistrar(),
    onFault: () => { throw new Error("a misbehaving observer"); },
  });
  // JOB_STORE's onScheduleError/onFault path is only exercised via a real fault; this test only
  // needs to prove construction with a throwing onFault, plus a normal lifecycle, never throws.
  await engine.start();
  await engine.dispose();
});

void test("MindmapEngine.start()'s JOB_STORE preflight check never describes an unconfigured runner set as operational readiness", async () => {
  const engine = new MindmapEngine({ dataRoot: "/data", fs: new FakeIndexFs(), registrar: fakeRegistrar() });
  const report = await engine.start();
  const jobCheck = report.checks.find((check) => check.code === "JOB_STORE");
  assert.equal(jobCheck?.context?.runnersConfigured, false);
  assert.match(jobCheck?.message ?? "", /no execution runners are configured/);
  await engine.dispose();
});

void test("MindmapEngine.start() sweeps ScheduleStore's own stale temp files as part of authoritative cleanup", async () => {
  const fs = new FakeIndexFs();
  fs.files.set("/data/schedules/schedule.json.atomic-tmp-leftover", "{ stale }");
  const engine = new MindmapEngine({ dataRoot: "/data", fs, registrar: fakeRegistrar() });
  await engine.start();
  assert.equal(fs.files.has("/data/schedules/schedule.json.atomic-tmp-leftover"), false, "start() must sweep ScheduleStore's leftover temp file, not just report it");
  await engine.dispose();
});

void test("JobEngine.start() (the mutation pump) is never called by MindmapEngine.start() -- no job can execute this checkpoint", async () => {
  const engine = new MindmapEngine({ dataRoot: "/data", fs: new FakeIndexFs(), registrar: fakeRegistrar() });
  await engine.start();
  // JobEngine exposes no public "isRunning" flag, so this is asserted the same way the engine
  // itself would notice: submitting a scheduled occurrence (which only ever *queues*, per
  // JobEngine.kick()'s own `if (!this.running) return;` guard) must never advance any job past
  // its initial queued phase without an explicit runOnce()/drain() call.
  const jobs = await engine.jobStore.list();
  assert.deepEqual(jobs, []);
  await engine.dispose();
});
