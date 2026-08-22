import test from "node:test";
import assert from "node:assert/strict";
import type MindmapPlugin from "./main";
import { resolveActiveNoteEligibility } from "./individualNoteActions";

import {
  APPLE_BOOKS_ANNOTATION_MIN_WORDS,
  assessActiveNote,
  isGeneratedReadingIndex,
  isManagedReadingArtifact,
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

void test("generated book indexes are classified by path and complete marker pair, and are never eligible for individual processing", () => {
  const indexPath = "Books/Apple Books/Author/Book/Index.md";
  const markerStart = "<!-- mindmap:apple-books-index:start -->";
  const markerEnd = "<!-- mindmap:apple-books-index:end -->";
  const completeIndex = `${markerStart}\n## Apple Books Annotations\n${markerEnd}\n`;

  assert.equal(isGeneratedReadingIndex(indexPath, completeIndex), true);
  assert.equal(isManagedReadingArtifact(indexPath, completeIndex), true);
  // Only the start marker present: not a complete managed pair.
  assert.equal(isGeneratedReadingIndex(indexPath, `${markerStart}\nnotes\n`), false);
  // An unrelated Index.md at the same location without both markers remains an ordinary note.
  assert.equal(isGeneratedReadingIndex(indexPath, "# My own index\nSome content."), false);
  // Same markers but the wrong structural location (not directly under a book folder) do not classify as generated.
  assert.equal(isGeneratedReadingIndex("Books/Apple Books/Author/Book/Annotations/Index.md", completeIndex), false);
  assert.equal(isGeneratedReadingIndex("Books/Other/Index.md", completeIndex), false);

  assert.equal(assessActiveNote(indexPath, completeIndex, { allScopeFolders: ["."], minimumWords: 1 }).code, "generated-index");
  assert.equal(assessActiveNote(indexPath, completeIndex, { allScopeFolders: ["."], minimumWords: 1 }).eligible, false);

  // Reversed order (end before start): not a complete pair; remains ordinary.
  assert.equal(isGeneratedReadingIndex(indexPath, `${markerEnd}\nnotes\n${markerStart}`), false);
  // Duplicate start marker: not a complete pair; remains ordinary.
  assert.equal(isGeneratedReadingIndex(indexPath, `${markerStart}\n${markerStart}\n${markerEnd}`), false);
  // Duplicate end marker: not a complete pair; remains ordinary.
  assert.equal(isGeneratedReadingIndex(indexPath, `${markerStart}\n${markerEnd}\n${markerEnd}`), false);
  // Orphan end marker only: not a complete pair; remains ordinary.
  assert.equal(isGeneratedReadingIndex(indexPath, `notes\n${markerEnd}`), false);
});
