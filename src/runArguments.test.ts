import test from "node:test";
import assert from "node:assert/strict";

import { assertSafeNoteArgument } from "./runArguments";

void test("assertSafeNoteArgument accepts a plain vault-relative markdown path", () => {
  assert.doesNotThrow(() => assertSafeNoteArgument("Notes/Example.md", ".obsidian"));
});

void test("assertSafeNoteArgument rejects absolute paths, traversal, non-markdown, and plugin-internal paths", () => {
  assert.throws(() => assertSafeNoteArgument("/etc/passwd", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument("C:/Notes/Example.md", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument("Notes/../Example.md", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument("Notes/Example.txt", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument(".obsidian/plugins/mindmap-ai/data/state.json", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument("   ", ".obsidian"));
});

void test("assertSafeNoteArgument uses the real configDir, not a blanket dot-prefix guess", () => {
  assert.doesNotThrow(() => assertSafeNoteArgument(".config-like-folder/Note.md", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument("custom-config/Note.md", "custom-config"));
});

void test("assertSafeNoteArgument rejects a leading ./ that would otherwise mask a runtime-internal target", () => {
  assert.throws(() => assertSafeNoteArgument("./.obsidian/plugins/mindmap-ai/data.md", ".obsidian"));
  assert.throws(() => assertSafeNoteArgument(".obsidian/./plugins/mindmap-ai/data.md", ".obsidian"));
});
