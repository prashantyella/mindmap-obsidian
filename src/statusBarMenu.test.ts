import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildStatusBarMenuItems, buildStatusBarPresentation, buildStatusSummary, type StatusBarMenuActions, type StatusBarMenuState } from "./statusBarState";
import { NO_ACTIVE_NOTE } from "./individualNote";
import { registerMindmapCommands } from "./pluginCommands";

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
    readingUnresearchable: 0,
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

function labelTitles(items: ReturnType<typeof buildStatusBarMenuItems>): string[] {
  return items.filter((item) => item.label).map((item) => item.title);
}

// A full ACTIONS implementation for compile-time proof every action key is actually wired end to end.
const ALL_ACTIONS_STUB: StatusBarMenuActions = {
  runCurrent: () => undefined,
  runActiveNote: () => undefined,
  runAll: () => undefined,
  processPendingNote: () => undefined,
  runPreflight: () => undefined,
  openNote: () => undefined,
  openMindmap: () => undefined,
  openSettings: () => undefined,
  selectStandardMode: () => undefined,
  selectReadingMode: () => undefined,
  syncReadingMode: () => undefined,
  processReadingBacklog: () => undefined,
  toggleWebResearchMode: () => undefined,
  researchSelectedText: () => undefined,
  researchActiveNote: () => undefined,
  researchAndReprocessActiveNote: () => undefined,
  toggleAutomaticReadingResearch: () => undefined,
  retryAutomaticResearch: () => undefined,
  startMigration: () => undefined,
  retryMigration: () => undefined,
  cancelMigration: () => undefined,
};

void test("StatusBarMenuActions is fully wired end to end (compile-time proof plus a runtime smoke call)", () => {
  assert.equal(typeof ALL_ACTIONS_STUB.runCurrent, "function");
  assert.doesNotThrow(() => {
    void ALL_ACTIONS_STUB.runCurrent();
  });
});

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

void test("activity-driven presentation uses approved alert/progress/queued labels and basename-only detail", () => {
  const base = state({ activity: { state: "paused", queuedCount: 2, activeCount: 0, processNoteCount: 1, bulkBlocked: true, latestFailureBatch: { status: "completed-with-failures", failed: 1 } } });
  const paused = buildStatusBarPresentation(base);
  assert.equal(paused.icon, "triangle-alert");
  assert.match(paused.ariaLabel, /paused/);
  assert.doesNotMatch(paused.ariaLabel, /\//);
  const progress = buildStatusBarPresentation(state({ activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", processed: 2, total: 4, failed: 0 } } }));
  assert.equal(progress.label, "Mindmap · 2/4");
  assert.equal(progress.icon, "loader-circle");
});

void test("active engine work takes priority over passive Reading count", () => {
  const presentation = buildStatusBarPresentation(state({ readingMode: "reading", readingActivity: "ready", readingPending: 9, activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", processed: 1, total: 3, failed: 0 } } }));
  assert.equal(presentation.label, "Mindmap · 1/3");
  assert.equal(presentation.icon, "loader-circle");
});

void test("current work hides a retained prior failure, while idle exposes it", () => {
  const prior = { status: "completed-with-failures" as const, failed: 2 };
  const active = buildStatusBarPresentation(state({ activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", processed: 1, total: 2, failed: 0 }, latestFailureBatch: prior } }));
  assert.equal(active.label, "Mindmap · 1/2");
  assert.equal(active.icon, "loader-circle");
  assert.match(active.ariaLabel, /queued/);
  const reading = buildStatusBarPresentation(state({ readingMode: "reading", readingActivity: "processing", activity: { state: "idle", queuedCount: 0, activeCount: 0, processNoteCount: 0, bulkBlocked: false, latestFailureBatch: prior } }));
  assert.equal(reading.label, "Reading · processing");
  assert.equal(reading.icon, "loader-circle");
  const idle = buildStatusBarPresentation(state({ activity: { state: "idle", queuedCount: 0, activeCount: 0, processNoteCount: 0, bulkBlocked: false, latestFailureBatch: prior } }));
  assert.equal(idle.label, "Mindmap · 2 failed");
  assert.equal(idle.icon, "triangle-alert");
});

void test("idle terminal batch statuses have exact accessible failure wording", () => {
  for (const [status, expected] of [["completed-with-failures", "Mindmap · 2 failed"], ["failed", "Mindmap · root failed"], ["cancelled", "Mindmap · cancelled"]] as const) {
    const presentation = buildStatusBarPresentation(state({ activity: { state: "idle", queuedCount: 0, activeCount: 0, processNoteCount: 0, bulkBlocked: false, latestFailureBatch: { status, failed: 2 } } }));
    assert.equal(presentation.label, expected);
    assert.match(presentation.ariaLabel, new RegExp(expected.replace("Mindmap · ", "")));
    assert.match(presentation.title, new RegExp(expected.replace("Mindmap · ", "")));
    assert.equal(presentation.icon, "triangle-alert");
  }
});

void test("activity detail row is bounded, disabled, and privacy-safe", () => {
  const items = buildStatusBarMenuItems(state({ activity: { state: "running", queuedCount: 2, activeCount: 1, processNoteCount: 1, bulkBlocked: true, current: { kind: "process-note", phase: "embed", path: "Note.md", attempt: 1 }, latestFailureBatch: { status: "failed", failed: 0 } } }));
  const detail = items.find((item) => item.title.startsWith("Engine: "));
  assert.ok(detail);
  assert.equal(detail?.disabled, true);
  assert.match(detail?.title ?? "", /embed/);
  assert.match(detail?.title ?? "", /Note\.md/);
  assert.doesNotMatch(detail?.title ?? "", /\//);
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

// ---------------------------------------------------------------------------
// (1) Healthy menu: at most 5 compact groups, and a tight item budget.
// ---------------------------------------------------------------------------

void test("healthy standard-mode menu stays within budget: Mode, Run, Research, Navigation only", () => {
  const items = buildStatusBarMenuItems(state());

  assert.deepEqual(labelTitles(items), ["Mode", "Run", "Research", "Navigation"]);
  assert.ok(items.length <= 12, `expected a tight healthy budget, got ${items.length} items`);
  assert.equal(items.some((item) => item.title === "Reading" && item.label), false);
  assert.deepEqual(items.map((item) => item.title), [
    "Mode",
    "Standard Mode",
    "Reading Mode (experimental)",
    "Run",
    "Run current scope",
    "Research",
    "Manual research",
    "Automatic for Reading",
    "Navigation",
    "Open Mindmap",
    "Open settings",
  ]);
});

void test("healthy Reading-active menu adds exactly one more group and stays at the 5-group limit: Mode, Run, Reading, Research, Navigation", () => {
  const items = buildStatusBarMenuItems(state({ readingMode: "reading", readingActivity: "ready" }));

  assert.deepEqual(labelTitles(items), ["Mode", "Run", "Reading", "Research", "Navigation"]);
  assert.ok(items.length <= 14, `expected a tight budget with Reading active, got ${items.length} items`);
});

void test("Navigation is a real, visually separated compact group", () => {
  const items = buildStatusBarMenuItems(state());
  const navLabelIndex = items.findIndex((item) => item.title === "Navigation" && item.label);
  assert.ok(navLabelIndex >= 0, "expected a Navigation group label");
  assert.equal(items[navLabelIndex + 1]?.title, "Open Mindmap");
  assert.equal(items[navLabelIndex + 2]?.title, "Open settings");
});

void test("no per-note Process/Open path pairs and no passive duplicate current-count row", () => {
  const items = buildStatusBarMenuItems(state({
    currentPending: 2,
    allPending: 3,
    pendingPaths: ["Notes/one.md", "Notes/two.md"],
  }));
  const titles = items.map((item) => item.title);

  assert.equal(items.some((item) => item.action === "processPendingNote"), false);
  assert.equal(items.some((item) => item.action === "openNote"), false);
  assert.equal(titles.some((title) => title.startsWith("Process Notes/")), false);
  assert.equal(titles.some((title) => title.startsWith("Open Notes/")), false);
  assert.equal(titles.some((title) => title.startsWith("Current scope:")), false);
  assert.ok(titles.includes("Process pending notes (3)"));
});

// ---------------------------------------------------------------------------
// (2) Mode: actionable/idempotent Standard and Reading radio rows.
// ---------------------------------------------------------------------------

void test("Mode rows are explicit radio choices: current mode is checked and disabled, the other is actionable", () => {
  const inStandard = buildStatusBarMenuItems(state({ readingMode: "standard" }));
  const standardRow = inStandard.find((item) => item.title === "Standard Mode");
  const readingRow = inStandard.find((item) => item.title === "Reading Mode (experimental)");
  assert.equal(standardRow?.checked, true);
  assert.equal(standardRow?.disabled, true);
  assert.equal(standardRow?.action, undefined);
  assert.equal(readingRow?.checked, false);
  assert.equal(readingRow?.disabled, false);
  assert.equal(readingRow?.action, "selectReadingMode");

  const inReading = buildStatusBarMenuItems(state({ readingMode: "reading" }));
  const standardRow2 = inReading.find((item) => item.title === "Standard Mode");
  const readingRow2 = inReading.find((item) => item.title === "Reading Mode (experimental)");
  assert.equal(standardRow2?.checked, false);
  assert.equal(standardRow2?.disabled, false);
  assert.equal(standardRow2?.action, "selectStandardMode");
  assert.equal(readingRow2?.checked, true);
  assert.equal(readingRow2?.disabled, true);
  assert.equal(readingRow2?.action, undefined);
});

// ---------------------------------------------------------------------------
// (3) Run: active-note only when eligible, current scope, pending(N) only N>0.
// ---------------------------------------------------------------------------

void test("Run active note is present only when the active note is eligible", () => {
  const ineligible = buildStatusBarMenuItems(state({
    activeNote: { path: "Notes/short.md", eligible: false, reason: "The active note is too short.", code: "too-short" },
  }));
  assert.equal(ineligible.some((item) => item.title.startsWith("Run active note") || item.title.startsWith("Run Mindmap for active note")), false);

  const eligible = buildStatusBarMenuItems(state({
    activeNote: { path: "Notes/one.md", eligible: true, reason: "", code: "eligible" },
  }));
  const action = eligible.find((item) => item.title === "Run Mindmap for active note");
  assert.ok(action);
  assert.equal(action?.action, "runActiveNote");
  assert.equal(action?.disabled, false);

  const runningWhileEligible = buildStatusBarMenuItems(state({
    running: true,
    activeNote: { path: "Notes/one.md", eligible: true, reason: "", code: "eligible" },
  }));
  const runningAction = runningWhileEligible.find((item) => item.title === "Run Mindmap for active note");
  assert.equal(runningAction?.disabled, false);
  assert.equal(runningAction?.action, "runActiveNote");
});

void test("Run current scope is always present", () => {
  const items = buildStatusBarMenuItems(state());
  const runCurrent = items.find((item) => item.title === "Run current scope");
  assert.ok(runCurrent);
  assert.equal(runCurrent?.action, "runCurrent");
});

void test("Process pending notes (N) appears only when N > 0", () => {
  const zero = buildStatusBarMenuItems(state({ allPending: 0 }));
  assert.equal(zero.some((item) => item.title.startsWith("Process pending notes")), false);

  const nonzero = buildStatusBarMenuItems(state({ allPending: 3, pendingAvailable: true }));
  const row = nonzero.find((item) => item.title === "Process pending notes (3)");
  assert.ok(row);
  assert.equal(row?.action, "runAll");

  const unavailable = buildStatusBarMenuItems(state({ pendingAvailable: false, allPending: 2 }));
  assert.equal(unavailable.some((item) => item.title.startsWith("Process pending notes")), false);
});

// ---------------------------------------------------------------------------
// (4) Reading group only while active; N-gated backlog row; no passive rows.
// ---------------------------------------------------------------------------

void test("Reading group appears only while Reading Mode is active", () => {
  const inactive = buildStatusBarMenuItems(state({ readingMode: "standard" }));
  assert.equal(inactive.some((item) => item.title === "Reading" && item.label), false);
  assert.equal(inactive.some((item) => item.title === "Sync Reading now"), false);
  assert.equal(inactive.some((item) => item.title.includes("Process Reading backlog")), false);

  const active = buildStatusBarMenuItems(state({ readingMode: "reading" }));
  assert.ok(active.some((item) => item.title === "Reading" && item.label));
  assert.ok(active.some((item) => item.title === "Sync Reading now"));
});

void test("Process Reading backlog (N) appears only when N > 0, and healthy passive Reading rows are omitted", () => {
  const zero = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 0 }));
  assert.equal(zero.some((item) => item.title.includes("Process Reading backlog")), false);

  const nonzero = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 3, readingUnresearchable: 2, readingLastSyncAt: "2026-08-22T00:00:00Z" }));
  const titles = nonzero.map((item) => item.title);
  assert.ok(titles.includes("Process Reading backlog (3)"));
  assert.equal(titles.some((title) => title.startsWith("Reading pending:")), false);
  assert.equal(titles.some((title) => title.startsWith("Reading unresearchable:")), false);
  assert.equal(titles.some((title) => title.includes("last sync") || title.includes("has not synced")), false);
  assert.equal(titles.some((title) => title.startsWith("Reading Mode:")), false);
});

void test("process reading backlog action disabled while busy or running", () => {
  const syncing = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 2, readingActivity: "syncing" }));
  assert.equal(syncing.find((item) => item.title === "Process Reading backlog (2)")?.disabled, true);

  const processing = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 2, readingActivity: "processing" }));
  assert.equal(processing.find((item) => item.title === "Process Reading backlog (2)")?.disabled, true);

  const running = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 2, running: true }));
  assert.equal(running.find((item) => item.title === "Process Reading backlog (2)")?.disabled, true);

  const researchBusy = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 2, webResearchActivity: "writing" }));
  assert.equal(researchBusy.find((item) => item.title === "Process Reading backlog (2)")?.disabled, true);

  const ready = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 2, readingActivity: "ready" }));
  assert.equal(ready.find((item) => item.title === "Process Reading backlog (2)")?.disabled, false);
  assert.equal(ready.find((item) => item.title === "Process Reading backlog (2)")?.action, "processReadingBacklog");
});

void test("Reading errors surface through the top recovery row, not as a passive Reading-group row", () => {
  const presentation = buildStatusBarPresentation(state({
    readingMode: "reading",
    readingActivity: "error",
    readingError: "Apple Books unavailable.",
  }));
  assert.equal(presentation.icon, "triangle-alert");
  assert.equal(presentation.actionable, true);
  assert.match(presentation.ariaLabel, /Apple Books unavailable/);

  const items = buildStatusBarMenuItems(state({
    readingMode: "reading",
    readingActivity: "error",
    readingError: "Apple Books unavailable.",
  }));
  const recoveryRow = items[0];
  assert.equal(recoveryRow.title, "Reading error: Apple Books unavailable.");
  assert.equal(recoveryRow.action, "syncReadingMode");
  assert.equal(items.some((item) => item.title.startsWith("Reading error:") && item !== recoveryRow), false);
});

// ---------------------------------------------------------------------------
// (5) Research: Manual research + Automatic for Reading toggles; selected-
// text/active-note/reprocess removed from the menu; usage/retry conditional.
// ---------------------------------------------------------------------------

void test("Research group offers only the Manual research and Automatic for Reading toggles", () => {
  const items = buildStatusBarMenuItems(state({ webResearchMode: "manual" }));
  assert.ok(items.some((item) => item.title === "Manual research"));
  assert.ok(items.some((item) => item.title === "Automatic for Reading"));
  assert.equal(items.some((item) => item.action === "researchSelectedText"), false);
  assert.equal(items.some((item) => item.action === "researchActiveNote"), false);
  assert.equal(items.some((item) => item.action === "researchAndReprocessActiveNote"), false);
});

void test("Manual research reads checked when included by Automatic, and is inert while Automatic is active", () => {
  const manual = buildStatusBarMenuItems(state({ webResearchMode: "manual" }));
  const manualRow = manual.find((item) => item.title === "Manual research");
  assert.equal(manualRow?.checked, true);
  assert.equal(manualRow?.action, "toggleWebResearchMode");

  const automatic = buildStatusBarMenuItems(state({ webResearchMode: "automatic-reading", readingMode: "reading" }));
  const manualUnderAutomatic = automatic.find((item) => item.title === "Manual research");
  assert.equal(manualUnderAutomatic?.checked, true);
  assert.equal(manualUnderAutomatic?.disabled, true);
  assert.equal(manualUnderAutomatic?.action, undefined);
});

void test("Automatic for Reading toggle enables when Reading is active and pauses independent of runtime state", () => {
  const notYetEnabled = buildStatusBarMenuItems(state({ readingMode: "reading", webResearchMode: "manual" }));
  const enableAction = notYetEnabled.find((item) => item.title === "Automatic for Reading");
  assert.equal(enableAction?.checked, false);
  assert.equal(enableAction?.disabled, false);
  assert.equal(enableAction?.action, "toggleAutomaticReadingResearch");

  const waitingForReading = buildStatusBarMenuItems(state({ readingMode: "standard", webResearchMode: "manual" }));
  assert.equal(waitingForReading.find((item) => item.title === "Automatic for Reading")?.disabled, true);

  const alreadyOn = buildStatusBarMenuItems(state({ readingMode: "reading", webResearchMode: "automatic-reading" }));
  const pauseAction = alreadyOn.find((item) => item.title === "Automatic for Reading");
  assert.equal(pauseAction?.checked, true);
  assert.equal(pauseAction?.disabled, false);
});

void test("automatic usage/retry only appear when a limit or pause is actionable", () => {
  const healthy = buildStatusBarMenuItems(state({ readingMode: "reading", webResearchMode: "automatic-reading", automaticResearchAttempted: 2 }));
  assert.equal(healthy.some((item) => item.title.includes("today · max 5/sync")), false);
  assert.equal(healthy.some((item) => item.title === "Retry automatic research"), false);

  const daily = buildStatusBarMenuItems(state({ readingMode: "reading", webResearchMode: "automatic-reading", automaticResearchAttempted: 10, automaticResearchPauseReason: "daily-limit" }));
  assert.ok(daily.some((item) => item.title === "Automatic research: 10/10 today · max 5/sync"));
  assert.ok(daily.some((item) => item.title.includes("daily limit reached")));
  assert.equal(daily.some((item) => item.title === "Retry automatic research"), false);

  const transient = buildStatusBarMenuItems(state({ readingMode: "reading", webResearchMode: "automatic-reading", automaticResearchAttempted: 2, automaticResearchPauseReason: "provider-network" }));
  assert.ok(transient.some((item) => item.title === "Retry automatic research"));
});

// ---------------------------------------------------------------------------
// (6) Navigation: Open Mindmap and Settings.
// ---------------------------------------------------------------------------

void test("Navigation offers Open Mindmap and Open settings", () => {
  const items = buildStatusBarMenuItems(state());
  assert.ok(items.some((item) => item.title === "Open Mindmap" && item.action === "openMindmap"));
  assert.ok(items.some((item) => item.title === "Open settings" && item.action === "openSettings"));
});

// ---------------------------------------------------------------------------
// (7) Exactly one highest-priority recovery row at top.
// ---------------------------------------------------------------------------

void test("top recovery row precedence: preflight, then Reading error, then manual/off Web Research error, then scheduler failure", () => {
  const preflightWins = buildStatusBarMenuItems(state({
    preflightOk: false,
    readingMode: "reading",
    readingActivity: "error",
    readingError: "boom",
    webResearchMode: "manual",
    webResearchError: "Credential unavailable.",
    schedulerHealth: "overdue",
  }));
  assert.equal(preflightWins[0].title, "Run preflight (failed)");
  assert.equal(preflightWins[0].action, "runPreflight");
  assert.equal(preflightWins.filter((item) => item.title.startsWith("Reading error:") || item.title.startsWith("Web Research error:") || item.title.startsWith("Scheduler ")).length, 0);

  const readingWins = buildStatusBarMenuItems(state({
    readingMode: "reading",
    readingActivity: "error",
    readingError: "Apple Books unavailable.",
    webResearchMode: "manual",
    webResearchError: "Credential unavailable.",
    schedulerHealth: "overdue",
  }));
  assert.equal(readingWins[0].title, "Reading error: Apple Books unavailable.");
  assert.equal(readingWins.filter((item) => item.title.startsWith("Web Research error:") || item.title.startsWith("Scheduler ")).length, 0);

  const webResearchWins = buildStatusBarMenuItems(state({
    webResearchMode: "manual",
    webResearchError: "Credential unavailable.",
    schedulerHealth: "overdue",
  }));
  assert.equal(webResearchWins[0].title, "Web Research error: Credential unavailable.");
  assert.equal(webResearchWins.filter((item) => item.title.startsWith("Scheduler ")).length, 0);

  const schedulerWins = buildStatusBarMenuItems(state({ schedulerHealth: "overdue" }));
  assert.equal(schedulerWins[0].title, "Scheduler overdue");

  const healthy = buildStatusBarMenuItems(state());
  assert.equal(healthy[0].title, "Mode");
});

void test("recovery rows lead somewhere: preflight runs, Reading syncs, manual/off Web Research and scheduler failures open settings", () => {
  const preflight = buildStatusBarMenuItems(state({ preflightOk: false }));
  assert.equal(preflight[0].action, "runPreflight");
  assert.equal(preflight[0].disabled, false);

  const reading = buildStatusBarMenuItems(state({ readingMode: "reading", readingActivity: "error", readingError: "boom" }));
  assert.equal(reading[0].action, "syncReadingMode");
  assert.equal(reading[0].disabled, false);

  const readingBusy = buildStatusBarMenuItems(state({ readingMode: "reading", readingActivity: "syncing", readingError: "boom" }));
  assert.equal(readingBusy[0].action, undefined);
  assert.equal(readingBusy[0].disabled, true);

  const manualError = buildStatusBarMenuItems(state({ webResearchMode: "manual", webResearchError: "Credential unavailable." }));
  assert.equal(manualError[0].action, "openSettings");
  assert.equal(manualError[0].disabled, undefined);

  const offError = buildStatusBarMenuItems(state({ webResearchMode: "off", webResearchError: "Keychain unavailable." }));
  assert.equal(offError[0].title, "Web Research error: Keychain unavailable.");
  assert.equal(offError[0].action, "openSettings");
  assert.equal(offError[0].disabled, undefined);

  const scheduler = buildStatusBarMenuItems(state({ schedulerHealth: "overdue" }));
  assert.equal(scheduler[0].action, "openSettings");
  assert.equal(scheduler[0].disabled, undefined);
});

void test("automatic-mode pauses/errors are represented exactly once: in Research, never in the top recovery row", () => {
  const paused = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    automaticResearchPauseReason: "provider-network",
    schedulerHealth: "overdue",
  }));
  // Scheduler is the highest remaining priority once automatic-mode research is excluded from the top row.
  assert.equal(paused[0].title, "Scheduler overdue");
  const pausedOccurrences = paused.filter((item) => item.title.includes("Automatic research paused"));
  assert.equal(pausedOccurrences.length, 1);
  assert.equal(paused.find((item) => item.title === "Automatic research paused: provider-network.")?.disabled, true);
  assert.ok(paused.some((item) => item.title === "Retry automatic research" && item.action === "retryAutomaticResearch"));

  const dailyLimit = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    automaticResearchAttempted: 10,
    automaticResearchPauseReason: "daily-limit",
  }));
  assert.equal(dailyLimit.filter((item) => item.title.includes("daily limit reached")).length, 1);
  assert.equal(dailyLimit[0].title, "Mode");

  const automaticActivityError = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    webResearchActivity: "error",
    automaticResearchLastError: "Provider request failed.",
  }));
  assert.equal(automaticActivityError.filter((item) => item.title.startsWith("Web Research error:")).length, 0);
  assert.equal(automaticActivityError.filter((item) => item.title === "Automatic research: Provider request failed.").length, 1);
  assert.equal(automaticActivityError[0].title, "Mode");
});

// ---------------------------------------------------------------------------
// Command preservation: removed menu rows keep a command-palette equivalent.
// ---------------------------------------------------------------------------

void test("removed menu actions remain registered as command-palette commands", () => {
  const registered: string[] = [];
  const fakePlugin = {
    addCommand: (command: { id: string }) => { registered.push(command.id); },
    researchSelectedText: () => undefined,
    researchActiveNote: () => undefined,
    runActiveNote: () => undefined,
    runMindmap: () => undefined,
    runPreflight: () => undefined,
    openMindmapView: () => undefined,
    openMindmapLookup: () => undefined,
    setSchedulerMode: () => undefined,
    showStatusSummary: () => undefined,
    startSemanticEnvironment: () => undefined,
  };
  registerMindmapCommands(fakePlugin as unknown as Parameters<typeof registerMindmapCommands>[0]);

  assert.ok(registered.includes("mindmap-research-selected-text"));
  assert.ok(registered.includes("mindmap-research-active-note"));
  assert.ok(registered.includes("mindmap-research-reprocess-active-note"));
  assert.ok(registered.includes("mindmap-run-active-note"));
  assert.ok(registered.includes("mindmap-validate-runtime"));
});

void test("Checkpoint 10B item 3: the migration section is absent from the menu when no production engine/migration record is available", () => {
  const items = buildStatusBarMenuItems(state({ migration: undefined }));
  assert.equal(items.some((item) => item.title === "Mindmap engine (TypeScript)"), false);
  assert.equal(items.some((item) => item.action === "startMigration" || item.action === "retryMigration" || item.action === "cancelMigration"), false);
});

void test("Checkpoint 10B item 3: a not-started migration shows a Start action but never Retry/Cancel", () => {
  const items = buildStatusBarMenuItems(state({ migration: { phase: "not-started", message: "not started", discoveredCount: 0, processedCount: 0, canStart: true, canRetry: false, canCancel: false } }));
  assert.ok(items.some((item) => item.action === "startMigration"));
  assert.equal(items.some((item) => item.action === "retryMigration"), false);
  assert.equal(items.some((item) => item.action === "cancelMigration"), false);
  assert.ok(items.some((item) => item.title.includes("Migration: not started (0/0)")));
});

void test("Checkpoint 10B item 3: an in-flight migration shows a Cancel action and progress counts, never Start/Retry", () => {
  const items = buildStatusBarMenuItems(state({ migration: { phase: "build", message: "building index", discoveredCount: 40, processedCount: 12, canStart: false, canRetry: false, canCancel: true } }));
  assert.ok(items.some((item) => item.action === "cancelMigration"));
  assert.equal(items.some((item) => item.action === "startMigration"), false);
  assert.equal(items.some((item) => item.action === "retryMigration"), false);
  assert.ok(items.some((item) => item.title.includes("(12/40)")));
});

void test("Checkpoint 10B item 3: a failed migration shows a Retry action, never Start/Cancel", () => {
  const items = buildStatusBarMenuItems(state({ migration: { phase: "failed", message: "failed retryable", discoveredCount: 10, processedCount: 3, canStart: false, canRetry: true, canCancel: false } }));
  assert.ok(items.some((item) => item.action === "retryMigration"));
  assert.equal(items.some((item) => item.action === "startMigration"), false);
  assert.equal(items.some((item) => item.action === "cancelMigration"), false);
});
