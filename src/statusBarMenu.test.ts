import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusBarMenuItems, buildStatusBarPresentation, buildStatusSummary, type StatusBarMenuState } from "./statusBarState";

function state(overrides: Partial<StatusBarMenuState> = {}): StatusBarMenuState {
  return {
    pendingAvailable: true,
    currentPending: 0,
    allPending: 0,
    pendingPaths: [],
    running: false,
    runStatus: null,
    preflightInProgress: false,
    preflightOk: true,
    scopeReady: true,
    schedulerMode: "manual",
    schedulerHealth: null,
    schedulerDetails: [],
    semanticState: "off",
    ...overrides,
  };
}

void test("standard status stays compact and exposes the orbit icon", () => {
  const presentation = buildStatusBarPresentation(state());

  assert.equal(presentation.label, "Mindmap · 0");
  assert.equal(presentation.icon, "orbit");
  assert.equal(presentation.running, false);
  assert.match(presentation.ariaLabel, /standard mode/i);
});

void test("actionable scheduler health is announced without contradictory schedule copy", () => {
  const presentation = buildStatusBarPresentation(state({
    currentPending: 2,
    schedulerHealth: "overdue",
  }));

  assert.equal(presentation.label, "Mindmap · 2");
  assert.equal(presentation.icon, "triangle-alert");
  assert.equal(presentation.actionable, true);
  assert.match(presentation.ariaLabel, /scheduler overdue/i);
});

void test("pending menu includes all-scope action and note openers", () => {
  const items = buildStatusBarMenuItems(state({
    currentPending: 2,
    allPending: 3,
    pendingPaths: ["Notes/one.md", "Notes/two.md"],
  }));
  const titles = items.map((item) => item.title);

  assert.ok(titles.includes("Process all pending notes (3)"));
  assert.ok(titles.includes("Open Notes/one.md"));
  assert.ok(titles.includes("Open Notes/two.md"));
  assert.ok(titles.includes("Open settings"));
  assert.equal(titles.includes("Show status summary"), false);
});

void test("running and unavailable states disable conflicting actions", () => {
  const running = buildStatusBarMenuItems(state({ running: true, runStatus: "Mindmap: current" }));
  const runCurrent = running.find((item) => item.title.startsWith("Run active"));
  assert.equal(runCurrent?.disabled, true);

  const unavailable = buildStatusBarMenuItems(state({ pendingAvailable: false, allPending: 2 }));
  const processAll = unavailable.find((item) => item.title.startsWith("Process all pending"));
  assert.equal(processAll?.disabled, true);
});

void test("scheduler menu keeps daily and weekly health separate", () => {
  const items = buildStatusBarMenuItems(state({
    schedulerDetails: [
      { label: "Daily", health: "healthy", lastSuccessfulRunAt: 1 },
      { label: "Weekly", health: "waiting", lastSuccessfulRunAt: null },
    ],
  }));
  const titles = items.map((item) => item.title);

  assert.ok(titles.includes("Daily: Healthy"));
  assert.ok(titles.includes("Weekly: Waiting"));
});

void test("status summary stays concise and omits runtime paths", () => {
  const summary = buildStatusSummary({
    ready: true,
    pendingAvailable: true,
    currentPending: 2,
    allPending: 5,
    preflightInProgress: false,
    preflightOk: true,
    schedulerMode: "launchAgent",
    schedulerDetails: [
      { label: "Daily", health: "healthy", lastSuccessfulRunAt: 1 },
      { label: "Weekly", health: "waiting", lastSuccessfulRunAt: null },
    ],
  });

  assert.equal(summary, "Mindmap status: Readiness: ready. Pending: 2 current / 5 all-scope pending. Preflight: ready. Scheduler: Daily: healthy, Weekly: waiting.");
  assert.doesNotMatch(summary, /python|config|script|\/Users|\/vault/i);
});
