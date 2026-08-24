import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import type { BuildMigrationRecordExtra } from "./migrationRecord";
import { MigrationStore } from "./migrationStore";

const NOW = "2026-08-23T00:00:00.000Z";

const DISCOVER_EXTRA: BuildMigrationRecordExtra = {
  runId: "run-1",
  desiredEmbeddingModel: "nomic-embed-text",
  desiredDimension: 768,
  desiredPipelineVersion: 1,
  cancellationRequested: false,
};

const BUILD_EXTRA: BuildMigrationRecordExtra = {
  ...DISCOVER_EXTRA,
  planFingerprint: "a".repeat(64),
  baseGenerationState: "none",
  stagingRunId: "run-1",
  cursorIndex: 0,
};

void test("MigrationStore.load() returns null for a fresh data root (never fabricates a status)", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  assert.equal(await store.load(), null);
});

void test("MigrationStore.setPhase persists atomically and load() reads it back unchanged", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  const written = await store.setPhase("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, DISCOVER_EXTRA);
  const loaded = await store.load();
  assert.deepEqual(loaded, written);
});

void test("MigrationStore.mutate serializes concurrent callers through one tail -- two concurrent phase transitions never interleave", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  await store.setPhase("build", "BUILDING_INDEX", { discoveredCount: 5, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);
  const [a, b] = await Promise.all([
    store.mutate((current) => ({ ...current!, processedCount: (current?.processedCount ?? 0) + 1, updatedAtIso: NOW })),
    store.mutate((current) => ({ ...current!, processedCount: (current?.processedCount ?? 0) + 1, updatedAtIso: NOW })),
  ]);
  // Both mutations must have observed each other -- final value is 2, never 1 (which would mean a lost update).
  const final = await store.load();
  assert.equal(final?.processedCount, 2);
  assert.ok(a.processedCount === 1 || a.processedCount === 2);
  assert.ok(b.processedCount === 1 || b.processedCount === 2);
});

void test("MigrationStore.load() fails closed on a corrupt committed file rather than fabricating a status", async () => {
  const fs = new FakeIndexFs();
  fs.files.set("/data/migration/state.json", "{ not valid json");
  const store = new MigrationStore(fs, "/data");
  await assert.rejects(() => store.load(), (error: unknown) => isEngineError(error));
});

void test("MigrationStore never touches any path containing 'chroma'", async () => {
  const fs = new FakeIndexFs();
  const store = new MigrationStore(fs, "/data");
  await store.setPhase("build", "BUILDING_INDEX", { discoveredCount: 3, processedCount: 1, failedCount: 0 }, NOW, BUILD_EXTRA);
  await store.load();
  for (const path of [...fs.files.keys(), ...fs.dirs]) {
    assert.doesNotMatch(path.toLowerCase(), /chroma/);
  }
});

void test("MigrationStore.cleanupStaleTempFiles is safe to call on a fresh store", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  const count = await store.cleanupStaleTempFiles();
  assert.equal(count, 0);
});

void test("item 1: setPhase persists the internal MigrationRecordV1 fields (cursorIndex, cancellationRequested, drift snapshot), and getPublicStatus() redacts them", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  const written = await store.setPhase("build", "BUILDING_INDEX", { discoveredCount: 3, processedCount: 1, failedCount: 0 }, NOW, { ...BUILD_EXTRA, cursorIndex: 1 });
  assert.equal(written.cursorIndex, 1);
  assert.equal(written.desiredEmbeddingModel, "nomic-embed-text");

  const loaded = await store.load();
  assert.deepEqual(loaded, written);

  const publicStatus = await store.getPublicStatus();
  assert.ok(publicStatus);
  assert.equal((publicStatus as unknown as { cursorIndex?: unknown }).cursorIndex, undefined, "internal cursor must never leak onto the public status");
  assert.equal((publicStatus as unknown as { desiredEmbeddingModel?: unknown }).desiredEmbeddingModel, undefined, "internal drift snapshot must never leak onto the public status");
});

void test("item 1: two MigrationStore instances over the SAME root share one mutation queue -- concurrent mutations from either instance never interleave", async () => {
  const fs = new FakeIndexFs();
  const storeA = new MigrationStore(fs, "/data");
  const storeB = new MigrationStore(fs, "/data");
  await storeA.setPhase("build", "BUILDING_INDEX", { discoveredCount: 5, processedCount: 0, failedCount: 0 }, NOW, BUILD_EXTRA);

  const [a, b] = await Promise.all([
    storeA.mutate((current) => ({ ...current!, processedCount: (current?.processedCount ?? 0) + 1, updatedAtIso: NOW })),
    storeB.mutate((current) => ({ ...current!, processedCount: (current?.processedCount ?? 0) + 1, updatedAtIso: NOW })),
  ]);

  const final = await storeA.load();
  assert.equal(final?.processedCount, 2, "a lost update across two instances over the same root would leave this at 1");
  assert.ok(a.processedCount === 1 || a.processedCount === 2);
  assert.ok(b.processedCount === 1 || b.processedCount === 2);
});

void test("item 12: setPhase with a stale expectedRevision throws MIGRATION_REVISION_CONFLICT and persists nothing", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  await store.setPhase("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, DISCOVER_EXTRA);
  await assert.rejects(
    () => store.setPhase("plan", "PLANNING", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, DISCOVER_EXTRA, 99),
    (error: unknown) => isEngineError(error) && error.code === "MIGRATION_REVISION_CONFLICT",
  );
  const stillDiscover = await store.load();
  assert.equal(stillDiscover?.phase, "discover", "a rejected CAS write must leave the prior record untouched");
});

void test("item 12: setPhase with a matching expectedRevision succeeds and advances revision by 1", async () => {
  const store = new MigrationStore(new FakeIndexFs(), "/data");
  const first = await store.setPhase("discover", "DISCOVERING_NOTES", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, DISCOVER_EXTRA);
  const second = await store.setPhase("plan", "PLANNING", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, NOW, DISCOVER_EXTRA, first.revision);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.phase, "plan");
});
