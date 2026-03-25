import test from "node:test";
import assert from "node:assert/strict";

import { getRunProfile } from "./runProfiles";

void test("getRunProfile returns current-scope apply arguments", () => {
  assert.deepEqual(getRunProfile("current"), {
    args: ["--current", "--apply"],
    label: "current scope",
  });
});

void test("getRunProfile returns all-scope apply arguments", () => {
  assert.deepEqual(getRunProfile("all"), {
    args: ["--all", "--apply"],
    label: "all scopes",
  });
});
