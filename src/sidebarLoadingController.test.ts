import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { SidebarLoadingController } from "./sidebarLoadingController";
import type { SidebarRefreshTimers } from "./sidebarRefreshController";

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
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.now) { this.tasks.delete(id); task.callback(); }
    }
  }
}

void test("quick queries finish without flashing a loader", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  timers.advance(249);
  controller.update(null);
  timers.advance(1_000);
  assert.deepEqual(visible, []);
  assert.equal(timers.tasks.size, 0);
});

void test("slow queries show at 250 ms and hide on completion or error", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  timers.advance(249);
  assert.deepEqual(visible, []);
  timers.advance(1);
  assert.deepEqual(visible, [true]);
  controller.update(null);
  assert.deepEqual(visible, [true, false]);
});

void test("re-renders of one request do not delay or restart its animation", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("lookup:1");
  timers.advance(200);
  controller.update("lookup:1");
  timers.advance(50);
  controller.update("lookup:1");
  assert.deepEqual(visible, [true]);
  assert.equal(timers.next, 1);
});

void test("switching notes or lookup requests resets the delayed indicator", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  timers.advance(200);
  controller.update("note:2");
  timers.advance(50);
  assert.deepEqual(visible, []);
  timers.advance(200);
  assert.deepEqual(visible, [true]);
  controller.update("lookup:3");
  assert.deepEqual(visible, [true, false]);
  timers.advance(250);
  assert.deepEqual(visible, [true, false, true]);
});

void test("closing the view cancels timers and prevents late visibility changes", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  const staleCallback = timers.tasks.get(1)!.callback;
  controller.close();
  staleCallback();
  controller.update("note:2");
  timers.advance(1_000);
  assert.deepEqual(visible, []);
  assert.equal(timers.tasks.size, 0);
});

void test("stale timer callbacks cannot show or cancel a newer request", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  const staleCallback = timers.tasks.get(1)!.callback;
  controller.update(null);
  controller.update("note:2");
  staleCallback();
  assert.deepEqual(visible, []);
  controller.close();
  assert.equal(timers.tasks.size, 0);
});

void test("closing an already visible indicator hides it once", () => {
  const timers = new FakeTimers();
  const visible: boolean[] = [];
  const controller = new SidebarLoadingController((value) => visible.push(value), timers);
  controller.update("note:1");
  timers.advance(250);
  controller.close();
  controller.close();
  assert.deepEqual(visible, [true, false]);
});

void test("sidebar loader reuses the existing swirl in the stable search-button slot", () => {
  const source = fs.readFileSync("src/workspaceView.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(source, /searchButton\.createSpan\(\{ cls: "mindmap-status-swirling mindmap-lookup-loading"/);
  assert.match(source, /ownerWindow\.setTimeout/);
  assert.match(source, /this\.loadingController\?\.close\(\)/);
  assert.doesNotMatch(source, /renderInlineLoadingIndicator|renderLoadingSpinner/);
  assert.doesNotMatch(css, /mindmap-inline-loading|mindmap-loading-spin/);
  assert.match(css, /\.mindmap-lookup-loading\[hidden\][\s\S]*?display: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mindmap-status-swirling::before,[\s\S]*?animation: none/);
});
