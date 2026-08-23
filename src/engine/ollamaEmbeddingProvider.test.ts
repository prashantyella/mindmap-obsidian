import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { EngineError } from "./errors";
import { createWindowSleep, normalizeVector, OllamaEmbeddingProvider, validateOllamaEndpoint } from "./ollamaEmbeddingProvider";

interface FakeSleepCall {
  ms: number;
  settled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function createFakeSleep() {
  const calls: FakeSleepCall[] = [];
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolvePromise, rejectPromise) => {
    const entry: FakeSleepCall = {
      ms,
      settled: false,
      resolve: () => { if (!entry.settled) { entry.settled = true; resolvePromise(); } },
      reject: (error: unknown) => { if (!entry.settled) { entry.settled = true; rejectPromise(error); } },
    };
    calls.push(entry);
    if (signal) {
      if (signal.aborted) { entry.reject(new Error("aborted")); return; }
      signal.addEventListener("abort", () => entry.reject(new Error("aborted")), { once: true });
    }
  });
  return { sleep, calls, pending: () => calls.filter((c) => !c.settled) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

function embedResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function neverResolvingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
  })) as typeof fetch;
}

/**
 * A fetch fake whose `Response` resolves immediately (headers arrive right
 * away) but whose `.text()` call stalls until `resolveText`/`rejectText` is
 * called, or the request's own `AbortSignal` fires (mirroring how a real
 * fetch implementation cancels an in-flight body read on abort). Used to
 * prove the request timeout/cancellation stays active through body
 * consumption, not just header resolution.
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

void test("validateOllamaEndpoint accepts loopback http(s) and rejects everything else", () => {
  assert.doesNotThrow(() => validateOllamaEndpoint("http://127.0.0.1:11434"));
  assert.doesNotThrow(() => validateOllamaEndpoint("http://localhost:11434"));
  assert.doesNotThrow(() => validateOllamaEndpoint("https://[::1]:11434"));
  assert.throws(() => validateOllamaEndpoint("http://example.com:11434"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
  assert.throws(() => validateOllamaEndpoint("not a url"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
  assert.throws(() => validateOllamaEndpoint("ftp://127.0.0.1"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
});

void test("validateOllamaEndpoint rejects embedded credentials, a query string, and a fragment", () => {
  assert.throws(() => validateOllamaEndpoint("http://user:pass@127.0.0.1:11434"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
  assert.throws(() => validateOllamaEndpoint("http://127.0.0.1:11434/?x=1"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
  assert.throws(() => validateOllamaEndpoint("http://127.0.0.1:11434/#frag"), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID");
});

void test("validateOllamaEndpoint resolves a '..' path segment via the URL parser's own normalization, never leaving one in the returned base URL", () => {
  assert.equal(validateOllamaEndpoint("http://127.0.0.1:11434/a/../b"), "http://127.0.0.1:11434/b");
});

void test("validateOllamaEndpoint normalizes a base path so /api/embed cannot be hijacked by a stray query/fragment", () => {
  assert.equal(validateOllamaEndpoint("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(validateOllamaEndpoint("http://127.0.0.1:11434/custom/"), "http://127.0.0.1:11434/custom");
});

void test("constructing a provider with a remote endpoint throws before any request is made", () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  assert.throws(
    () => new OllamaEmbeddingProvider({ baseUrl: "http://example.com", model: "m" }, { fetchImpl, sleep }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_ENDPOINT_INVALID",
  );
});

void test("sends model+input in order and returns an L2-normalized vector", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => embedResponse({ model: "m", embeddings: [[3, 4]] })]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  const result = await provider.embedBatch({ model: "m", items: [{ id: "chunk-0", text: "hello world" }] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${LOOPBACK_URL}/api/embed`);
  const sentBody = JSON.parse(String(calls[0].init?.body)) as { model: string; input: string[] };
  assert.deepEqual(sentBody, { model: "m", input: ["hello world"] });

  assert.equal(result.model, "m");
  assert.equal(result.dimension, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "chunk-0");
  assert.ok(Math.abs(result.items[0].values[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(result.items[0].values[1] - 0.8) < 1e-9);
});

void test("splits an oversized item count into sequential, order-preserving sub-batches", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const handlers = [
    () => embedResponse({ model: "m", embeddings: [[1, 0], [1, 0]] }),
    () => embedResponse({ model: "m", embeddings: [[1, 0], [1, 0]] }),
    () => embedResponse({ model: "m", embeddings: [[1, 0]] }),
  ];
  const { fetchImpl, calls } = createFakeFetch(handlers);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxBatchSize: 2 }, { fetchImpl, sleep });
  const result = await provider.embedBatch({ model: "m", items: ids.map((id) => ({ id, text: `text-${id}` })) });

  assert.equal(calls.length, 3);
  const batchSizes = calls.map((call) => (JSON.parse(String(call.init?.body)) as { input: string[] }).input.length);
  assert.deepEqual(batchSizes, [2, 2, 1]);
  assert.deepEqual(result.items.map((item) => item.id), ids);
});

void test("splits sub-batches on total character length even under the item-count limit", async () => {
  const { fetchImpl, calls } = createFakeFetch([
    () => embedResponse({ model: "m", embeddings: [[1, 0]] }),
    () => embedResponse({ model: "m", embeddings: [[1, 0]] }),
  ]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxBatchSize: 10, maxBatchChars: 10 }, { fetchImpl, sleep });
  await provider.embedBatch({ model: "m", items: [{ id: "a", text: "0123456789" }, { id: "b", text: "0123456789" }] });
  assert.equal(calls.length, 2);
});

void test("a single item exceeding maxBatchChars alone is rejected rather than silently truncated", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxBatchChars: 5 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "too many characters" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("the whole embedBatch call is rejected once summed item text exceeds maxTotalChars, even though every item individually fits under maxBatchChars", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider(
    { baseUrl: LOOPBACK_URL, model: "m", maxBatchSize: 10, maxBatchChars: 15, maxTotalChars: 15 },
    { fetchImpl, sleep },
  );
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "0123456789" }, { id: "b", text: "0123456789" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  assert.equal(calls.length, 0, "no HTTP call should happen once the whole-call bound is already exceeded");
});

void test("constructing a provider with maxTotalChars smaller than maxBatchChars is rejected", () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  assert.throws(
    () => new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxBatchChars: 1_000, maxTotalChars: 10 }, { fetchImpl, sleep }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("duplicate item ids in one request are rejected", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "same", text: "x" }, { id: "same", text: "y" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("an item id containing a control character is rejected, and never appears in the thrown error", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  const badId = `secret${String.fromCharCode(1)}notepath.md`;
  try {
    await provider.embedBatch({ model: "m", items: [{ id: badId, text: "x" }] });
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "EMBEDDING_BATCH_INVALID");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /secret/);
  }
});

void test("an item id exceeding the bounded identifier length is rejected", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "x".repeat(600), text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("an item id with leading or trailing whitespace is rejected rather than silently trimmed -- the echo-unchanged correlation-id contract must never silently change the id", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: " chunk-0", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "chunk-0 ", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("a valid item id is echoed back byte-identical in the result", async () => {
  const { fetchImpl } = createFakeFetch([() => embedResponse({ model: "m", embeddings: [[1, 0]] })]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  const id = "Notes/Example.md#chunk-3";
  const result = await provider.embedBatch({ model: "m", items: [{ id, text: "x" }] });
  assert.equal(result.items[0].id, id);
});

void test("empty or whitespace-only item text is rejected before any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "   \n\t  " }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  assert.equal(calls.length, 0);
});

void test("newline-containing note text remains valid -- newlines are ordinary content, never treated as an identifier boundary", async () => {
  const { fetchImpl, calls } = createFakeFetch([() => embedResponse({ model: "m", embeddings: [[1, 0]] })]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await provider.embedBatch({ model: "m", items: [{ id: "a", text: "line one\nline two\n\nline three" }] });
  assert.equal(calls.length, 1);
  const sentBody = JSON.parse(String(calls[0].init?.body)) as { input: string[] };
  assert.equal(sentBody.input[0], "line one\nline two\n\nline three");
});

void test("a configured model name with a control character or that is too long is rejected at construction time", () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  assert.throws(
    () => new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: `bad${String.fromCharCode(1)}model` }, { fetchImpl, sleep }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  assert.throws(
    () => new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m".repeat(300) }, { fetchImpl, sleep }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("a request exceeding maxTotalItems is rejected before any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxTotalItems: 2 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }, { id: "b", text: "y" }, { id: "c", text: "z" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
  assert.equal(calls.length, 0);
});

void test("a request whose model does not match the configured provider model is rejected", async () => {
  const { fetchImpl } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "different-model", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_BATCH_INVALID",
  );
});

void test("retries once on a transient network failure, then succeeds", async () => {
  let attempt = 0;
  const fetchImpl = (async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("network down");
    return embedResponse({ model: "m", embeddings: [[1, 0]] });
  }) as typeof fetch;
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 1 }, { fetchImpl, sleep: fakeSleep.sleep });

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  await flush();
  const backoffCall = fakeSleep.pending().find((call) => call.ms > 0);
  assert.ok(backoffCall, "expected a pending backoff sleep call after the first transient failure");
  backoffCall!.resolve();

  const result = await resultPromise;
  assert.equal(attempt, 2);
  assert.equal(result.items[0].values[0], 1);
});

void test("exhausts retries and throws EMBEDDING_REQUEST_FAILED after the configured attempt count", async () => {
  let attempt = 0;
  const fetchImpl = (async () => { attempt += 1; throw new TypeError("network down"); }) as typeof fetch;
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 2 }, { fetchImpl, sleep: fakeSleep.sleep });

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  for (let i = 0; i < 2; i += 1) {
    await flush();
    const backoffCall = fakeSleep.pending().find((call) => call.ms > 0);
    assert.ok(backoffCall, `expected a pending backoff sleep call before retry ${i + 2}`);
    backoffCall!.resolve();
  }
  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_REQUEST_FAILED");
  assert.equal(attempt, 3);
});

void test("a 4xx status other than 404 is not retried", async () => {
  let attempt = 0;
  const fetchImpl = (async () => { attempt += 1; return embedResponse({ error: "bad request" }, 400); }) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 2 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_REQUEST_FAILED",
  );
  assert.equal(attempt, 1);
});

void test("a missing model (404) is reported as EMBEDDING_MODEL_NOT_FOUND without retry", async () => {
  let attempt = 0;
  const fetchImpl = (async () => { attempt += 1; return embedResponse({ error: "model not found" }, 404); }) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 2 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_MODEL_NOT_FOUND",
  );
  assert.equal(attempt, 1);
});

void test("times out when the response never arrives, and does not retry past the exhausted attempts without backoff calls piling up", async () => {
  const fetchImpl = neverResolvingFetch();
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", timeoutMs: 5_000, maxRetries: 0 }, { fetchImpl, sleep: fakeSleep.sleep });

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  await flush();
  const timeoutCall = fakeSleep.pending().find((call) => call.ms === 5_000);
  assert.ok(timeoutCall, "expected a pending timeout sleep call");
  timeoutCall!.resolve();

  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_TIMEOUT");
});

void test("timeout stays active through body consumption: response headers resolve immediately but text() stalls until the timeout fires", async () => {
  const { fetchImpl, rejectText } = createStallingBodyFetch();
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", timeoutMs: 5_000, maxRetries: 0 }, { fetchImpl, sleep: fakeSleep.sleep });

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  await flush();
  const timeoutCall = fakeSleep.pending().find((call) => call.ms === 5_000);
  assert.ok(timeoutCall, "expected a pending timeout sleep call to still be pending while the body stalls");
  timeoutCall!.resolve();

  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_TIMEOUT");
  // Never resolved/rejected by the test -- proves the provider itself aborted body consumption
  // rather than waiting on it after the timeout fired.
  rejectText(new Error("should never be observed"));
});

void test("a text() rejection (body-read failure) after headers resolve maps to a static redacted EMBEDDING_REQUEST_FAILED, never the raw thrown error", async () => {
  const { fetchImpl, rejectText } = createStallingBodyFetch();
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 0 }, { fetchImpl, sleep });

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  await flush();
  rejectText(new Error("SECRET-BODY-READ-FAILURE-xyz"));

  try {
    await resultPromise;
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "EMBEDDING_REQUEST_FAILED");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-BODY-READ-FAILURE/);
  }
});

void test("caller abort during body read (after headers already resolved) throws EMBEDDING_CANCELLED", async () => {
  const { fetchImpl } = createStallingBodyFetch();
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", timeoutMs: 60_000 }, { fetchImpl, sleep });
  const controller = new AbortController();

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_CANCELLED");
});

void test("caller cancellation before the call starts throws EMBEDDING_CANCELLED without any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }, { signal: controller.signal }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_CANCELLED",
  );
  assert.equal(calls.length, 0);
});

void test("caller cancellation mid-request throws EMBEDDING_CANCELLED, not EMBEDDING_TIMEOUT", async () => {
  const fetchImpl = neverResolvingFetch();
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", timeoutMs: 60_000 }, { fetchImpl, sleep: fakeSleep.sleep });
  const controller = new AbortController();

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }, { signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_CANCELLED");
});

void test("a malformed (non-JSON) response body is rejected without retry", async () => {
  let attempt = 0;
  const fetchImpl = (async () => { attempt += 1; return new Response("not json", { status: 200 }); }) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 2 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_RESPONSE_INVALID",
  );
  assert.equal(attempt, 1);
});

void test("a response.model that disagrees with the configured model is rejected", async () => {
  const fetchImpl = (async () => embedResponse({ model: "other-model", embeddings: [[1, 0]] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_MODEL_MISMATCH",
  );
});

void test("a response with no model field at all is rejected (model is required, not merely checked when present)", async () => {
  const fetchImpl = (async () => embedResponse({ embeddings: [[1, 0]] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_MODEL_MISMATCH",
  );
});

void test("a response with the wrong number of embeddings is rejected", async () => {
  const fetchImpl = (async () => embedResponse({ model: "m", embeddings: [[1, 0]] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }, { id: "b", text: "y" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_COUNT_MISMATCH",
  );
});

void test("vectors of inconsistent dimension within one response are rejected", async () => {
  const fetchImpl = (async () => embedResponse({ model: "m", embeddings: [[1, 0], [1, 0, 0]] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }, { id: "b", text: "y" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_DIMENSION_MISMATCH",
  );
});

void test("a zero-magnitude vector is rejected rather than dividing by zero", async () => {
  const fetchImpl = (async () => embedResponse({ model: "m", embeddings: [[0, 0, 0]] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID",
  );
});

void test("normalizeVector rejects a non-finite value (defensive: JSON has no NaN/Infinity literal, so this cannot round-trip through the HTTP response path)", () => {
  assert.throws(() => normalizeVector([1, Number.NaN]), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
  assert.throws(() => normalizeVector([1, Number.POSITIVE_INFINITY]), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("normalizeVector rejects finite input values whose squared norm overflows to Infinity", () => {
  const huge = 1e200;
  assert.throws(() => normalizeVector([huge, huge, huge]), (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("normalizeVector's output is finite and unit-length for an ordinary vector", () => {
  const normalized = normalizeVector([1, 2, 3]);
  const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0));
  assert.ok(normalized.every((value) => Number.isFinite(value)));
  assert.ok(Math.abs(magnitude - 1) < 1e-9);
});

void test("a response vector whose dimension exceeds the maximum bounded dimension is rejected without normalizing it", async () => {
  const oversizedDimension = 8193; // MAX_EMBEDDING_DIMENSION (8192) + 1
  const fetchImpl = (async () => embedResponse({ model: "m", embeddings: [Array.from({ length: oversizedDimension }, () => 1)] })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_DIMENSION_INVALID",
  );
});

void test("a vector value that fails JSON's own number grammar is rejected as a malformed response, not silently coerced", async () => {
  const fetchImpl = (async () => new Response('{"model":"m","embeddings":[[1,null]]}', { status: 200 })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_RESPONSE_INVALID",
  );
});

void test("a fetchImpl that throws an EngineError instance carrying a secret is never re-thrown as-is -- it is remapped to the static request-failed error", async () => {
  const secret = "SECRET-FETCH-THROWN-ENGINEERROR-xyz";
  const fetchImpl = (async () => { throw new EngineError("EMBEDDING_RESPONSE_INVALID", secret); }) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 0 }, { fetchImpl, sleep });
  try {
    await provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "EMBEDDING_REQUEST_FAILED", "the seam's own error code/instance must never be trusted, even though it is an EngineError");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-FETCH-THROWN-ENGINEERROR/);
  }
});

void test("a response.text() that throws an EngineError instance carrying a secret is never re-thrown as-is -- it is remapped to the static request-failed error", async () => {
  const secret = "SECRET-TEXT-THROWN-ENGINEERROR-xyz";
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => { throw new EngineError("EMBEDDING_MODEL_MISMATCH", secret); },
  } as unknown as Response)) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 0 }, { fetchImpl, sleep });
  try {
    await provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "EMBEDDING_REQUEST_FAILED", "the seam's own error code/instance must never be trusted, even though it is an EngineError");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SECRET-TEXT-THROWN-ENGINEERROR/);
  }
});

void test("errors never leak the raw response body, provider error text, or endpoint URL", async () => {
  const secretBody = "SECRET-PROVIDER-BODY-abc123";
  const fetchImpl = (async () => new Response(secretBody, { status: 500 })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 0 }, { fetchImpl, sleep });
  try {
    await provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    const serialized = JSON.stringify({ message: error.message, context: error.context });
    assert.doesNotMatch(serialized, /SECRET-PROVIDER-BODY/);
    assert.doesNotMatch(serialized, /127\.0\.0\.1/);
  }
});

void test("empty items list returns an empty result without any HTTP call", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m" }, { fetchImpl, sleep });
  const result = await provider.embedBatch({ model: "m", items: [] });
  assert.deepEqual(result, { model: "m", dimension: 0, items: [] });
  assert.equal(calls.length, 0);
});

void test("a response exceeding maxResponseChars is rejected, checked via a Content-Length preflight when present", async () => {
  const bigBody = JSON.stringify({ embeddings: [[1, 0]] });
  const fetchImpl = (async () => new Response(bigBody, { status: 200, headers: { "content-length": "999999999" } })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxResponseChars: 100 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_RESPONSE_TOO_LARGE",
  );
});

void test("a response exceeding maxResponseChars is rejected via a post-read length check even without a Content-Length header", async () => {
  const bigBody = `{"embeddings":[[1,0]],"padding":"${"x".repeat(200)}"}`;
  const fetchImpl = (async () => new Response(bigBody, { status: 200 })) as typeof fetch;
  const { sleep } = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxResponseChars: 100 }, { fetchImpl, sleep });
  await assert.rejects(
    provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }),
    (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_RESPONSE_TOO_LARGE",
  );
});

void test("a backoff sleep that fails for a reason other than caller cancellation surfaces a static EMBEDDING_TIMER_FAILED, never the injected sleep's own error", async () => {
  let attempt = 0;
  const fetchImpl = (async () => { attempt += 1; throw new TypeError("network down"); }) as typeof fetch;
  const sleep = async (): Promise<void> => { throw new Error("SEAM-INTERNAL-FAILURE-abc"); };
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 1 }, { fetchImpl, sleep });
  try {
    await provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
    assert.fail("expected embedBatch to throw");
  } catch (error) {
    assert.ok(error instanceof EngineError);
    assert.equal(error.code, "EMBEDDING_TIMER_FAILED");
    assert.doesNotMatch(JSON.stringify({ message: error.message, context: error.context }), /SEAM-INTERNAL-FAILURE/);
  }
  assert.equal(attempt, 1);
});

void test("backoff cancellation during retry always maps to EMBEDDING_CANCELLED, never a raw sleep error", async () => {
  const fetchImpl = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", maxRetries: 1 }, { fetchImpl, sleep: fakeSleep.sleep });
  const controller = new AbortController();

  const resultPromise = provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] }, { signal: controller.signal });
  await flush();
  const backoffCall = fakeSleep.pending().find((call) => call.ms > 0);
  assert.ok(backoffCall, "expected a pending backoff sleep call");
  controller.abort();
  await assert.rejects(resultPromise, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_CANCELLED");
});

void test("request timeout cleanup does not hang after the fetch already won the race", async () => {
  const fetchImpl = (async () => embedResponse({ model: "m", embeddings: [[1, 0]] })) as typeof fetch;
  const fakeSleep = createFakeSleep();
  const provider = new OllamaEmbeddingProvider({ baseUrl: LOOPBACK_URL, model: "m", timeoutMs: 60_000 }, { fetchImpl, sleep: fakeSleep.sleep });

  const result = await provider.embedBatch({ model: "m", items: [{ id: "a", text: "x" }] });
  assert.equal(result.items[0].values[0], 1);
  // The timeout sleep call should have been registered (the race started) but never needed
  // manual resolution -- requestOnce aborts its own timeoutController once the fetch wins.
  assert.equal(fakeSleep.calls.length, 1);
  assert.equal(fakeSleep.calls[0].ms, 60_000);
});

void test("createWindowSleep resolves after the given delay and rejects on abort", async () => {
  const sleep = createWindowSleep();
  const start = Date.now();
  await sleep(5);
  assert.ok(Date.now() - start >= 0);

  const controller = new AbortController();
  const pending = sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof EngineError && error.code === "EMBEDDING_CANCELLED");
});

void test("createWindowSleep does not leak abort listeners on a long-lived signal across many sequential sleeps that resolve normally", async () => {
  const sleep = createWindowSleep();
  const controller = new AbortController();
  for (let i = 0; i < 20; i += 1) {
    await sleep(1, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
