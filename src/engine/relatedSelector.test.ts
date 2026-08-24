import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { canonicalizePath } from "./contracts";
import { selectRelatedCandidates } from "./relatedSelector";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "engine", "related_selection.json");

interface SelectionCase {
  name: string;
  candidates: [string, number][];
  self_path: string;
  related_limit: number;
  overreach_count: number;
  creative_count: number;
  creative_min: number;
  creative_max: number;
  output: [string, string][];
}

function loadCases(): SelectionCase[] {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  return (JSON.parse(raw) as { cases: SelectionCase[] }).cases;
}

void test("selectRelatedCandidates matches every golden case in related_selection.json", () => {
  for (const testCase of loadCases()) {
    const result = selectRelatedCandidates(
      testCase.candidates.map(([p, score]) => ({ path: canonicalizePath(p), score })),
      {
        selfPath: canonicalizePath(testCase.self_path),
        relatedLimit: testCase.related_limit,
        overreachCount: testCase.overreach_count,
        creativeCount: testCase.creative_count,
        creativeMin: testCase.creative_min,
        creativeMax: testCase.creative_max,
      },
    );
    assert.deepEqual(result.map((c) => [c.path, c.kind]), testCase.output, `case "${testCase.name}" mismatched`);
  }
});

void test("relatedLimit of zero returns no candidates", () => {
  const result = selectRelatedCandidates([{ path: canonicalizePath("A.md"), score: 0.9 }], {
    selfPath: canonicalizePath("Self.md"),
    relatedLimit: 0,
    overreachCount: 0,
    creativeCount: 0,
    creativeMin: 0,
    creativeMax: 1,
  });
  assert.deepEqual(result, []);
});

void test("self is excluded even when it is the single highest-scoring candidate", () => {
  const result = selectRelatedCandidates(
    [{ path: canonicalizePath("Self.md"), score: 0.99 }, { path: canonicalizePath("A.md"), score: 0.5 }],
    { selfPath: canonicalizePath("Self.md"), relatedLimit: 5, overreachCount: 0, creativeCount: 0, creativeMin: 0, creativeMax: 1 },
  );
  assert.deepEqual(result.map((c) => c.path), ["A.md"]);
});

void test("duplicate paths are deduped, keeping the highest score", () => {
  const result = selectRelatedCandidates(
    [{ path: canonicalizePath("A.md"), score: 0.4 }, { path: canonicalizePath("A.md"), score: 0.9 }],
    { selfPath: canonicalizePath("Self.md"), relatedLimit: 5, overreachCount: 0, creativeCount: 0, creativeMin: 0, creativeMax: 1 },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].score, 0.9);
});

void test("non-finite scores are excluded", () => {
  const result = selectRelatedCandidates(
    [{ path: canonicalizePath("A.md"), score: Number.NaN }, { path: canonicalizePath("B.md"), score: 0.5 }],
    { selfPath: canonicalizePath("Self.md"), relatedLimit: 5, overreachCount: 0, creativeCount: 0, creativeMin: 0, creativeMax: 1 },
  );
  assert.deepEqual(result.map((c) => c.path), ["B.md"]);
});

void test("candidates below minScore are excluded", () => {
  const result = selectRelatedCandidates(
    [{ path: canonicalizePath("A.md"), score: 0.1 }, { path: canonicalizePath("B.md"), score: 0.6 }],
    { selfPath: canonicalizePath("Self.md"), relatedLimit: 5, overreachCount: 0, creativeCount: 0, creativeMin: 0, creativeMax: 1, minScore: 0.3 },
  );
  assert.deepEqual(result.map((c) => c.path), ["B.md"]);
});

void test("isEligible excludes unsafe/ineligible candidates before selection", () => {
  const result = selectRelatedCandidates(
    [{ path: canonicalizePath(".obsidian/plugins/x.md"), score: 0.9 }, { path: canonicalizePath("B.md"), score: 0.5 }],
    {
      selfPath: canonicalizePath("Self.md"),
      relatedLimit: 5,
      overreachCount: 0,
      creativeCount: 0,
      creativeMin: 0,
      creativeMax: 1,
      isEligible: (p) => !p.startsWith(".obsidian/"),
    },
  );
  assert.deepEqual(result.map((c) => c.path), ["B.md"]);
});
