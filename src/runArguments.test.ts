import test from "node:test";
import assert from "node:assert/strict";

import { assertAllowedPluginArgs } from "./runArguments";

void test("assertAllowedPluginArgs accepts allowlisted flags", () => {
  assert.doesNotThrow(() => {
    assertAllowedPluginArgs(["--current", "--apply"], ".obsidian");
  });
});

void test("assertAllowedPluginArgs rejects unexpected flags", () => {
  assert.throws(() => {
    assertAllowedPluginArgs(["--current", "--rm-all"], ".obsidian");
  }, /Blocked unexpected Mindmap CLI argument/);
});

void test("assertAllowedPluginArgs validates individual note values", () => {
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--note", "Notes/one.md", "--apply", "--index", "--tag", "--quiet"], ".obsidian"));
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--note=Notes/-draft.md", "--apply"], ".obsidian"));
  assert.throws(() => assertAllowedPluginArgs(["--note", "../outside.md"], ".obsidian"), /traversal/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", "/vault/one.md"], ".obsidian"), /vault-relative/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", ".obsidian/plugins/mindmap-ai/data.md"], ".obsidian"), /runtime/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", "Notes/one.txt"], ".obsidian"), /Markdown/i);
});

void test("assertAllowedPluginArgs rejects a leading ./ that would otherwise mask a runtime-internal target", () => {
  assert.throws(() => assertAllowedPluginArgs(["--note", "./.obsidian/plugins/mindmap-ai/data.md"], ".obsidian"), /runtime/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", ".obsidian/./plugins/mindmap-ai/data.md"], ".obsidian"), /runtime/i);
});

void test("assertAllowedPluginArgs uses the real configDir, not a blanket dot-prefix guess", () => {
  // Vault#configDir is user-configurable; the exact configured root and its
  // descendants must be rejected, whatever its name.
  assert.throws(() => assertAllowedPluginArgs(["--note", "Config/plugins/mindmap-ai/data.md"], "Config"), /runtime/i);
  // A hidden-looking folder unrelated to the actual configDir must remain
  // allowed -- users may legitimately keep notes under e.g. ".journal".
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--note", ".journal/Note.md"], "Config"));
});

void test("assertAllowedPluginArgs rejects repeated and incompatible individual note flags", () => {
  for (const args of [
    ["--note", "Notes/one.md", "--note", "Notes/two.md"],
    ["--note=", "--apply"],
    ["--note=../outside.md", "--apply"],
    ["--note=Notes/one.md", "--current"],
    ["--note", "Notes/one.md", "--current"],
    ["--note", "Notes/one.md", "--all"],
    ["--note", "Notes/one.md", "--refresh-all"],
    ["--note", "Notes/one.md", "--rebuild"],
    ["--note", "Notes/one.md", "--apply-preview"],
    ["--note", "Notes/one.md", "--limit", "1"],
  ]) {
    assert.throws(() => assertAllowedPluginArgs(args, ".obsidian"));
  }
});

void test("assertAllowedPluginArgs accepts --include-reading-pending only with --all --apply maintenance", () => {
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--all", "--apply", "--include-reading-pending"], ".obsidian"));
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--all", "--apply", "--include-reading-pending", "--tag", "--index", "--quiet"], ".obsidian"));
});

void test("assertAllowedPluginArgs rejects invalid --include-reading-pending combinations", () => {
  for (const args of [
    ["--apply", "--include-reading-pending"],
    ["--all", "--include-reading-pending"],
    ["--all", "--apply", "--include-reading-pending", "--current"],
    ["--note", "Notes/one.md", "--include-reading-pending"],
    ["--all", "--apply", "--include-reading-pending", "--refresh-all"],
    ["--all", "--apply", "--include-reading-pending", "--rebuild"],
    ["--all", "--apply", "--include-reading-pending", "--preview"],
    ["--all", "--apply", "--include-reading-pending", "--apply-preview"],
  ]) {
    assert.throws(() => assertAllowedPluginArgs(args, ".obsidian"), /Blocked incompatible Mindmap CLI arguments/);
  }
});
