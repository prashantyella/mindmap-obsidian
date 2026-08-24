import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import { buildMigrationStatusV1, computeIndexDependentFeaturesBlocked, deriveMigrationAffordances, isTerminalMigrationPhase, parseMigrationStatusV1, type MigrationPhase } from "./migrationContract";

const NOW = "2026-08-23T00:00:00.000Z";

void test("deriveMigrationAffordances: canStart is true only for not-started/cancelled/failed/complete", () => {
  const startable: MigrationPhase[] = ["not-started", "cancelled", "failed", "complete"];
  const notStartable: MigrationPhase[] = ["discover", "plan", "build", "verify", "activate"];
  for (const phase of startable) assert.equal(deriveMigrationAffordances(phase).canStart, true, phase);
  for (const phase of notStartable) assert.equal(deriveMigrationAffordances(phase).canStart, false, phase);
});

void test("deriveMigrationAffordances: canRetry is true only for failed", () => {
  for (const phase of ["not-started", "discover", "plan", "build", "verify", "activate", "complete", "cancelled"] as MigrationPhase[]) {
    assert.equal(deriveMigrationAffordances(phase).canRetry, false, phase);
  }
  assert.equal(deriveMigrationAffordances("failed").canRetry, true);
});

void test("deriveMigrationAffordances: canCancel is true up through verify, false at/after activate and for terminal phases", () => {
  for (const phase of ["not-started", "discover", "plan", "build", "verify"] as MigrationPhase[]) {
    assert.equal(deriveMigrationAffordances(phase).canCancel, true, phase);
  }
  for (const phase of ["activate", "complete", "cancelled", "failed"] as MigrationPhase[]) {
    assert.equal(deriveMigrationAffordances(phase).canCancel, false, phase);
  }
});

void test("computeIndexDependentFeaturesBlocked is false only for complete; Standard Mode is never gated by this flag at all", () => {
  for (const phase of ["not-started", "discover", "plan", "build", "verify", "activate", "cancelled", "failed"] as MigrationPhase[]) {
    assert.equal(computeIndexDependentFeaturesBlocked(phase), true, phase);
  }
  assert.equal(computeIndexDependentFeaturesBlocked("complete"), false);
});

void test("isTerminalMigrationPhase: complete/cancelled/failed are terminal, everything else is not", () => {
  for (const phase of ["complete", "cancelled", "failed"] as MigrationPhase[]) assert.equal(isTerminalMigrationPhase(phase), true, phase);
  for (const phase of ["not-started", "discover", "plan", "build", "verify", "activate"] as MigrationPhase[]) assert.equal(isTerminalMigrationPhase(phase), false, phase);
});

void test("buildMigrationStatusV1 round-trips through parseMigrationStatusV1 unchanged", () => {
  const built = buildMigrationStatusV1("build", "BUILDING_INDEX", { discoveredCount: 10, processedCount: 3, failedCount: 1 }, NOW);
  const parsed = parseMigrationStatusV1(built);
  assert.deepEqual(parsed, built);
});

void test("parseMigrationStatusV1 rejects a non-object value", () => {
  assert.throws(() => parseMigrationStatusV1("not an object"), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
  assert.throws(() => parseMigrationStatusV1(null), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
  assert.throws(() => parseMigrationStatusV1([]), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects an unrecognized field", () => {
  const built = buildMigrationStatusV1("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, extra: "nope" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects a phase outside the closed enumeration", () => {
  const built = buildMigrationStatusV1("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, phase: "unknown-phase" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects tampered affordances that disagree with the persisted phase", () => {
  const built = buildMigrationStatusV1("activate", "ACTIVATING_GENERATION", { discoveredCount: 5, processedCount: 5, failedCount: 0 }, NOW);
  // A corrupted document claiming canCancel:true at "activate" (real activation is irreversible) must fail closed.
  assert.throws(() => parseMigrationStatusV1({ ...built, canCancel: true }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects tampered indexDependentFeaturesBlocked that disagrees with phase", () => {
  const built = buildMigrationStatusV1("complete", "COMPLETE", { discoveredCount: 5, processedCount: 5, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, indexDependentFeaturesBlocked: true }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects processedCount+failedCount exceeding discoveredCount", () => {
  const built = buildMigrationStatusV1("build", "BUILDING_INDEX", { discoveredCount: 3, processedCount: 2, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, processedCount: 2, failedCount: 2 }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects a non-canonical updatedAtIso", () => {
  const built = buildMigrationStatusV1("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, updatedAtIso: "2026-08-23" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 rejects a schemaVersion other than 1", () => {
  const built = buildMigrationStatusV1("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW);
  assert.throws(() => parseMigrationStatusV1({ ...built, schemaVersion: 2 }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});

void test("parseMigrationStatusV1 accepts an optional lastFailureCode and rejects an oversized one", () => {
  const built = buildMigrationStatusV1("failed", "FAILED_RETRYABLE", { discoveredCount: 1, processedCount: 0, failedCount: 1 }, NOW, { lastFailureCode: "EMBEDDING_REQUEST_FAILED" });
  const parsed = parseMigrationStatusV1(built);
  assert.equal(parsed.lastFailureCode, "EMBEDDING_REQUEST_FAILED");
  assert.throws(() => parseMigrationStatusV1({ ...built, lastFailureCode: "x".repeat(500) }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_STATE_CORRUPT");
});
