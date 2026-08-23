import test from "node:test";
import assert from "node:assert/strict";

import { EngineError } from "./errors";
import { createOllamaMetadataProvider, createOpenAiCompatibleMetadataProvider } from "./localMetadataProvider";

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function createFakeFetch(handlers: Array<() => Response | Promise<Response>>): { fetchImpl: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return await handler();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function neverResolvingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
  })) as typeof fetch;
}

/**
 * A fetch fake whose `Response` resolves immediately (headers arrive right
 * away) but whose `.text()` call stalls until `resolveText`/`rejectText` is
 * called, or the request's own `AbortSignal` fires.
 */
function createStallingBodyFetch(): { fetchImpl: typeof fetch; resolveText: (text: string) => void; rejectText: (error: unknown) => void } {
  let resolveText!: (text: string) => void;
  let rejectText!: (error: unknown) => void;
  const textPromise = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => rejectText(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => textPromise,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, resolveText, rejectText };
}

const LOOPBACK_URL = "http://127.0.0.1:11434";

void test("createOllamaMetadataProvider sends /api/chat with format:json and extracts message.content", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => jsonResponse({ message: { content: '{"summary":"s","tags":[],"concepts":[]}' } })]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  const content = await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.equal(content, '{"summary":"s","tags":[],"concepts":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${LOOPBACK_URL}/api/chat`);
  const sentBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.equal(sentBody.format, "json");
  assert.equal(sentBody.stream, false);
  assert.equal(sentBody.model, "m");
});

void test("createOllamaMetadataProvider rejects a remote endpoint", () => {
  const { fetchImpl } = createFakeFetch([]);
  assert.throws(
    () => createOllamaMetadataProvider({ baseUrl: "http://example.com" }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_ENDPOINT_INVALID",
  );
});

void test("createOllamaMetadataProvider rejects a malformed response shape", async () => {
  const { fetchImpl } = createFakeFetch([() => jsonResponse({ nothing: true })]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("createOllamaMetadataProvider times out and reports METADATA_TIMEOUT", async () => {
  const fetchImpl = neverResolvingFetch();
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL, timeoutMs: 20 }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_TIMEOUT",
  );
});

void test("createOllamaMetadataProvider cancellation reports METADATA_CANCELLED, not METADATA_TIMEOUT", async () => {
  const fetchImpl = neverResolvingFetch();
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL, timeoutMs: 60_000 }, { fetchImpl });
  const controller = new AbortController();
  const pending = provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof EngineError && error.code === "METADATA_CANCELLED");
});

void test("createOllamaMetadataProvider rejects a response exceeding maxResponseChars", async () => {
  const bigBody = `{"message":{"content":"${"x".repeat(2_000)}"}}`;
  const { fetchImpl } = createFakeFetch([() => new Response(bigBody, { status: 200 })]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL, maxResponseChars: 100 }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_TOO_LARGE",
  );
});

void test("createOllamaMetadataProvider errors never leak the raw response body or endpoint URL", async () => {
  const secret = "SECRET-OLLAMA-BODY-xyz";
  const { fetchImpl } = createFakeFetch([() => new Response(secret, { status: 500 })]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    const serialized = JSON.stringify({ message: error.message, context: error.context });
    assert.doesNotMatch(serialized, /SECRET-OLLAMA-BODY/);
    assert.doesNotMatch(serialized, /127\.0\.0\.1/);
  }
});

void test("a fetchImpl that throws an EngineError instance carrying a secret is never re-thrown as-is -- it is remapped to a static provider-failed error", async () => {
  const secret = "SECRET-FETCH-THROWN-ENGINEERROR-xyz";
  const fetchImpl = (async () => { throw new EngineError("METADATA_RESPONSE_INVALID", secret); }) as typeof fetch;
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "METADATA_PROVIDER_FAILED", "the seam's own error code/instance must never be trusted, even though it is an EngineError");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-FETCH-THROWN-ENGINEERROR/);
  }
});

void test("a response.text() that throws an EngineError instance carrying a secret is never re-thrown as-is -- it is remapped to a static provider-failed error", async () => {
  const secret = "SECRET-TEXT-THROWN-ENGINEERROR-xyz";
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => { throw new EngineError("METADATA_RESPONSE_TOO_LARGE", secret); },
  } as unknown as Response)) as typeof fetch;
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "METADATA_PROVIDER_FAILED", "the seam's own error code/instance must never be trusted, even though it is an EngineError");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-TEXT-THROWN-ENGINEERROR/);
  }
});

void test("createOpenAiCompatibleMetadataProvider sends /chat/completions with response_format json_object and extracts choices[0].message.content", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => jsonResponse({ choices: [{ message: { content: '{"summary":"s","tags":[],"concepts":[]}' } }] })]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  const content = await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 256 });
  assert.equal(content, '{"summary":"s","tags":[],"concepts":[]}');
  assert.equal(calls[0].url, `${LOOPBACK_URL}/chat/completions`);
  const sentBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(sentBody.response_format, { type: "json_object" });
  assert.equal(sentBody.max_tokens, 256);
});

void test("createOpenAiCompatibleMetadataProvider extracts content from an array-of-parts message shape", async () => {
  const { fetchImpl } = createFakeFetch([() => jsonResponse({ choices: [{ message: { content: [{ text: "hello " }, { text: "world" }] } }] })]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  const content = await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  assert.equal(content, "hello world");
});

void test("createOpenAiCompatibleMetadataProvider sends a Bearer Authorization header only when an apiKey is configured", async () => {
  const { fetchImpl, calls } = createFakeFetch([
    () => jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    () => jsonResponse({ choices: [{ message: { content: "{}" } }] }),
  ]);
  const withKey = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, apiKey: "sekret-key" }, { fetchImpl });
  await withKey.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  const headersWithKey = calls[0].init?.headers as Record<string, string>;
  assert.equal(headersWithKey.authorization, "Bearer sekret-key");

  const withoutKey = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await withoutKey.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  const headersWithoutKey = calls[1].init?.headers as Record<string, string>;
  assert.equal(headersWithoutKey.authorization, undefined);
});

void test("createOpenAiCompatibleMetadataProvider errors never leak the API key", async () => {
  const { fetchImpl } = createFakeFetch([() => new Response("boom", { status: 500 })]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, apiKey: "SECRET-API-KEY-123" }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    const serialized = JSON.stringify({ message: error.message, context: error.context });
    assert.doesNotMatch(serialized, /SECRET-API-KEY/);
  }
});

void test("createOpenAiCompatibleMetadataProvider: a fetchImpl that throws a secret-bearing EngineError is remapped to a static provider-failed error", async () => {
  const secret = "SECRET-OPENAI-FETCH-ENGINEERROR-xyz";
  const fetchImpl = (async () => { throw new EngineError("METADATA_RESPONSE_INVALID", secret); }) as typeof fetch;
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "METADATA_PROVIDER_FAILED");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-OPENAI-FETCH-ENGINEERROR/);
  }
});

void test("createOpenAiCompatibleMetadataProvider: a response.text() that throws a secret-bearing EngineError is remapped to a static provider-failed error", async () => {
  const secret = "SECRET-OPENAI-TEXT-ENGINEERROR-xyz";
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => { throw new EngineError("METADATA_RESPONSE_TOO_LARGE", secret); },
  } as unknown as Response)) as typeof fetch;
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  try {
    await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "METADATA_PROVIDER_FAILED");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-OPENAI-TEXT-ENGINEERROR/);
  }
});

void test("createOpenAiCompatibleMetadataProvider rejects a remote endpoint even with an apiKey configured", () => {
  const { fetchImpl } = createFakeFetch([]);
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: "http://example.com", apiKey: "k" }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_ENDPOINT_INVALID",
  );
});

void test("a request whose model contains a control character is rejected", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: `bad${String.fromCharCode(1)}model`, messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("timeout stays active through body consumption for the Ollama adapter", async () => {
  const { fetchImpl, rejectText } = createStallingBodyFetch();
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL, timeoutMs: 20 }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_TIMEOUT",
  );
  rejectText(new Error("should never be observed"));
});

void test("a text() rejection after headers resolve maps to a static METADATA_PROVIDER_FAILED, never the raw thrown error", async () => {
  const { fetchImpl, rejectText } = createStallingBodyFetch();
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  const pending = provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  rejectText(new Error("SECRET-BODY-READ-FAILURE-xyz"));
  try {
    await pending;
    assert.fail("expected complete to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "METADATA_PROVIDER_FAILED");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-BODY-READ-FAILURE/);
  }
});

void test("caller abort during body read (after headers already resolved) throws METADATA_CANCELLED", async () => {
  const { fetchImpl } = createStallingBodyFetch();
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL, timeoutMs: 60_000 }, { fetchImpl });
  const controller = new AbortController();
  const pending = provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof EngineError && error.code === "METADATA_CANCELLED");
});

void test("createOllamaMetadataProvider.complete rejects an empty messages array before any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.equal(calls.length, 0);
});

void test("createOllamaMetadataProvider.complete rejects a message with an unrecognized role", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "assistant", content: "hi" } as never], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("createOllamaMetadataProvider.complete rejects a message with non-string content", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: 123 as unknown as string }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("createOllamaMetadataProvider.complete rejects an oversized single message and an oversized total message count", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "x".repeat(200_000) }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  const manyMessages = Array.from({ length: 60 }, () => ({ role: "user" as const, content: "hi" }));
  await assert.rejects(
    provider.complete({ model: "m", messages: manyMessages, maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("createOllamaMetadataProvider.complete rejects a non-integer or out-of-range maxTokens", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 0 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1.5 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 1_000_000 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("createOpenAiCompatibleMetadataProvider.complete fails closed on an unrecognized array-content part rather than silently dropping it", async () => {
  const { fetchImpl } = createFakeFetch([() => jsonResponse({ choices: [{ message: { content: [{ text: "hello" }, { unexpected: "shape" }] } }] })]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("createOpenAiCompatibleMetadataProvider.complete rejects empty/whitespace-only extracted content", async () => {
  const { fetchImpl } = createFakeFetch([
    () => jsonResponse({ choices: [{ message: { content: "   " } }] }),
    () => jsonResponse({ choices: [{ message: { content: [{ text: "  " }, { text: "" }] } }] }),
  ]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_INVALID",
  );
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("createOllamaMetadataProvider.complete rejects empty/whitespace-only extracted content", async () => {
  const { fetchImpl } = createFakeFetch([() => jsonResponse({ message: { content: "  \n " } })]);
  const provider = createOllamaMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_RESPONSE_INVALID",
  );
});

void test("createOpenAiCompatibleMetadataProvider forwards a validated chatTemplateKwargs as chat_template_kwargs, and rejects an invalid one at construction", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => jsonResponse({ choices: [{ message: { content: "{}" } }] })]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { enable_thinking: false } }, { fetchImpl });
  await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  const sentBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(sentBody.chat_template_kwargs, { enable_thinking: false });

  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: "not-an-object" as unknown as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { big: "x".repeat(30_000) } }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("createOpenAiCompatibleMetadataProvider.complete rejects an oversized/malformed messages array before any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const provider = createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL }, { fetchImpl });
  await assert.rejects(
    provider.complete({ model: "m", messages: [{ role: "system", content: 5 as unknown as string }], maxTokens: 100 }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.equal(calls.length, 0);
});

void test("chatTemplateKwargs recursive validator rejects undefined/function/symbol/bigint deep inside a nested value, which JSON.stringify would otherwise silently drop", async () => {
  const { fetchImpl } = createFakeFetch([]);
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: { b: [1, undefined, 3] } } }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: { b: () => 1 } } as unknown as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: Symbol("x") } as unknown as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: 10n } as unknown as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("chatTemplateKwargs recursive validator rejects a non-finite number, a non-plain-object value, and a sparse array, nested", async () => {
  const { fetchImpl } = createFakeFetch([]);
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: [1, Number.NaN] } }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: new Date() } as unknown as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  const sparse: unknown[] = [1, 2];
  sparse[5] = 3;
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: sparse } }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("chatTemplateKwargs recursive validator rejects a cyclic value rather than crashing or hanging", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: cyclic }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );

  const cyclicArray: unknown[] = [1, 2];
  cyclicArray.push(cyclicArray);
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: { a: cyclicArray } }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("chatTemplateKwargs recursive validator rejects nesting deeper than the bounded depth and more items than the bounded count", async () => {
  const { fetchImpl } = createFakeFetch([]);
  let deep: unknown = "leaf";
  for (let i = 0; i < 10; i += 1) deep = { nested: deep };
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: deep as Record<string, unknown> }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );

  const manyKeys: Record<string, number> = {};
  for (let i = 0; i < 500; i += 1) manyKeys[`k${i}`] = i;
  assert.throws(
    () => createOpenAiCompatibleMetadataProvider({ baseUrl: LOOPBACK_URL, chatTemplateKwargs: manyKeys }, { fetchImpl }),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
});

void test("chatTemplateKwargs recursive validator accepts a normal nested plain value", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => jsonResponse({ choices: [{ message: { content: "{}" } }] })]);
  const provider = createOpenAiCompatibleMetadataProvider(
    { baseUrl: LOOPBACK_URL, chatTemplateKwargs: { enable_thinking: false, nested: { a: [1, 2, "three", null] } } },
    { fetchImpl },
  );
  await provider.complete({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
  const sentBody = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(sentBody.chat_template_kwargs, { enable_thinking: false, nested: { a: [1, 2, "three", null] } });
});
