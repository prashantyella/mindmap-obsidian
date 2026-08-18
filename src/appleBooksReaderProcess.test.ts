import test from "node:test";
import assert from "node:assert/strict";

import { APPLE_BOOKS_READER_TIMEOUT_MESSAGE, startAppleBooksReaderProcess, type ReaderChild } from "./appleBooksReaderProcess";

class FakeChild implements ReaderChild {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();
  killed = false;
  on(event: "error" | "close", listener: (value?: unknown) => void): void { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
  kill(): void { this.killed = true; }
  emit(event: "error" | "close", value?: unknown): void { for (const listener of this.listeners.get(event) ?? []) listener(value); }
}
class FakeStream {
  private readonly listeners: Array<(value: unknown) => void> = [];
  on(_event: "data", listener: (chunk: unknown) => void): void { this.listeners.push(listener); }
  emit(value: string): void { for (const listener of this.listeners) listener(value); }
}
class FakeTimer {
  callback: (() => void) | null = null;
  cleared = false;
  setTimeout(callback: () => void): number { this.callback = callback; return 1; }
  clearTimeout(): void { this.cleared = true; }
}

test("reader process resolves JSON and rejects nonzero or malformed output", async () => {
  const child = new FakeChild();
  const success = startAppleBooksReaderProcess({ spawn: () => child, timer: new FakeTimer() });
  child.stdout.emit('{"status":"success"}\n');
  child.emit("close", 0);
  assert.deepEqual(await success.promise, { status: "success" });
  const bad = new FakeChild();
  const malformed = startAppleBooksReaderProcess({ spawn: () => bad, timer: new FakeTimer() });
  bad.stdout.emit("not-json\n");
  bad.emit("close", 0);
  await assert.rejects(() => malformed.promise, /not valid JSON/);
  const nonzero = new FakeChild();
  const failed = startAppleBooksReaderProcess({ spawn: () => nonzero, timer: new FakeTimer() });
  nonzero.stderr.emit("reader failed");
  nonzero.emit("close", 2);
  await assert.rejects(() => failed.promise, /reader failed/);
});

test("reader timeout kills once, settles once, and a later reader can start", async () => {
  const timer = new FakeTimer();
  const child = new FakeChild();
  const timed = startAppleBooksReaderProcess({ spawn: () => child, timer });
  timer.callback?.();
  child.emit("close", 0);
  await assert.rejects(() => timed.promise, new RegExp(APPLE_BOOKS_READER_TIMEOUT_MESSAGE));
  assert.equal(child.killed, true);
  assert.equal(timer.cleared, true);
  const retry = new FakeChild();
  const next = startAppleBooksReaderProcess({ spawn: () => retry, timer: new FakeTimer() });
  retry.stdout.emit("{}\n");
  retry.emit("close", 0);
  assert.deepEqual(await next.promise, {});
});
