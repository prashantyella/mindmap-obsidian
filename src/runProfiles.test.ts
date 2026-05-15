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

void test("getRunProfile returns all-scope full refresh arguments", () => {
  assert.deepEqual(getRunProfile("refreshAll"), {
    args: ["--all", "--refresh-all", "--apply"],
    label: "all scopes full refresh",
  });
});

void test("getRunProfile returns all-scope full rebuild arguments", () => {
  assert.deepEqual(getRunProfile("rebuildAll"), {
    args: ["--all", "--refresh-all", "--rebuild", "--apply"],
    label: "all scopes full rebuild",
  });
});
