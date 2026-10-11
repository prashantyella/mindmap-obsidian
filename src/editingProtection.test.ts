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

void test("recent edits, focused panes, and unsaved secondary panes protect a note", () => {
  const clock = new FakeClock();
  let snapshots: EditorSnapshot[] = [];
  const protection = new EditingProtection(() => snapshots, clock);
  protection.recordEdit("Note.md");
  clock.advance(1_999);
  assert.equal(protection.isProtected("Note.md"), true);
  clock.advance(1);
  assert.equal(protection.isProtected("Note.md"), false);
  snapshots = [{ path: "Note.md", focused: true, unsaved: false }];
  assert.equal(protection.isProtected("Note.md"), true);
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

void test("focus-only protection wakes after blur even without a recent edit", () => {
  const clock = new FakeClock();
  let snapshots: EditorSnapshot[] = [{ path: "Focused.md", focused: true, unsaved: false }];
  const protection = new EditingProtection(() => snapshots, clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  assert.equal(protection.isProtected("Focused.md"), true);
  snapshots = [{ path: "Focused.md", focused: false, unsaved: false }];
  protection.refresh();
  assert.equal(wakes, 1);
});

void test("final saved-source comparison protects an unfocused buffer until its save commits", () => {
  const clock = new FakeClock();
  const snapshots: EditorSnapshot[] = [{ path: "Other.md", focused: false, unsaved: false, content: "new buffer" }];
  const protection = new EditingProtection(() => snapshots, clock);
  let wakes = 0;
  protection.subscribeSafeTransition(() => { wakes += 1; });
  assert.equal(protection.isProtected("Other.md", "old disk source"), true);
  protection.refresh();
  assert.equal(wakes, 0);
  protection.recordSaved("Other.md", "new buffer");
  assert.equal(wakes, 1);
  assert.equal(protection.isProtected("Other.md", "new buffer"), false);
  protection.dispose();
});
