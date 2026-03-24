import test from "node:test";
import assert from "node:assert/strict";

import { assertAllowedPluginArgs } from "./runArguments";

test("assertAllowedPluginArgs accepts allowlisted flags", () => {
  assert.doesNotThrow(() => {
    assertAllowedPluginArgs(["--current", "--apply"]);
  });
});

test("assertAllowedPluginArgs rejects unexpected flags", () => {
  assert.throws(() => {
    assertAllowedPluginArgs(["--current", "--rm-all"]);
  }, /Blocked unexpected Mindmap CLI argument/);
});
