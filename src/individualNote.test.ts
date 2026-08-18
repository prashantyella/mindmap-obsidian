import test from "node:test";
import assert from "node:assert/strict";
import type MindmapPlugin from "./main";
import { resolveActiveNoteEligibility } from "./individualNoteActions";

import {
  APPLE_BOOKS_ANNOTATION_MIN_WORDS,
  assessActiveNote,
  isSafeIndividualNotePath,
  minimumWordsForNote,
} from "./individualNote";

void test("individual note path validation rejects absolute, traversal, runtime, and non-markdown paths", () => {
  assert.equal(isSafeIndividualNotePath("Notes/valid.md"), true);
  assert.equal(isSafeIndividualNotePath("../outside.md"), false);
  assert.equal(isSafeIndividualNotePath("/vault/valid.md"), false);
  assert.equal(isSafeIndividualNotePath("C:\\vault\\valid.md"), false);
  assert.equal(isSafeIndividualNotePath(".obsidian/plugins/mindmap-ai/runtime.md"), false);
  assert.equal(isSafeIndividualNotePath("Notes/valid.txt"), false);
});

void test("active non-Markdown files are rejected before cachedRead", async () => {
  let cachedReadCalls = 0;
  const plugin = {
    app: {
      workspace: {
        getActiveFile: () => ({ path: "Notes/image.png", extension: "png" }),
      },
      vault: {
        cachedRead: async () => {
          cachedReadCalls += 1;
          throw new Error("cachedRead should not be called for non-Markdown files");
        },
      },
    },
  } as unknown as MindmapPlugin;

  const result = await resolveActiveNoteEligibility(plugin);

  assert.equal(result.code, "not-markdown");
  assert.equal(result.eligible, false);
  assert.equal(cachedReadCalls, 0);
});

void test("active note scope and thresholds are explicit", () => {
  const ordinary = "one two three four five";
  const annotation = "---\ntype: apple-books-annotation\n---\nquote one two three four five six";

  assert.equal(minimumWordsForNote(ordinary, 30), 30);
  assert.equal(minimumWordsForNote(annotation, 30), APPLE_BOOKS_ANNOTATION_MIN_WORDS);
  assert.equal(assessActiveNote("Other/note.md", ordinary, { allScopeFolders: ["Notes"], minimumWords: 1 }).code, "out-of-scope");
  assert.equal(assessActiveNote(".obsidian/plugins/mindmap-ai/runtime.md", ordinary, { allScopeFolders: ["."], minimumWords: 1 }).code, "runtime-internal");
  assert.equal(assessActiveNote("Notes/note.md", annotation, { allScopeFolders: ["Notes"], minimumWords: 30 }).code, "too-short");
  assert.equal(assessActiveNote("Notes/empty.md", "", { allScopeFolders: ["Notes"], minimumWords: 1 }).code, "too-short");
  assert.equal(assessActiveNote("Notes/note.md", `${annotation} seven eight`, { allScopeFolders: ["Notes"], minimumWords: 30 }).eligible, true);
});

void test("Reading-root Apple annotations are eligible outside all scope while spoofed and ordinary notes remain blocked", () => {
  const annotation = "---\ntype: apple-books-annotation\n---\none two three four five six seven eight";
  assert.equal(assessActiveNote("Books/Apple Books/Author/Book/Annotations/note.md", annotation, { allScopeFolders: ["Notes"], minimumWords: 30 }).eligible, true);
  assert.equal(assessActiveNote("Books/Apple Books/Author/Book/Annotations/note.md", "---\ntype: note\n---\none two three four five six seven eight", { allScopeFolders: ["Notes"], minimumWords: 1 }).code, "out-of-scope");
  assert.equal(assessActiveNote("Books/Apple Books Spoof/note.md", annotation, { allScopeFolders: ["Notes"], minimumWords: 1 }).code, "out-of-scope");
  assert.equal(assessActiveNote("Other/note.md", annotation, { allScopeFolders: ["Notes"], minimumWords: 1 }).code, "out-of-scope");
});
