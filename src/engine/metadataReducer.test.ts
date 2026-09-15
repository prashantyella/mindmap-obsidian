import test from "node:test";
import assert from "node:assert/strict";

import { EngineError } from "./errors";
import type { MetadataInferenceProvider } from "./metadataPipeline";
import { resolveLeafBudget } from "./metadataBudget";
import {
  validateIntermediate,
  buildReductionMessages,
  reduceIntermediates,
  type IntermediateMetadata,
} from "./metadataReducer";

function im(summary: string, tags: string[] = [], concepts: string[] = []): IntermediateMetadata {
  return { summary, tags, concepts };
}

function fakeReduceProvider(response: string): MetadataInferenceProvider {
  return { complete: async () => response };
}

const CTX = 4096;
const BUDGET = resolveLeafBudget(CTX);

function baseOpts(provider: MetadataInferenceProvider, overrides: Partial<{ signal: AbortSignal }> = {}) {
  return { provider, model: "m", contextTokens: CTX, budget: BUDGET, ...overrides };
}

void test("validateIntermediate rejects oversized summary", () => {
  assert.throws(
    () => validateIntermediate({ summary: "x".repeat(3000), tags: [], concepts: [] }),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("validateIntermediate rejects too many tags", () => {
  assert.throws(
    () => validateIntermediate({ summary: "ok", tags: Array.from({ length: 100 }, (_, i) => `tag-${i}`), concepts: [] }),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("validateIntermediate rejects too many concepts", () => {
  assert.throws(
    () => validateIntermediate({ summary: "ok", tags: [], concepts: Array.from({ length: 100 }, (_, i) => `c-${i}`) }),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("validateIntermediate rejects oversized tag entry", () => {
  assert.throws(
    () => validateIntermediate({ summary: "ok", tags: ["a".repeat(600)], concepts: [] }),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("validateIntermediate accepts valid input and trims", () => {
  const result = validateIntermediate({ summary: "  ok  ", tags: ["a", "", 123 as unknown as string, "b"], concepts: ["c"] });
  assert.equal(result.summary, "ok");
  assert.deepEqual(result.tags, ["a", "b"]);
  assert.deepEqual(result.concepts, ["c"]);
});

void test("buildReductionMessages includes all intermediates", () => {
  const messages = buildReductionMessages([im("A", ["t1"], ["c1"]), im("B", ["t2"], ["c2"])]);
  assert.equal(messages.length, 2);
  assert.ok(messages[1].content.includes("Part 1:"));
  assert.ok(messages[1].content.includes("Part 2:"));
});

void test("reduceIntermediates makes a distinct configured root call for one intermediate", async () => {
  const single = im("solo", ["tag"], ["concept"]);
  const result = await reduceIntermediates([single], baseOpts(fakeReduceProvider('{"summary":"root","tags":[],"concepts":[]}')));
  assert.equal(result.summary, "root");
});

void test("reduceIntermediates merges two intermediates via provider", async () => {
  const provider = fakeReduceProvider('{"summary":"merged","tags":["merged-tag"],"concepts":["merged-concept"]}');
  const result = await reduceIntermediates(
    [im("A", ["a"], ["ca"]), im("B", ["b"], ["cb"])],
    baseOpts(provider),
  );
  assert.equal(result.summary, "merged");
  assert.deepEqual(result.tags, ["merged-tag"]);
  assert.deepEqual(result.concepts, ["merged-concept"]);
});

void test("reduceIntermediates handles multi-level reduction", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      return `{"summary":"level-${callCount}","tags":["t${callCount}"],"concepts":["c${callCount}"]}`;
    },
  };
  const many = Array.from({ length: 10 }, (_, i) => im(`part ${i}`, [`tag-${i}`], [`concept-${i}`]));
  const result = await reduceIntermediates(many, baseOpts(provider));
  assert.ok(callCount >= 1, "should call provider at least once");
  assert.ok(result.summary.startsWith("level-"));
});

void test("reduceIntermediates rejects empty input", async () => {
  await assert.rejects(
    reduceIntermediates([], baseOpts(fakeReduceProvider("{}"))),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_CONFIG_INVALID",
  );
});

void test("reduceIntermediates propagates METADATA_RESPONSE_INVALID from malformed provider JSON", async () => {
  const provider: MetadataInferenceProvider = {
    async complete() {
      return "not json at all";
    },
  };
  await assert.rejects(
    reduceIntermediates(
      [im("A", [], []), im("B", [], [])],
      baseOpts(provider),
    ),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("reduceIntermediates respects cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reduceIntermediates(
      [im("A", [], []), im("B", [], [])],
      baseOpts(fakeReduceProvider("{}"), { signal: controller.signal }),
    ),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_CANCELLED",
  );
});

void test("reduceIntermediates with many small intermediates converges", async () => {
  const provider = fakeReduceProvider('{"summary":"root","tags":["rt"],"concepts":["rc"]}');
  const many = Array.from({ length: 50 }, (_, i) => im(`s${i}`, [`t${i}`], [`c${i}`]));
  const result = await reduceIntermediates(many, baseOpts(provider));
  assert.equal(result.summary, "root");
});

void test("reduceIntermediates retries once on METADATA_RESPONSE_INVALID", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      if (callCount === 1) return "not json";
      return '{"summary":"ok","tags":[],"concepts":[]}';
    },
  };
  const result = await reduceIntermediates(
    [im("A", [], []), im("B", [], [])],
    baseOpts(provider),
  );
  assert.equal(callCount, 3, "should retry once, then make the distinct root call");
  assert.equal(result.summary, "ok");
});

void test("reduceIntermediates does not retry non-METADATA_RESPONSE_INVALID errors", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      throw new EngineError("METADATA_TIMEOUT", "timed out");
    },
  };
  await assert.rejects(
    reduceIntermediates(
      [im("A", [], []), im("B", [], [])],
      baseOpts(provider),
    ),
    (e: unknown) => e instanceof EngineError && e.code === "METADATA_TIMEOUT",
  );
  assert.equal(callCount, 1, "should not retry METADATA_TIMEOUT");
});

void test("reduceIntermediates carries contextTokens in provider request", async () => {
  let receivedContextTokens: number | undefined;
  const provider: MetadataInferenceProvider = {
    async complete(request) {
      receivedContextTokens = request.contextTokens;
      return '{"summary":"ok","tags":[],"concepts":[]}';
    },
  };
  await reduceIntermediates(
    [im("A", [], []), im("B", [], [])],
    { provider, model: "m", contextTokens: 8192, budget: resolveLeafBudget(8192) },
  );
  assert.equal(receivedContextTokens, 8192, "contextTokens must be passed to provider");
});

void test("reduceIntermediates group sizes strictly decrease", async () => {
  const provider = fakeReduceProvider('{"summary":"r","tags":[],"concepts":[]}');
  const many = Array.from({ length: 20 }, (_, i) => im(`s${i}`, [`t${i}`], [`c${i}`]));
  const result = await reduceIntermediates(many, baseOpts(provider));
  assert.equal(result.summary, "r");
});
