import test from "node:test";
import assert from "node:assert/strict";

import { SidebarRefreshController, type SidebarRefreshTimers } from "./sidebarRefreshController";

class FakeTimers implements SidebarRefreshTimers {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks].sort((a, b) => a[1].at - b[1].at)) {
      if (task.at <= this.now) { this.tasks.delete(id); task.callback(); }
    }
  }
}

void test("lookup coalesces at 350 ms and input invalidation rejects old completion immediately", () => {
  const timers = new FakeTimers();
  let calls = 0;
  const controller = new SidebarRefreshController({ runLookup: () => { calls += 1; }, refreshNote: () => undefined }, timers);
  const first = controller.scheduleLookup();
  timers.advance(200);
  const second = controller.scheduleLookup();
  assert.equal(controller.isCurrentLookup(first), false);
  timers.advance(349);
  assert.equal(calls, 0);
  timers.advance(1);
  assert.equal(calls, 1);
  assert.equal(controller.isCurrentLookup(second), true);
  controller.invalidateLookup();
  assert.equal(controller.isCurrentLookup(second), false);
});

void test("note edits coalesce at 1000 ms and close cancels all callbacks", () => {
  const timers = new FakeTimers();
  let calls = 0;
  const controller = new SidebarRefreshController({ runLookup: () => { calls += 10; }, refreshNote: () => { calls += 1; } }, timers);
  controller.scheduleNoteRefresh();
  timers.advance(700);
  controller.scheduleNoteRefresh();
  timers.advance(999);
  assert.equal(calls, 0);
  timers.advance(1);
  assert.equal(calls, 1);
  controller.scheduleLookup();
  controller.scheduleNoteRefresh();
  controller.close();
  timers.advance(2_000);
  assert.equal(calls, 1);
});
