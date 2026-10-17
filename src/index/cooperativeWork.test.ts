import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import timers from "node:timers";

import { runCooperativeBlocks, yieldToProcessingLoop } from "./cooperativeWork";

void test("runCooperativeBlocks processes bounded blocks and yields at the slice target", async () => {
  let clock = 0;
  let yields = 0;
  const blocks: Array<[number, number]> = [];
  const metrics = await runCooperativeBlocks(10, 2, (start, end) => {
    blocks.push([start, end]);
    clock += 2;
  }, { sliceMs: 4, now: () => clock, yieldControl: async () => { yields += 1; } });
  assert.deepEqual(blocks, [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
  assert.equal(yields, 2);
  assert.equal(metrics.maxSliceMs, 4);
});

void test("runCooperativeBlocks rejects non-finite slice targets", async () => {
  await assert.rejects(() => runCooperativeBlocks(1, 1, () => undefined, { sliceMs: Number.POSITIVE_INFINITY }));
  await assert.rejects(() => runCooperativeBlocks(1, 1, () => undefined, { sliceMs: Number.NaN }));
});

void test("processing yield rejects pre-abort without scheduling work or adding a listener", (context) => {
  const schedule = context.mock.method(timers, "setImmediate");
  const controller = new AbortController();
  const reason = new Error("plugin unloaded");
  controller.abort(reason);
  assert.throws(() => yieldToProcessingLoop(controller.signal), (error) => error === reason);
  assert.equal(schedule.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("processing yield clears its pending immediate and abort listener on cancellation", async (context) => {
  const schedule = context.mock.method(timers, "setImmediate");
  const cancel = context.mock.method(timers, "clearImmediate");
  const controller = new AbortController();
  const reason = new Error("plugin unloaded");
  const pending = yieldToProcessingLoop(controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(schedule.mock.callCount(), 1);
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(cancel.mock.calls[0].arguments[0], schedule.mock.calls[0].result);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("processing yield gives other event-loop work a turn and removes its listener on success", async () => {
  const controller = new AbortController();
  let otherWorkRan = false;
  timers.setImmediate(() => { otherWorkRan = true; });
  await yieldToProcessingLoop(controller.signal);
  assert.equal(otherWorkRan, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("processing yield normalizes a non-Error cancellation to AbortError", async () => {
  const controller = new AbortController();
  const pending = yieldToProcessingLoop(controller.signal);
  controller.abort("cancelled");
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

void test("cooperative blocks stop before the next block when aborted during a processing yield", async () => {
  const controller = new AbortController();
  const blocks: number[] = [];
  let clock = 0;
  const pending = runCooperativeBlocks(10, 1, (start) => {
    blocks.push(start);
    clock += 4;
  }, { now: () => clock, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(blocks, [0]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
