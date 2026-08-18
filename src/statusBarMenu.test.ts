import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
    webResearchMode: "off",
    webResearchActivity: "off",
    webResearchError: null,
    automaticResearchAttempted: 0,
    automaticResearchPauseReason: null,
    automaticResearchLastError: null,
    automaticResearchLastErrorAt: null,
    ...overrides,
  };
}

void test("standard status stays compact and exposes the orbit icon", () => {
  const presentation = buildStatusBarPresentation(state());

  assert.equal(presentation.label, "Mindmap · 0");
  assert.equal(presentation.icon, "orbit");
  assert.equal(presentation.running, false);
  assert.equal(presentation.busy, false);
  assert.match(presentation.ariaLabel, /standard mode/i);
});

void test("status presentation gives real work a loader while warnings retain precedence", () => {
  const research = buildStatusBarPresentation(state({ webResearchMode: "manual", webResearchActivity: "deriving" }));
  assert.equal(research.label, "Research · deriving");
  assert.equal(research.icon, "loader-circle");
  assert.equal(research.busy, true);
  assert.equal(research.animateIcon, true);
  assert.match(research.ariaLabel, /Web Research: deriving/);
  const reading = buildStatusBarPresentation(state({ readingMode: "reading", readingActivity: "syncing" }));
  assert.equal(reading.icon, "loader-circle");
  const warning = buildStatusBarPresentation(state({ webResearchMode: "automatic-reading", webResearchActivity: "writing", automaticResearchPauseReason: "provider-network" }));
  assert.equal(warning.icon, "triangle-alert");
  assert.equal(warning.busy, true);
  assert.equal(warning.animateIcon, false);
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.mindmap-status\.is-animating \.mindmap-status-icon svg/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mindmap-status\.is-animating \.mindmap-status-icon svg/);
});

void test("automatic policy usage distinguishes daily limits from transient retry pauses while manual actions remain enabled", () => {
  const daily = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", automaticResearchAttempted: 10, automaticResearchPauseReason: "daily-limit" }));
  assert.ok(daily.some((item) => item.title === "Automatic research: 10/10 today · max 5/sync"));
  assert.equal(daily.some((item) => item.title === "Retry automatic research"), false);

  const transient = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", automaticResearchAttempted: 2, automaticResearchPauseReason: "provider-network", webResearchActivity: "error" }));
  assert.ok(transient.some((item) => item.title === "Retry automatic research"));
  assert.equal(transient.find((item) => item.title === "Research active note")?.disabled, false);

  const waiting = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", readingMode: "standard" }));
  assert.ok(waiting.some((item) => item.title.includes("waiting for Reading Mode")));
  assert.equal(waiting.find((item) => item.title === "Pause Automatic for Reading")?.disabled, false);

  const persisted = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", webResearchActivity: "ready" }));
  assert.ok(persisted.some((item) => item.title === "Research mode: Automatic for Reading"));

  const busy = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", webResearchActivity: "writing" }));
  assert.equal(busy.find((item) => item.title === "Pause Automatic for Reading")?.disabled, true);

  const manualError = buildStatusBarMenuItems(state({ webResearchMode: "manual", webResearchActivity: "error", webResearchError: "Manual request failed." }));
  assert.equal(manualError.some((item) => item.title === "Retry automatic research"), false);
});

void test("persisted automatic pauses stay actionable without a transient web error", () => {
  const transient = buildStatusBarPresentation(state({ webResearchMode: "automatic-reading", webResearchActivity: "ready", automaticResearchPauseReason: "provider-network" }));
  assert.equal(transient.actionable, true);
  assert.equal(transient.icon, "triangle-alert");
  assert.match(transient.ariaLabel, /provider-network/);
  const daily = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", automaticResearchAttempted: 10, automaticResearchPauseReason: "daily-limit" }));
  assert.ok(daily.some((item) => item.title.includes("daily limit reached")));
  assert.equal(daily.some((item) => item.title === "Retry automatic research"), false);
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
  assert.equal(webResearch?.title, "Web Research is not enabled");
});

void test("web research errors are actionable and busy actions are disabled", () => {
  const presentation = buildStatusBarPresentation(state({ webResearchMode: "manual", webResearchActivity: "error", webResearchError: "Credential unavailable." }));
  assert.equal(presentation.icon, "triangle-alert");
  assert.equal(presentation.actionable, true);
  assert.match(presentation.ariaLabel, /Credential unavailable/);
  const items = buildStatusBarMenuItems(state({ webResearchMode: "manual", webResearchActivity: "searching", running: true }));
  assert.equal(items.find((item) => item.title === "Research selected text")?.disabled, true);
  assert.equal(items.find((item) => item.title === "Research active note")?.disabled, true);
  assert.equal(items.find((item) => item.title === "Use Manual research")?.disabled, true);
  assert.equal(items.find((item) => item.title.startsWith("Run active"))?.disabled, true);
  const offError = buildStatusBarMenuItems(state({ webResearchMode: "off", webResearchError: "Keychain unavailable." }));
  assert.ok(offError.some((item) => item.title.includes("Keychain unavailable.")));
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
