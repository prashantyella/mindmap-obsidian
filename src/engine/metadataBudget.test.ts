import test from "node:test";
import assert from "node:assert/strict";

import { EngineError } from "./errors";
import {
  DEFAULT_CONTEXT_TOKENS,
  validateContextTokens,
  resolveRootBudget,
  resolveLeafBudget,
  messagesTotalBytes,
  fitsInputBudget,
  assertFitsInputBudget,
} from "./metadataBudget";

void test("validateContextTokens returns default 4096 when undefined", () => {
  assert.equal(validateContextTokens(undefined), DEFAULT_CONTEXT_TOKENS);
  assert.equal(DEFAULT_CONTEXT_TOKENS, 4096);
});

void test("validateContextTokens accepts valid integers", () => {
  assert.equal(validateContextTokens(512), 512);
  assert.equal(validateContextTokens(8192), 8192);
  assert.equal(validateContextTokens(131072), 131072);
});

void test("validateContextTokens rejects out-of-range values", () => {
  assert.throws(() => validateContextTokens(0), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
  assert.throws(() => validateContextTokens(100), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
  assert.throws(() => validateContextTokens(200_000), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
  assert.throws(() => validateContextTokens(1.5), (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID");
});

void test("resolveRootBudget computes positive inputBudgetBytes", () => {
  const budget = resolveRootBudget(4096, 512);
  assert.ok(budget.inputBudgetBytes > 0);
  assert.equal(budget.maxOutputTokens, 512);
  assert.equal(budget.contextTokens, 4096);
  assert.equal(budget.inputBudgetBytes, 4096 - 512 - 512);
});

void test("resolveRootBudget rejects when maxTokens consumes all context", () => {
  assert.throws(
    () => resolveRootBudget(1024, 1024),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID",
  );
});

void test("resolveLeafBudget uses 256 output allowance", () => {
  const budget = resolveLeafBudget(4096);
  assert.equal(budget.maxOutputTokens, 256);
  assert.equal(budget.inputBudgetBytes, 4096 - 512 - 256);
});

void test("messagesTotalBytes counts UTF-8 bytes correctly", () => {
  const messages = [
    { content: "hello" },
    { content: "日本語" },
  ];
  assert.equal(messagesTotalBytes(messages), 5 + 9);
});

void test("fitsInputBudget returns true/false correctly", () => {
  const budget = resolveRootBudget(4096, 512);
  const small = [{ content: "x" }];
  const large = [{ content: "x".repeat(budget.inputBudgetBytes + 1) }];
  assert.equal(fitsInputBudget(small, budget), true);
  assert.equal(fitsInputBudget(large, budget), false);
});

void test("assertFitsInputBudget throws on oversized messages", () => {
  const budget = resolveRootBudget(4096, 512);
  const large = [{ content: "x".repeat(budget.inputBudgetBytes + 1) }];
  assert.throws(
    () => assertFitsInputBudget(large, budget),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_PROMPT_TOO_LARGE",
  );
});
