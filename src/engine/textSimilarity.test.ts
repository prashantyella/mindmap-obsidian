import test from "node:test";
import assert from "node:assert/strict";

import { closestMatches, sequenceRatio } from "./textSimilarity";

void test("sequenceRatio of identical strings is 1", () => {
  assert.equal(sequenceRatio("machine-learning", "machine-learning"), 1);
});

void test("sequenceRatio of completely disjoint strings is 0", () => {
  assert.equal(sequenceRatio("abc", "xyz"), 0);
});

void test("sequenceRatio of two empty strings is 1 (Python difflib convention)", () => {
  assert.equal(sequenceRatio("", ""), 1);
});

void test("closestMatches respects the cutoff and n limit", () => {
  assert.deepEqual(closestMatches("machinelearning", ["machine-learning", "artificial-intelligence"], 1, 0.75), ["machine-learning"]);
  assert.deepEqual(closestMatches("ml", ["machine-learning", "artificial-intelligence"], 1, 0.75), []);
});

void test("closestMatches returns nothing when no possibility meets the cutoff", () => {
  assert.deepEqual(closestMatches("zzz", ["machine-learning"], 1, 0.75), []);
});

void test("closestMatches excludes a word at or beyond MAX_JUNK_FREE_LENGTH from matching entirely", () => {
  const longWord = "a".repeat(200);
  assert.deepEqual(closestMatches(longWord, ["a".repeat(200)], 1, 0.75), []);
});

void test("closestMatches excludes an oversized possibility from the candidate pool while still matching shorter ones", () => {
  const word = "machine-learning";
  const oversizedPossibility = `${word}${"x".repeat(200)}`;
  assert.deepEqual(closestMatches(word, [oversizedPossibility, "machine-learning"], 2, 0.75), ["machine-learning"]);
});

void test("closestMatches still matches normally for words just under the bound", () => {
  const word = "a".repeat(199);
  assert.deepEqual(closestMatches(word, ["a".repeat(199)], 1, 0.75), ["a".repeat(199)]);
});
