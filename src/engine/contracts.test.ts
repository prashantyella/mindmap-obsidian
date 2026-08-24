import test from "node:test";
import assert from "node:assert/strict";

import {
  APPROVED_PRODUCTION_BENCHMARK_V1,
  canonicalizePath,
  computeJobIdempotencyKey,
  JOB_KIND_PHASES,
  JOB_TRIGGER_KINDS,
  parseEmbeddingVectorV1,
  parseHealthCheckV1,
  parseIndexRecordV1,
  parseMetadataOutputV1,
  parseNoteSnapshotV1,
  parseQueueJobV1,
  parseRelatedCandidateV1,
  parseSourceProjectionV1,
  parseStructuredFailureV1,
  stableNoteIdentity,
  type JobTargetV1,
} from "./contracts";
import { EngineError, isEngineError } from "./errors";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function validNoteSnapshot(): unknown {
  return {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" },
    rawContent: "---\ntitle: Example\n---\nBody.\n",
    isAppleAnnotation: false,
  };
}

void test("canonicalizePath normalizes backslashes and strips leading ./", () => {
  assert.equal(canonicalizePath(".\\Notes\\Example.md"), "Notes/Example.md");
  assert.equal(canonicalizePath("./Notes/Example.md"), "Notes/Example.md");
});

void test("canonicalizePath rejects traversal and absolute paths with distinct codes", () => {
  assert.throws(() => canonicalizePath("../Notes/Example.md"), (error: unknown) => isEngineError(error) && error.code === "PATH_TRAVERSAL");
  assert.throws(() => canonicalizePath("/Notes/Example.md"), (error: unknown) => isEngineError(error) && error.code === "PATH_ABSOLUTE");
  assert.throws(() => canonicalizePath("   "), (error: unknown) => isEngineError(error) && error.code === "PATH_EMPTY");
});

void test("canonicalizePath is deterministic for equivalent inputs", () => {
  const a = canonicalizePath("Notes//Sub/../Sub/Example.md".replace("../Sub/", ""));
  const b = canonicalizePath("Notes/Sub/Example.md");
  assert.equal(a, b);
});

void test("canonicalizePath preserves meaningful leading/trailing spaces inside a filename", () => {
  assert.equal(canonicalizePath("Notes/ Draft.md"), "Notes/ Draft.md");
  assert.equal(canonicalizePath("Notes/Draft .md"), "Notes/Draft .md");
});

void test("canonicalizePath rejects control characters, including a NUL byte", () => {
  const nulByte = String.fromCharCode(0);
  const bellChar = String.fromCharCode(7);
  const delChar = String.fromCharCode(127);
  assert.throws(
    () => canonicalizePath(`Notes/Bad${nulByte}Name.md`),
    (error: unknown) => isEngineError(error) && error.code === "PATH_CONTROL_CHARACTER",
  );
  assert.throws(
    () => canonicalizePath(`Notes/Bad${bellChar}Name.md`),
    (error: unknown) => isEngineError(error) && error.code === "PATH_CONTROL_CHARACTER",
  );
  assert.throws(
    () => canonicalizePath(`Notes/Bad${delChar}Name.md`),
    (error: unknown) => isEngineError(error) && error.code === "PATH_CONTROL_CHARACTER",
  );
});

void test("stableNoteIdentity picks path kind when no annotation id is given", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/Example.md"));
  assert.equal(identity.kind, "path");
  assert.equal(identity.appleAnnotationId, undefined);
});

void test("stableNoteIdentity picks apple-annotation kind and keeps it as the identity even if path changes", () => {
  const identity = stableNoteIdentity(canonicalizePath("Books/Apple Books/A/B/Annotations/1.md"), "abc-123");
  assert.equal(identity.kind, "apple-annotation");
  assert.equal(identity.appleAnnotationId, "abc-123");
});

void test("stableNoteIdentity never silently downgrades a blank annotation id to a path identity", () => {
  const canonicalPath = canonicalizePath("Books/Apple Books/A/B/Annotations/1.md");
  assert.throws(
    () => stableNoteIdentity(canonicalPath, "   "),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
  assert.throws(
    () => stableNoteIdentity(canonicalPath, ""),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
});

void test("parseNoteSnapshotV1 accepts a well-formed contract", () => {
  const snapshot = parseNoteSnapshotV1(validNoteSnapshot());
  assert.equal(snapshot.identity.canonicalPath, "Notes/Example.md");
});

void test("parseNoteSnapshotV1 rejects a missing schemaVersion with a distinct code", () => {
  const value = validNoteSnapshot() as Record<string, unknown>;
  delete value.schemaVersion;
  assert.throws(() => parseNoteSnapshotV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SCHEMA_VERSION_MISSING");
});

void test("parseNoteSnapshotV1 rejects a future/unknown schemaVersion with a distinct code", () => {
  const value = validNoteSnapshot() as Record<string, unknown>;
  value.schemaVersion = 2;
  assert.throws(() => parseNoteSnapshotV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SCHEMA_VERSION_MISMATCH");
});

void test("parseNoteSnapshotV1 rejects malformed shapes with CONTRACT_SHAPE_INVALID", () => {
  assert.throws(() => parseNoteSnapshotV1({ schemaVersion: 1 }), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
  assert.throws(() => parseNoteSnapshotV1(null), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
  assert.throws(() => parseNoteSnapshotV1("not an object"), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseNoteSnapshotV1 rejects isAppleAnnotation/identity.kind contradictions", () => {
  const annotationTrueButPathIdentity = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" },
    rawContent: "Body.\n",
    isAppleAnnotation: true,
  };
  assert.throws(
    () => parseNoteSnapshotV1(annotationTrueButPathIdentity),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );

  const annotationFalseButAnnotationIdentity = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "apple-annotation", canonicalPath: "Books/Apple Books/A/B/Annotations/1.md", appleAnnotationId: "abc" },
    rawContent: "Body.\n",
    isAppleAnnotation: false,
  };
  assert.throws(
    () => parseNoteSnapshotV1(annotationFalseButAnnotationIdentity),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
});

void test("parseNoteSnapshotV1 accepts a consistent apple-annotation identity/flag pairing", () => {
  const value = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "apple-annotation", canonicalPath: "Books/Apple Books/A/B/Annotations/1.md", appleAnnotationId: "abc" },
    rawContent: "Body.\n",
    isAppleAnnotation: true,
  };
  const parsed = parseNoteSnapshotV1(value);
  assert.equal(parsed.identity.kind, "apple-annotation");
  assert.equal(parsed.isAppleAnnotation, true);
});

void test("an apple-annotation identity requires a non-blank appleAnnotationId and never downgrades to path", () => {
  const value = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "apple-annotation", canonicalPath: "Books/Apple Books/A/B/Annotations/1.md", appleAnnotationId: "   " },
    rawContent: "Body.\n",
    isAppleAnnotation: true,
  };
  assert.throws(
    () => parseNoteSnapshotV1(value),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("a path identity rejects a present appleAnnotationId as contradictory", () => {
  const value = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md", appleAnnotationId: "abc" },
    rawContent: "Body.\n",
    isAppleAnnotation: false,
  };
  assert.throws(
    () => parseNoteSnapshotV1(value),
    (error: unknown) => isEngineError(error) && error.code === "IDENTITY_INVALID",
  );
});

void test("parseSourceProjectionV1 round-trips a valid contract", () => {
  const value = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" },
    projectedFrontmatterJson: JSON.stringify("title: Example\n"),
    projectedBody: "Body.\n",
    excludedFrontmatterKeys: ["summary", "tags"],
    excludedManagedSections: ["related-section"],
    sourceHash: HASH_A,
  };
  const parsed = parseSourceProjectionV1(value);
  assert.deepEqual(parsed.excludedFrontmatterKeys, ["summary", "tags"]);
});

void test("parseSourceProjectionV1 rejects a sourceHash that is not a 64-character hex hash", () => {
  const value = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" },
    projectedFrontmatterJson: "",
    projectedBody: "",
    excludedFrontmatterKeys: [],
    excludedManagedSections: [],
    sourceHash: "not-a-hash",
  };
  assert.throws(() => parseSourceProjectionV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseMetadataOutputV1 requires string arrays for list fields", () => {
  const base = {
    schemaVersion: 1,
    identity: { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" },
    summary: "A summary.",
    tags: ["a", "b"],
    concepts: ["c"],
    related: [],
  };
  assert.equal(parseMetadataOutputV1(base).summary, "A summary.");
  const bad = { ...base, tags: [1, 2] };
  assert.throws(() => parseMetadataOutputV1(bad), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseEmbeddingVectorV1 rejects a dimension/values length mismatch", () => {
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: "m", dimension: 3, values: [1, 2] }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  const ok = parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: "m", dimension: 2, values: [1, 2] });
  assert.equal(ok.values.length, 2);
});

void test("parseEmbeddingVectorV1 rejects NaN/Infinity values", () => {
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: "m", dimension: 1, values: [Number.NaN] }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: "m", dimension: 1, values: [Number.POSITIVE_INFINITY] }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseEmbeddingVectorV1 rejects a blank model name", () => {
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: "   ", dimension: 1, values: [0.1] }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseRelatedCandidateV1 rejects an unrecognized kind", () => {
  assert.throws(
    () => parseRelatedCandidateV1({ schemaVersion: 1, path: "Notes/Example.md", score: 0.5, kind: "bogus" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseIndexRecordV1 rejects a negative chunkCount", () => {
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseIndexRecordV1({ schemaVersion: 1, identity, sourceHash: HASH_A, embeddingModel: "m", chunkCount: -1 }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseIndexRecordV1 rejects a non-hex64 sourceHash and a blank embeddingModel", () => {
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseIndexRecordV1({ schemaVersion: 1, identity, sourceHash: "h", embeddingModel: "m", chunkCount: 1 }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseIndexRecordV1({ schemaVersion: 1, identity, sourceHash: HASH_A, embeddingModel: "  ", chunkCount: 1 }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

const NOTE_TARGET: JobTargetV1 = { schemaVersion: 1, kind: "note", identity: stableNoteIdentity(canonicalizePath("Notes/Example.md")) };
const SCOPE_TARGET: JobTargetV1 = { schemaVersion: 1, kind: "scope", scopeId: "reading" };
const GLOBAL_TARGET: JobTargetV1 = { schemaVersion: 1, kind: "global" };

void test("computeJobIdempotencyKey is deterministic and distinguishes kind/target/pipelineVersion/hash/model, but NOT trigger", () => {
  const key1 = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a");
  const key2 = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a");
  assert.equal(key1, key2);

  const otherTarget = computeJobIdempotencyKey("process-note", { schemaVersion: 1, kind: "note", identity: stableNoteIdentity(canonicalizePath("Notes/Other.md")) }, 1, HASH_A, "model-a");
  const otherHash = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_B, "model-a");
  const otherModel = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-b");
  const otherVersion = computeJobIdempotencyKey("process-note", NOTE_TARGET, 2, HASH_A, "model-a");
  const scopeJob = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
  const globalJob = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
  const distinctKeys = new Set([key1, otherTarget, otherHash, otherModel, otherVersion, scopeJob, globalJob]);
  assert.equal(distinctKeys.size, 7);

  // Trigger is provenance only, never part of work identity: every trigger that can legally
  // produce this exact kind/target/version/hash/model combination must coalesce to the same key.
  assert.equal(computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a"), key1);

  // scopeJob/globalJob above differ in target kind too, so they don't isolate "kind" alone;
  // this pins kind as distinguishing even when trigger/target/pipelineVersion all match.
  const scopeSync = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
  const scopeRefresh = computeJobIdempotencyKey("scope-refresh", SCOPE_TARGET, 1);
  assert.notEqual(scopeSync, scopeRefresh, "computeJobIdempotencyKey must distinguish kind even when target/pipelineVersion match");
});

void test("computeJobIdempotencyKey distinguishes two different scope ids and note-vs-scope targets with the same trailing text", () => {
  const scopeA = computeJobIdempotencyKey("reading-sync", { schemaVersion: 1, kind: "scope", scopeId: "reading" }, 1);
  const scopeB = computeJobIdempotencyKey("reading-sync", { schemaVersion: 1, kind: "scope", scopeId: "reading-two" }, 1);
  assert.notEqual(scopeA, scopeB);

  const noteTarget: JobTargetV1 = { schemaVersion: 1, kind: "note", identity: stableNoteIdentity(canonicalizePath("reading")) };
  const notePathKey = computeJobIdempotencyKey("process-note", noteTarget, 1, HASH_A, "model-a");
  assert.notEqual(notePathKey, computeJobIdempotencyKey("process-note", { schemaVersion: 1, kind: "note", identity: stableNoteIdentity(canonicalizePath("Notes/Example.md")) }, 1, HASH_A, "model-a"));
});

function validNoteJob(): Record<string, unknown> {
  const idempotencyKey = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a");
  return {
    schemaVersion: 1,
    jobId: "job-1",
    trigger: "manual",
    kind: "process-note",
    target: NOTE_TARGET,
    sourceHash: HASH_A,
    embeddingModel: "model-a",
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

void test("parseQueueJobV1 accepts a well-formed process-note job whose idempotencyKey matches its derived value", () => {
  const parsed = parseQueueJobV1(validNoteJob());
  assert.equal(parsed.kind, "process-note");
  assert.equal(parsed.sourceHash, HASH_A);
});

void test("parseQueueJobV1 accepts a well-formed scope job with no sourceHash/embeddingModel", () => {
  const idempotencyKey = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
  const parsed = parseQueueJobV1({
    schemaVersion: 1,
    jobId: "job-2",
    trigger: "reading",
    kind: "reading-sync",
    target: SCOPE_TARGET,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(parsed.kind, "reading-sync");
  assert.equal(parsed.sourceHash, undefined);
  assert.equal(parsed.embeddingModel, undefined);
});

void test("parseQueueJobV1 accepts a well-formed global job", () => {
  const idempotencyKey = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
  const parsed = parseQueueJobV1({
    schemaVersion: 1,
    jobId: "job-3",
    trigger: "manual",
    kind: "rebuild-index",
    target: GLOBAL_TARGET,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(parsed.kind, "rebuild-index");
  assert.deepEqual(parsed.target, GLOBAL_TARGET);
});

void test("parseQueueJobV1 rejects an idempotencyKey that does not match its derived value", () => {
  const value = { ...validNoteJob(), idempotencyKey: "not-the-real-key" };
  assert.throws(() => parseQueueJobV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects process-note paired with a scope or global target", () => {
  const withScopeTarget = { ...validNoteJob(), target: SCOPE_TARGET };
  assert.throws(() => parseQueueJobV1(withScopeTarget), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");

  const withGlobalTarget = { ...validNoteJob(), target: GLOBAL_TARGET };
  assert.throws(() => parseQueueJobV1(withGlobalTarget), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects rebuild-index/reading-sync paired with a note target", () => {
  const idempotencyKey = computeJobIdempotencyKey("rebuild-index", NOTE_TARGET, 1);
  const rebuildWithNoteTarget = {
    schemaVersion: 1,
    jobId: "job-4",
    trigger: "manual",
    kind: "rebuild-index",
    target: NOTE_TARGET,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
  assert.throws(() => parseQueueJobV1(rebuildWithNoteTarget), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects a process-note job missing sourceHash/embeddingModel", () => {
  const value = { ...validNoteJob() };
  delete value.sourceHash;
  delete value.embeddingModel;
  assert.throws(() => parseQueueJobV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects a non-process-note job carrying sourceHash/embeddingModel", () => {
  const idempotencyKey = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
  const value = {
    schemaVersion: 1,
    jobId: "job-5",
    trigger: "reading",
    kind: "reading-sync",
    target: SCOPE_TARGET,
    sourceHash: HASH_A,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
  assert.throws(() => parseQueueJobV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects a non-positive or fractional pipelineVersion", () => {
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), pipelineVersion: 0, idempotencyKey: computeJobIdempotencyKey("process-note", NOTE_TARGET, 0, HASH_A, "model-a") }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), pipelineVersion: 1.5 }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 rejects malformed createdAt/updatedAt timestamps", () => {
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), createdAt: "not-a-date" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), updatedAt: "2026-08-22" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 rejects a blank jobId", () => {
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), jobId: "   " }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseHealthCheckV1 and parseStructuredFailureV1 round-trip minimal and full shapes", () => {
  const health = parseHealthCheckV1({ schemaVersion: 1, code: "OK", status: "ok", message: "Fine." });
  assert.equal(health.status, "ok");
  const failure = parseStructuredFailureV1({
    schemaVersion: 1,
    code: "SOME_FAILURE",
    message: "Something failed.",
    guidance: "Try again.",
    context: { note: "Notes/Example.md" },
  });
  assert.equal(failure.code, "SOME_FAILURE");
});

void test("parseHealthCheckV1 rejects an unrecognized status", () => {
  assert.throws(
    () => parseHealthCheckV1({ schemaVersion: 1, code: "X", status: "bogus", message: "m" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseHealthCheckV1 and parseStructuredFailureV1 reject a blank code", () => {
  assert.throws(
    () => parseHealthCheckV1({ schemaVersion: 1, code: "  ", status: "ok", message: "m" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseStructuredFailureV1({ schemaVersion: 1, code: "", message: "m" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("JobTrigger no longer accepts \"rebuild\"/\"migration\": those are job kinds, not triggers", () => {
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), trigger: "rebuild" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), trigger: "migration" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 accepts the \"startup\" trigger for the at-most-one catch-up job", () => {
  const idempotencyKey = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a");
  const parsed = parseQueueJobV1({ ...validNoteJob(), trigger: "startup", idempotencyKey });
  assert.equal(parsed.trigger, "startup");
});

void test("JOB_KIND_PHASES gives every kind its own durable high-level phases, not just discover/complete", () => {
  assert.deepEqual(JOB_KIND_PHASES["process-note"], ["discover", "embed", "extract-metadata", "confirm-source", "write-note", "write-overlay", "complete"]);
  assert.deepEqual(JOB_KIND_PHASES["reading-sync"], ["discover", "import", "enqueue", "complete"]);
  assert.deepEqual(JOB_KIND_PHASES["scope-refresh"], ["discover", "enqueue", "complete"]);
  assert.deepEqual(JOB_KIND_PHASES["rebuild-index"], ["discover", "build-generation", "verify-generation", "activate-generation", "complete"]);
  assert.deepEqual(JOB_KIND_PHASES["migrate-index"], ["discover", "build-generation", "verify-generation", "activate-generation", "complete"]);
});

void test("JOB_KIND_PHASES keeps the note-only pipeline phases exclusive to process-note", () => {
  const noteOnlyPhases = ["embed", "extract-metadata", "confirm-source", "write-note", "write-overlay"];
  for (const kind of ["reading-sync", "scope-refresh", "rebuild-index", "migrate-index"] as const) {
    for (const phase of noteOnlyPhases) {
      assert.ok(!JOB_KIND_PHASES[kind].includes(phase as never), `${kind} must not include note-only phase "${phase}"`);
    }
  }
});

void test("parseQueueJobV1 accepts a reading-sync job resuming from its import/enqueue phases", () => {
  for (const phase of ["discover", "import", "enqueue", "complete"] as const) {
    const idempotencyKey = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
    const parsed = parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-reading-phase",
      trigger: "reading",
      kind: "reading-sync",
      target: SCOPE_TARGET,
      pipelineVersion: 1,
      phase,
      idempotencyKey,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(parsed.phase, phase);
  }
});

void test("parseQueueJobV1 accepts a rebuild-index job resuming from its build/verify/activate-generation phases", () => {
  for (const phase of ["discover", "build-generation", "verify-generation", "activate-generation", "complete"] as const) {
    const idempotencyKey = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
    const parsed = parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-rebuild-phase",
      trigger: "manual",
      kind: "rebuild-index",
      target: GLOBAL_TARGET,
      pipelineVersion: 1,
      phase,
      idempotencyKey,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(parsed.phase, phase);
  }
});

void test("JOB_TRIGGER_KINDS restricts migrate-index to manual/startup only", () => {
  assert.ok(JOB_TRIGGER_KINDS.manual.includes("migrate-index"));
  assert.ok(JOB_TRIGGER_KINDS.startup.includes("migrate-index"));
  assert.ok(!JOB_TRIGGER_KINDS.reading.includes("migrate-index"));
  assert.ok(!JOB_TRIGGER_KINDS.scheduled.includes("migrate-index"));
});

void test("JOB_TRIGGER_KINDS restricts the reading trigger away from rebuild-index/migrate-index", () => {
  assert.ok(!JOB_TRIGGER_KINDS.reading.includes("rebuild-index"));
  assert.ok(!JOB_TRIGGER_KINDS.reading.includes("migrate-index"));
  assert.ok(JOB_TRIGGER_KINDS.reading.includes("process-note"));
  assert.ok(JOB_TRIGGER_KINDS.reading.includes("reading-sync"));
});

void test("parseQueueJobV1 rejects a scheduled trigger producing migrate-index", () => {
  const idempotencyKey = computeJobIdempotencyKey("migrate-index", GLOBAL_TARGET, 1);
  assert.throws(
    () => parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-invalid-trigger-1",
      trigger: "scheduled",
      kind: "migrate-index",
      target: GLOBAL_TARGET,
      pipelineVersion: 1,
      phase: "discover",
      idempotencyKey,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 rejects a reading trigger producing rebuild-index", () => {
  const idempotencyKey = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
  assert.throws(
    () => parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-invalid-trigger-2",
      trigger: "reading",
      kind: "rebuild-index",
      target: GLOBAL_TARGET,
      pipelineVersion: 1,
      phase: "discover",
      idempotencyKey,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 accepts a manual trigger producing migrate-index (an explicit legitimate flow)", () => {
  const idempotencyKey = computeJobIdempotencyKey("migrate-index", GLOBAL_TARGET, 1);
  const parsed = parseQueueJobV1({
    schemaVersion: 1,
    jobId: "job-valid-migration",
    trigger: "manual",
    kind: "migrate-index",
    target: GLOBAL_TARGET,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(parsed.kind, "migrate-index");
});

void test("parseQueueJobV1 accepts a scheduled trigger producing rebuild-index (a legitimate weekly-rebuild flow)", () => {
  const idempotencyKey = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
  const parsed = parseQueueJobV1({
    schemaVersion: 1,
    jobId: "job-valid-scheduled-rebuild",
    trigger: "scheduled",
    kind: "rebuild-index",
    target: GLOBAL_TARGET,
    pipelineVersion: 1,
    phase: "discover",
    idempotencyKey,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  assert.equal(parsed.kind, "rebuild-index");
});

void test("parseQueueJobV1 rejects a scope/global-kind job carrying a note-pipeline phase like write-note or extract-metadata", () => {
  const idempotencyKeyForWriteNote = computeJobIdempotencyKey("reading-sync", SCOPE_TARGET, 1);
  assert.throws(
    () => parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-phase-1",
      trigger: "reading",
      kind: "reading-sync",
      target: SCOPE_TARGET,
      pipelineVersion: 1,
      phase: "write-note",
      idempotencyKey: idempotencyKeyForWriteNote,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );

  const idempotencyKeyForExtractMetadata = computeJobIdempotencyKey("rebuild-index", GLOBAL_TARGET, 1);
  assert.throws(
    () => parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-phase-2",
      trigger: "manual",
      kind: "rebuild-index",
      target: GLOBAL_TARGET,
      pipelineVersion: 1,
      phase: "extract-metadata",
      idempotencyKey: idempotencyKeyForExtractMetadata,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseQueueJobV1 accepts process-note jobs at every phase in its own pipeline", () => {
  for (const phase of JOB_KIND_PHASES["process-note"]) {
    const idempotencyKey = computeJobIdempotencyKey("process-note", NOTE_TARGET, 1, HASH_A, "model-a");
    const parsed = parseQueueJobV1({ ...validNoteJob(), phase, idempotencyKey });
    assert.equal(parsed.phase, phase);
  }
});

void test("computeJobIdempotencyKey cannot be forged by injecting a would-be separator into a scope id", () => {
  // A NUL-joined key would let a crafted scopeId containing the separator collide with a
  // differently-shaped target. The structured JSON serialization used here rejects control
  // characters in scopeId outright (via assertIdentifier), and even a printable near-miss like
  // this one does not collide because JSON string-escapes every field independently.
  const keyA = computeJobIdempotencyKey("reading-sync", { schemaVersion: 1, kind: "scope", scopeId: "reading" }, 1);
  const keyB = computeJobIdempotencyKey("reading-sync", { schemaVersion: 1, kind: "scope", scopeId: "reading\",\"extra\":\"x" }, 1);
  assert.notEqual(keyA, keyB);
});

void test("parseJobTarget rejects a scope id containing a control character", () => {
  const controlChar = String.fromCharCode(1);
  assert.throws(
    () => parseQueueJobV1({
      schemaVersion: 1,
      jobId: "job-scope-control",
      trigger: "reading",
      kind: "reading-sync",
      target: { schemaVersion: 1, kind: "scope", scopeId: `reading${controlChar}root` },
      pipelineVersion: 1,
      phase: "discover",
      idempotencyKey: "placeholder",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseNoteIdentity rejects an appleAnnotationId containing a control character", () => {
  const controlChar = String.fromCharCode(2);
  const value = {
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      kind: "apple-annotation",
      canonicalPath: "Books/Apple Books/A/B/Annotations/1.md",
      appleAnnotationId: `abc${controlChar}123`,
    },
    rawContent: "Body.\n",
    isAppleAnnotation: true,
  };
  assert.throws(() => parseNoteSnapshotV1(value), (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("parseQueueJobV1 rejects a jobId containing a control character", () => {
  const controlChar = String.fromCharCode(3);
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), jobId: `job${controlChar}1` }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseEmbeddingVectorV1 rejects a model name containing a control character", () => {
  const controlChar = String.fromCharCode(4);
  const identity = { schemaVersion: 1, kind: "path", canonicalPath: "Notes/Example.md" };
  assert.throws(
    () => parseEmbeddingVectorV1({ schemaVersion: 1, identity, model: `model${controlChar}x`, dimension: 1, values: [0.1] }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("parseHealthCheckV1 rejects a code containing a control character", () => {
  const controlChar = String.fromCharCode(5);
  assert.throws(
    () => parseHealthCheckV1({ schemaVersion: 1, code: `CODE${controlChar}X`, status: "ok", message: "m" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("assertIdentifier trims surrounding whitespace on identifiers but canonicalizePath never trims a path", () => {
  const parsed = parseQueueJobV1({ ...validNoteJob(), jobId: "  job-with-spaces  " });
  assert.equal(parsed.jobId, "job-with-spaces");
  assert.equal(canonicalizePath("Notes/ Padded.md"), "Notes/ Padded.md");
});

void test("assertIsoTimestamp rejects a calendar-impossible date like 2026-02-30 despite matching the ISO shape", () => {
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), createdAt: "2026-02-30T00:00:00.000Z" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("assertIsoTimestamp accepts exactly the canonical toISOString() form and rejects non-canonical equivalents", () => {
  const canonical = new Date(Date.UTC(2026, 7, 22, 12, 30, 45, 123)).toISOString();
  const parsed = parseQueueJobV1({ ...validNoteJob(), createdAt: canonical });
  assert.equal(parsed.createdAt, canonical);

  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), createdAt: "2026-08-22T12:30:45Z" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
  assert.throws(
    () => parseQueueJobV1({ ...validNoteJob(), createdAt: "2026-08-22" }),
    (error: unknown) => isEngineError(error) && error.code === "CONTRACT_SHAPE_INVALID",
  );
});

void test("APPROVED_PRODUCTION_BENCHMARK_V1 records exactly the plan's approved figures", () => {
  assert.deepEqual(APPROVED_PRODUCTION_BENCHMARK_V1, {
    schemaVersion: 1,
    scopedNoteCount: 1094,
    indexedNoteCount: 275,
    chunkCount: 436,
    embeddingDimension: 1024,
  });
});

void test("EngineError carries a stable code/message/context shape", () => {
  const error = new EngineError("PATH_EMPTY", "Path is empty.", { path: "" });
  assert.equal(error.code, "PATH_EMPTY");
  assert.equal(error.message, "Path is empty.");
  assert.deepEqual(error.context, { path: "" });
  assert.equal(isEngineError(error), true);
  assert.equal(isEngineError(new Error("plain")), false);
});
