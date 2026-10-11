import test from "node:test";
import assert from "node:assert/strict";

import { replaceEngineSafely, type ReplaceableEngine } from "./engineReplacement";

void test("replacement never has two active writers", async () => {
  let active = 1;
  let maxActive = 1;
  const current: ReplaceableEngine = { start: async () => {}, dispose: async () => { active -= 1; } };
  const next: ReplaceableEngine = {
    start: async () => { active += 1; maxActive = Math.max(maxActive, active); },
    dispose: async () => { active -= 1; },
  };
  const result = await replaceEngineSafely({ current, createNext: () => next });
  assert.equal(result.engine, next);
  assert.equal(maxActive, 1);
  assert.equal(active, 1);
});

void test("failed activation is disposed and the last healthy configuration is rebuilt", async () => {
  const events: string[] = [];
  const current: ReplaceableEngine = { start: async () => {}, dispose: async () => { events.push("old:stop"); } };
  const failed: ReplaceableEngine = {
    start: async () => { events.push("new:start"); throw new Error("bad config"); },
    dispose: async () => { events.push("new:stop"); },
  };
  const rollback: ReplaceableEngine = {
    start: async () => { events.push("rollback:start"); },
    dispose: async () => { events.push("rollback:stop"); },
  };
  const result = await replaceEngineSafely({ current, createNext: () => failed, createRollback: () => rollback });
  assert.equal(result.engine, rollback);
  assert.equal(result.recovered, true);
  assert.ok(result.activationError instanceof Error);
  assert.deepEqual(events, ["old:stop", "new:start", "new:stop", "rollback:start"]);
});

void test("a delayed durable phase must settle after dispose before the replacement starts", async () => {
  const events: string[] = [];
  let settlePhase!: () => void;
  const phase = new Promise<void>((resolve) => { settlePhase = resolve; });
  const current: ReplaceableEngine = { start: async () => {}, dispose: async () => { events.push("old:dispose-returned"); } };
  const next: ReplaceableEngine = { start: async () => { events.push("new:start"); }, dispose: async () => {} };
  const replacing = replaceEngineSafely({
    current,
    createNext: () => next,
    prepareCurrent: async (engine) => { await engine.dispose(); events.push("wait:phase"); await phase; events.push("phase:settled"); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["old:dispose-returned", "wait:phase"]);
  settlePhase();
  await replacing;
  assert.deepEqual(events, ["old:dispose-returned", "wait:phase", "phase:settled", "new:start"]);
});

void test("quiescence failure is fail-closed and never starts the replacement", async () => {
  let nextStarted = false;
  const current: ReplaceableEngine = { start: async () => {}, dispose: async () => {} };
  await assert.rejects(() => replaceEngineSafely({
    current,
    createNext: () => ({ start: async () => { nextStarted = true; }, dispose: async () => {} }),
    prepareCurrent: async (engine) => { await engine.dispose(); throw new Error("quiescence timeout"); },
  }), /quiescence timeout/);
  assert.equal(nextStarted, false);
});

void test("default replacement preparation stops, drains, disposes, then starts", async () => {
  const events: string[] = [];
  const current: ReplaceableEngine = {
    start: async () => {},
    stop: async () => { events.push("old:stop"); },
    whenJobsSettled: async () => { events.push("old:drain"); },
    dispose: async () => { events.push("old:dispose"); },
  };
  await replaceEngineSafely({
    current,
    createNext: () => ({ start: async () => { events.push("new:start"); }, dispose: async () => {} }),
  });
  assert.deepEqual(events, ["old:stop", "old:drain", "old:dispose", "new:start"]);
});

void test("drain timeout disposes the old engine but never starts a new writer", async () => {
  const events: string[] = [];
  const current: ReplaceableEngine = {
    start: async () => {}, stop: async () => { events.push("old:stop"); },
    whenJobsSettled: async () => await new Promise<void>(() => {}),
    dispose: async () => { events.push("old:dispose"); },
  };
  await assert.rejects(() => replaceEngineSafely({
    current,
    createNext: () => ({ start: async () => { events.push("new:start"); }, dispose: async () => {} }),
    quiescenceTimeoutMs: 10,
  }), /Timed out waiting/);
  assert.deepEqual(events, ["old:stop", "old:dispose"]);
});

void test("a failed candidate settles its durable phase before rollback starts", async () => {
  let settle!: () => void;
  const durablePhase = new Promise<void>((resolve) => { settle = resolve; });
  let rollbackStarted = false;
  const candidate: ReplaceableEngine = {
    start: async () => { throw new Error("startup failed after dispatch"); },
    stop: async () => {},
    whenJobsSettled: async () => { await durablePhase; },
    dispose: async () => {},
  };
  const replacing = replaceEngineSafely({
    current: null,
    createNext: () => candidate,
    createRollback: () => ({ start: async () => { rollbackStarted = true; }, dispose: async () => {} }),
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(rollbackStarted, false);
  settle();
  const result = await replacing;
  assert.equal(rollbackStarted, true);
  assert.equal(result.recovered, true);
});

void test("retry retains the timed-out retired writer's barrier until its phase settles", async () => {
  let settle!: () => void;
  const durablePhase = new Promise<void>((resolve) => { settle = resolve; });
  const retired: ReplaceableEngine = {
    start: async () => {}, stop: async () => {},
    whenJobsSettled: async () => { await durablePhase; }, dispose: async () => {},
  };
  let newWriters = 0;
  const createNext = (): ReplaceableEngine => ({ start: async () => { newWriters += 1; }, dispose: async () => {} });
  await assert.rejects(() => replaceEngineSafely({ current: retired, createNext, quiescenceTimeoutMs: 5 }), /Timed out/);
  const retry = replaceEngineSafely({ current: retired, createNext });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(newWriters, 0);
  settle();
  await retry;
  assert.equal(newWriters, 1);
});
