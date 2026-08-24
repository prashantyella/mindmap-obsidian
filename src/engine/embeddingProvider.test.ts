import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { EngineError } from "./errors";
import { buildEmbeddingVectorV1 } from "./embeddingProvider";

void test("buildEmbeddingVectorV1 constructs a valid EmbeddingVectorV1 from raw values", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  const vector = buildEmbeddingVectorV1(identity, "nomic-embed-text", [0.6, 0.8]);
  assert.deepEqual(vector, { schemaVersion: 1, identity, model: "nomic-embed-text", dimension: 2, values: [0.6, 0.8] });
});

void test("buildEmbeddingVectorV1 rejects a non-finite value via the shared unit-vector validator (checked before the contract's own validation)", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  assert.throws(() => buildEmbeddingVectorV1(identity, "m", [0.6, Number.NaN]), (error: unknown) => error instanceof EngineError && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("buildEmbeddingVectorV1 rejects a zero vector", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  assert.throws(() => buildEmbeddingVectorV1(identity, "m", [0, 0, 0]), (error: unknown) => error instanceof EngineError && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("buildEmbeddingVectorV1 rejects a non-unit-length vector, regardless of type-level plausibility", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  assert.throws(() => buildEmbeddingVectorV1(identity, "m", [1, 1]), (error: unknown) => error instanceof EngineError && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("buildEmbeddingVectorV1 rejects an empty vector", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  assert.throws(() => buildEmbeddingVectorV1(identity, "m", []), (error: unknown) => error instanceof EngineError && error.code === "CONTRACT_SHAPE_INVALID");
});

void test("buildEmbeddingVectorV1 rejects a vector exceeding the maximum bounded dimension", () => {
  const identity = stableNoteIdentity(canonicalizePath("Notes/A.md"));
  const oversized = Array.from({ length: 8_193 }, () => 1 / Math.sqrt(8_193));
  assert.throws(() => buildEmbeddingVectorV1(identity, "m", oversized), (error: unknown) => error instanceof EngineError && error.code === "CONTRACT_SHAPE_INVALID");
});
