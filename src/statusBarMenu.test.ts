import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildStatusBarMenuItems, buildStatusBarPresentation, buildStatusSummary, type StatusBarMenuActions, type StatusBarMenuState, type StatusBarRuntimeSetupState } from "./statusBarState";
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

function runtimeSetupState(overrides: Partial<StatusBarRuntimeSetupState> = {}): StatusBarRuntimeSetupState {
  return {
    phase: "setup-required",
    message: "A compatible Python was found, but Mindmap's packages are not installed yet.",
    canSetup: true,
    canCancel: false,
    blocking: true,
    ...overrides,
  };
}

function labelTitles(items: ReturnType<typeof buildStatusBarMenuItems>): string[] {
  return items.filter((item) => item.label).map((item) => item.title);
}

// A full ACTIONS implementation for compile-time proof every action key
// (including openPythonDownload) is actually wired end to end.
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
  startRuntimeSetup: () => undefined,
  cancelRuntimeSetup: () => undefined,
  openPythonDownload: () => undefined,
};

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
  const runningAction = runningWhileEligible.find((item) => item.title.startsWith("Run active note"));
  assert.equal(runningAction?.disabled, true);
  assert.equal(runningAction?.action, undefined);
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
// (7) Runtime setup or exactly one highest-priority recovery row at top.
// ---------------------------------------------------------------------------

void test("setup-required: menu shows the runtime line and a Set up action; presentation is actionable", () => {
  const items = buildStatusBarMenuItems(state({ runtimeSetup: runtimeSetupState({ phase: "setup-required" }) }));
  assert.ok(items.some((item) => item.title === "Runtime setup" && item.label));
  const line = items.find((item) => item.title.startsWith("Runtime: "));
  assert.ok(line);
  assert.equal(line?.disabled, true);
  assert.equal(line?.icon, "triangle-alert");
  const setupAction = items.find((item) => item.action === "startRuntimeSetup");
  assert.ok(setupAction);
  assert.equal(setupAction?.title, "Set up Mindmap runtime");
  assert.equal(items.some((item) => item.action === "cancelRuntimeSetup"), false);

  const presentation = buildStatusBarPresentation(state({ runtimeSetup: runtimeSetupState({ phase: "setup-required" }) }));
  assert.equal(presentation.actionable, true);
  assert.equal(presentation.busy, false);
  assert.match(presentation.ariaLabel, /runtime setup required/i);
});

void test("unavailable: menu offers the Python download page instead of a Set up action", () => {
  const items = buildStatusBarMenuItems(state({
    runtimeSetup: runtimeSetupState({ phase: "unavailable", message: "No compatible Python 3.11-3.13 was found.", canSetup: false }),
  }));
  assert.equal(items.some((item) => item.action === "startRuntimeSetup"), false);
  assert.equal(items.some((item) => item.action === "cancelRuntimeSetup"), false);
  const download = items.find((item) => item.action === "openPythonDownload");
  assert.ok(download);
  assert.equal(download?.title, "Open official Python download page");

  const presentation = buildStatusBarPresentation(state({ runtimeSetup: runtimeSetupState({ phase: "unavailable", canSetup: false }) }));
  assert.equal(presentation.actionable, true);
  assert.match(presentation.ariaLabel, /Python not found/);
});

void test("busy setup phases (creating/installing/verifying) show Cancel and a loader, and are not 'actionable'", () => {
  for (const phase of ["creating", "installing", "verifying"] as const) {
    const rt = runtimeSetupState({ phase, canSetup: false, canCancel: true, message: `${phase}...` });
    const items = buildStatusBarMenuItems(state({ runtimeSetup: rt }));
    const cancel = items.find((item) => item.action === "cancelRuntimeSetup");
    assert.ok(cancel, `expected a cancel action for phase ${phase}`);
    assert.equal(items.some((item) => item.action === "startRuntimeSetup"), false);

    const presentation = buildStatusBarPresentation(state({ runtimeSetup: rt }));
    assert.equal(presentation.busy, true, `expected busy for phase ${phase}`);
    assert.equal(presentation.icon, "loader-circle");
    assert.equal(presentation.actionable, false, `expected not actionable for phase ${phase}`);
  }
});

void test("runtime-setup message row uses loader-circle for busy phases and triangle-alert for warning phases", () => {
  for (const phase of ["discovering", "confirming", "creating", "installing", "verifying"] as const) {
    const items = buildStatusBarMenuItems(state({ runtimeSetup: runtimeSetupState({ phase, canSetup: false, canCancel: true, message: `${phase}...` }) }));
    const line = items.find((item) => item.title.startsWith("Runtime: "));
    assert.equal(line?.icon, "loader-circle", `expected loader-circle for busy phase ${phase}`);
  }

  for (const phase of ["setup-required", "unavailable", "failed", "cancelled"] as const) {
    const items = buildStatusBarMenuItems(state({ runtimeSetup: runtimeSetupState({ phase, canSetup: true, canCancel: false, message: `${phase}...` }) }));
    const line = items.find((item) => item.title.startsWith("Runtime: "));
    assert.equal(line?.icon, "triangle-alert", `expected triangle-alert for warning phase ${phase}`);
  }

  // Presentation-level animation/warning precedence stays untouched by this menu-only icon fix.
  const busyPresentation = buildStatusBarPresentation(state({ runtimeSetup: runtimeSetupState({ phase: "discovering", canSetup: false, canCancel: false }) }));
  assert.equal(busyPresentation.icon, "loader-circle");
  assert.equal(busyPresentation.animateIcon, true);
  const warningPresentation = buildStatusBarPresentation(state({ runtimeSetup: runtimeSetupState({ phase: "failed", canSetup: true }) }));
  assert.equal(warningPresentation.icon, "triangle-alert");
  assert.equal(warningPresentation.animateIcon, false);
});

void test("ready runtime is healthy: no runtime line, no top recovery row, queue actions are not blocked", () => {
  const rt = runtimeSetupState({ phase: "ready", message: "Mindmap runtime is ready.", canSetup: false, canCancel: false, blocking: false });
  const items = buildStatusBarMenuItems(state({ runtimeSetup: rt, scopeReady: true }));
  assert.equal(items.some((item) => item.title.startsWith("Runtime:")), false);
  assert.equal(items.some((item) => item.title === "Runtime setup" && item.label), false);
  assert.equal(items.some((item) => item.action === "startRuntimeSetup"), false);
  assert.equal(items.some((item) => item.action === "cancelRuntimeSetup"), false);
  assert.equal(items.some((item) => item.action === "openPythonDownload"), false);
  assert.equal(items.find((item) => item.action === "runCurrent")?.disabled, false);
  assert.equal(items[0].title, "Mode");

  const presentation = buildStatusBarPresentation(state({ runtimeSetup: rt }));
  assert.equal(presentation.actionable, false);
  assert.equal(presentation.busy, false);
});

void test("attention precedence: an actionable runtime-setup state wins over preflight/scope/scheduler attention text", () => {
  const presentation = buildStatusBarPresentation(state({
    runtimeSetup: runtimeSetupState({ phase: "unavailable", canSetup: false }),
    preflightOk: false,
    scopeReady: false,
    schedulerHealth: "overdue",
  }));
  assert.match(presentation.ariaLabel, /Python not found/);
  assert.doesNotMatch(presentation.ariaLabel, /preflight failed/);
  assert.doesNotMatch(presentation.ariaLabel, /scope setup required/);
  assert.doesNotMatch(presentation.ariaLabel, /scheduler overdue/);
});

void test("runtime-setup block wins over the top recovery row: only one appears at once", () => {
  const items = buildStatusBarMenuItems(state({
    runtimeSetup: runtimeSetupState({ phase: "unavailable", canSetup: false }),
    preflightOk: false,
    schedulerHealth: "overdue",
  }));
  assert.ok(items.some((item) => item.title === "Runtime setup" && item.label));
  assert.equal(items.some((item) => item.title.startsWith("Run preflight")), false);
  assert.equal(items.some((item) => item.title.startsWith("Scheduler ")), false);
});

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

void test("blocked Reading backlog: disabled with setup-directed copy even when annotations are pending", () => {
  const items = buildStatusBarMenuItems(state({
    readingMode: "reading",
    readingPending: 4,
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const backlog = items.find((item) => item.action === "processReadingBacklog");
  assert.ok(backlog);
  assert.equal(backlog?.title, "Process Reading backlog (runtime setup required)");
  assert.equal(backlog?.disabled, true);
});

void test("runtime blocking disables normal queue actions and preflight with setup-directed copy; manual research toggle stays enabled", () => {
  const items = buildStatusBarMenuItems(state({
    scopeReady: true,
    activeNote: { path: "Notes/one.md", eligible: true, reason: "", code: "eligible" },
    pendingAvailable: true,
    allPending: 2,
    webResearchMode: "manual",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));

  const runActiveNote = items.find((item) => item.title.startsWith("Run Mindmap for active note") || item.title.startsWith("Run active note"));
  assert.equal(runActiveNote?.disabled, true);
  assert.match(runActiveNote?.title ?? "", /runtime setup required/);

  const runCurrent = items.find((item) => item.title.includes("Run current scope") || item.title.includes("Run active:"));
  assert.equal(runCurrent?.disabled, true);
  assert.match(runCurrent?.title ?? "", /runtime setup required/);

  const runAll = items.find((item) => item.action === "runAll");
  assert.equal(runAll?.disabled, true);
  assert.match(runAll?.title ?? "", /runtime setup required/);

  // The runtime-setup block itself owns the top row, so there is no
  // separate "preflight failed" recovery row while it is blocking.
  assert.equal(items.some((item) => item.action === "runPreflight"), false);

  // Manual research reads/derives locally and never touches the Python runtime.
  const manualRow = items.find((item) => item.title === "Manual research");
  assert.equal(manualRow?.disabled, false);
});

void test("runtime blocking disables enabling automatic Reading research but not pausing it, and disables retry", () => {
  const notYetEnabled = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "manual",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const enableAction = notYetEnabled.find((item) => item.title === "Automatic for Reading" || item.title.startsWith("Automatic for Reading "));
  assert.equal(enableAction?.disabled, true);
  assert.match(enableAction?.title ?? "", /runtime setup required/);

  const alreadyOn = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const pauseAction = alreadyOn.find((item) => item.title === "Automatic for Reading");
  assert.equal(pauseAction?.disabled, false);

  const transientPause = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    automaticResearchPauseReason: "provider-network",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const retry = transientPause.find((item) => item.action === "retryAutomaticResearch");
  assert.ok(retry);
  assert.equal(retry?.disabled, true);
  assert.match(retry?.title ?? "", /runtime setup required/);
});

void test("retry copy is used for failed/cancelled phases, and cancel is offered independently of canSetup", () => {
  for (const phase of ["failed", "cancelled"] as const) {
    const items = buildStatusBarMenuItems(state({ runtimeSetup: runtimeSetupState({ phase, canSetup: true, canCancel: false }) }));
    const action = items.find((item) => item.action === "startRuntimeSetup");
    assert.equal(action?.title, "Retry Mindmap runtime setup");
  }

  const cancellableButNotRetryable = buildStatusBarMenuItems(state({ runtimeSetup: runtimeSetupState({ phase: "confirming", canSetup: false, canCancel: true }) }));
  assert.ok(cancellableButNotRetryable.some((item) => item.action === "cancelRuntimeSetup"));
  assert.equal(cancellableButNotRetryable.some((item) => item.action === "startRuntimeSetup"), false);
});

void test("StatusBarMenuActions requires openPythonDownload to be wired (compile-time proof) and it is callable", () => {
  assert.equal(typeof ALL_ACTIONS_STUB.openPythonDownload, "function");
  assert.doesNotThrow(() => {
    void ALL_ACTIONS_STUB.openPythonDownload();
  });
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
