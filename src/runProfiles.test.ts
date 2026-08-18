import test from "node:test";
import assert from "node:assert/strict";

import { getRunProfile } from "./runProfiles";

void test("getRunProfile returns current-scope apply arguments", () => {
  assert.deepEqual(getRunProfile("current"), {
    args: ["--current", "--apply"],
    label: "current scope",
  });
});

void test("getRunProfile returns one-note apply arguments", () => {
  assert.deepEqual(getRunProfile("note", "Notes/one.md"), {
    args: ["--note=Notes/one.md", "--apply"],
    label: "individual note Notes/one.md",
  });
});

void test("getRunProfile returns all-scope apply arguments", () => {
  assert.deepEqual(getRunProfile("all"), {
    args: ["--all", "--apply"],
    label: "all scopes",
  });
});

void test("getRunProfile returns metadata-only refresh arguments with confirmation", () => {
  assert.deepEqual(getRunProfile("metadataAll"), {
    args: ["--all", "--tag", "--refresh-all", "--apply"],
    label: "all scopes metadata refresh",
    confirmation: {
      title: "Run metadata refresh?",
      message: "This rewrites summaries, tags, concepts, and related-note metadata for every all-scope note without rebuilding the vector index.",
      confirmText: "Run metadata refresh",
      confirmClass: "mod-cta",
    },
  });
});

void test("getRunProfile returns all-scope full refresh arguments", () => {
  assert.deepEqual(getRunProfile("refreshAll"), {
    args: ["--all", "--refresh-all", "--apply"],
    label: "all scopes full refresh",
    confirmation: {
      title: "Run full refresh?",
      message: "This regenerates metadata for every all-scope note using the current model and prompt settings.",
      confirmText: "Run full refresh",
      confirmClass: "mod-cta",
    },
  });
});

void test("getRunProfile returns all-scope full rebuild arguments", () => {
  assert.deepEqual(getRunProfile("rebuildAll"), {
    args: ["--all", "--refresh-all", "--rebuild", "--apply"],
    label: "all scopes full rebuild",
    confirmation: {
      title: "Run full rebuild?",
      message: "This deletes and recreates the local vector collections, then refreshes every all-scope note.",
      confirmText: "Run full rebuild",
      confirmClass: "mod-warning",
    },
  });
});
