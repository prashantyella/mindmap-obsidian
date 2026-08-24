import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import { buildMigrationRecordV1, parseMigrationRecordV1, type BuildMigrationRecordExtra } from "./migrationRecord";

const NOW = "2026-08-23T00:00:00.000Z";

const BUILD_EXTRA: BuildMigrationRecordExtra = {
  runId: "run-1",
  desiredEmbeddingModel: "nomic-embed-text",
  desiredDimension: 768,
  desiredPipelineVersion: 1,
  planFingerprint: "a".repeat(64),
  baseGenerationState: "none",
  stagingRunId: "run-1",
  cursorIndex: 0,
};

void test("item 9: lastFailureCode must be a member of the closed EngineErrorCode/UNKNOWN_TRANSIENT set, never an arbitrary string", () => {
  const record = buildMigrationRecordV1("failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, { ...BUILD_EXTRA, lastFailureCode: "EMBEDDING_REQUEST_FAILED" });
  assert.deepEqual(parseMigrationRecordV1(record), record);
  assert.throws(() => parseMigrationRecordV1({ ...record, lastFailureCode: "totally-made-up-code" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: runId/stagingRunId must be runId-shaped -- a slash (path-traversal-shaped) token is rejected", () => {
  const record = buildMigrationRecordV1("build", "BUILDING_INDEX", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);
  assert.throws(() => parseMigrationRecordV1({ ...record, runId: "../escape" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
  assert.throws(() => parseMigrationRecordV1({ ...record, stagingRunId: "a/b" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: an active phase (discover/plan/build/verify/activate) requires runId/desiredEmbeddingModel/desiredDimension/desiredPipelineVersion", () => {
  const record = buildMigrationRecordV1("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, { runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1 });
  const { desiredDimension: _drop, ...missingDimension } = record;
  assert.throws(() => parseMigrationRecordV1(missingDimension), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: build/verify/activate additionally require planFingerprint/baseGenerationState/stagingRunId/cursorIndex", () => {
  const record = buildMigrationRecordV1("build", "BUILDING_INDEX", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);
  const { planFingerprint: _drop, ...missingPlanFingerprint } = record;
  assert.throws(() => parseMigrationRecordV1(missingPlanFingerprint), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: phase 'activate' requires activationGenerationId and builtGenerationFingerprint", () => {
  const record = buildMigrationRecordV1("activate", "ACTIVATING_GENERATION", { discoveredCount: 1, processedCount: 1, failedCount: 0 }, NOW, { ...BUILD_EXTRA, activationGenerationId: 1, builtGenerationFingerprint: "b".repeat(64) });
  const { activationGenerationId: _drop, ...missingTarget } = record;
  assert.throws(() => parseMigrationRecordV1(missingTarget), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: phase 'failed' requires a lastFailureCode", () => {
  const record = buildMigrationRecordV1("failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);
  assert.throws(() => parseMigrationRecordV1(record), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: a terminal outcome other than 'cancelled' can never claim cancellationRequested: true", () => {
  const record = buildMigrationRecordV1("complete", "COMPLETE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, { ...BUILD_EXTRA, cancellationRequested: true });
  assert.throws(() => parseMigrationRecordV1(record), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: cleanupPending may only be true at phase 'complete'", () => {
  const record = buildMigrationRecordV1("build", "BUILDING_INDEX", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, { ...BUILD_EXTRA, cleanupPending: true });
  assert.throws(() => parseMigrationRecordV1(record), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 9: messageCode must correlate with phase -- a 'COMPLETE' message at phase 'build' is corrupt", () => {
  const record = buildMigrationRecordV1("build", "BUILDING_INDEX", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);
  assert.throws(() => parseMigrationRecordV1({ ...record, messageCode: "COMPLETE" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 5: cursorIndex may never exceed the record's own discoveredCount", () => {
  const record = buildMigrationRecordV1("build", "BUILDING_INDEX", { discoveredCount: 3, processedCount: 3, failedCount: 0 }, NOW, { ...BUILD_EXTRA, cursorIndex: 3 });
  assert.throws(() => parseMigrationRecordV1({ ...record, cursorIndex: 4 }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("item 12: revision defaults to 0 and round-trips through parseMigrationRecordV1", () => {
  const record = buildMigrationRecordV1("not-started", "NOT_STARTED", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW);
  assert.equal(record.revision, 0);
  assert.deepEqual(parseMigrationRecordV1(record), record);
});
