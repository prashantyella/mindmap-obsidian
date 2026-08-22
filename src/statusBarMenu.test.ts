import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildStatusBarMenuItems, buildStatusBarPresentation, buildStatusSummary, type StatusBarMenuActions, type StatusBarMenuState, type StatusBarRuntimeSetupState } from "./statusBarState";
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
  const titles = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 3, readingUnresearchable: 2 })).map((item) => item.title);
  assert.ok(titles.includes("Reading Mode (experimental)"));
  assert.ok(titles.includes("Sync Reading Mode now"));
  assert.ok(titles.includes("Process Reading backlog (3)"));
  assert.ok(titles.includes("Reading pending: 3"));
  assert.ok(titles.includes("Reading unresearchable: 2"));
});

void test("process reading backlog action disabled at zero pending and while busy", () => {
  const empty = buildStatusBarMenuItems(state({ readingMode: "reading", readingPending: 0 }));
  const backlogEmpty = empty.find((item) => item.title === "Process Reading backlog (0)");
  assert.ok(backlogEmpty);
  assert.equal(backlogEmpty?.disabled, true);

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

  const standard = buildStatusBarMenuItems(state({ readingMode: "standard" }));
  assert.equal(standard.some((item) => item.title.includes("Process Reading backlog")), false);
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

// ---------------------------------------------------------------------------
// (B/C/F) Runtime setup: presentation, menu items, actions, and blocking.
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

void test("ready: informational line stays but no Set up/Cancel action, and queue actions are not blocked", () => {
  const rt = runtimeSetupState({ phase: "ready", message: "Mindmap runtime is ready.", canSetup: false, canCancel: false, blocking: false });
  const items = buildStatusBarMenuItems(state({ runtimeSetup: rt, scopeReady: true }));
  const line = items.find((item) => item.title === "Runtime: Mindmap runtime is ready.");
  assert.ok(line);
  assert.equal(line?.icon, "check");
  assert.equal(items.some((item) => item.action === "startRuntimeSetup"), false);
  assert.equal(items.some((item) => item.action === "cancelRuntimeSetup"), false);
  assert.equal(items.some((item) => item.action === "openPythonDownload"), false);
  assert.equal(items.find((item) => item.action === "runCurrent")?.disabled, false);

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

void test("runtime blocking disables normal queue actions, preflight, and research-and-reprocess with setup-directed copy; manual research-only actions stay enabled", () => {
  const items = buildStatusBarMenuItems(state({
    scopeReady: true,
    activeNote: { path: "Notes/one.md", eligible: true, reason: "", code: "eligible" },
    pendingAvailable: true,
    allPending: 2,
    pendingPaths: ["Notes/one.md"],
    webResearchMode: "manual",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));

  const runActiveNote = items.find((item) => item.action === "runActiveNote" || item.title.startsWith("Run active note"));
  assert.equal(runActiveNote?.disabled, true);
  assert.match(runActiveNote?.title ?? "", /runtime setup required/);

  const runCurrent = items.find((item) => item.title.includes("Run current scope") || item.title.includes("Run active:"));
  assert.equal(runCurrent?.disabled, true);
  assert.match(runCurrent?.title ?? "", /runtime setup required/);

  const runAll = items.find((item) => item.action === "runAll");
  assert.equal(runAll?.disabled, true);
  assert.match(runAll?.title ?? "", /runtime setup required/);

  const processPending = items.find((item) => item.action === "processPendingNote");
  assert.equal(processPending?.disabled, true);
  assert.match(processPending?.title ?? "", /runtime setup required/);

  const preflight = items.find((item) => item.action === "runPreflight");
  assert.equal(preflight?.disabled, true);
  assert.match(preflight?.title ?? "", /runtime setup required/);

  const reprocess = items.find((item) => item.action === "researchAndReprocessActiveNote");
  assert.equal(reprocess?.disabled, true);
  assert.match(reprocess?.title ?? "", /runtime setup required/);

  // Manual research-only actions read/derive locally and never touch the Python runtime.
  const selectedText = items.find((item) => item.action === "researchSelectedText");
  assert.equal(selectedText?.disabled, false);
  const activeNoteResearch = items.find((item) => item.action === "researchActiveNote");
  assert.equal(activeNoteResearch?.disabled, false);
});

void test("runtime blocking disables enabling automatic Reading research but not pausing it, and disables retry", () => {
  const notYetEnabled = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "manual",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const enableAction = notYetEnabled.find((item) => item.action === "toggleAutomaticReadingResearch");
  assert.equal(enableAction?.disabled, true);
  assert.match(enableAction?.title ?? "", /runtime setup required/);

  const alreadyOn = buildStatusBarMenuItems(state({
    readingMode: "reading",
    webResearchMode: "automatic-reading",
    runtimeSetup: runtimeSetupState({ phase: "setup-required" }),
  }));
  const pauseAction = alreadyOn.find((item) => item.action === "toggleAutomaticReadingResearch");
  assert.equal(pauseAction?.title, "Pause Automatic for Reading");
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

void test("StatusBarMenuActions requires openPythonDownload to be wired (compile-time proof) and it is callable", () => {
  assert.equal(typeof ALL_ACTIONS_STUB.openPythonDownload, "function");
  assert.doesNotThrow(() => {
    void ALL_ACTIONS_STUB.openPythonDownload();
  });
});

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
