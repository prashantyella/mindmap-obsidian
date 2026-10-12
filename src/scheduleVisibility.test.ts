import test from "node:test";
import assert from "node:assert/strict";

import { buildScheduleVisibility, formatTimeOfDay, isSchedulerRecoveryActionable, parseTimeOfDay } from "./scheduleVisibility";

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

void test("HH:MM parsing is strict and bounded", () => {
  assert.deepEqual(parseTimeOfDay("02:30"), { hour: 2, minute: 30 });
  assert.deepEqual(parseTimeOfDay(" 23:59 "), { hour: 23, minute: 59 });
  assert.equal(parseTimeOfDay("2:30"), null);
  assert.equal(parseTimeOfDay("24:00"), null);
  assert.equal(parseTimeOfDay("12:60"), null);
  assert.equal(parseTimeOfDay("noon"), null);
  assert.equal(formatTimeOfDay(2, 5), "02:05");
});
