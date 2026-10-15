import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { evaluateConnectionQuality, type ConnectionQualityFixture, type QualityEmbedding } from "./connectionQuality";

const FIXTURE_PATH = path.resolve(__dirname, "../../tests/fixtures/quality/representative-notes.json");

function unit(...values: number[]): Float32Array {
  const norm = Math.hypot(...values);
  return Float32Array.from(values.map((value) => value / norm));
}

const SMALL_FIXTURE: ConnectionQualityFixture = {
  notes: [
    { path: "Garden/A.md", theme: "garden", text: "a" },
    { path: "Garden/B.md", theme: "garden", text: "b" },
    { path: "Systems/C.md", theme: "systems", text: "c" },
    { path: "Inbox/Tiny.md", theme: "short", text: "tiny", excluded: true },
  ],
  queries: [{ path: "Garden/A.md", relevant: ["Garden/B.md"] }],
};

const SMALL_EMBEDDINGS = new Map<string, QualityEmbedding>([
  ["Garden/A.md", { noteVector: unit(1, 0), chunkVectors: [unit(1, 0)] }],
  ["Garden/B.md", { noteVector: unit(0.99, 0.01), chunkVectors: [unit(0.99, 0.01)] }],
  ["Systems/C.md", { noteVector: unit(0, 1), chunkVectors: [unit(0, 1)] }],
  ["Inbox/Tiny.md", { noteVector: unit(1, 0), chunkVectors: [unit(1, 0)] }],
]);

const SMALL_OPTIONS = {
  candidateLimit: 3,
  relatedLimit: 1,
  overreachCount: 0,
  creativeCount: 0,
  creativeMin: 0.45,
  creativeMax: 0.7,
  minScore: 0,
};

void test("representative quality fixture is bounded, synthetic, and has explicit relevance judgments", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as ConnectionQualityFixture;
  assert.ok(fixture.notes.length >= 20 && fixture.notes.length <= 30);
  assert.ok(new Set(fixture.notes.map((note) => note.theme)).size >= 4);
  assert.ok(fixture.notes.some((note) => note.excluded), "fixture should exercise an ineligible short note");
  assert.equal(new Set(fixture.notes.map((note) => note.path)).size, fixture.notes.length);
  const paths = new Set(fixture.notes.map((note) => note.path));
  for (const query of fixture.queries) {
    assert.ok(paths.has(query.path));
    assert.ok(query.relevant.length > 0);
    assert.ok(!query.relevant.includes(query.path));
    for (const relevant of query.relevant) assert.ok(paths.has(relevant));
  }
});

void test("quality evaluator uses production retrieval/selection and excludes self", () => {
  const result = evaluateConnectionQuality(SMALL_FIXTURE, SMALL_EMBEDDINGS, SMALL_OPTIONS);
  assert.equal(result.precisionAtK, 1);
  assert.equal(result.expectedCoverage, 1);
  assert.equal(result.labeledCorePrecision, 1);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.meanReciprocalRank, 1);
  assert.equal(result.selfHits, 0);
  assert.deepEqual(result.queries[0].returned, ["Garden/B.md"]);
  assert.ok(!result.queries[0].returned.includes("Inbox/Tiny.md"));
});

void test("quality evaluator rejects zero, negative, and non-integer related limits", () => {
  for (const relatedLimit of [0, -1, 1.5]) {
    assert.throws(
      () => evaluateConnectionQuality(SMALL_FIXTURE, SMALL_EMBEDDINGS, { ...SMALL_OPTIONS, relatedLimit }),
      /relatedLimit must be a positive integer/,
    );
  }
});

void test("quality evaluator rejects queries without explicit relevance judgments", () => {
  const fixture = { ...SMALL_FIXTURE, queries: [{ path: "Garden/A.md", relevant: [] }] };
  assert.throws(
    () => evaluateConnectionQuality(fixture, SMALL_EMBEDDINGS, SMALL_OPTIONS),
    /must include at least one explicit relevance judgment/,
  );
});
