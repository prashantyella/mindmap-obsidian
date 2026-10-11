import test from "node:test";
import assert from "node:assert/strict";

import { testLocalAiDraft } from "./localAiDraftTest";

const config = {
  embedBaseUrl: "http://localhost:11434", embedModel: "embed", embedDimension: 3,
  llmBaseUrl: "http://localhost:11434", llmModel: "chat", llmMaxTokens: 100,
};

void test("tests the displayed draft once when addresses match", async () => {
  const urls: string[] = [];
  const message = await testLocalAiDraft(config, async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ models: [{ name: "embed" }, { name: "chat" }] }));
  });
  assert.deepEqual(urls, ["http://localhost:11434/api/tags"]);
  assert.match(message, /displayed models are installed/);
});

void test("distinct draft endpoints are preserved and checked independently", async () => {
  const urls: string[] = [];
  await testLocalAiDraft({ ...config, llmBaseUrl: "http://127.0.0.1:11435" }, async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ models: [{ name: urls.length === 1 ? "embed" : "chat" }] }));
  });
  assert.deepEqual(urls, ["http://localhost:11434/api/tags", "http://127.0.0.1:11435/api/tags"]);
});

void test("missing draft model fails without applying settings", async () => {
  await assert.rejects(() => testLocalAiDraft(config, async () => new Response(JSON.stringify({ models: [{ name: "embed" }] }))), /chat is not installed/);
});

void test("an untagged configured model matches Ollama's explicit latest tag", async () => {
  const message = await testLocalAiDraft(config, async () => new Response(JSON.stringify({
    models: [{ name: "embed:latest" }, { name: "chat:latest" }],
  })));
  assert.match(message, /displayed models are installed/);
});

void test("null and non-object model entries fail with fixed actionable guidance", async () => {
  for (const malformed of [null, "embed"]) {
    await assert.rejects(
      () => testLocalAiDraft(config, async () => new Response(JSON.stringify({ models: [{ name: "embed:latest" }, malformed] }))),
      (error: unknown) => error instanceof Error && error.message === "Ollama returned a malformed model list. Restart or update Ollama, then test again.",
    );
  }
});

void test("blank embedding model fails before any network call", async () => {
  let calls = 0;
  await assert.rejects(
    () => testLocalAiDraft({ ...config, embedModel: "   " }, async () => { calls += 1; return new Response(); }),
    /Embedding model is required/,
  );
  assert.equal(calls, 0);
});

void test("blank summaries and tags model fails before any network call", async () => {
  let calls = 0;
  await assert.rejects(
    () => testLocalAiDraft({ ...config, llmModel: "\t" }, async () => { calls += 1; return new Response(); }),
    /Summaries and tags model is required/,
  );
  assert.equal(calls, 0);
});
