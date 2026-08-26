import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, computeJobIdempotencyKey, stableNoteIdentity, type QueueJobV1 } from "../engine/contracts";
import { ENGINE_ERROR_CODES, EngineError, isEngineError } from "../engine/errors";
import { parseJobStoreDocumentV1, parsePersistedJobV1, parseProviderPauseV1, sanitizeFailureCode, toFailureCode } from "./jobTypes";

const HASH_A = "a".repeat(64);

function noteJob(overrides: Partial<Pick<QueueJobV1, "phase">> = {}): QueueJobV1 {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  const target = { schemaVersion: 1 as const, kind: "note" as const, identity };
  const kind = "process-note" as const;
  const pipelineVersion = 1;
  const sourceHash = HASH_A;
  const embeddingModel = "m1";
  const phase = overrides.phase ?? "discover";
  return {
    schemaVersion: 1,
    jobId: "job-1",
    trigger: "manual",
    kind,
    target,
    sourceHash,
    embeddingModel,
    pipelineVersion,
    phase,
    idempotencyKey: computeJobIdempotencyKey(kind, target, pipelineVersion, sourceHash, embeddingModel),
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function rebuildJob(phase: QueueJobV1["phase"] = "discover"): QueueJobV1 {
  const target = { schemaVersion: 1 as const, kind: "global" as const };
  const kind = "rebuild-index" as const;
  const pipelineVersion = 1;
  return {
    schemaVersion: 1,
    jobId: "job-2",
    trigger: "manual",
    kind,
    target,
    pipelineVersion,
    phase,
    idempotencyKey: computeJobIdempotencyKey(kind, target, pipelineVersion),
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function scopeJob(kind: "reading-sync" | "scope-refresh", phase: QueueJobV1["phase"] = "discover"): QueueJobV1 {
  const target = { schemaVersion: 1 as const, kind: "scope" as const, scopeId: "vault-scope" };
  const pipelineVersion = 1;
  return {
    schemaVersion: 1,
    jobId: "job-3",
    trigger: "manual",
    kind,
    target,
    pipelineVersion,
    phase,
    idempotencyKey: computeJobIdempotencyKey(kind, target, pipelineVersion),
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

function assertShapeInvalid(value: unknown): void {
  assert.throws(() => parsePersistedJobV1(value), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
}

void test("bulk batch schema remains compatible with queue documents missing bulkBatches", () => {
  const parsed = parseJobStoreDocumentV1({ schemaVersion: 1, jobs: [], providerPause: { active: false }, scheduledOccurrences: [] });
  assert.deepEqual(parsed.bulkBatches, []);
});

void test("bulk batch parser rejects malformed timestamps, root kinds, and item references", () => {
  const root = { ...scopeJob("scope-refresh"), jobId: "bulk-root", batchId: "batch" };
  const base = { schemaVersion: 1, jobs: [{ schemaVersion: 1, job: root, status: "queued", attempt: 0, cancelRequested: false }], providerPause: { active: false }, scheduledOccurrences: [] };
  const batch = { schemaVersion: 1, batchId: "batch", rootJobId: "bulk-root", trigger: "manual", scopeId: "vault-scope", status: "active", createdAt: "not-a-date", updatedAt: "2026-08-23T00:00:00.000Z", items: [] };
  assert.throws(() => parseJobStoreDocumentV1({ ...base, bulkBatches: [batch] }), (error: unknown) => isEngineError(error) && error.code === "JOB_STORE_CORRUPT");
  const note = { ...noteJob(), jobId: "bulk-root", batchId: "batch", batchItemId: "a".repeat(64) };
  assert.throws(() => parseJobStoreDocumentV1({ ...base, jobs: [{ schemaVersion: 1, job: note, status: "queued", attempt: 0, cancelRequested: false }], bulkBatches: [{ ...batch, createdAt: "2026-08-23T00:00:00.000Z" }] }), (error: unknown) => isEngineError(error) && error.code === "JOB_STORE_CORRUPT");
});

void test("toFailureCode returns an EngineError's own code verbatim", () => {
  const error = new EngineError("EMBEDDING_TIMEOUT", "timed out", {});
  assert.equal(toFailureCode(error), "EMBEDDING_TIMEOUT");
});

void test("toFailureCode redacts a well-shaped but UNRECOGNIZED Error.name (e.g. a secret-bearing name) to UNKNOWN_TRANSIENT", () => {
  const error = new Error("some transient failure");
  error.name = "SECRET_TOKEN";
  assert.equal(toFailureCode(error), "UNKNOWN_TRANSIENT");
});

void test("(requirement 11) toFailureCode redacts a plain Error even when its .name is spelled exactly like a real EngineErrorCode -- only a genuine EngineError instance is ever trusted", () => {
  const error = new Error("boom");
  error.name = "EMBEDDING_TIMEOUT";
  assert.equal(toFailureCode(error), "UNKNOWN_TRANSIENT");

  const sourceStale = new Error("boom");
  sourceStale.name = "SOURCE_STALE";
  assert.equal(toFailureCode(sourceStale), "UNKNOWN_TRANSIENT");

  const modelNotFound = new Error("boom");
  modelNotFound.name = "EMBEDDING_MODEL_NOT_FOUND";
  assert.equal(toFailureCode(modelNotFound), "UNKNOWN_TRANSIENT");
});

void test("toFailureCode redacts an arbitrary non-Error thrown value to UNKNOWN_TRANSIENT", () => {
  assert.equal(toFailureCode("some string"), "UNKNOWN_TRANSIENT");
  assert.equal(toFailureCode(undefined), "UNKNOWN_TRANSIENT");
  assert.equal(toFailureCode({ code: "EMBEDDING_TIMEOUT" }), "UNKNOWN_TRANSIENT");
});

void test("sanitizeFailureCode passes through every real EngineErrorCode and UNKNOWN_TRANSIENT, and redacts everything else", () => {
  for (const code of ENGINE_ERROR_CODES) {
    assert.equal(sanitizeFailureCode(code), code);
  }
  assert.equal(sanitizeFailureCode("UNKNOWN_TRANSIENT"), "UNKNOWN_TRANSIENT");
  assert.equal(sanitizeFailureCode("SECRET_TOKEN"), "UNKNOWN_TRANSIENT");
  assert.equal(sanitizeFailureCode("MY_CUSTOM_RUNNER_CODE"), "UNKNOWN_TRANSIENT");
  assert.equal(sanitizeFailureCode(""), "UNKNOWN_TRANSIENT");
});

// -- Checkpoint 7 requirement 5: persisted invariants -- corrupt-document matrix -----------------

void test("parsePersistedJobV1 accepts a well-formed mid-pipeline note job", () => {
  const job = noteJob({ phase: "embed" });
  assert.doesNotThrow(() => parsePersistedJobV1({ schemaVersion: 1, job, status: "queued", attempt: 1, cancelRequested: false }));
});

void test("invariant: overlayCommitted requires noteCommitted", () => {
  const job = noteJob({ phase: "complete" });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "completed",
    attempt: 3,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: false, overlayCommitted: true },
  });
});

void test("invariant: noteCommitted requires an exact lowercase hex64 noteContentHash", () => {
  const job = noteJob({ phase: "write-overlay" });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "active",
    attempt: 2,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, overlayCommitted: false },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "active",
    attempt: 2,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, noteContentHash: "NOT-HEX", overlayCommitted: false },
  });
});

void test("invariant: noteContentHash must be absent while noteCommitted is false", () => {
  const job = noteJob({ phase: "embed" });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "queued",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: false, noteContentHash: HASH_A, overlayCommitted: false },
  });
});

void test("invariant: note receipt.noteCommitted is impossible before phase \"write-overlay\"", () => {
  const job = noteJob({ phase: "extract-metadata" });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "queued",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, noteContentHash: HASH_A, overlayCommitted: false },
  });
});

void test("invariant: a completed note job requires a fully-committed receipt", () => {
  const job = noteJob({ phase: "complete" });
  assertShapeInvalid({
    schemaVersion: 1,
    job,
    status: "completed",
    attempt: 3,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, noteContentHash: HASH_A, overlayCommitted: false },
  });
});

void test("invariant: rebuild chain activated => verified => built => targetGenerationId present", () => {
  const job = rebuildJob("complete");
  assertShapeInvalid({ schemaVersion: 1, job, status: "completed", attempt: 1, cancelRequested: false, receipt: { kind: "rebuild", built: false, verified: false, activated: true } });
  assertShapeInvalid({ schemaVersion: 1, job: rebuildJob("activate-generation"), status: "active", attempt: 1, cancelRequested: false, receipt: { kind: "rebuild", built: false, verified: true, activated: false } });
  assertShapeInvalid({ schemaVersion: 1, job: rebuildJob("build-generation"), status: "active", attempt: 1, cancelRequested: false, receipt: { kind: "rebuild", built: true, verified: false, activated: false, targetGenerationId: undefined } });
});

void test("invariant: rebuild receipt.built/verified are impossible before their corresponding phase", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("discover"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: true, activated: false },
  });
});

void test("invariant: a completed rebuild job requires an activated receipt", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("complete"),
    status: "completed",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: true, activated: false },
  });
});

void test("invariant: status \"completed\" requires job.phase to be the final phase, and vice versa", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "write-overlay" }),
    status: "completed",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, noteContentHash: HASH_A, overlayCommitted: true },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "complete" }),
    status: "queued",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: true, noteContentHash: HASH_A, overlayCommitted: true },
  });
});

void test("invariant: lastFailureCode and lastFailureClass must appear together", () => {
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "queued", attempt: 1, cancelRequested: false, lastFailureCode: "EMBEDDING_TIMEOUT" });
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "queued", attempt: 1, cancelRequested: false, lastFailureClass: "transient" });
});

void test("invariant: status \"failed\" requires lastFailureCode/lastFailureClass", () => {
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "failed", attempt: 1, cancelRequested: false });
});

void test("invariant: status \"completed\" must not carry a stale lastFailureCode/lastFailureClass", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "complete" }),
    status: "completed",
    attempt: 2,
    cancelRequested: false,
    lastFailureCode: "EMBEDDING_TIMEOUT",
    lastFailureClass: "transient",
    receipt: { kind: "note", noteCommitted: true, noteContentHash: HASH_A, overlayCommitted: true },
  });
});

void test("invariant: epoch fields (nextAttemptAtMs) must be non-negative safe integers", () => {
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "queued", attempt: 1, cancelRequested: false, nextAttemptAtMs: -1 });
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "queued", attempt: 1, cancelRequested: false, nextAttemptAtMs: 1.5 });
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "queued", attempt: 1, cancelRequested: false, nextAttemptAtMs: Number.MAX_SAFE_INTEGER + 10 });
});

void test("receipt: extra/unrecognized fields are rejected", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "embed" }),
    status: "queued",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "note", noteCommitted: false, overlayCommitted: false, secretField: "leak" },
  });
});

void test("invariant: an active ProviderPauseV1 requires both code and pausedAtMs; an inactive one forbids them", () => {
  assert.throws(() => parseProviderPauseV1({ active: true }), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  assert.throws(() => parseProviderPauseV1({ active: true, code: "EMBEDDING_TIMEOUT" }), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  assert.throws(
    () => parseProviderPauseV1({ active: false, code: "EMBEDDING_TIMEOUT", pausedAtMs: 100 }),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
  assert.doesNotThrow(() => parseProviderPauseV1({ active: true, code: "EMBEDDING_TIMEOUT", pausedAtMs: 100 }));
  assert.doesNotThrow(() => parseProviderPauseV1({ active: false }));
});

void test("invariant: ProviderPauseV1.pausedAtMs must be a non-negative safe integer", () => {
  assert.throws(
    () => parseProviderPauseV1({ active: true, code: "EMBEDDING_TIMEOUT", pausedAtMs: -5 }),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

// -- final-closure requirement 4/12: rebuild snapshot consistency, "paused" status removed, nextAttemptAtMs bounds --

function validRebuildSnapshot(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    baseGenerationId: null,
    baseFingerprint: null,
    dimension: 4,
    embeddingModel: "m1",
    overlays: [],
    fingerprint: "a".repeat(64),
    ...overrides,
  };
}

void test("invariant: rebuild receipt built:true requires a persisted snapshot", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false },
  });
});

void test("invariant: rebuild snapshot overlay entries must be unique and in strictly ascending fileName order", () => {
  const overlayFileNameFor = (hex: string) => `overlays/${hex.repeat(1).padEnd(64, "0")}.movl`;
  const entryA = { fileName: overlayFileNameFor("a"), version: 1, fingerprint: "a".repeat(64) };
  const entryB = { fileName: overlayFileNameFor("b"), version: 1, fingerprint: "b".repeat(64) };

  // Out of order (descending) must be rejected.
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot({ overlays: [entryB, entryA] }) },
  });

  // A duplicate fileName must be rejected.
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot({ overlays: [entryA, entryA] }) },
  });

  // Correctly ordered, unique entries are accepted.
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: rebuildJob("verify-generation"),
      status: "active",
      attempt: 1,
      cancelRequested: false,
      receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, builtManifestFingerprint: "c".repeat(64), snapshot: validRebuildSnapshot({ overlays: [entryA, entryB] }) },
    }),
  );
});

void test("invariant: rebuild snapshot dimension must respect MAX_EMBEDDING_DIMENSION", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot({ dimension: 8193 }) },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot({ dimension: 0 }) },
  });
});

void test("invariant: rebuild snapshot baseGenerationId and baseFingerprint must be null together, never only one", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("build-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot({ baseGenerationId: 1, baseFingerprint: null }) },
  });
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: rebuildJob("verify-generation"),
      status: "active",
      attempt: 1,
      cancelRequested: false,
      receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, builtManifestFingerprint: "c".repeat(64), snapshot: validRebuildSnapshot({ baseGenerationId: 1, baseFingerprint: "b".repeat(64) }) },
    }),
  );
});

void test("invariant: a raw \"paused\" status is rejected -- the status is no longer modeled at all", () => {
  assertShapeInvalid({ schemaVersion: 1, job: noteJob(), status: "paused", attempt: 1, cancelRequested: false });
});

void test("invariant: nextAttemptAtMs may only be set on a queued job with lastFailureClass transient -- never on active/failed/cancelled/completed, and never alongside a terminal lastFailureClass", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "embed" }),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    nextAttemptAtMs: 1000,
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: noteJob({ phase: "embed" }),
    status: "queued",
    attempt: 1,
    cancelRequested: false,
    lastFailureCode: "JOB_SHAPE_INVALID",
    lastFailureClass: "terminal",
    nextAttemptAtMs: 1000,
  });
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: noteJob({ phase: "embed" }),
      status: "queued",
      attempt: 1,
      cancelRequested: false,
      lastFailureCode: "EMBEDDING_TIMEOUT",
      lastFailureClass: "transient",
      nextAttemptAtMs: 1000,
    }),
  );
});

void test("(acceptance guard 5) rebuild receipt: built=true requires builtManifestFingerprint", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("verify-generation"),
    status: "active",
    attempt: 1,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: false, activated: false, snapshot: validRebuildSnapshot() },
  });
});

void test("(acceptance guard 5) rebuild receipt: built=false forbids carrying a stale snapshot or builtManifestFingerprint", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("discover"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "rebuild", built: false, verified: false, activated: false, snapshot: validRebuildSnapshot() },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("discover"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "rebuild", built: false, verified: false, activated: false, builtManifestFingerprint: "c".repeat(64) },
  });
});

void test("(acceptance guard 5) rebuild receipt: targetGenerationId must be a safe integer, never NaN/Infinity/a float", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assertShapeInvalid({
      schemaVersion: 1,
      job: rebuildJob("discover"),
      status: "active",
      attempt: 0,
      cancelRequested: false,
      receipt: { kind: "rebuild", targetGenerationId: bad, built: false, verified: false, activated: false },
    });
  }
});

void test("(last-contract guard 1) rebuild receipt: targetGenerationId remains allowed alongside built=false -- exactly the post-discover, pre-build shape", () => {
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: rebuildJob("build-generation"),
      status: "active",
      attempt: 0,
      cancelRequested: false,
      receipt: { kind: "rebuild", targetGenerationId: 3, built: false, verified: false, activated: false },
    }),
  );
});

void test("(last-contract guard 1) rebuild receipt: a fully well-formed built+verified+activated receipt (the full chain, every field present) is accepted", () => {
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: rebuildJob("complete"),
      status: "completed",
      attempt: 0,
      cancelRequested: false,
      receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: true, activated: true, snapshot: validRebuildSnapshot(), builtManifestFingerprint: "c".repeat(64) },
    }),
  );
});

void test("(last-contract guard 1) rebuild receipt: verified=true without builtManifestFingerprint is rejected (verified inherits the full built chain, not just built=true)", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("activate-generation"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: true, activated: false, snapshot: validRebuildSnapshot() },
  });
});

void test("(last-contract guard 1) rebuild receipt: activated=true without builtManifestFingerprint is rejected (activated inherits the full built chain)", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: rebuildJob("complete"),
    status: "completed",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "rebuild", targetGenerationId: 1, built: true, verified: true, activated: true, snapshot: validRebuildSnapshot() },
  });
});

void test("(acceptance guard 5) scope receipt: discovered and discoveredCount must be set together", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("scope-refresh", "enqueue"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true },
  });
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("scope-refresh", "enqueue"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: false, discoveredCount: 3 },
  });
});

void test("(acceptance guard 5) scope receipt: discovered is impossible while still at phase \"discover\" -- an impossible future flag", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("scope-refresh", "discover"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 0 },
  });
});

void test("(acceptance guard 5) scope receipt: a reading-sync job that has left phase \"import\" (now at enqueue/complete) requires receipt.imported", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("reading-sync", "enqueue"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 2 },
  });
});

void test("(acceptance guard 5) scope receipt: imported is impossible while still at phase \"import\" itself (not yet left it)", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("reading-sync", "import"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 2, imported: true },
  });
});

void test("(acceptance guard 5) scope receipt: enqueuedCount is impossible before leaving phase \"enqueue\"", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("reading-sync", "enqueue"),
    status: "active",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "d".repeat(64), imported: true, enqueuedCount: 2 },
  });
});

void test("(acceptance guard 5) scope receipt: a completed reading-sync job requires receipt.imported", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("reading-sync", "complete"),
    status: "completed",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "d".repeat(64), enqueuedCount: 2 },
  });
});

void test("(acceptance guard 5) scope receipt: scope-refresh can never legitimately carry receipt.imported: true", () => {
  assertShapeInvalid({
    schemaVersion: 1,
    job: scopeJob("scope-refresh", "complete"),
    status: "completed",
    attempt: 0,
    cancelRequested: false,
    receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "d".repeat(64), imported: true, enqueuedCount: 2 },
  });
});

void test("(acceptance guard 5) scope receipt: a well-formed completed reading-sync receipt (discovered+imported+enqueued, all counts present) is accepted", () => {
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: scopeJob("reading-sync", "complete"),
      status: "completed",
      attempt: 0,
      cancelRequested: false,
      receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "d".repeat(64), imported: true, enqueuedCount: 2 },
    }),
  );
});

void test("(acceptance guard 5) scope receipt: a well-formed completed scope-refresh receipt (discovered+enqueued, no imported) is accepted", () => {
  assert.doesNotThrow(() =>
    parsePersistedJobV1({
      schemaVersion: 1,
      job: scopeJob("scope-refresh", "complete"),
      status: "completed",
      attempt: 0,
      cancelRequested: false,
      receipt: { kind: "scope", discovered: true, discoveredCount: 2, discoveryFingerprint: "d".repeat(64), enqueuedCount: 2 },
    }),
  );
});
