import test from "node:test";
import assert from "node:assert/strict";
import { resolveKnownEmbeddingDimension } from "./embeddingModelConfig";

void test("known embedding models resolve native dimensions with or without Ollama tags", () => {
  for (const model of ["embeddinggemma", "embeddinggemma:latest", "embeddinggemma-2", "embeddinggemma-2:270m"]) {
    assert.equal(resolveKnownEmbeddingDimension(model, undefined), 768);
  }
  assert.equal(resolveKnownEmbeddingDimension("mxbai-embed-large:latest", undefined), 1024);
  assert.equal(resolveKnownEmbeddingDimension("custom:latest", undefined), undefined);
  assert.equal(resolveKnownEmbeddingDimension("someone/embeddinggemma-2:270m", undefined), undefined);
  assert.equal(resolveKnownEmbeddingDimension("constructor", undefined), undefined);
  assert.equal(resolveKnownEmbeddingDimension("__proto__", undefined), undefined);
});

void test("explicit dimensions win without guessing custom model shapes", () => {
  assert.equal(resolveKnownEmbeddingDimension("embeddinggemma-2:270m", 256), 256);
  assert.equal(resolveKnownEmbeddingDimension("custom:latest", 128), 128);
});
