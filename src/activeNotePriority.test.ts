import test from "node:test";
import assert from "node:assert/strict";
import { ActiveNotePriority } from "./activeNotePriority";

class Timers {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.next; this.tasks.set(id, { at: this.now + ms, callback }); return id;
  }
  clearTimeout(id: unknown): void { this.tasks.delete(id as number); }
  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const due = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at; this.tasks.delete(due[0]); due[1].callback();
    }
    this.now = end;
  }
}

void test("typing is coalesced and priority waits for the latest saved version", () => {
  const timers = new Timers();
  let saved = false;
  let version = 0;
  const processed: number[] = [];
  const c = new ActiveNotePriority({ clear() {}, isSaved: () => saved, prioritize: async () => { processed.push(version); } }, timers);
  c.select("Draft.md");
  for (let i = 0; i < 10; i++) { version++; c.edited("Draft.md"); timers.advance(300); }
  assert.deepEqual(processed, []);
  timers.advance(2_000);
  assert.deepEqual(processed, [], "unsaved text must not be submitted");
  saved = true;
  timers.advance(500);
  assert.deepEqual(processed, [10]);
  c.close();
});

void test("switching notes cancels pending work and aborts stale in-flight priority", () => {
  const timers = new Timers();
  const processed: { path: string; signal: AbortSignal }[] = [];
  const c = new ActiveNotePriority({ clear() {}, isSaved: () => true, prioritize: async (path, signal) => { processed.push({ path, signal }); } }, timers);
  c.select("A.md"); timers.advance(2_000);
  c.edited("A.md");
  assert.equal(processed[0].signal.aborted, true);
  c.select("B.md"); timers.advance(2_000);
  assert.deepEqual(processed.map((item) => item.path), ["A.md", "B.md"]);
  assert.equal(processed[1].signal.aborted, false);
  c.close();
});

void test("edits in other notes and callbacks after unload cannot affect current priority", () => {
  const timers = new Timers();
  let processed = 0;
  const c = new ActiveNotePriority({ clear() {}, isSaved: () => true, prioritize: async () => { processed++; } }, timers);
  c.select("A.md");
  const stale = timers.tasks.values().next().value!.callback;
  c.edited("B.md");
  timers.advance(2_000);
  assert.equal(processed, 1);
  c.edited("A.md"); c.close(); stale(); timers.advance(5_000);
  assert.equal(processed, 1);
  assert.equal(timers.tasks.size, 0);
});
