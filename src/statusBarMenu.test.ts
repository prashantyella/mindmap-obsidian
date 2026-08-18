import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusBarMenuItems, buildStatusBarPresentation, buildStatusSummary, type StatusBarMenuState } from "./statusBarState";
import { NO_ACTIVE_NOTE } from "./individualNote";

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
    activeNote: NO_ACTIVE_NOTE,
    readingMode: "standard",
    readingActivity: "disabled",
    readingLastSyncAt: null,
    readingPending: 0,
    readingImported: 0,
    readingError: null,
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

void test("reading status is visibly distinct and exposes experimental toggle", () => {
  const presentation = buildStatusBarPresentation(state({ readingMode: "reading", readingActivity: "ready", readingPending: 3 }));
  assert.equal(presentation.label, "Reading · 3");
  assert.equal(presentation.icon, "book-open");
  assert.match(presentation.ariaLabel, /Reading Mode/);
  const titles = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 3 })).map((item) => item.title);
  assert.ok(titles.includes("Reading Mode (experimental)"));
  assert.ok(titles.includes("Sync Reading Mode now"));
  assert.ok(titles.includes("Reading pending: 3"));
});

void test("reading errors are actionable and Web Research copy matches Reading Mode", () => {
  const presentation = buildStatusBarPresentation(state({
    readingMode: "reading",
    readingActivity: "error",
    readingError: "Apple Books unavailable.",
  }));
  assert.equal(presentation.icon, "triangle-alert");
  assert.equal(presentation.actionable, true);
  assert.match(presentation.ariaLabel, /Apple Books unavailable/);
  const webResearch = buildStatusBarMenuItems(state({ readingMode: "reading" })).find((item) => item.title.includes("not enabled"));
  assert.equal(webResearch?.title, "Web Research is not enabled in Reading Mode");
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

void test("pending menu includes individual processing and clear note openers", () => {
  const items = buildStatusBarMenuItems(state({
    currentPending: 2,
    allPending: 3,
    pendingPaths: ["Notes/one.md", "Notes/two.md"],
  }));
  const titles = items.map((item) => item.title);

  assert.ok(titles.includes("Process all pending notes (3)"));
  assert.ok(titles.includes("Process Notes/one.md"));
  assert.ok(titles.includes("Open Notes/one.md"));
  assert.ok(titles.includes("Open Notes/two.md"));
  assert.ok(titles.includes("Open settings"));
  assert.equal(titles.includes("Show status summary"), false);
});

void test("active-note action explains ineligible states", () => {
  const items = buildStatusBarMenuItems(state({
    activeNote: { path: "Notes/short.md", eligible: false, reason: "The active note is too short.", code: "too-short" },
  }));
  const action = items.find((item) => item.title.startsWith("Run active note"));
  assert.equal(action?.disabled, true);
  assert.match(action?.title ?? "", /too short/);
});

void test("running and unavailable states disable conflicting actions", () => {
  const running = buildStatusBarMenuItems(state({ running: true, runStatus: "Mindmap: current", pendingPaths: ["Notes/one.md"] }));
  const runCurrent = running.find((item) => item.title.startsWith("Run active"));
  assert.equal(runCurrent?.disabled, true);
  assert.equal(running.find((item) => item.title === "Process Notes/one.md")?.disabled, true);

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
