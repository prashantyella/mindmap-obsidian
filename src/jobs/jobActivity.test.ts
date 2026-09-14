import test from "node:test";
import assert from "node:assert/strict";
import { deriveEngineActivity } from "./jobActivity";
import { EngineError } from "../engine/errors";

void test("activity distinguishes queued work from pending and reports batch progress", () => {
  const rootJob = { schemaVersion: 1 as const, job: { schemaVersion: 1 as const, jobId: "r", trigger: "manual" as const, kind: "scope-refresh" as const, target: { schemaVersion: 1 as const, kind: "scope" as const, scopeId: "all" }, sourceHash: undefined, embeddingModel: undefined, pipelineVersion: 1, phase: "complete", idempotencyKey: "k", batchId: "b", createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" }, status: "completed" as const, attempt: 1, cancelRequested: false, receipt: { kind: "scope" as const, discovered: true, discoveredCount: 2, discoveryFingerprint: "f".repeat(64), enqueuedCount: 2 } };
  const snapshot = deriveEngineActivity([rootJob as never], [{ schemaVersion: 1, batchId: "b", rootJobId: "r", trigger: "manual", scopeId: "all", status: "active", discoveredTotal: 2, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z", items: [{ batchItemId: "0".repeat(64), jobId: "j1", status: "completed" }, { batchItemId: "0".repeat(63) + "1", jobId: "j2", status: "queued" }] }], { active: false }, { active: false }, true, false, undefined);
  assert.equal(snapshot.state, "running");
  assert.deepEqual(snapshot.batch, { status: "active", preparing: false, processed: 1, total: 2, failed: 0, enqueuedCount: 2 });
});

void test("activity reports stopped for a disabled pump even when work remains", () => {
  const snapshot = deriveEngineActivity([{ schemaVersion: 1, job: { schemaVersion: 1, jobId: "j", trigger: "manual", kind: "process-note", target: { schemaVersion: 1, kind: "global" } as never, sourceHash: "a".repeat(64), embeddingModel: "m", pipelineVersion: 1, phase: "discover", idempotencyKey: "k", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, status: "queued", attempt: 0, cancelRequested: false } as never], [], { active: false }, { active: false }, false, false, undefined);
  assert.equal(snapshot.state, "stopped");
});

void test("activity fault takes precedence over pause and includes latest failed batches", () => {
  const snapshot = deriveEngineActivity([], [{ schemaVersion: 1, batchId: "b", rootJobId: "r", trigger: "manual", status: "failed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", items: [] }], { active: true, code: "EMBEDDING_TIMEOUT", pausedAtMs: 1 }, { active: false }, true, false, "STORE_READ_FAILED");
  assert.equal(snapshot.state, "faulted");
  assert.deepEqual(snapshot.latestFailureBatch, { status: "failed", failed: 0 });
});

void test("operator pause is distinct and wins over provider pause", () => {
  const snapshot = deriveEngineActivity([], [], { active: true, code: "EMBEDDING_TIMEOUT", pausedAtMs: 1 }, { active: true, pausedAt: "2026-08-25T00:00:00.000Z" }, true, false, undefined);
  assert.equal(snapshot.state, "operator-paused");
  assert.equal(snapshot.operatorPause, true);
});

// -- CP4: preparing boolean + progress formula tests ----------------------------------------------

const TS = "2026-09-14T00:00:00.000Z";
const NO_PAUSE = { active: false } as const;

function makeScopeRootJob(overrides: { status: "queued" | "active" | "completed" | "failed" | "cancelled"; phase?: string; enqueuedCount?: number; discoveredCount?: number }) {
  const hasDiscovery = overrides.discoveredCount !== undefined;
  return {
    schemaVersion: 1 as const,
    job: { schemaVersion: 1 as const, jobId: "root-1", trigger: "scheduled" as const, kind: "scope-refresh" as const, target: { schemaVersion: 1 as const, kind: "scope" as const, scopeId: "all" }, sourceHash: undefined, embeddingModel: undefined, pipelineVersion: 1, phase: overrides.phase ?? "complete", idempotencyKey: "k", batchId: "b1", createdAt: TS, updatedAt: TS },
    status: overrides.status,
    attempt: 1,
    cancelRequested: false,
    receipt: hasDiscovery ? { kind: "scope" as const, discovered: true, discoveredCount: overrides.discoveredCount!, discoveryFingerprint: "f".repeat(64), enqueuedCount: overrides.enqueuedCount } : undefined,
  };
}

function makeRebuildRootJob(overrides: { status: "queued" | "active" | "completed" | "failed" | "cancelled"; phase?: string }) {
  return {
    schemaVersion: 1 as const,
    job: { schemaVersion: 1 as const, jobId: "root-1", trigger: "manual" as const, kind: "rebuild-index" as const, target: { schemaVersion: 1 as const, kind: "global" as const }, sourceHash: undefined, embeddingModel: undefined, pipelineVersion: 1, phase: overrides.phase ?? "complete", idempotencyKey: "k", batchId: "b1", createdAt: TS, updatedAt: TS },
    status: overrides.status,
    attempt: 1,
    cancelRequested: false,
  };
}

function makeBatch(overrides: { discoveredTotal?: number; items?: Array<{ status: string }>; scopeId?: string; trigger?: "scheduled" | "manual" }) {
  const items = (overrides.items ?? []).map((item, i) => ({ batchItemId: i.toString(16).padStart(64, "0"), jobId: `child-${i}`, status: item.status }));
  return { schemaVersion: 1 as const, batchId: "b1", rootJobId: "root-1", trigger: (overrides.trigger ?? "scheduled") as "scheduled" | "manual", scopeId: overrides.scopeId, status: "active" as const, discoveredTotal: overrides.discoveredTotal, createdAt: TS, updatedAt: TS, items };
}

void test("CP4: preparing=true when scope-refresh root is nonterminal (discover phase)", () => {
  const root = makeScopeRootJob({ status: "active", phase: "discover" });
  const batch = makeBatch({ discoveredTotal: undefined, items: [], scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.preparing, true);
  assert.equal(snapshot.batch?.total, undefined);
});

void test("CP4: preparing=true when scope-refresh root is in enqueue phase", () => {
  const root = makeScopeRootJob({ status: "active", phase: "enqueue", discoveredCount: 935 });
  const batch = makeBatch({ discoveredTotal: 935, items: [], scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.preparing, true);
});

void test("CP4: preparing=false, processed=(D-E)+terminal when root completed (E=40, D=935, 10 done → 905)", () => {
  const root = makeScopeRootJob({ status: "completed", enqueuedCount: 40, discoveredCount: 935 });
  const terminalItems = Array.from({ length: 10 }, () => ({ status: "completed" }));
  const queuedItems = Array.from({ length: 30 }, () => ({ status: "queued" }));
  const batch = makeBatch({ discoveredTotal: 935, items: [...terminalItems, ...queuedItems], scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.preparing, false);
  assert.equal(snapshot.batch?.processed, 905);
  assert.equal(snapshot.batch?.total, 935);
  assert.equal(snapshot.batch?.enqueuedCount, 40);
});

void test("CP4: preparing=false, processed=935 when all 40 children terminal (D=935, E=40)", () => {
  const root = makeScopeRootJob({ status: "completed", enqueuedCount: 40, discoveredCount: 935 });
  const children = Array.from({ length: 40 }, () => ({ status: "completed" }));
  const batch = makeBatch({ discoveredTotal: 935, items: children, scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.preparing, false);
  assert.equal(snapshot.batch?.processed, 935);
});

void test("CP4: total=undefined when discoveredTotal not yet set", () => {
  const root = makeScopeRootJob({ status: "active", phase: "discover" });
  const batch = makeBatch({ discoveredTotal: undefined, items: [], scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.total, undefined);
  assert.equal(snapshot.batch?.preparing, true);
});

void test("CP4: rebuild-index preparing=true when root nonterminal", () => {
  const root = makeRebuildRootJob({ status: "active", phase: "build-generation" });
  const batch = makeBatch({ discoveredTotal: 0, items: [], trigger: "manual" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.preparing, true);
  assert.equal(snapshot.batch?.enqueuedCount, undefined);
});

void test("CP4: mixed terminal children — processed counts all terminal, failed counts failed+cancelled", () => {
  const root = makeScopeRootJob({ status: "completed", enqueuedCount: 10, discoveredCount: 50 });
  const items = [
    { status: "completed" }, { status: "completed" }, { status: "completed" },
    { status: "failed" }, { status: "failed" },
    { status: "cancelled" },
    { status: "queued" }, { status: "queued" }, { status: "queued" }, { status: "active" },
  ];
  const batch = makeBatch({ discoveredTotal: 50, items, scopeId: "all" });
  const snapshot = deriveEngineActivity([root as never], [batch as never], NO_PAUSE, { active: false }, true, false, undefined);
  assert.equal(snapshot.batch?.processed, 46);
  assert.equal(snapshot.batch?.failed, 3);
  assert.equal(snapshot.batch?.total, 50);
});

void test("CP4: active batch with missing root throws JOB_STORE_CORRUPT", () => {
  const batch = makeBatch({ discoveredTotal: 10, items: [], scopeId: "all" });
  assert.throws(() => deriveEngineActivity([], [batch as never], NO_PAUSE, { active: false }, true, false, undefined), (err: unknown) => err instanceof EngineError && err.code === "JOB_STORE_CORRUPT");
});
