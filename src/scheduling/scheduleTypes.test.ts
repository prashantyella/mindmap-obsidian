import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import {
  assertNextDueAtAdvances,
  assertScheduleIdentityUnchanged,
  computeScheduleOccurrenceId,
  computeScheduleWorkFingerprint,
  parsePersistedScheduleV1,
  parseScheduleDefinitionV1,
  parseScheduleStateV1,
  parseScheduleStoreDocumentV1,
  type PersistedScheduleV1,
  type ScheduleDefinitionV1,
} from "./scheduleTypes";

function dailyDef(overrides: Partial<ScheduleDefinitionV1> = {}): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "daily-maintenance",
    kind: "daily-maintenance",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "daily", hour: 3, minute: 0 },
    pipelineVersion: 1,
    scopeId: "vault-default",
    ...overrides,
  };
}

function weeklyDef(overrides: Partial<ScheduleDefinitionV1> = {}): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "weekly-refresh",
    kind: "weekly-refresh",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "weekly", weekday: 0, hour: 4, minute: 0 },
    pipelineVersion: 1,
    ...overrides,
  };
}

function readingDef(overrides: Partial<ScheduleDefinitionV1> = {}): ScheduleDefinitionV1 {
  return {
    schemaVersion: 1,
    id: "reading-sync",
    kind: "reading-sync",
    enabled: true,
    timezone: "UTC",
    cadence: { type: "interval", intervalMinutes: 30 },
    pipelineVersion: 1,
    scopeId: "reading",
    ...overrides,
  };
}

function persisted(definition: ScheduleDefinitionV1, nextDueAt = "2026-08-23T00:00:00.000Z"): PersistedScheduleV1 {
  return { schemaVersion: 1, definition, state: { nextDueAt, consecutiveFailures: 0 } };
}

void test("parseScheduleDefinitionV1 accepts a well-formed definition of each kind", () => {
  assert.doesNotThrow(() => parseScheduleDefinitionV1(dailyDef()));
  assert.doesNotThrow(() => parseScheduleDefinitionV1(weeklyDef()));
  assert.doesNotThrow(() => parseScheduleDefinitionV1(readingDef()));
});

void test("parseScheduleDefinitionV1 rejects id/kind mismatch", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), id: "weekly-refresh" }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
});

void test("parseScheduleDefinitionV1 rejects a cadence shape that doesn't match the schedule kind", () => {
  assert.throws(
    () => parseScheduleDefinitionV1({ ...dailyDef(), cadence: { type: "weekly", weekday: 1, hour: 3, minute: 0 } }),
    (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID",
  );
});

void test("parseScheduleDefinitionV1 rejects out-of-range cadence fields", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), cadence: { type: "daily", hour: 24, minute: 0 } }));
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), cadence: { type: "daily", hour: 3, minute: 60 } }));
  assert.throws(() => parseScheduleDefinitionV1({ ...weeklyDef(), cadence: { type: "weekly", weekday: 7, hour: 3, minute: 0 } }));
});

void test("parseScheduleDefinitionV1 rejects an interval cadence outside the bounded min/max", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...readingDef(), cadence: { type: "interval", intervalMinutes: 1 } }));
  assert.throws(() => parseScheduleDefinitionV1({ ...readingDef(), cadence: { type: "interval", intervalMinutes: 999_999 } }));
});

void test("parseScheduleDefinitionV1 requires scopeId exactly for scope-targeted job kinds", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), scopeId: undefined }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  assert.throws(() => parseScheduleDefinitionV1({ ...weeklyDef(), scopeId: "should-not-be-here" }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
});

void test("parseScheduleDefinitionV1 rejects an invalid timezone", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), timezone: "not-a-zone" }), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
});

void test("parseScheduleDefinitionV1 rejects unrecognized extra fields (closed shape)", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), extraField: "nope" }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
});

void test("parseScheduleDefinitionV1 rejects a control character in scopeId", () => {
  assert.throws(() => parseScheduleDefinitionV1({ ...dailyDef(), scopeId: "vault\x07default" }));
});

void test("parseScheduleStateV1 requires nextDueAt to be canonical ISO", () => {
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "not-a-date", consecutiveFailures: 0 }));
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "2024-02-30T00:00:00.000Z", consecutiveFailures: 0 })); // impossible calendar date
  assert.doesNotThrow(() => parseScheduleStateV1({ nextDueAt: "2024-02-29T00:00:00.000Z", consecutiveFailures: 0 }));
});

void test("parseScheduleStateV1 pairs lastOutcome/lastFailureCode strictly", () => {
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: 0, lastOutcome: "submit-failed" }));
  assert.throws(() =>
    parseScheduleStateV1({ nextDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: 0, lastOutcome: "submitted", lastFailureCode: "SCHEDULE_SUBMIT_UNKNOWN" }),
  );
  assert.doesNotThrow(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-01T00:00:00.000Z",
      lastDueAt: "2023-12-31T00:00:00.000Z",
      consecutiveFailures: 1,
      lastOutcome: "submit-failed",
      lastFailureCode: "SCHEDULE_SUBMIT_UNKNOWN",
    }),
  );
});

void test("parseScheduleStateV1 enforces the requirement-7 cross-field invariants", () => {
  // lastOutcome requires lastDueAt.
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: 0, lastOutcome: "submitted", lastSubmittedAt: "2024-01-01T00:00:00.000Z" }));
  // "submitted" requires lastSubmittedAt and consecutiveFailures === 0.
  assert.throws(() =>
    parseScheduleStateV1({ nextDueAt: "2024-01-02T00:00:00.000Z", lastDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: 0, lastOutcome: "submitted" }),
  );
  assert.throws(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-02T00:00:00.000Z",
      lastDueAt: "2024-01-01T00:00:00.000Z",
      lastSubmittedAt: "2024-01-01T00:00:00.000Z",
      consecutiveFailures: 1,
      lastOutcome: "submitted",
    }),
  );
  assert.doesNotThrow(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-02T00:00:00.000Z",
      lastDueAt: "2024-01-01T00:00:00.000Z",
      lastSubmittedAt: "2024-01-01T00:00:00.000Z",
      consecutiveFailures: 0,
      lastOutcome: "submitted",
    }),
  );
  // "submit-failed" requires consecutiveFailures >= 1.
  assert.throws(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-02T00:00:00.000Z",
      lastDueAt: "2024-01-01T00:00:00.000Z",
      consecutiveFailures: 0,
      lastOutcome: "submit-failed",
      lastFailureCode: "SCHEDULE_SUBMIT_UNKNOWN",
    }),
  );
  // nextDueAt must be strictly after lastDueAt.
  assert.throws(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-01T00:00:00.000Z",
      lastDueAt: "2024-01-01T00:00:00.000Z",
      lastSubmittedAt: "2024-01-01T00:00:00.000Z",
      consecutiveFailures: 0,
      lastOutcome: "submitted",
    }),
  );
  // lastSubmittedAt must not precede lastDueAt.
  assert.throws(() =>
    parseScheduleStateV1({
      nextDueAt: "2024-01-02T00:00:00.000Z",
      lastDueAt: "2024-01-01T12:00:00.000Z",
      lastSubmittedAt: "2024-01-01T00:00:00.000Z",
      consecutiveFailures: 0,
      lastOutcome: "submitted",
    }),
  );
});

void test("parseScheduleStateV1 rejects an out-of-bound consecutiveFailures", () => {
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: -1 }));
  assert.throws(() => parseScheduleStateV1({ nextDueAt: "2024-01-01T00:00:00.000Z", consecutiveFailures: 1_000_000 }));
});

void test("parsePersistedScheduleV1 round-trips a well-formed record", () => {
  const record = persisted(dailyDef());
  const parsed = parsePersistedScheduleV1(record);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), record);
});

void test("parseScheduleStoreDocumentV1 rejects a duplicate schedule id", () => {
  const doc = { schemaVersion: 1, schedules: [persisted(dailyDef()), persisted(dailyDef())] };
  assert.throws(() => parseScheduleStoreDocumentV1(doc), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_STORE_CORRUPT");
});

void test("parseScheduleStoreDocumentV1 accepts one schedule of each kind together", () => {
  const doc = { schemaVersion: 1, schedules: [persisted(dailyDef()), persisted(weeklyDef()), persisted(readingDef())] };
  assert.doesNotThrow(() => parseScheduleStoreDocumentV1(doc));
});

void test("parseScheduleStoreDocumentV1 fails closed on a bad schemaVersion", () => {
  assert.throws(() => parseScheduleStoreDocumentV1({ schemaVersion: 2, schedules: [] }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_STORE_CORRUPT");
});

void test("assertScheduleIdentityUnchanged rejects a changed id/kind", () => {
  assert.throws(() => assertScheduleIdentityUnchanged(dailyDef(), weeklyDef()), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_TRANSITION_INVALID");
});

void test("assertScheduleIdentityUnchanged allows reconfiguring enabled/cadence/pipelineVersion/scopeId", () => {
  assert.doesNotThrow(() => assertScheduleIdentityUnchanged(dailyDef(), dailyDef({ enabled: false, pipelineVersion: 2, scopeId: "other-scope" })));
});

void test("assertNextDueAtAdvances rejects a non-strictly-increasing nextDueAt", () => {
  const current = { nextDueAt: "2026-08-23T00:00:00.000Z", consecutiveFailures: 0 };
  assert.throws(() => assertNextDueAtAdvances(current, { ...current, nextDueAt: "2026-08-23T00:00:00.000Z" }), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_TRANSITION_INVALID");
  assert.throws(() => assertNextDueAtAdvances(current, { ...current, nextDueAt: "2026-08-22T00:00:00.000Z" }));
  assert.doesNotThrow(() => assertNextDueAtAdvances(current, { ...current, nextDueAt: "2026-08-24T00:00:00.000Z" }));
});

// ---------------------------------------------------------------------------
// Final-integration requirement 13: runtime input validation, value-free errors
// ---------------------------------------------------------------------------

void test("(final-integration 13) computeScheduleWorkFingerprint validates runtime inputs and fails value-free", () => {
  const bad = { kind: "not-a-real-kind", pipelineVersion: 1 } as unknown as ScheduleDefinitionV1;
  try {
    computeScheduleWorkFingerprint(bad);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
    assert.ok(!e.message.includes("not-a-real-kind"));
  }
  assert.throws(
    () => computeScheduleWorkFingerprint({ kind: "daily-maintenance", pipelineVersion: 0 } as unknown as ScheduleDefinitionV1),
    (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID",
  );
  assert.throws(
    () => computeScheduleWorkFingerprint({ kind: "daily-maintenance", pipelineVersion: 1, scopeId: "bad\x00scope" } as unknown as ScheduleDefinitionV1),
    (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID",
  );
  assert.doesNotThrow(() => computeScheduleWorkFingerprint({ kind: "daily-maintenance", pipelineVersion: 1, scopeId: "vault-default" } as unknown as ScheduleDefinitionV1));
});

void test("(final-integration 13) computeScheduleOccurrenceId validates runtime inputs and fails value-free", () => {
  const validFingerprint = computeScheduleWorkFingerprint({ kind: "daily-maintenance", pipelineVersion: 1, scopeId: "vault-default" } as unknown as ScheduleDefinitionV1);
  try {
    computeScheduleOccurrenceId("not-a-real-schedule-id" as never, "2026-01-01T00:00:00.000Z", validFingerprint);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
    assert.ok(!e.message.includes("not-a-real-schedule-id"));
  }
  assert.throws(
    () => computeScheduleOccurrenceId("daily-maintenance", "not-a-timestamp", validFingerprint),
    (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID",
  );
  assert.throws(
    () => computeScheduleOccurrenceId("daily-maintenance", "2026-01-01T00:00:00.000Z", "not-hex64"),
    (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID",
  );
  assert.doesNotThrow(() => computeScheduleOccurrenceId("daily-maintenance", "2026-01-01T00:00:00.000Z", validFingerprint));
});
