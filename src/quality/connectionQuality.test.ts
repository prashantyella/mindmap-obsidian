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
  const fixture: ConnectionQualityFixture = {
    notes: [
      { path: "Garden/A.md", theme: "garden", text: "a" },
      { path: "Garden/B.md", theme: "garden", text: "b" },
      { path: "Systems/C.md", theme: "systems", text: "c" },
      { path: "Inbox/Tiny.md", theme: "short", text: "tiny", excluded: true },
    ],
    queries: [{ path: "Garden/A.md", relevant: ["Garden/B.md"] }],
  };
  const embeddings = new Map<string, QualityEmbedding>([
    ["Garden/A.md", { noteVector: unit(1, 0), chunkVectors: [unit(1, 0)] }],
    ["Garden/B.md", { noteVector: unit(0.99, 0.01), chunkVectors: [unit(0.99, 0.01)] }],
    ["Systems/C.md", { noteVector: unit(0, 1), chunkVectors: [unit(0, 1)] }],
    ["Inbox/Tiny.md", { noteVector: unit(1, 0), chunkVectors: [unit(1, 0)] }],
  ]);
  const result = evaluateConnectionQuality(fixture, embeddings, {
    candidateLimit: 3,
    relatedLimit: 1,
    overreachCount: 0,
    creativeCount: 0,
    creativeMin: 0.45,
    creativeMax: 0.7,
    minScore: 0,
  });
  assert.equal(result.precisionAtK, 1);
  assert.equal(result.expectedCoverage, 1);
  assert.equal(result.labeledCorePrecision, 1);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.meanReciprocalRank, 1);
  assert.equal(result.selfHits, 0);
  assert.deepEqual(result.queries[0].returned, ["Garden/B.md"]);
  assert.ok(!result.queries[0].returned.includes("Inbox/Tiny.md"));
});
