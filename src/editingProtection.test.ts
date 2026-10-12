import test from "node:test";
import assert from "node:assert/strict";

import { EditingProtection, type EditingProtectionClock, type EditorSnapshot } from "./editingProtection";

class FakeClock implements EditingProtectionClock {
  nowMs = 0;
  id = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.nowMs; }
  setTimeout(callback: () => void, delayMs: number): unknown { const id = ++this.id; this.tasks.set(id, { at: this.nowMs + delayMs, callback }); return id; }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  advance(ms: number): void { this.nowMs += ms; for (const [id, task] of [...this.tasks]) if (task.at <= this.nowMs) { this.tasks.delete(id); task.callback(); } }
}

void test("recent edits and unsaved secondary panes protect a note", () => {
  const clock = new FakeClock();
  let snapshots: EditorSnapshot[] = [];
  const protection = new EditingProtection(() => snapshots, clock);
  protection.recordEdit("Note.md");
  clock.advance(1_999);
  assert.equal(protection.isProtected("Note.md"), true);
  clock.advance(1);
  assert.equal(protection.isProtected("Note.md"), false);
  snapshots = [{ path: "Note.md", focused: false, unsaved: true }];
  assert.equal(protection.isProtected("Note.md"), true);
  snapshots = [{ path: "Note.md", focused: false, unsaved: false }];
  assert.equal(protection.isProtected("Note.md"), false);
});

void test("reading panes do not protect, renames follow edits, idle wakes once, and dispose cancels", () => {
  const clock = new FakeClock();
  const protection = new EditingProtection(() => [], clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  protection.recordEdit("Old.md");
  protection.rename("Old.md", "New.md");
  assert.equal(protection.isProtected("Old.md"), false);
  assert.equal(protection.isProtected("New.md"), true);
  clock.advance(2_000);
  assert.equal(wakes, 1);
  protection.recordEdit("Again.md");
  protection.dispose();
  clock.advance(2_000);
  assert.equal(wakes, 1);
});

void test("a focused, saved note becomes safe after typing is idle", () => {
  const clock = new FakeClock();
  const snapshots: EditorSnapshot[] = [{ path: "Focused.md", focused: true, unsaved: false, content: "saved" }];
  const protection = new EditingProtection(() => snapshots, clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  protection.recordEdit("Focused.md");
  assert.equal(protection.isProtected("Focused.md", "saved"), true);
  clock.advance(2_000);
  assert.equal(wakes, 1);
  assert.equal(protection.isProtected("Focused.md", "saved"), false);
});

void test("typing again restarts the idle transition", () => {
  const clock = new FakeClock();
  const snapshots: EditorSnapshot[] = [{ path: "Focused.md", focused: true, unsaved: false, content: "saved" }];
  const protection = new EditingProtection(() => snapshots, clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  protection.recordEdit("Focused.md");
  assert.equal(protection.isProtected("Focused.md", "saved"), true);
  clock.advance(1_500);
  protection.recordEdit("Focused.md");
  clock.advance(500);
  assert.equal(wakes, 0);
  assert.equal(protection.isProtected("Focused.md", "saved"), true);
  clock.advance(1_500);
  assert.equal(wakes, 1);
});

void test("unsaved and mismatching buffers remain protected until matching content is saved", () => {
  const clock = new FakeClock();
  const snapshots: EditorSnapshot[] = [{ path: "Other.md", focused: true, unsaved: true, content: "new buffer" }];
  const protection = new EditingProtection(() => snapshots, clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  assert.equal(protection.isProtected("Other.md", "old disk source"), true);
  snapshots[0] = { path: "Other.md", focused: true, unsaved: false, content: "new buffer" };
  protection.refresh();
  assert.equal(wakes, 0);
  protection.recordSaved("Other.md", "new buffer");
  assert.equal(wakes, 1);
  assert.equal(protection.isProtected("Other.md", "new buffer"), false);
  protection.dispose();
});

void test("dispose cancels a pending idle wake and removes subscriptions", () => {
  const clock = new FakeClock();
  const protection = new EditingProtection(() => [], clock);
  let wakes = 0;
  const unsubscribe = protection.subscribeSafeTransition(() => { wakes += 1; });
  protection.recordEdit("Note.md");
  assert.equal(protection.isProtected("Note.md"), true);
  protection.dispose();
  unsubscribe();
  clock.advance(2_000);
  protection.refresh();
  assert.equal(wakes, 0);
  assert.equal(clock.tasks.size, 0);
});
