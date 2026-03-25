import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { DebouncedRefreshController, PendingIndex } from "./pendingScan";

function hashBody(text: string): string {
  return createHash("sha1").update(`${text.trim()}\n`).digest("hex");
}

test("PendingIndex rescans only changed files and recomputes counts from state without rereading", async () => {
  const index = new PendingIndex();
  const reads = new Map<string, number>();
  const contents = new Map<string, string>([
    ["Notes/one.md", "one two three"],
    ["Notes/two.md", "four five six"],
  ]);

  const buildFiles = (mtimeTwo: number) => [
    {
      relpath: "Notes/one.md",
      mtimeMs: 1,
      read: async () => {
        reads.set("Notes/one.md", (reads.get("Notes/one.md") ?? 0) + 1);
        return contents.get("Notes/one.md") ?? "";
      },
    },
    {
      relpath: "Notes/two.md",
      mtimeMs: mtimeTwo,
      read: async () => {
        reads.set("Notes/two.md", (reads.get("Notes/two.md") ?? 0) + 1);
        return contents.get("Notes/two.md") ?? "";
      },
    },
  ];

  const config = {
    currentPaths: ["Notes"],
    allPaths: ["Notes"],
    heading: "## Mindmap",
    minWords: 0,
    statePath: "/vault/.obsidian/plugins/mindmap-ai/data/state.json",
  };

  const first = await index.refresh({
    config,
    stateHashes: { "Notes/one.md": hashBody("one two three") },
    files: buildFiles(1),
    dirtyPaths: new Set<string>(),
    forceFull: true,
    now: 1,
  });

  assert.equal(first.current.total, 1);
  assert.equal(first.metrics.filesScanned, 2);
  assert.equal(reads.get("Notes/one.md"), 1);
  assert.equal(reads.get("Notes/two.md"), 1);

  const second = await index.refresh({
    config,
    stateHashes: {
      "Notes/one.md": hashBody("one two three"),
      "Notes/two.md": hashBody("four five six"),
    },
    files: buildFiles(1),
    dirtyPaths: new Set<string>(),
    forceFull: false,
    now: 2,
  });

  assert.equal(second.current.total, 0);
  assert.equal(second.metrics.filesScanned, 0);
  assert.equal(reads.get("Notes/one.md"), 1);
  assert.equal(reads.get("Notes/two.md"), 1);

  contents.set("Notes/two.md", "four five six seven");
  const third = await index.refresh({
    config,
    stateHashes: {
      "Notes/one.md": hashBody("one two three"),
      "Notes/two.md": hashBody("four five six"),
    },
    files: buildFiles(2),
    dirtyPaths: new Set<string>(["Notes/two.md"]),
    forceFull: false,
    now: 3,
  });

  assert.equal(third.current.total, 1);
  assert.equal(third.metrics.filesScanned, 1);
  assert.equal(reads.get("Notes/one.md"), 1);
  assert.equal(reads.get("Notes/two.md"), 2);
});

test("DebouncedRefreshController collapses repeated triggers into one callback", () => {
  let callbackCount = 0;
  const handles = new Set<{ run: () => void }>();
  const controller = new DebouncedRefreshController(
    (callback) => {
      const handle = { run: callback };
      handles.add(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    },
    (handle) => {
      handles.delete(handle as unknown as { run: () => void });
    },
    () => {
      callbackCount += 1;
    },
    100,
  );

  controller.trigger();
  controller.trigger();
  controller.trigger();

  assert.equal(handles.size, 1);
  const [handle] = [...handles];
  handle.run();

  assert.equal(callbackCount, 1);
  controller.dispose();
});

test("PendingIndex treats vault-root scope (.) as matching all markdown files", async () => {
  const index = new PendingIndex();
  const config = {
    currentPaths: ["."],
    allPaths: ["."],
    heading: "## Mindmap",
    minWords: 0,
    statePath: "/vault/.obsidian/plugins/mindmap-ai/data/state.json",
  };

  const snapshot = await index.refresh({
    config,
    stateHashes: {},
    files: [
      {
        relpath: "Notes/new-note.md",
        mtimeMs: 10,
        read: async () => "this note should be considered pending",
      },
    ],
    dirtyPaths: new Set<string>(),
    forceFull: true,
    now: 10,
  });

  assert.equal(snapshot.current.total, 1);
  assert.equal(snapshot.all.total, 1);
  assert.deepEqual(snapshot.current.items, ["Notes/new-note.md"]);
});
