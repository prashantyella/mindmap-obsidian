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

void test("continuous metadata changes keep the in-flight result current until one queued refresh fires", () => {
  const timers = new FakeTimers();
  let refreshes = 0;
  let refreshedGeneration: number | null = null;
  const controller = new SidebarRefreshController({
    runLookup: () => undefined,
    refreshNote: () => { refreshes += 1; refreshedGeneration = controller.invalidateNoteRequest(); },
  }, timers);
  const inFlight = controller.invalidateNoteRequest();
  controller.scheduleNoteRefresh();
  timers.advance(700);
  controller.scheduleNoteRefresh();
  assert.equal(controller.isCurrentNote(inFlight), true, "rescheduling metadata debounce must not reject the active request");
  timers.advance(999);
  assert.equal(refreshes, 0);
  assert.equal(controller.isCurrentNote(inFlight), true);
  timers.advance(1);
  assert.equal(refreshes, 1);
  assert.equal(controller.isCurrentNote(inFlight), false, "the fired refresh invalidates the prior result");
  assert.notEqual(refreshedGeneration, null);
  assert.equal(controller.isCurrentNote(refreshedGeneration!), true);
});

void test("a stale timer callback cannot fire after reschedule, note switch, or close", () => {
  class LeakyTimers extends FakeTimers {
    override clearTimeout(_handle: unknown): void { /* intentionally leaves stale callbacks queued */ }
  }
  const timers = new LeakyTimers();
  let refreshes = 0;
  const controller = new SidebarRefreshController({ runLookup: () => undefined, refreshNote: () => { refreshes += 1; } }, timers);
  controller.scheduleNoteRefresh();
  timers.advance(500);
  controller.scheduleNoteRefresh();
  timers.advance(500);
  assert.equal(refreshes, 0, "the cancelled first timer is rejected by its timer generation");
  controller.invalidateNoteRequest();
  timers.advance(500);
  assert.equal(refreshes, 0, "a note switch cancels the queued refresh");
  controller.scheduleNoteRefresh();
  controller.close();
  timers.advance(1_000);
  assert.equal(refreshes, 0, "close rejects even a timer backend that delivers cancelled callbacks");
});

void test("a delivered stale callback cannot clear the newer timer handle", () => {
  class RecordingLeakyTimers extends FakeTimers {
    cleared: number[] = [];
    override clearTimeout(handle: unknown): void { this.cleared.push(handle as number); }
  }
  const timers = new RecordingLeakyTimers();
  const controller = new SidebarRefreshController({ runLookup: () => undefined, refreshNote: () => undefined }, timers);
  const requestGeneration = controller.invalidateNoteRequest();
  assert.equal(controller.scheduleNoteRefresh(), requestGeneration, "schedule preserves the current request-token return contract");
  const staleCallback = timers.tasks.get(1)!.callback;
  controller.scheduleNoteRefresh();
  assert.equal(timers.next, 2);
  staleCallback();
  controller.close();
  assert.equal(timers.cleared.includes(2), true, "close must still cancel the newer live timer handle");
});

void test("a fired refresh targets the current path, not the path active when it was scheduled", () => {
  const timers = new FakeTimers();
  let currentPath = "Before.md";
  const refreshed: string[] = [];
  const controller = new SidebarRefreshController({ runLookup: () => undefined, refreshNote: () => { controller.invalidateNoteRequest(); refreshed.push(currentPath); } }, timers);
  const oldRequest = controller.invalidateNoteRequest();
  controller.scheduleNoteRefresh();
  currentPath = "Current.md";
  timers.advance(1_000);
  assert.deepEqual(refreshed, ["Current.md"]);
  assert.equal(controller.isCurrentNote(oldRequest), false);
});

void test("global index revisions coalesce for one refresh and close cancels the burst", () => {
  const timers = new FakeTimers();
  let refreshes = 0;
  const controller = new SidebarRefreshController({ runLookup: () => undefined, refreshNote: () => undefined, refreshIndex: () => { refreshes += 1; } }, timers);
  controller.scheduleIndexRefresh();
  timers.advance(600);
  controller.scheduleIndexRefresh();
  timers.advance(399);
  assert.equal(refreshes, 0);
  timers.advance(1);
  assert.equal(refreshes, 1);
  controller.scheduleIndexRefresh();
  controller.close();
  timers.advance(1_000);
  assert.equal(refreshes, 1);
});
