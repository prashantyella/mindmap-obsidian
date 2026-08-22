import test from "node:test";
import assert from "node:assert/strict";

import {
  createReadingStateStore,
  serializeReadingState,
  type ReadingStateFileSystem,
} from "./readingState";
import { createEmptyReadingState, parseReadingState } from "./readingTypes";

class MemoryStateFs implements ReadingStateFileSystem {
  readonly files = new Map<string, string>();
  failWrite = false;
  failRename = false;

  async mkdir(): Promise<void> {}

  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return value;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (this.failWrite) {
      throw new Error("write failed");
    }
    this.files.set(filePath, content);
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
    if (this.failRename) {
      throw new Error("rename failed");
    }
    const content = this.files.get(sourcePath);
    if (content === undefined) {
      throw new Error("temporary state missing");
    }
    this.files.set(targetPath, content);
    this.files.delete(sourcePath);
  }

  async unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

test("state store loads empty state and serializes versioned state atomically", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  const state = await store.load();
  state.lastSyncAt = "2026-08-17T00:00:00Z";
  await store.save(state);

  assert.equal(JSON.parse(fs.files.get("runtime/reading-state.json") ?? "{}").version, 1);
  assert.equal(fs.files.has("runtime/reading-state.json.tmp"), false);
  assert.equal((await store.load()).lastSyncAt, "2026-08-17T00:00:00Z");
});

test("write failure and rename failure never replace the committed state", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  const initial = createEmptyReadingState();
  initial.lastSyncAt = "before";
  await store.save(initial);

  const changed = { ...initial, lastSyncAt: "after" };
  fs.failWrite = true;
  await assert.rejects(() => store.save(changed), /write failed/);
  assert.equal((await store.load()).lastSyncAt, "before");

  fs.failWrite = false;
  fs.failRename = true;
  await assert.rejects(() => store.save(changed), /rename failed/);
  assert.equal((await store.load()).lastSyncAt, "before");
  assert.equal(fs.files.has("runtime/reading-state.json.tmp"), false);
});

test("concurrent mutate() calls queue instead of losing one another's updates", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);

  // Both mutations start from a load() that resolves before either has
  // saved, which is exactly the interleaving that a bare load()/save()
  // pair at each call site would lose: whichever save() lands last would
  // silently discard the other's change.
  const first = store.mutate(async (state) => {
    await Promise.resolve();
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });
  const second = store.mutate(async (state) => {
    state.annotations.second = {
      contentHash: "hash-second",
      notePath: "Books/Apple Books/A/B/Annotations/second.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  await Promise.all([first, second]);

  const state = await store.load();
  assert.ok(state.annotations.first, "first mutation must not be lost");
  assert.ok(state.annotations.second, "second mutation must not be lost");
});

test("state parser rejects unsafe or malformed entries", () => {
  assert.throws(() => parseReadingState({
    version: 1,
    lastSyncAt: null,
    annotations: {
      bad: {
        contentHash: "hash",
        notePath: ".obsidian/runtime.md",
        importedAt: "now",
        researchStatus: "off",
        processedAt: null,
      },
    },
  }), /annotation bad is malformed/);
  assert.match(serializeReadingState(createEmptyReadingState()), /"version": 1/);
});
