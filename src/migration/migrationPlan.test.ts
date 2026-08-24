import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { isEngineError } from "../engine/errors";
import { buildMigrationPlanV1, computePlanFingerprint, parseMigrationPlanV1, type MigrationPlanEntryV1, type PlanFingerprintContext } from "./migrationPlan";

const CONTEXT: PlanFingerprintContext = { desiredEmbeddingModel: "nomic-embed-text", desiredDimension: 768, desiredPipelineVersion: 1 };

function entry(path: string, sourceHash = "a".repeat(64), embeddingModel = "nomic-embed-text"): MigrationPlanEntryV1 {
  return { identity: stableNoteIdentity(canonicalizePath(path)), sourceHash, embeddingModel };
}

void test("item 10: computePlanFingerprint does not collide across a delimiter-ambiguous split -- one entry 'a|b' vs two entries 'a'/'b'-shaped paths produce DIFFERENT fingerprints", () => {
  const combined = computePlanFingerprint(CONTEXT, [entry("Notes/a|b.md")]);
  const split = computePlanFingerprint(CONTEXT, [entry("Notes/a.md"), entry("Notes/b.md")]);
  assert.notEqual(combined, split);
});

void test("item 4: computePlanFingerprint is genuinely order-independent -- it sorts internally, so a REVERSED entry array produces the identical fingerprint without the caller pre-sorting", () => {
  const a = entry("Notes/a.md");
  const b = entry("Notes/b.md");
  assert.equal(computePlanFingerprint(CONTEXT, [a, b]), computePlanFingerprint(CONTEXT, [b, a]));
});

void test("item 5: computePlanFingerprint changes when the desired context (model/dimension/pipeline) changes even though entries are byte-identical", () => {
  const entries = [entry("Notes/a.md")];
  const base = computePlanFingerprint(CONTEXT, entries);
  assert.notEqual(base, computePlanFingerprint({ ...CONTEXT, desiredDimension: 4 }, entries));
  assert.notEqual(base, computePlanFingerprint({ ...CONTEXT, desiredPipelineVersion: 2 }, entries));
  assert.notEqual(base, computePlanFingerprint({ ...CONTEXT, desiredEmbeddingModel: "other-model" }, entries));
});

void test("buildMigrationPlanV1 + parseMigrationPlanV1 round-trips unchanged, entries canonically sorted", () => {
  const plan = buildMigrationPlanV1({
    runId: "run-1",
    desiredEmbeddingModel: "nomic-embed-text",
    desiredDimension: 768,
    desiredPipelineVersion: 1,
    baseGenerationState: "none",
    entries: [entry("Notes/b.md"), entry("Notes/a.md")],
  });
  assert.deepEqual(
    plan.entries.map((e) => e.identity.canonicalPath),
    ["Notes/a.md", "Notes/b.md"],
  );
  const parsed = parseMigrationPlanV1(plan);
  assert.deepEqual(parsed, plan);
});

void test("item 5: buildMigrationPlanV1 rejects an entry whose embeddingModel does not match desiredEmbeddingModel", () => {
  assert.throws(() =>
    buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [entry("Notes/a.md", "a".repeat(64), "different-model")] }),
  );
});

void test("item 5: parseMigrationPlanV1 rejects a tampered entry whose embeddingModel no longer matches desiredEmbeddingModel", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [entry("Notes/a.md", "a".repeat(64), "m")] });
  const tamperedEntries = [{ ...plan.entries[0], embeddingModel: "different-model" }];
  const tampered = { ...plan, entries: tamperedEntries, planFingerprint: computePlanFingerprint({ desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1 }, tamperedEntries) };
  assert.throws(() => parseMigrationPlanV1(tampered), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("item 8: parseMigrationPlanV1 rejects baseGenerationState 'none' carrying leftover snapshot fields", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [] });
  assert.throws(() => parseMigrationPlanV1({ ...plan, baseGenerationId: 1 }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("item 8: parseMigrationPlanV1 rejects baseGenerationState 'verified' missing its fingerprint", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "verified", baseGenerationId: 1, baseGenerationFingerprint: "b".repeat(64), entries: [] });
  const { baseGenerationFingerprint: _drop, ...tampered } = plan;
  assert.throws(() => parseMigrationPlanV1(tampered), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("item 4/8: parseMigrationPlanV1 rejects baseGenerationState 'unverifiable' missing baseManifestRawFingerprint -- id alone is never sufficient", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "unverifiable", baseGenerationId: 1, baseManifestRawFingerprint: "c".repeat(64), entries: [] });
  const { baseManifestRawFingerprint: _drop, ...tampered } = plan;
  assert.throws(() => parseMigrationPlanV1(tampered), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("parseMigrationPlanV1 rejects a tampered planFingerprint that no longer matches its own entries", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [entry("Notes/a.md", "a".repeat(64), "m")] });
  assert.throws(() => parseMigrationPlanV1({ ...plan, planFingerprint: "0".repeat(64) }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("parseMigrationPlanV1 rejects a duplicate identity across entries", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [entry("Notes/a.md", "a".repeat(64), "m")] });
  const tamperedEntries = [plan.entries[0], plan.entries[0]];
  const tampered = { ...plan, entries: tamperedEntries, planFingerprint: computePlanFingerprint({ desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1 }, tamperedEntries) };
  assert.throws(() => parseMigrationPlanV1(tampered), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("parseMigrationPlanV1 rejects entries out of canonical sorted order", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [entry("Notes/a.md", "a".repeat(64), "m"), entry("Notes/b.md", "a".repeat(64), "m")] });
  const reversedEntries = [...plan.entries].reverse();
  const tampered = { ...plan, entries: reversedEntries, planFingerprint: computePlanFingerprint({ desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1 }, reversedEntries) };
  assert.throws(() => parseMigrationPlanV1(tampered), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});

void test("parseMigrationPlanV1 rejects a runId containing a path separator", () => {
  const plan = buildMigrationPlanV1({ runId: "run-1", desiredEmbeddingModel: "m", desiredDimension: 4, desiredPipelineVersion: 1, baseGenerationState: "none", entries: [] });
  assert.throws(() => parseMigrationPlanV1({ ...plan, runId: "../escape" }), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_PLAN_CORRUPT");
});
