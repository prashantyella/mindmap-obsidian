import test from "node:test";
import assert from "node:assert/strict";
import { knownSourceResult, overlapAtK } from "./retrievalDiagnostics";

void test("known-source retrieval accepts exact duplicates but does not turn absent or out-of-window sources into hits", () => {
  assert.equal(knownSourceResult(["copy", "other"], new Set(["source", "copy"])).hitAt1, 1);
  assert.equal(knownSourceResult(["other", "source"], new Set(["source"])).reciprocalRankAtK, .5);
  assert.equal(knownSourceResult(["other", "source"], new Set(["source"]), 1).hitAtK, 0);
  assert.equal(knownSourceResult(["other"], new Set(["source"])).rankWithinCandidates, null);
  assert.throws(() => knownSourceResult([], new Set()));
});

void test("result overlap is bounded and does not double-count duplicate paths", () => {
  assert.equal(overlapAtK([], []), 1);
  assert.equal(overlapAtK(["a", "b"], ["b", "c"]), .5);
  assert.equal(overlapAtK(["a", "a"], ["a"]), 1);
  assert.equal(overlapAtK(["a"], ["b"]), 0);
});
