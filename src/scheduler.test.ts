import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSchedulerStatus,
  computeNextRunAt,
  getSchedulerAction,
  MIN_SCHEDULER_INTERVAL_MINUTES,
  normalizeSchedulerInterval,
} from "./scheduler";

void test("computeNextRunAt returns null when scheduler is disabled", () => {
  assert.equal(computeNextRunAt({ mode: "manual", intervalMinutes: 60 }, 1_000), null);
});

void test("computeNextRunAt uses the configured interval when enabled", () => {
  assert.equal(computeNextRunAt({ mode: "interval", intervalMinutes: 30 }, 1_000), 1_801_000);
});

void test("normalizeSchedulerInterval enforces a minimum interval", () => {
  assert.equal(normalizeSchedulerInterval(1), MIN_SCHEDULER_INTERVAL_MINUTES);
});

void test("getSchedulerAction skips when a run is already in progress", () => {
  assert.equal(getSchedulerAction({ mode: "interval", intervalMinutes: 60 }, true), "skip-running");
});

void test("buildSchedulerStatus clears next run when disabled", () => {
  const status = buildSchedulerStatus({ mode: "manual", intervalMinutes: 60 }, 999_999);
  assert.equal(status.enabled, false);
  assert.equal(status.nextRunAt, null);
});
