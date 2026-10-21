import test from "node:test";
import assert from "node:assert/strict";
import { JOB_KIND_PHASES } from "../engine/contracts";
import { JobEngine } from "./jobEngine";
import { JobStore } from "./jobStore";
import { deriveEngineActivity } from "./jobActivity";
import { buildStatusBarPresentation, type StatusBarMenuState } from "../statusBarState";
import { NO_ACTIVE_NOTE } from "../individualNote";
import { FakeFs, FakeClock, makeEngine, noteIdentity } from "./jobEngine.test-support";

// -- CP6: end-to-end scope lifecycle regressions -------------------------------------------

async function completeChild(store: JobStore, jobId: string): Promise<void> {
  const phases = JOB_KIND_PHASES["process-note"];
  for (let i = 1; i < phases.length; i++) {
    await store.updateJob(jobId, (c) => ({ ...c, job: { ...c.job, phase: phases[i] }, ...(i === phases.length - 1 ? { status: "completed" as const, receipt: { kind: "note" as const, noteCommitted: true, noteContentHash: "c".repeat(64), overlayCommitted: true } } : {}) }));
  }
}

async function snapshotActivity(store: JobStore, pumpEnabled = true): Promise<ReturnType<typeof deriveEngineActivity>> {
  return deriveEngineActivity(await store.list(), await store.getBulkBatches(), await store.getProviderPause(), await store.getOperatorPause(), pumpEnabled, false, undefined);
}

function presentationLabel(activity: ReturnType<typeof deriveEngineActivity>): string {
  const menuState: StatusBarMenuState = { pendingAvailable: true, currentPending: 0, allPending: 0, pendingPaths: [], running: false, runStatus: null, activity, preflightInProgress: false, preflightOk: true, scopeReady: true, schedulerMode: "manual", schedulerHealth: null, schedulerDetails: [], semanticState: "off", activeNote: NO_ACTIVE_NOTE, readingMode: "standard", readingActivity: "disabled", readingLastSyncAt: null, readingPending: 0, readingImported: 0, readingUnresearchable: 0, readingError: null, webResearchMode: "off", webResearchActivity: "off", webResearchError: null, automaticResearchAttempted: 0, automaticResearchPauseReason: null, automaticResearchLastError: null, automaticResearchLastErrorAt: null };
  return buildStatusBarPresentation(menuState).label;
}

void test("CP6: scope lifecycle — discover/preparing → enqueue/preparing → root complete 895/935 → children complete settles batch", async () => {
  const { engine, store } = makeEngine({});
  const root = await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });

  // Stage 1: discover phase — preparing, no total
  const a1 = await snapshotActivity(store);
  assert.equal(a1.batch?.preparing, true);
  assert.equal(a1.batch?.total, undefined);
  assert.equal(presentationLabel(a1), "Mindmap · preparing");

  // Stage 2: advance root to enqueue with discoveredCount=935 — still preparing, total=935
  await store.updateJob(root.job.jobId, (c) => ({ ...c, job: { ...c.job, phase: "enqueue" }, receipt: { kind: "scope", discovered: true, discoveredCount: 935, discoveryFingerprint: "f".repeat(64) } }));
  const a2 = await snapshotActivity(store);
  assert.equal(a2.batch?.preparing, true);
  assert.equal(a2.batch?.total, 935);
  assert.equal(presentationLabel(a2), "Mindmap · preparing");

  // Submit 40 bulk children
  const batch = (await store.getBulkBatches())[0]!;
  for (let i = 0; i < 40; i++) {
    await engine.submitBulkChild(batch.batchId, { trigger: "manual", kind: "process-note", identity: noteIdentity(`Notes/N${i}.md`), sourceHash: i.toString(16).padStart(64, "0"), embeddingModel: "m", pipelineVersion: 1 });
  }

  // Stage 3: complete root with enqueuedCount=40, 0 children terminal — 895/935
  await store.updateJob(root.job.jobId, (c) => ({ ...c, status: "completed", job: { ...c.job, phase: "complete" }, receipt: { kind: "scope", discovered: true, discoveredCount: 935, discoveryFingerprint: "f".repeat(64), enqueuedCount: 40 } }));
  const a3 = await snapshotActivity(store);
  assert.equal(a3.batch?.preparing, false);
  assert.equal(a3.batch?.processed, 895);
  assert.equal(a3.batch?.total, 935);
  assert.equal(a3.batch?.enqueuedCount, 40);
  assert.equal(presentationLabel(a3), "Mindmap · 895/935");

  // Stage 4: complete 10 children — 905/935
  const children = (await store.getBulkBatches())[0]!.items;
  for (let i = 0; i < 10; i++) await completeChild(store, children[i].jobId);
  const a4 = await snapshotActivity(store);
  assert.equal(a4.batch?.processed, 905);
  assert.equal(presentationLabel(a4), "Mindmap · 905/935");

  // Stage 5: complete remaining 30 children — batch settles to "completed"
  for (let i = 10; i < 40; i++) await completeChild(store, children[i].jobId);
  const settled = (await store.getBulkBatches())[0]!;
  assert.equal(settled.status, "completed");
  const a5 = await snapshotActivity(store);
  assert.equal(a5.batch, undefined);
  assert.equal(a5.state, "idle");
});

void test("CP6: operator pause with queued enqueue-phase root preserves work and resumes as preparing", async () => {
  const { engine, store } = makeEngine({});
  const root = await engine.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });

  // Advance to enqueue phase with discovery
  await store.updateJob(root.job.jobId, (c) => ({ ...c, job: { ...c.job, phase: "enqueue" }, receipt: { kind: "scope", discovered: true, discoveredCount: 50, discoveryFingerprint: "f".repeat(64) } }));
  for (let i = 0; i < 5; i++) {
    const batch = (await store.getBulkBatches())[0]!;
    await engine.submitBulkChild(batch.batchId, { trigger: "manual", kind: "process-note", identity: noteIdentity(`Notes/P${i}.md`), sourceHash: i.toString(16).padStart(64, "0"), embeddingModel: "m", pipelineVersion: 1 });
  }

  // Pause processing
  await engine.pauseProcessing();
  const paused = await snapshotActivity(store);
  assert.equal(paused.state, "operator-paused");
  assert.equal(paused.batch?.preparing, true);
  assert.equal(paused.batch?.total, 50);
  assert.equal(presentationLabel(paused), "Mindmap · paused");

  // Verify work is preserved: root still active, children still queued, batch still active
  const rootAfterPause = await store.getById(root.job.jobId);
  assert.equal(rootAfterPause?.status, "queued");
  const batchAfterPause = (await store.getBulkBatches())[0]!;
  assert.equal(batchAfterPause.status, "active");
  assert.equal(batchAfterPause.items.length, 5);

  // Resume processing
  await engine.resumeProcessing();
  const resumed = await snapshotActivity(store);
  assert.equal(resumed.state, "running");
  assert.equal(resumed.batch?.preparing, true);
  assert.equal(presentationLabel(resumed), "Mindmap · preparing");

  // Complete root — preparing transitions to progress display
  await store.updateJob(root.job.jobId, (c) => ({ ...c, status: "completed", job: { ...c.job, phase: "complete" }, receipt: { kind: "scope", discovered: true, discoveredCount: 50, discoveryFingerprint: "f".repeat(64), enqueuedCount: 5 } }));
  const afterRoot = await snapshotActivity(store);
  assert.equal(afterRoot.batch?.preparing, false);
  assert.equal(afterRoot.batch?.processed, 45);
  assert.equal(afterRoot.batch?.total, 50);
  assert.equal(presentationLabel(afterRoot), "Mindmap · 45/50");
});

void test("CP6: fresh engine restart re-derives preparing and progress from persisted state", async () => {
  const fs = new FakeFs();
  const store1 = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engine1 = new JobEngine(store1, {}, clock);

  // Set up mid-lifecycle: root complete with D=100/E=20, 5 children terminal
  const root = await engine1.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  await store1.updateJob(root.job.jobId, (c) => ({ ...c, job: { ...c.job, phase: "enqueue" }, receipt: { kind: "scope", discovered: true, discoveredCount: 100, discoveryFingerprint: "f".repeat(64) } }));
  const batch = (await store1.getBulkBatches())[0]!;
  for (let i = 0; i < 20; i++) {
    await engine1.submitBulkChild(batch.batchId, { trigger: "manual", kind: "process-note", identity: noteIdentity(`Notes/R${i}.md`), sourceHash: i.toString(16).padStart(64, "0"), embeddingModel: "m", pipelineVersion: 1 });
  }
  await store1.updateJob(root.job.jobId, (c) => ({ ...c, status: "completed", job: { ...c.job, phase: "complete" }, receipt: { kind: "scope", discovered: true, discoveredCount: 100, discoveryFingerprint: "f".repeat(64), enqueuedCount: 20 } }));
  const children = (await store1.getBulkBatches())[0]!.items;
  for (let i = 0; i < 5; i++) await completeChild(store1, children[i].jobId);
  engine1.dispose();

  // Construct NEW JobStore + JobEngine over the same FakeFs — true restart from persisted state
  const freshStore = new JobStore(fs, "/root");
  const freshEngine = new JobEngine(freshStore, {});
  await freshEngine.recoverInterruptedJobs();
  const restarted = await snapshotActivity(freshStore);
  assert.equal(restarted.batch?.preparing, false);
  assert.equal(restarted.batch?.processed, 85);
  assert.equal(restarted.batch?.total, 100);
  assert.equal(restarted.batch?.enqueuedCount, 20);
  assert.equal(restarted.batch?.failed, 0);
  assert.equal(presentationLabel(restarted), "Mindmap · 85/100");

  // Also verify preparing=true is correctly re-derived for a mid-discover state
  const fs2 = new FakeFs();
  const storeA = new JobStore(fs2, "/root");
  const engineA = new JobEngine(storeA, {}, clock);
  await engineA.submit({ trigger: "manual", kind: "scope-refresh", scopeId: "all", pipelineVersion: 1 });
  engineA.dispose();

  const storeB = new JobStore(fs2, "/root");
  const engineB = new JobEngine(storeB, {});
  await engineB.recoverInterruptedJobs();
  const restartedPreparing = await snapshotActivity(storeB);
  assert.equal(restartedPreparing.batch?.preparing, true);
  assert.equal(restartedPreparing.batch?.total, undefined);
  assert.equal(presentationLabel(restartedPreparing), "Mindmap · preparing");
});
