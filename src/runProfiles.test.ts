import test from "node:test";
import assert from "node:assert/strict";

import { getRunProfile } from "./runProfiles";

void test("getRunProfile returns current-scope label with no confirmation", () => {
  assert.deepEqual(getRunProfile("current"), { label: "current scope" });
});

void test("getRunProfile returns one-note label", () => {
  assert.deepEqual(getRunProfile("note", "Notes/one.md"), { label: "individual note Notes/one.md" });
});

void test("getRunProfile throws when scope is note and no path is given", () => {
  assert.throws(() => getRunProfile("note"));
});

void test("getRunProfile returns all-scope label with no confirmation", () => {
  assert.deepEqual(getRunProfile("all"), { label: "all scopes" });
});

void test("getRunProfile returns metadata-only refresh label with confirmation", () => {
  assert.deepEqual(getRunProfile("metadataAll"), {
    label: "all scopes metadata refresh",
    confirmation: {
      title: "Run metadata refresh?",
      message: "This rewrites summaries, tags, concepts, and related-note metadata for every all-scope note without rebuilding the vector index.",
      confirmText: "Run metadata refresh",
      confirmClass: "mod-cta",
    },
  });
});

void test("getRunProfile returns all-scope full refresh label with confirmation", () => {
  assert.deepEqual(getRunProfile("refreshAll"), {
    label: "all scopes full refresh",
    confirmation: {
      title: "Run full refresh?",
      message: "This regenerates metadata for every all-scope note using the current model and prompt settings.",
      confirmText: "Run full refresh",
      confirmClass: "mod-cta",
    },
  });
});

void test("getRunProfile returns all-scope full rebuild label with confirmation", () => {
  assert.deepEqual(getRunProfile("rebuildAll"), {
    label: "all scopes full rebuild",
    confirmation: {
      title: "Run full rebuild?",
      message: "This rebuilds the local vector index from the committed generation, then refreshes every all-scope note.",
      confirmText: "Run full rebuild",
      confirmClass: "mod-warning",
    },
  });
});
