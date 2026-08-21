import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createReadingStateStore, type ReadingStateFileSystem } from "./readingState";
import {
  parsePythonStateHashes,
  reconcileReadingProcessedFromPythonState,
  shouldTriggerDailyReconciliation,
  type LaunchAgentDetailLike,
} from "./readingPythonReconciliation";

class MemoryStateFs implements ReadingStateFileSystem {
  readonly files = new Map<string, string>();

  async mkdir(): Promise<void> {}

  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return value;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async rename(sourcePath: string, targetPath: string): Promise<void> {
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

function pythonBodyHash(text: string): string {
  return createHash("sha1").update(`${text.trim()}\n`).digest("hex");
}

void test("matching Python body signature sets processedAt through the state store without touching the vault", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  const noteBody = "> A quote worth remembering.";
  const pythonState = JSON.stringify({ files: { "Books/Apple Books/A/B/Annotations/first.md": { hash: pythonBodyHash(noteBody) } } });

  const writes: string[] = [];
  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => pythonState,
    readNoteText: async (notePath) => {
      writes.push(notePath);
      return notePath === "Books/Apple Books/A/B/Annotations/first.md" ? noteBody : null;
    },
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.equal(result.updated, 1);

  const state = await store.load();
  assert.equal(state.annotations.first.processedAt, "2026-08-20T12:00:00Z");
  // Read-only against the vault: no note write API was ever offered or called.
  assert.deepEqual(writes, ["Books/Apple Books/A/B/Annotations/first.md"]);
});

void test("mismatched or missing Python hash leaves processedAt untouched", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  const pythonState = JSON.stringify({ files: { "Books/Apple Books/A/B/Annotations/first.md": { hash: "deadbeef".repeat(5) } } });
  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => pythonState,
    readNoteText: async () => "> A different quote now.",
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0);
  assert.equal((await store.load()).annotations.first.processedAt, null);
});

void test("already-processed entries are skipped and never re-read", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "complete",
      processedAt: "2026-08-18T00:00:00Z",
    };
  });

  let readCount = 0;
  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => JSON.stringify({ files: {} }),
    readNoteText: async () => {
      readCount += 1;
      return null;
    },
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.checked, 0);
  assert.equal(readCount, 0);
});

void test("missing Python state.json is nonfatal and leaves Reading state unchanged", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    readNoteText: async () => "> unused",
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing or malformed/i);
  assert.equal((await store.load()).annotations.first.processedAt, null);
});

void test("malformed Python state.json JSON is nonfatal and actionable", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);

  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => "{not valid json",
    readNoteText: async () => "> unused",
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing or malformed/i);
});

void test("a Reading note missing from the vault is skipped without throwing", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/gone.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => JSON.stringify({ files: { "Books/Apple Books/A/B/Annotations/gone.md": { hash: "deadbeef".repeat(5) } } }),
    readNoteText: async () => null,
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0);
});

void test("parsePythonStateHashes rejects structurally malformed shapes", () => {
  assert.equal(parsePythonStateHashes(null), null);
  assert.equal(parsePythonStateHashes("not an object"), null);
  assert.equal(parsePythonStateHashes([]), null);
  assert.equal(parsePythonStateHashes({}), null, "missing `files` is malformed");
  assert.equal(parsePythonStateHashes({ files: "not an object" }), null);
  assert.equal(parsePythonStateHashes({ files: [] }), null);
  assert.equal(parsePythonStateHashes({ files: { "a.md": "not an object" } }), null);
  assert.equal(parsePythonStateHashes({ files: { "a.md": { hash: 123 } } }), null, "non-string hash is malformed");
  assert.equal(parsePythonStateHashes({ files: { "a.md": {} } }), null, "missing hash is malformed");
  assert.deepEqual(parsePythonStateHashes({ files: {} }), {}, "an explicitly empty files map is valid, not malformed");
  const validSha1 = "deadbeef".repeat(5);
  assert.deepEqual(parsePythonStateHashes({ files: { "a.md": { hash: validSha1 } } }), { "a.md": validSha1 });
});

void test("parsePythonStateHashes rejects a hash that is not a well-formed SHA-1 hex digest", () => {
  for (const badHash of [
    "abc",
    "not-a-hash",
    "deadbeef".repeat(5).slice(0, 39),
    `${"deadbeef".repeat(4)}${"g".repeat(8)}`,
    `${"deadbeef".repeat(5)}extra`,
    "",
    " ".repeat(40),
    "g".repeat(40),
  ]) {
    assert.equal(parsePythonStateHashes({ files: { "a.md": { hash: badHash } } }), null, `expected rejection for hash ${JSON.stringify(badHash)}`);
  }
  // Case-insensitive uppercase hex is still a valid signature.
  assert.deepEqual(
    parsePythonStateHashes({ files: { "a.md": { hash: "DEADBEEF".repeat(5) } } }),
    { "a.md": "DEADBEEF".repeat(5) },
  );
});

void test("a top-level files map that is non-object, or contains one malformed entry, fails the whole reconciliation", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/first.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  for (const malformed of [
    JSON.stringify({ files: "nope" }),
    JSON.stringify({ files: { "Books/Apple Books/A/B/Annotations/first.md": { hash: 42 } } }),
    JSON.stringify({}),
  ]) {
    const result = await reconcileReadingProcessedFromPythonState(store, {
      readPythonStateText: async () => malformed,
      readNoteText: async () => "> unused",
      now: () => "2026-08-20T12:00:00Z",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed/i);
  }

  assert.equal((await store.load()).annotations.first.processedAt, null);
});

void test("vault reads happen before the brief mutate() pass, not inside a long-held mutation", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.a = {
      contentHash: "a", notePath: "Books/Apple Books/A/B/Annotations/a.md", importedAt: "t", researchStatus: "off", processedAt: null,
    };
    state.annotations.b = {
      contentHash: "b", notePath: "Books/Apple Books/A/B/Annotations/b.md", importedAt: "t", researchStatus: "off", processedAt: null,
    };
  });

  const noteBody = "> quote";
  const hash = createHash("sha1").update(`${noteBody}\n`).digest("hex");
  const pythonState = JSON.stringify({
    files: {
      "Books/Apple Books/A/B/Annotations/a.md": { hash },
      "Books/Apple Books/A/B/Annotations/b.md": { hash },
    },
  });

  const events: string[] = [];
  const trackedStore: typeof store = {
    load: store.load,
    save: store.save,
    mutate: (fn) => {
      events.push("mutate-start");
      return store.mutate(fn);
    },
  };

  await reconcileReadingProcessedFromPythonState(trackedStore, {
    readPythonStateText: async () => pythonState,
    readNoteText: async (notePath) => {
      events.push(`read:${notePath}`);
      return noteBody;
    },
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.deepEqual(events, [
    "read:Books/Apple Books/A/B/Annotations/a.md",
    "read:Books/Apple Books/A/B/Annotations/b.md",
    "mutate-start",
  ]);
});

void test("mutate pass revalidates notePath before marking processedAt, skipping a note renamed during the read pass", async () => {
  const fs = new MemoryStateFs();
  const store = createReadingStateStore("runtime/reading-state.json", fs);
  await store.mutate((state) => {
    state.annotations.first = {
      contentHash: "hash-first",
      notePath: "Books/Apple Books/A/B/Annotations/original.md",
      importedAt: "2026-08-17T00:00:00Z",
      researchStatus: "off",
      processedAt: null,
    };
  });

  const noteBody = "> A quote.";
  const pythonState = JSON.stringify({ files: { "Books/Apple Books/A/B/Annotations/original.md": { hash: createHash("sha1").update(`${noteBody}\n`).digest("hex") } } });

  const result = await reconcileReadingProcessedFromPythonState(store, {
    readPythonStateText: async () => pythonState,
    readNoteText: async () => {
      // Simulate a rename racing the reconciliation pass: by the time the
      // read resolves, the entry's notePath in the store has moved on.
      await store.mutate((state) => {
        state.annotations.first.notePath = "Books/Apple Books/A/B/Annotations/renamed.md";
      });
      return noteBody;
    },
    now: () => "2026-08-20T12:00:00Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 0, "the renamed entry must not be marked processed against the stale path it was read under");
  const state = await store.load();
  assert.equal(state.annotations.first.processedAt, null);
  assert.equal(state.annotations.first.notePath, "Books/Apple Books/A/B/Annotations/renamed.md");
});

void test("shouldTriggerDailyReconciliation only reacts to the daily LaunchAgent detail, never weekly or an aggregate", () => {
  const details: LaunchAgentDetailLike[] = [
    { label: "com.mindmap.daily", lastSuccessfulRunAt: null },
    { label: "com.mindmap.weekly", lastSuccessfulRunAt: 500 },
  ];
  const decision = shouldTriggerDailyReconciliation(
    details,
    "com.mindmap.daily",
    { lastReconciledDailySuccessAt: null, lastReconciliationFailureAt: null },
    1000,
    1800000,
  );
  assert.equal(decision.trigger, false, "a weekly success must never trigger reconciliation");
  assert.equal(decision.dailySuccessAt, null);
});

void test("shouldTriggerDailyReconciliation triggers once per newly observed daily success and then holds until it advances again", () => {
  const details: LaunchAgentDetailLike[] = [{ label: "com.mindmap.daily", lastSuccessfulRunAt: 100 }];
  const first = shouldTriggerDailyReconciliation(details, "com.mindmap.daily", { lastReconciledDailySuccessAt: null, lastReconciliationFailureAt: null }, 1000, 1800000);
  assert.equal(first.trigger, true);
  assert.equal(first.dailySuccessAt, 100);

  const second = shouldTriggerDailyReconciliation(details, "com.mindmap.daily", { lastReconciledDailySuccessAt: 100, lastReconciliationFailureAt: null }, 2000, 1800000);
  assert.equal(second.trigger, false, "already-reconciled daily success must not retrigger");
});

void test("shouldTriggerDailyReconciliation suppresses retries during the failure cooldown, then allows retry after it elapses", () => {
  const details: LaunchAgentDetailLike[] = [{ label: "com.mindmap.daily", lastSuccessfulRunAt: 100 }];
  const cooldownMs = 1800000;
  const watermark = { lastReconciledDailySuccessAt: null, lastReconciliationFailureAt: 5000 };

  const duringCooldown = shouldTriggerDailyReconciliation(details, "com.mindmap.daily", watermark, 5000 + cooldownMs - 1, cooldownMs);
  assert.equal(duringCooldown.trigger, false, "must not retry-spam within the cooldown window");

  const afterCooldown = shouldTriggerDailyReconciliation(details, "com.mindmap.daily", watermark, 5000 + cooldownMs + 1, cooldownMs);
  assert.equal(afterCooldown.trigger, true, "retry is allowed once the cooldown has elapsed");
});
