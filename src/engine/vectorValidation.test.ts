import test from "node:test";
import assert from "node:assert/strict";

import { EngineError } from "./errors";
import { isUnitNorm, squaredNorm, UNIT_NORM_TOLERANCE, validateUnitVector } from "./vectorValidation";

void test("squaredNorm sums the square of every component", () => {
  assert.equal(squaredNorm([3, 4]), 25);
  assert.equal(squaredNorm([]), 0);
});

void test("isUnitNorm accepts a true unit vector and rejects a scaled one", () => {
  assert.equal(isUnitNorm([0.6, 0.8]), true);
  assert.equal(isUnitNorm([3, 4]), false);
  assert.equal(isUnitNorm([0, 0, 0]), false);
});

void test("isUnitNorm tolerates only documented Float64 rounding error, not an arbitrary scale", () => {
  const nearUnit = [0.6 + 1e-9, 0.8];
  assert.equal(isUnitNorm(nearUnit), true);
  const offByALot = [0.6 + 0.1, 0.8];
  assert.equal(isUnitNorm(offByALot), false);
});

void test("isUnitNorm rejects when the squared norm overflows to Infinity", () => {
  assert.equal(isUnitNorm([1e200, 1e200]), false);
});

void test("validateUnitVector rejects an empty vector", () => {
  assert.throws(() => validateUnitVector([], 100, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects a vector exceeding maxDimension", () => {
  assert.throws(() => validateUnitVector([1, 0, 0], 2, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects a non-finite component", () => {
  assert.throws(() => validateUnitVector([1, Number.NaN], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects a zero-magnitude vector", () => {
  assert.throws(() => validateUnitVector([0, 0], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector accepts a true unit vector", () => {
  assert.doesNotThrow(() => validateUnitVector([0.6, 0.8], 10, "EMBEDDING_VECTOR_INVALID"));
});

void test("UNIT_NORM_TOLERANCE is a small, documented Float64 tolerance", () => {
  assert.ok(UNIT_NORM_TOLERANCE > 0 && UNIT_NORM_TOLERANCE < 1e-3);
});

void test("validateUnitVector rejects null with a structured EngineError, never a raw TypeError", () => {
  assert.throws(() => validateUnitVector(null, 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects a non-array value with a structured EngineError", () => {
  assert.throws(() => validateUnitVector("not-an-array", 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => validateUnitVector({ 0: 0.6, 1: 0.8, length: 2 }, 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => validateUnitVector(undefined, 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects a sparse array (a hole) with a structured EngineError", () => {
  const sparse = [1, 2];
  sparse[5] = 3;
  assert.throws(() => validateUnitVector(sparse, 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector rejects an array containing a non-number value with a structured EngineError", () => {
  assert.throws(() => validateUnitVector([0.6, "0.8"], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => validateUnitVector([0.6, null], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => validateUnitVector([0.6, undefined], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("validateUnitVector still accepts a normal number[] and enforces dimension/unit bounds as before", () => {
  assert.doesNotThrow(() => validateUnitVector([0.6, 0.8], 10, "EMBEDDING_VECTOR_INVALID"));
  assert.throws(() => validateUnitVector([1, 0, 0], 2, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => validateUnitVector([1, 1], 10, "EMBEDDING_VECTOR_INVALID"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});
