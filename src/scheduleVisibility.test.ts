import test from "node:test";
import assert from "node:assert/strict";

import { buildScheduleVisibility, isSchedulerRecoveryActionable } from "./scheduleVisibility";

void test("manual mode shows nothing beyond the mode selector", () => {
  const visibility = buildScheduleVisibility("manual", false);
  assert.deepEqual(visibility, { showInterval: false, showDailyTime: false, showWeeklyToggle: false, showWeeklyTime: false });
});

void test("interval mode shows only the interval minutes control", () => {
  const visibility = buildScheduleVisibility("interval", true);
  assert.deepEqual(visibility, { showInterval: true, showDailyTime: false, showWeeklyToggle: false, showWeeklyTime: false });
});

void test("LaunchAgent mode shows daily time and the weekly toggle; weekly time only when the toggle is enabled", () => {
  const disabled = buildScheduleVisibility("launchAgent", false);
  assert.deepEqual(disabled, { showInterval: false, showDailyTime: true, showWeeklyToggle: true, showWeeklyTime: false });

  const enabled = buildScheduleVisibility("launchAgent", true);
  assert.deepEqual(enabled, { showInterval: false, showDailyTime: true, showWeeklyToggle: true, showWeeklyTime: true });
});

void test("scheduler recovery is actionable only for LaunchAgent mode with overdue/failing health", () => {
  assert.equal(isSchedulerRecoveryActionable("launchAgent", "overdue"), true);
  assert.equal(isSchedulerRecoveryActionable("launchAgent", "failing"), true);
  assert.equal(isSchedulerRecoveryActionable("launchAgent", "healthy"), false);
  assert.equal(isSchedulerRecoveryActionable("launchAgent", "waiting"), false);
  assert.equal(isSchedulerRecoveryActionable("launchAgent", null), false);
  assert.equal(isSchedulerRecoveryActionable("interval", "overdue"), false);
  assert.equal(isSchedulerRecoveryActionable("manual", "overdue"), false);
});
