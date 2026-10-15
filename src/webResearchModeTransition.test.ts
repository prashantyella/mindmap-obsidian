import test from "node:test";
import assert from "node:assert/strict";

import { prerequisiteFailureState, WebResearchModeTransition, type WebResearchModeSnapshot } from "./webResearchModeTransition";

function harness(initial: WebResearchModeSnapshot, readingMode: "standard" | "reading" = "standard") {
  let current = { ...initial };
  let durable = { ...initial };
  let saves = 0;
  return {
    readingMode,
    transition: new WebResearchModeTransition(),
    current: () => ({ ...current }),
    durable: () => ({ ...durable }),
    saves: () => saves,
    options(target: WebResearchModeSnapshot["mode"], prepare: () => Promise<boolean>, failSave = false, waitForSave?: Promise<void>, onSave?: () => void) {
      return {
        target,
        snapshot: () => ({ ...current }),
        prepare: async () => prepare(),
        apply: (next: WebResearchModeSnapshot) => { current = { ...next }; },
        persist: async () => {
          saves += 1;
          onSave?.();
          await waitForSave;
          if (failSave) throw new Error("save failed");
          durable = { ...current };
        },
      };
    },
  };
}

void test("cancelled consent stays off without saving or changing independent reading mode", async () => {
  const h = harness({ mode: "off", activity: "off", lastError: null }, "reading");
  const result = await h.transition.change(h.options("manual", async () => false));
  assert.equal(result, "cancelled");
  assert.deepEqual(h.current(), { mode: "off", activity: "off", lastError: null });
  assert.deepEqual(h.durable(), h.current());
  assert.equal(h.saves(), 0);
  assert.equal(h.readingMode, "reading");
});

void test("failed save restores mode and activity exactly", async () => {
  const initial = { mode: "automatic-reading", activity: "ready", lastError: "prior" } as const;
  const h = harness(initial, "reading");
  const result = await h.transition.change(h.options("off", async () => true, true));
  assert.equal(result, "save-failed");
  assert.deepEqual(h.current(), initial);
  assert.deepEqual(h.durable(), initial);
  assert.equal(h.saves(), 1);
  assert.equal(h.readingMode, "reading");
});

void test("overlapping master and automatic changes reject the second before a same-mode shortcut or save", async () => {
  const h = harness({ mode: "off", activity: "off", lastError: null }, "reading");
  let release!: () => void;
  const consent = new Promise<void>((resolve) => { release = resolve; });
  const master = h.transition.change(h.options("manual", async () => { await consent; return true; }));
  const automatic = await h.transition.change(h.options("automatic-reading", async () => true));
  assert.equal(automatic, "busy");
  assert.equal(h.saves(), 0);
  release();
  assert.equal(await master, "changed");
  assert.equal(h.saves(), 1);
  assert.deepEqual(h.current(), { mode: "manual", activity: "ready", lastError: null });
  assert.deepEqual(h.durable(), h.current());
});

void test("an overlap is busy even when the first change has applied the same mode but not saved it", async () => {
  const h = harness({ mode: "off", activity: "off", lastError: null });
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  const first = h.transition.change(h.options("manual", async () => true, false, saveGate, markSaveStarted));
  await saveStarted;
  assert.deepEqual(h.current(), { mode: "manual", activity: "ready", lastError: null });
  assert.equal(await h.transition.change(h.options("manual", async () => true)), "busy");
  assert.equal(h.saves(), 1);
  releaseSave();
  assert.equal(await first, "changed");
  assert.deepEqual(h.durable(), h.current());
});

void test("failed Automatic prerequisites preserve an existing Manual snapshot", async () => {
  const previous: WebResearchModeSnapshot = { mode: "manual", activity: "ready", lastError: "existing context" };
  const failure = prerequisiteFailureState(previous, "Provider unavailable");
  assert.equal(failure.exposeInStatus, false);
  assert.deepEqual(failure.snapshot, previous);

  const h = harness(previous, "reading");
  const result = await h.transition.change(h.options("automatic-reading", async () => {
    const prepared = prerequisiteFailureState(h.current(), "Provider unavailable");
    assert.equal(prepared.exposeInStatus, false);
    assert.deepEqual(prepared.snapshot, previous);
    return false;
  }));
  assert.equal(result, "cancelled");
  assert.deepEqual(h.current(), previous);
  assert.deepEqual(h.durable(), previous);
  assert.equal(h.saves(), 0);
});

void test("failed first enable remains actionable in status without persisting a mode", () => {
  const previous: WebResearchModeSnapshot = { mode: "off", activity: "off", lastError: null };
  assert.deepEqual(prerequisiteFailureState(previous, "Provider unavailable"), {
    snapshot: { mode: "off", activity: "error", lastError: "Provider unavailable" },
    exposeInStatus: true,
  });
});
