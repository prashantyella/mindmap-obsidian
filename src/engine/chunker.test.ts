import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chunkText, DEFAULT_OVERLAP_TOKENS, DEFAULT_TARGET_TOKENS } from "./chunker";
import { EngineError } from "./errors";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURE_PATH = path.join(REPO_ROOT, "tests", "fixtures", "engine", "chunking.json");

interface ChunkingCase {
  name: string;
  text: string;
  target_tokens: number;
  overlap_tokens: number;
  chunks: string[];
}

function loadCases(): ChunkingCase[] {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  return (JSON.parse(raw) as { cases: ChunkingCase[] }).cases;
}

void test("chunkText matches every golden case in chunking.json", () => {
  for (const testCase of loadCases()) {
    const actual = chunkText(testCase.text, { targetTokens: testCase.target_tokens, overlapTokens: testCase.overlap_tokens });
    assert.deepEqual(actual, testCase.chunks, `case "${testCase.name}" mismatched`);
  }
});

void test("default target/overlap tokens match the fixture's recorded production benchmark constants", () => {
  assert.equal(DEFAULT_TARGET_TOKENS, 400);
  assert.equal(DEFAULT_OVERLAP_TOKENS, 40);
});

void test("CRLF and LF inputs that differ only in newline convention produce identical chunks", () => {
  const lf = "alpha beta gamma\ndelta epsilon\nzeta eta theta";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(chunkText(lf, { targetTokens: 400, overlapTokens: 40 }), chunkText(crlf, { targetTokens: 400, overlapTokens: 40 }));
});

void test("Unicode text is NFC-normalized before word-splitting", () => {
  const decomposed = `caf${String.fromCharCode(0x65, 0x0301)} au lait`; // "e" + combining acute accent (U+0301)
  const composed = `caf${String.fromCharCode(0xe9)} au lait`; // precomposed accented "e" (U+00E9)
  assert.notEqual(decomposed, composed);
  assert.deepEqual(chunkText(decomposed, { targetTokens: 400, overlapTokens: 40 }), chunkText(composed, { targetTokens: 400, overlapTokens: 40 }));
});

void test("headings and list markers are treated as ordinary whitespace-delimited words", () => {
  const text = "# Heading One\n- item one\n- item two\n\nSome paragraph text.";
  const chunks = chunkText(text, { targetTokens: 400, overlapTokens: 40 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "# Heading One - item one - item two Some paragraph text.");
});

void test("short input under the target word count returns a single chunk", () => {
  assert.deepEqual(chunkText("one two three", { targetTokens: 400, overlapTokens: 40 }), ["one two three"]);
});

void test("empty and whitespace-only input returns no chunks", () => {
  assert.deepEqual(chunkText("", { targetTokens: 400, overlapTokens: 40 }), []);
  assert.deepEqual(chunkText("   \n\t  ", { targetTokens: 400, overlapTokens: 40 }), []);
});

void test("target/overlap word counts are floored at the minimums (50/10) even for tiny configured token counts", () => {
  const words = Array.from({ length: 120 }, (_, i) => `word${i + 1}`).join(" ");
  const chunks = chunkText(words, { targetTokens: 1, overlapTokens: 1 });
  assert.equal(chunks[0].split(" ").length, 50);
  const secondChunkFirstWord = chunks[1].split(" ")[0];
  assert.equal(secondChunkFirstWord, "word41"); // 50 - 10 overlap
});

void test("a chunk boundary exactly at the word count produces one final chunk with no trailing empty chunk", () => {
  const words = Array.from({ length: 300 }, (_, i) => `word${i + 1}`).join(" ");
  const chunks = chunkText(words, { targetTokens: 400, overlapTokens: 40 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].split(" ").length, 300);
});

void test("oversized input is rejected rather than silently processed", () => {
  const huge = "word ".repeat(3_000_000);
  assert.throws(() => chunkText(huge, { targetTokens: 400, overlapTokens: 40 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("non-positive targetTokens is rejected", () => {
  assert.throws(() => chunkText("a b c", { targetTokens: 0, overlapTokens: 10 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("overlapTokens equal to targetTokens is rejected rather than looping forever", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" ");
  assert.throws(() => chunkText(words, { targetTokens: 100, overlapTokens: 100 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("overlapTokens greater than targetTokens is rejected rather than looping forever", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" ");
  assert.throws(() => chunkText(words, { targetTokens: 10, overlapTokens: 10_000 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("an overlapTokens/targetTokens pair whose floored effective word counts collide (overlapWords >= targetWords) is rejected even when the raw token counts look fine", () => {
  // targetTokens=15 -> targetWords = max(50, floor(15*0.75)=11) = 50 (floor dominates).
  // overlapTokens=90 -> overlapWords = max(10, floor(90*0.75)=67) = 67. 67 < 50 is false -- rejected.
  const words = Array.from({ length: 200 }, (_, i) => `word${i + 1}`).join(" ");
  assert.throws(() => chunkText(words, { targetTokens: 15, overlapTokens: 90 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("this validation fails closed even for empty input text -- a config problem, not a text problem", () => {
  assert.throws(() => chunkText("", { targetTokens: 100, overlapTokens: 100 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("fractional targetTokens/overlapTokens are rejected", () => {
  assert.throws(() => chunkText("a b c", { targetTokens: 400.5, overlapTokens: 40 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
  assert.throws(() => chunkText("a b c", { targetTokens: 400, overlapTokens: 40.5 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("NaN targetTokens/overlapTokens are rejected", () => {
  assert.throws(() => chunkText("a b c", { targetTokens: Number.NaN, overlapTokens: 40 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
  assert.throws(() => chunkText("a b c", { targetTokens: 400, overlapTokens: Number.NaN }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("Infinity targetTokens/overlapTokens are rejected", () => {
  assert.throws(() => chunkText("a b c", { targetTokens: Number.POSITIVE_INFINITY, overlapTokens: 40 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
  assert.throws(() => chunkText("a b c", { targetTokens: 400, overlapTokens: Number.POSITIVE_INFINITY }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("negative overlapTokens is rejected", () => {
  assert.throws(() => chunkText("a b c", { targetTokens: 400, overlapTokens: -1 }), (error: unknown) => error instanceof EngineError && error.code === "CHUNK_INPUT_INVALID");
});

void test("golden parity is unaffected for every previously valid setting", () => {
  const words = Array.from({ length: 600 }, (_, i) => `word${i + 1}`).join(" ");
  assert.deepEqual(chunkText(words, { targetTokens: 400, overlapTokens: 40 }), chunkText(words));
});
