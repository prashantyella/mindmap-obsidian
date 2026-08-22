import test from "node:test";
import assert from "node:assert/strict";

import { bindCommitOnBlurOrEnter } from "./commitOnBlur";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeInput {
  value: string;
  blurCalls = 0;
  private readonly listeners: Record<string, Array<(event: { key?: string; preventDefault?(): void }) => void>> = { blur: [], keydown: [] };

  constructor(initialValue: string) {
    this.value = initialValue;
  }

  addEventListener(type: "blur" | "keydown", listener: (event: { key?: string; preventDefault?(): void }) => void): void {
    this.listeners[type].push(listener);
  }

  blur(): void {
    this.blurCalls += 1;
    for (const listener of this.listeners.blur) {
      listener({});
    }
  }

  pressEnter(): void {
    this.pressKey("Enter");
  }

  pressKey(key: string): void {
    for (const listener of this.listeners.keydown) {
      listener({ key, preventDefault: () => {} });
    }
  }

  typeUnfocused(next: string): void {
    // Simulates keystrokes without ever firing blur/Enter.
    this.value = next;
  }
}

void test("no commit fires per keystroke; only on blur", () => {
  const input = new FakeInput("initial");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "initial", (value) => { commits.push(value); });

  input.typeUnfocused("i");
  input.typeUnfocused("in");
  input.typeUnfocused("initial-value");
  assert.deepEqual(commits, []);

  input.blur();
  assert.deepEqual(commits, ["initial-value"]);
});

void test("Enter commits immediately and blurs the field", () => {
  const input = new FakeInput("initial");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "initial", (value) => { commits.push(value); });

  input.typeUnfocused("changed");
  input.pressEnter();

  assert.deepEqual(commits, ["changed"]);
  assert.equal(input.blurCalls, 1);
});

void test("Enter followed by the resulting blur commits exactly once, not twice", () => {
  const input = new FakeInput("initial");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "initial", (value) => { commits.push(value); });

  input.typeUnfocused("changed");
  input.pressEnter(); // commits, then calls input.blur() -> fires the blur listener too

  assert.deepEqual(commits, ["changed"]);
});

void test("committing an unchanged value is a no-op", () => {
  const input = new FakeInput("same");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "same", (value) => { commits.push(value); });

  input.blur();
  input.pressEnter();

  assert.deepEqual(commits, []);
});

void test("a later distinct value after a committed one still commits", () => {
  const input = new FakeInput("initial");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "initial", (value) => { commits.push(value); });

  input.typeUnfocused("first");
  input.blur();
  input.typeUnfocused("second");
  input.blur();

  assert.deepEqual(commits, ["first", "second"]);
});

void test("non-Enter keydown events never commit", () => {
  const input = new FakeInput("initial");
  const commits: string[] = [];
  bindCommitOnBlurOrEnter(input, "initial", (value) => { commits.push(value); });

  input.typeUnfocused("changed");
  input.pressKey("a");

  assert.deepEqual(commits, []);
});

void test("a commit that throws does not advance lastCommitted, so the same value can be retried", async () => {
  const input = new FakeInput("initial");
  const attempts: string[] = [];
  let shouldThrow = true;
  bindCommitOnBlurOrEnter(input, "initial", (value) => {
    attempts.push(value);
    if (shouldThrow) {
      throw new Error("save failed");
    }
  });

  input.typeUnfocused("changed");
  input.blur();
  await flush();
  // First attempt failed; blurring again with the same (still-uncommitted) value must retry, not dedupe.
  shouldThrow = false;
  input.blur();
  await flush();

  assert.deepEqual(attempts, ["changed", "changed"]);
});

void test("a commit that returns false does not advance lastCommitted, so the same value can be retried", async () => {
  const input = new FakeInput("initial");
  const attempts: string[] = [];
  let succeed = false;
  bindCommitOnBlurOrEnter(input, "initial", (value) => {
    attempts.push(value);
    return succeed;
  });

  input.typeUnfocused("changed");
  input.blur();
  await flush();
  succeed = true;
  input.blur();
  await flush();

  assert.deepEqual(attempts, ["changed", "changed"]);
});

void test("a rejected async commit does not advance lastCommitted, so the same value can be retried", async () => {
  const input = new FakeInput("initial");
  const attempts: string[] = [];
  let shouldReject = true;
  bindCommitOnBlurOrEnter(input, "initial", async (value) => {
    attempts.push(value);
    if (shouldReject) {
      throw new Error("async save failed");
    }
  });

  input.typeUnfocused("changed");
  input.blur();
  await flush();
  shouldReject = false;
  input.blur();
  await flush();

  assert.deepEqual(attempts, ["changed", "changed"]);
});

void test("a successful async commit only advances lastCommitted after it resolves, and then dedupes", async () => {
  const input = new FakeInput("initial");
  const attempts: string[] = [];
  let resolveCommit!: () => void;
  bindCommitOnBlurOrEnter(input, "initial", (value) => {
    attempts.push(value);
    return new Promise<void>((resolve) => { resolveCommit = resolve; });
  });

  input.typeUnfocused("changed");
  input.blur();
  assert.deepEqual(attempts, ["changed"]);

  resolveCommit();
  await flush();

  // Now committed; blurring again with the same value must not re-commit.
  input.blur();
  assert.deepEqual(attempts, ["changed"]);
});

void test("Enter immediately followed by its own blur coalesces into one in-flight call for the same value", async () => {
  const input = new FakeInput("initial");
  const attempts: string[] = [];
  let resolveCommit!: () => void;
  bindCommitOnBlurOrEnter(input, "initial", (value) => {
    attempts.push(value);
    return new Promise<void>((resolve) => { resolveCommit = resolve; });
  });

  input.typeUnfocused("changed");
  input.pressEnter(); // commits (starts an in-flight promise), then calls input.blur() synchronously

  // Only one call should have started, even though both Enter and the blur it triggers call commitNow().
  assert.deepEqual(attempts, ["changed"]);

  resolveCommit();
  await flush();
  assert.deepEqual(attempts, ["changed"]);
});
