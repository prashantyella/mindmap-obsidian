import test from "node:test";
import assert from "node:assert/strict";
import { buildStatusBarMenuItems, buildStatusBarPresentation, type StatusBarMenuState } from "./statusBarState";
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

void test("CP5: preparing=true → label 'Mindmap · preparing'", () => {
  const s = state({ activity: { state: "running", queuedCount: 0, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: true, processed: 0, total: 935, failed: 0, enqueuedCount: undefined } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · preparing");
});

void test("a backed-off rebuild displays retry deadline/failure instead of preparing and does not spin", () => {
  const activity = { state: "running" as const, queuedCount: 1, activeCount: 0, processNoteCount: 0, bulkBlocked: true,
    current: { kind: "rebuild-index" as const, phase: "build-generation", attempt: 8, nextAttemptAtMs: Date.UTC(2026, 9, 21), failureCode: "UNKNOWN_TRANSIENT" },
    batch: { status: "active" as const, preparing: true, processed: 0, total: 0, failed: 0 } };
  const s = state({ activity });
  const presentation = buildStatusBarPresentation(s);
  assert.equal(presentation.label, "Mindmap · waiting to retry");
  assert.equal(presentation.animateIcon, false);
  assert.match(presentation.title, /build-generation.*retry scheduled 2026-10-21T00:00:00.000Z, phase attempt 8, UNKNOWN_TRANSIENT/);
  assert.match(buildStatusBarMenuItems(s).find((item) => item.title.startsWith("Engine:"))!.title, /waiting to retry.*UNKNOWN_TRANSIENT/);
  for (const pausedState of ["paused", "operator-paused", "faulted"] as const) {
    assert.equal(buildStatusBarPresentation(state({ activity: { ...activity, state: pausedState } })).label, pausedState === "faulted" ? "Mindmap · fault" : "Mindmap · paused");
  }
});

void test("active rebuild phases and terminal identity conflicts appear in existing status text", () => {
  for (const [phase, label] of [["build-generation", "rebuilding index"], ["verify-generation", "verifying index"], ["activate-generation", "activating index"]]) {
    const presentation = buildStatusBarPresentation(state({ activity: { state: "running", queuedCount: 0, activeCount: 1, processNoteCount: 0, bulkBlocked: true, current: { kind: "rebuild-index", phase, attempt: 1 }, batch: { status: "active", preparing: true, processed: 0, total: 0, failed: 0 } } }));
    assert.equal(presentation.label, `Mindmap · ${label}`);
  }
  const presentation = buildStatusBarPresentation(state({ activity: { state: "idle", queuedCount: 0, activeCount: 0, processNoteCount: 0, bulkBlocked: false, latestFailureBatch: { status: "failed", failed: 0, phase: "build-generation", failureCode: "INDEX_IDENTITY_CONFLICT" } } }));
  assert.equal(presentation.label, "Mindmap · root failed");
  assert.match(presentation.title, /build-generation, INDEX_IDENTITY_CONFLICT/);
});

void test("CP5: preparing=true with total=undefined → label 'Mindmap · preparing'", () => {
  const s = state({ activity: { state: "running", queuedCount: 0, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: true, processed: 0, total: undefined, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · preparing");
});

void test("CP5: preparing=false, 895/935 → label 'Mindmap · 895/935'", () => {
  const s = state({ activity: { state: "running", queuedCount: 0, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 895, total: 935, failed: 0, enqueuedCount: 40 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · 895/935");
});

void test("CP5: aria-label includes progress when not preparing", () => {
  const s = state({ activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 895, total: 935, failed: 0, enqueuedCount: 40 } } });
  const p = buildStatusBarPresentation(s);
  assert.match(p.ariaLabel, /895\/935/);
});

void test("CP5: aria-label says 'preparing' when preparing=true", () => {
  const s = state({ activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: true, processed: 0, total: 935, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.match(p.ariaLabel, /preparing/);
  assert.doesNotMatch(p.ariaLabel, /0\/935/);
});

void test("CP5: fault priority wins over batch preparing", () => {
  const s = state({ activity: { state: "faulted", queuedCount: 0, activeCount: 0, processNoteCount: 0, bulkBlocked: true, fault: "STORE_READ_FAILED", batch: { status: "active", preparing: true, processed: 0, total: undefined, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · fault");
});

void test("CP5: operator-paused priority wins over batch progress", () => {
  const s = state({ activity: { state: "operator-paused", operatorPause: true, queuedCount: 1, activeCount: 0, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 5, total: 10, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · paused");
});

void test("CP5: provider-pause priority wins over batch progress", () => {
  const s = state({ activity: { state: "paused", queuedCount: 1, activeCount: 0, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 5, total: 10, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Mindmap · paused");
});

void test("CP5: Research-busy priority wins over batch progress", () => {
  const s = state({ webResearchMode: "manual", webResearchActivity: "deriving", activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 5, total: 10, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Research · deriving");
});

void test("CP5: Reading busy priority wins over batch", () => {
  const s = state({ readingMode: "reading", readingActivity: "syncing", activity: { state: "running", queuedCount: 1, activeCount: 1, processNoteCount: 0, bulkBlocked: true, batch: { status: "active", preparing: false, processed: 5, total: 10, failed: 0 } } });
  const p = buildStatusBarPresentation(s);
  assert.equal(p.label, "Reading · syncing");
});
