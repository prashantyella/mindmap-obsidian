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
