import test from "node:test";
import assert from "node:assert/strict";

import { assertAllowedPluginArgs } from "./runArguments";

void test("assertAllowedPluginArgs accepts allowlisted flags", () => {
  assert.doesNotThrow(() => {
    assertAllowedPluginArgs(["--current", "--apply"]);
  });
});

void test("assertAllowedPluginArgs rejects unexpected flags", () => {
  assert.throws(() => {
    assertAllowedPluginArgs(["--current", "--rm-all"]);
  }, /Blocked unexpected Mindmap CLI argument/);
});

void test("assertAllowedPluginArgs validates individual note values", () => {
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--note", "Notes/one.md", "--apply", "--index", "--tag", "--quiet"]));
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--note=Notes/-draft.md", "--apply"]));
  assert.throws(() => assertAllowedPluginArgs(["--note", "../outside.md"]), /traversal/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", "/vault/one.md"]), /vault-relative/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", ".obsidian/plugins/mindmap-ai/data.md"]), /runtime/i);
  assert.throws(() => assertAllowedPluginArgs(["--note", "Notes/one.txt"]), /Markdown/i);
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
    assert.throws(() => assertAllowedPluginArgs(args));
  }
});

void test("assertAllowedPluginArgs accepts --include-reading-pending only with --all --apply maintenance", () => {
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--all", "--apply", "--include-reading-pending"]));
  assert.doesNotThrow(() => assertAllowedPluginArgs(["--all", "--apply", "--include-reading-pending", "--tag", "--index", "--quiet"]));
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
    assert.throws(() => assertAllowedPluginArgs(args), /Blocked incompatible Mindmap CLI arguments/);
  }
});
