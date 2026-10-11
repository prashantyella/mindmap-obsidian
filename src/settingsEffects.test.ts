import test from "node:test";
import assert from "node:assert/strict";

import { cloneSettings, classifySettingsChanges, SettingsEffectQueue } from "./settingsEffects";
import { DEFAULT_SETTINGS, type MindmapSettings } from "./settings";

function settings(): MindmapSettings {
  return cloneSettings(DEFAULT_SETTINGS);
}

void test("equivalent and pin-only saves have no runtime effects", () => {
  const previous = settings();
  assert.deepEqual(classifySettingsChanges(previous, settings()), {
    persistOnly: true, refreshPending: false, syncScheduler: false, reconfigureEngine: false,
  });
  const pinned = settings();
  pinned.pinnedConnections = { "A.md": ["B.md"] };
  assert.equal(classifySettingsChanges(previous, pinned).persistOnly, true);
});

void test("scope and provider changes reconfigure once and refresh pending work", () => {
  const previous = settings();
  const scope = settings();
  scope.scopeAllPaths = ["Notes"];
  assert.deepEqual(classifySettingsChanges(previous, scope), {
    persistOnly: false, refreshPending: true, syncScheduler: false, reconfigureEngine: true,
  });
  const provider = settings();
  provider.embedModel = "nomic-embed-text";
  assert.deepEqual(classifySettingsChanges(previous, provider), {
    persistOnly: false, refreshPending: true, syncScheduler: false, reconfigureEngine: true,
  });
});

void test("schedule changes only sync scheduling, while research mode only persists", () => {
  const previous = settings();
  const schedule = settings();
  schedule.schedulerMode = "interval";
  assert.deepEqual(classifySettingsChanges(previous, schedule), {
    persistOnly: false, refreshPending: false, syncScheduler: true, reconfigureEngine: false,
  });
  const research = settings();
  research.webResearchMode = "manual";
  assert.equal(classifySettingsChanges(previous, research).persistOnly, true);
});

void test("cloneSettings isolates mutable arrays and pins", () => {
  const original = settings();
  original.scopeAllPaths = ["Notes"];
  original.pinnedConnections = { "A.md": ["B.md"] };
  const clone = cloneSettings(original);
  clone.scopeAllPaths.push("Archive");
  clone.pinnedConnections["A.md"]!.push("C.md");
  assert.deepEqual(original.scopeAllPaths, ["Notes"]);
  assert.deepEqual(original.pinnedConnections, { "A.md": ["B.md"] });
});

void test("rejected persistence performs no runtime effects and remains retryable", async () => {
  const initial = settings();
  const next = settings();
  next.scopeAllPaths = ["Notes"];
  const queue = new SettingsEffectQueue(initial);
  const calls: string[] = [];
  let fail = true;
  const handlers = {
    persist: async () => { calls.push("persist"); if (fail) throw new Error("disk"); },
    reconfigureEngine: async () => { calls.push("engine"); },
    syncScheduler: async () => { calls.push("scheduler"); },
    refreshPending: () => { calls.push("refresh"); },
  };
  await assert.rejects(() => queue.enqueue(next, handlers), (error: unknown) => error instanceof Error && error.message === "disk");
  assert.deepEqual(calls, ["persist"]);
  fail = false;
  await queue.enqueue(next, handlers);
  assert.deepEqual(calls, ["persist", "persist", "engine", "refresh"]);
});

void test("failed activation does not advance the applied snapshot", async () => {
  const initial = settings();
  const next = settings();
  next.embedModel = "new-model";
  const queue = new SettingsEffectQueue(initial);
  let fail = true;
  let starts = 0;
  const handlers = {
    persist: async () => {},
    reconfigureEngine: async () => { starts += 1; if (fail) throw new Error("activation"); },
    syncScheduler: async () => {}, refreshPending: () => {},
  };
  await assert.rejects(() => queue.enqueue(next, handlers), /activation/);
  fail = false;
  await queue.enqueue(next, handlers);
  assert.equal(starts, 2);
});

void test("overlapping saves apply captured snapshots serially without dropping the newer edit", async () => {
  const initial = settings();
  const first = settings(); first.embedModel = "first";
  const second = settings(); second.embedModel = "second";
  const queue = new SettingsEffectQueue(initial);
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handlers = {
    persist: async (value: MindmapSettings) => { events.push(`persist:${value.embedModel}`); if (value.embedModel === "first") await gate; },
    reconfigureEngine: async (value: MindmapSettings) => { events.push(`engine:${value.embedModel}`); },
    syncScheduler: async () => {}, refreshPending: () => {},
  };
  const firstSave = queue.enqueue(first, handlers);
  const secondSave = queue.enqueue(second, handlers);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["persist:first"]);
  release();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(events, ["persist:first", "engine:first", "persist:second", "engine:second"]);
});
