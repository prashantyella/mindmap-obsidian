import test from "node:test";
import assert from "node:assert/strict";

import { createConfiguredLocalResearchModel, validateLocalEndpoint } from "./localResearchModel";

function response(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200 }); }

test("rejects remote and non-HTTP local model endpoints before content leaves the note", () => {
  assert.throws(() => validateLocalEndpoint("https://example.com/v1"), /loopback/);
  assert.throws(() => validateLocalEndpoint("file:///tmp/model"), /loopback/);
});

test("uses loopback OpenAI JSON mode and parses bounded fenced query objects", async () => {
  const calls: RequestInit[] = [];
  const model = createConfiguredLocalResearchModel({ provider: "openai_compatible", baseUrl: "http://127.0.0.1:8000/v1", model: "qwen", chatTemplateKwargs: { enable_thinking: false }, temperature: 0.1 }, async (_url, init) => {
    calls.push(init ?? {});
    return response({ choices: [{ message: { content: "```json\n{\"queries\":[\"one\",\"two\",\"three\"]}\n```" } }] });
  });
  assert.deepEqual(await model.deriveQueries({ text: "private text", maxChars: 20 }), ["one", "two"]);
  const body = JSON.parse(String(calls[0]?.body)) as Record<string, unknown>;
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test("maps local model AbortError to a redacted timeout", async () => {
  const model = createConfiguredLocalResearchModel({ provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" }, async () => {
    throw Object.assign(new Error("private body"), { name: "AbortError" });
  });
  await assert.rejects(() => model.deriveQueries({ text: "private text", maxChars: 20 }), (error: unknown) => error instanceof Error && error.message.includes("timed out") && !error.message.includes("private"));
});
