import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "./settings";
import { resolveKnownEmbeddingDimension } from "./engine/embeddingModelConfig";

void test("new installations default to the tested Gemma 2 text model and its native dimension", () => {
  assert.equal(DEFAULT_SETTINGS.embedModel, "embeddinggemma-2:270m");
  assert.equal(DEFAULT_SETTINGS.embedDimension, 0);
  assert.equal(resolveKnownEmbeddingDimension(DEFAULT_SETTINGS.embedModel, undefined), 768);
});

void test("an explicitly saved model is preserved when applying defaults", () => {
  const settings = { ...DEFAULT_SETTINGS, embedModel: "mxbai-embed-large", embedDimension: 1024 };
  assert.equal(settings.embedModel, "mxbai-embed-large");
  assert.equal(settings.embedDimension, 1024);
});
