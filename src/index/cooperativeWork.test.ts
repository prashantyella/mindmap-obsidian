import assert from "node:assert/strict";
import test from "node:test";

import { runCooperativeBlocks, yieldWithWindowTimer } from "./cooperativeWork";

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

void test("window timer yield clears its timer and abort listener on cancellation", async () => {
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  let cleared = false;
  let callback: (() => void) | undefined;
  window.setTimeout = ((handler: TimerHandler) => { callback = handler as () => void; return 77; }) as typeof window.setTimeout;
  window.clearTimeout = ((id: number | undefined) => { if (id === 77) cleared = true; }) as typeof window.clearTimeout;
  try {
    const controller = new AbortController();
    const pending = yieldWithWindowTimer(controller.signal);
    controller.abort();
    await assert.rejects(() => pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(cleared, true);
    callback?.();
  } finally {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  }
});
