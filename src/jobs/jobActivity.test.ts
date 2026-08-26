import test from "node:test";
import assert from "node:assert/strict";
import { deriveEngineActivity } from "./jobActivity";

void test("activity distinguishes queued work from pending and reports batch progress", () => {
  const snapshot = deriveEngineActivity([], [{ schemaVersion: 1, batchId: "b", rootJobId: "r", trigger: "manual", scopeId: "all", status: "active", discoveredTotal: 2, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z", items: [{ batchItemId: "a".repeat(64), jobId: "j", status: "completed" }] }], { active: false }, true, false, undefined);
  assert.equal(snapshot.state, "running");
  assert.deepEqual(snapshot.batch, { status: "active", processed: 1, total: 2, failed: 0 });
});

void test("activity reports stopped for a disabled pump even when work remains", () => {
  const snapshot = deriveEngineActivity([{ schemaVersion: 1, job: { schemaVersion: 1, jobId: "j", trigger: "manual", kind: "process-note", target: { schemaVersion: 1, kind: "global" } as never, sourceHash: "a".repeat(64), embeddingModel: "m", pipelineVersion: 1, phase: "discover", idempotencyKey: "k", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, status: "queued", attempt: 0, cancelRequested: false } as never], [], { active: false }, false, false, undefined);
  assert.equal(snapshot.state, "stopped");
});

void test("activity fault takes precedence over pause and includes latest failed batches", () => {
  const snapshot = deriveEngineActivity([], [{ schemaVersion: 1, batchId: "b", rootJobId: "r", trigger: "manual", status: "failed", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", items: [] }], { active: true, code: "EMBEDDING_TIMEOUT", pausedAtMs: 1 }, true, false, "STORE_READ_FAILED");
  assert.equal(snapshot.state, "faulted");
  assert.deepEqual(snapshot.latestFailureBatch, { status: "failed", failed: 0 });
});
