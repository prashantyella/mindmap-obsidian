import test from "node:test";
import assert from "node:assert/strict";

import { cloneSettings, classifySettingsChanges, restoreEngineSettingsInPlace, SettingsEffectQueue, withEngineSettings } from "./settingsEffects";
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
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => withEngineSettings(attempted, previous),
  };
  await assert.rejects(() => queue.enqueue(next, handlers), (error: unknown) => error instanceof Error && error.message === "disk");
  assert.deepEqual(calls, ["persist"]);
  fail = false;
  await queue.enqueue(next, handlers);
  assert.deepEqual(calls, ["persist", "persist", "engine", "refresh"]);
});

void test("failed activation restores the applied snapshot and an explicit retry can activate it", async () => {
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
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => withEngineSettings(attempted, previous),
  };
  await assert.rejects(() => queue.enqueue(next, handlers), /activation/);
  fail = false;
  await queue.enqueue(next, handlers, { explicitEngineActivation: true });
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
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => withEngineSettings(attempted, previous),
  };
  const firstSave = queue.enqueue(first, handlers);
  const secondSave = queue.enqueue(second, handlers);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["persist:first"]);
  release();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(events, ["persist:first", "engine:first", "persist:second", "engine:second"]);
});

void test("failed provider activation is durably restored and later pin/mode saves do not reactivate it", async () => {
  const initial = settings();
  const badProvider = settings();
  badProvider.embedModel = "missing";
  badProvider.webResearchMode = "manual";
  const queue = new SettingsEffectQueue(initial);
  const events: string[] = [];
  const persisted: MindmapSettings[] = [];
  const handlers = {
    persist: async (value: MindmapSettings) => { persisted.push(cloneSettings(value)); events.push(`persist:${value.embedModel}:${value.webResearchMode}`); },
    reconfigureEngine: async () => { events.push("engine"); throw new Error("unavailable"); },
    syncScheduler: async () => { events.push("scheduler"); },
    refreshPending: () => { events.push("refresh"); },
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => {
      const restored = withEngineSettings(attempted, previous);
      persisted.push(cloneSettings(restored));
      events.push(`rollback:${restored.embedModel}`);
      return restored;
    },
  };
  await assert.rejects(() => queue.enqueue(badProvider, handlers, { explicitEngineActivation: true }), /unavailable/);
  assert.equal(persisted[1]?.webResearchMode, "manual", "durable rollback must keep the already-written non-engine mode");

  const pinAndMode = cloneSettings(badProvider);
  pinAndMode.pinnedConnections = { "A.md": ["B.md"] };
  pinAndMode.webResearchMode = "manual";
  await queue.enqueue(pinAndMode, handlers);

  assert.equal(events.filter((event) => event === "engine").length, 1);
  const finalPersisted = persisted[persisted.length - 1]!;
  assert.equal(finalPersisted.embedModel, initial.embedModel);
  assert.equal(finalPersisted.webResearchMode, "manual");
  assert.deepEqual(finalPersisted.pinnedConnections, { "A.md": ["B.md"] });
});

void test("a queued non-engine save after activation failure keeps its changes while using restored engine settings", async () => {
  const initial = settings();
  const bad = settings(); bad.llmBaseUrl = "http://127.0.0.1:9999";
  const later = cloneSettings(bad); later.webResearchMode = "manual";
  const latest = cloneSettings(later); latest.pinnedConnections = { "A.md": ["B.md"] };
  const queue = new SettingsEffectQueue(initial);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const persisted: MindmapSettings[] = [];
  const handlers = {
    persist: async (value: MindmapSettings) => { persisted.push(cloneSettings(value)); },
    reconfigureEngine: async () => { await gate; throw new Error("offline"); },
    syncScheduler: async () => {}, refreshPending: () => {},
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => {
      const restored = withEngineSettings(attempted, previous);
      persisted.push(cloneSettings(restored));
      return restored;
    },
  };
  const failed = queue.enqueue(bad, handlers, { explicitEngineActivation: true });
  const queued = queue.enqueue(later, handlers);
  const queuedAgain = queue.enqueue(latest, handlers);
  release();
  await assert.rejects(() => failed, /offline/);
  await queued;
  await queuedAgain;
  const finalPersisted = persisted[persisted.length - 1]!;
  assert.equal(finalPersisted.llmBaseUrl, initial.llmBaseUrl);
  assert.equal(finalPersisted.webResearchMode, "manual");
  assert.deepEqual(finalPersisted.pinnedConnections, { "A.md": ["B.md"] });
});

void test("explicit equivalent settings force recovery only when requested", async () => {
  const initial = settings();
  const queue = new SettingsEffectQueue(initial);
  let starts = 0;
  const handlers = {
    persist: async () => {},
    reconfigureEngine: async () => { starts += 1; },
    syncScheduler: async () => {}, refreshPending: () => {},
    recoverActivation: async (previous: MindmapSettings) => previous,
  };
  await queue.enqueue(initial, handlers, { explicitEngineActivation: true });
  assert.equal(starts, 0, "healthy equivalent saves do not restart");
  await queue.enqueue(initial, handlers, { explicitEngineActivation: true, forceEngineActivation: true });
  assert.equal(starts, 1, "an unavailable engine can be recovered with equivalent known-good settings");
});

void test("queued equivalent Apply evaluates recovery need at execution time", async () => {
  const initial = settings();
  const first = settings(); first.webResearchMode = "manual";
  const queue = new SettingsEffectQueue(initial);
  let unavailable = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let starts = 0;
  const handlers = {
    persist: async (value: MindmapSettings) => {
      if (value.webResearchMode === "manual" && unavailable) {
        await gate;
        unavailable = false;
      }
    },
    reconfigureEngine: async () => { starts += 1; },
    syncScheduler: async () => {}, refreshPending: () => {},
    recoverActivation: async (previous: MindmapSettings) => previous,
  };
  const earlier = queue.enqueue(first, handlers);
  const equivalentApply = queue.enqueue(first, handlers, {
    explicitEngineActivation: true,
    forceEngineActivation: () => unavailable,
  });
  release();
  await Promise.all([earlier, equivalentApply]);
  assert.equal(starts, 0, "the healthy engine restored before execution must not be restarted");

  unavailable = true;
  await queue.enqueue(first, handlers, {
    explicitEngineActivation: true,
    forceEngineActivation: () => unavailable,
  });
  assert.equal(starts, 1, "equivalent Apply still recovers an engine unavailable at execution");
});

void test("durable rollback failure stays typed and a later persist-only save repairs disk without reactivation", async () => {
  const initial = settings();
  const bad = settings(); bad.embedModel = "bad";
  const queue = new SettingsEffectQueue(initial);
  let starts = 0;
  let recoveryFails = true;
  const live = cloneSettings(bad);
  const persisted: MindmapSettings[] = [];
  const handlers = {
    persist: async (value: MindmapSettings) => { persisted.push(cloneSettings(value)); },
    adoptPersisted: (value: MindmapSettings, requested: MindmapSettings) => { restoreEngineSettingsInPlace(live, requested, value); },
    reconfigureEngine: async () => { starts += 1; throw new Error("activation failed"); },
    syncScheduler: async () => {}, refreshPending: () => {},
    recoverActivation: async (previous: MindmapSettings, attempted: MindmapSettings) => {
      if (recoveryFails) throw new Error("rollback disk failed");
      return withEngineSettings(attempted, previous);
    },
  };
  await assert.rejects(
    () => queue.enqueue(bad, handlers, { explicitEngineActivation: true }),
    (error: unknown) => error instanceof Error && error.name === "SettingsApplyError" && error.message === "rollback disk failed",
  );
  recoveryFails = false;
  const pin = cloneSettings(bad); pin.pinnedConnections = { "A.md": ["B.md"] };
  await queue.enqueue(pin, handlers);
  assert.equal(starts, 1);
  assert.equal(persisted[persisted.length - 1]?.embedModel, initial.embedModel);
  assert.equal(live.embedModel, initial.embedModel);
});
