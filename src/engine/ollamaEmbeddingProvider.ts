import type { EmbeddingBatchRequest, EmbeddingBatchResult, EmbeddingProvider, EmbeddingProviderCallOptions, EmbeddingResultItem } from "./embeddingProvider";
import { MAX_EMBEDDING_DIMENSION } from "./embeddingLimits";
import { EngineError } from "./errors";
import { validateBoundedIdentifier, validateCorrelationId } from "./identifierValidation";
import { validateLoopbackEndpoint } from "./loopbackEndpoint";
import { isUnitNorm } from "./vectorValidation";

/**
 * Ports `embed_texts`/`ollama_request` (Ollama `/api/embed`) from
 * python/mindmap.py behaviorally, not line-by-line: bounded batching/sizes,
 * retry classification, timeout, cancellation, strict response validation,
 * and output normalization are new TypeScript-side requirements the Python
 * oracle did not enforce as strictly.
 *
 * No "obsidian" import here (test-reachable by `npm test`). Production
 * wiring (out of scope for this checkpoint) passes `requestUrlFetch` from
 * `obsidianRequestUrlFetch.ts` as `fetchImpl` and `createWindowSleep()` as
 * `sleep`, mirroring `createConfiguredLocalResearchModel` in
 * `localResearchModel.ts`.
 */
export interface OllamaEmbeddingConfig {
  baseUrl: string;
  model: string;
  /** Per-HTTP-request timeout. Bounded to [1, MAX_TIMEOUT_MS]. */
  timeoutMs?: number;
  /** Max items sent in a single HTTP request; a larger `embedBatch` call is auto-split into sequential, order-preserving sub-batches. */
  maxBatchSize?: number;
  /** Max summed `text.length` for a single HTTP request; also drives auto-splitting. Must not exceed `maxTotalChars`. */
  maxBatchChars?: number;
  /** Hard cap on the summed `text.length` across every item in one `embedBatch` call, checked before any HTTP request is made -- bounds the whole call, not just one sub-batch. */
  maxTotalChars?: number;
  /** Hard cap on `request.items.length` for one `embedBatch` call -- exceeding this fails closed rather than silently processing an unbounded input. */
  maxTotalItems?: number;
  /** Hard cap on one HTTP response body's length, enforced via a `Content-Length` preflight (when present and parseable) and a post-read length check. */
  maxResponseChars?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface OllamaEmbeddingProviderDeps {
  /** `fetch`-compatible seam -- see `obsidianRequestUrlFetch.ts`. Never a bare global `fetch` reference in production wiring. */
  fetchImpl: typeof fetch;
  /** Injected sleep for both retry backoff and the request timeout race, so tests run with a fake clock instead of real delays. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BATCH_SIZE = 64;
const MAX_MAX_BATCH_SIZE = 256;
const DEFAULT_MAX_BATCH_CHARS = 200_000;
const MAX_MAX_BATCH_CHARS = 2_000_000;
const DEFAULT_MAX_TOTAL_CHARS = 2_000_000;
const MAX_MAX_TOTAL_CHARS = 50_000_000;
const DEFAULT_MAX_TOTAL_ITEMS = 4_096;
const MAX_MAX_TOTAL_ITEMS = 20_000;
const DEFAULT_MAX_RESPONSE_CHARS = 20_000_000;
const MAX_MAX_RESPONSE_CHARS = 200_000_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_MAX_RETRIES = 5;
const DEFAULT_BACKOFF_MS = 500;
const MAX_MODEL_LENGTH = 256;
const MAX_ITEM_ID_LENGTH = 512;

/**
 * `window.setTimeout`/`window.clearTimeout`-backed sleep for real (non-test)
 * adapters, per the official Obsidian plugin guideline
 * (obsidianmd/prefer-window-timers). `scripts/test-setup.mjs` aliases
 * `window` to `globalThis` under `node:test`, so this remains callable (with
 * real delays) in tests, but production/most tests should inject a fake
 * `sleep` via `OllamaEmbeddingProviderDeps` instead of using this directly.
 *
 * Always removes its own `abort` listener from `signal` before settling --
 * on the timer firing normally as well as on abort -- so a long-lived
 * signal reused across many sequential `sleep` calls never accumulates
 * listeners.
 */
export function createWindowSleep(): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    let onAbort: (() => void) | undefined;
    const timeoutId = window.setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        window.clearTimeout(timeoutId);
        reject(cancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function cancelledError(): EngineError {
  return new EngineError("EMBEDDING_CANCELLED", "Embedding request was cancelled.");
}

function timeoutError(attempt: number, attempts: number): EngineError {
  return new EngineError("EMBEDDING_TIMEOUT", "Ollama embedding request timed out.", { attempt, attempts });
}

/** Static, redacted: never includes the raw thrown error, provider response body, or URL. */
function requestFailedError(attempt: number, attempts: number, status?: number): EngineError {
  return new EngineError("EMBEDDING_REQUEST_FAILED", "Ollama embedding request failed.", { attempt, attempts, status });
}

/** An unexpected failure in the injected timer/sleep seam itself (never a caller cancellation, never a real timeout) -- surfaced explicitly rather than silently disabling timeout/backoff enforcement. */
function timerFailedError(attempt: number, attempts: number): EngineError {
  return new EngineError("EMBEDDING_TIMER_FAILED", "Embedding request timer failed unexpectedly.", { attempt, attempts });
}

export function validateOllamaEndpoint(baseUrl: string): string {
  return validateLoopbackEndpoint(baseUrl, "EMBEDDING_ENDPOINT_INVALID", "Ollama embedding").baseUrl;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new EngineError("EMBEDDING_BATCH_INVALID", `Ollama embedding config.${field} must be an integer between ${min} and ${max}.`, { field });
  }
  return candidate;
}

interface ResolvedConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxBatchSize: number;
  maxBatchChars: number;
  maxTotalChars: number;
  maxTotalItems: number;
  maxResponseChars: number;
  maxRetries: number;
  backoffMs: number;
}

function resolveConfig(config: OllamaEmbeddingConfig): ResolvedConfig {
  const baseUrl = validateOllamaEndpoint(config.baseUrl);
  const model = validateBoundedIdentifier(config.model, "Ollama embedding config.model", "EMBEDDING_BATCH_INVALID", MAX_MODEL_LENGTH);
  const maxBatchChars = clampInt(config.maxBatchChars, DEFAULT_MAX_BATCH_CHARS, 1, MAX_MAX_BATCH_CHARS, "maxBatchChars");
  const maxTotalChars = clampInt(config.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, 1, MAX_MAX_TOTAL_CHARS, "maxTotalChars");
  if (maxTotalChars < maxBatchChars) {
    throw new EngineError("EMBEDDING_BATCH_INVALID", "Ollama embedding config.maxTotalChars must not be smaller than config.maxBatchChars.");
  }
  return {
    baseUrl,
    model,
    timeoutMs: clampInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, "timeoutMs"),
    maxBatchSize: clampInt(config.maxBatchSize, DEFAULT_MAX_BATCH_SIZE, 1, MAX_MAX_BATCH_SIZE, "maxBatchSize"),
    maxBatchChars,
    maxTotalChars,
    maxTotalItems: clampInt(config.maxTotalItems, DEFAULT_MAX_TOTAL_ITEMS, 1, MAX_MAX_TOTAL_ITEMS, "maxTotalItems"),
    maxResponseChars: clampInt(config.maxResponseChars, DEFAULT_MAX_RESPONSE_CHARS, 1, MAX_MAX_RESPONSE_CHARS, "maxResponseChars"),
    maxRetries: clampInt(config.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_MAX_RETRIES, "maxRetries"),
    backoffMs: clampInt(config.backoffMs, DEFAULT_BACKOFF_MS, 0, 60_000, "backoffMs"),
  };
}

/** Greedy, order-preserving packing into sub-batches bounded by both item count and summed character length. A single item whose own text exceeds `maxBatchChars` cannot be packed at all and fails closed. Never includes an item's `id`/`text` in a thrown error -- an id may be a note path. */
function splitIntoSubBatches(items: readonly { id: string; text: string }[], maxBatchSize: number, maxBatchChars: number): { id: string; text: string }[][] {
  const batches: { id: string; text: string }[][] = [];
  let current: { id: string; text: string }[] = [];
  let currentChars = 0;
  for (const item of items) {
    if (item.text.length > maxBatchChars) {
      throw new EngineError("EMBEDDING_BATCH_INVALID", "An embedding input exceeds the maximum bounded character length for a single request.", { length: item.text.length, maxBatchChars });
    }
    const wouldExceedCount = current.length + 1 > maxBatchSize;
    const wouldExceedChars = currentChars + item.text.length > maxBatchChars;
    if (current.length > 0 && (wouldExceedCount || wouldExceedChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += item.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/**
 * L2-normalizes (returns a new array); throws on non-finite input values, a
 * squared-norm overflow (finite inputs whose sum-of-squares itself
 * overflows to `Infinity`), a zero-magnitude vector, or a normalized result
 * that fails to come out finite. Exported for direct unit testing -- a
 * non-finite `number` cannot actually round-trip through `JSON.parse`
 * (JSON has no NaN/Infinity literal), so the HTTP-response path can only
 * exercise the zero-magnitude/overflow cases; the non-finite-input case is
 * exercised directly instead. Never called on a vector whose dimension
 * already exceeds `MAX_EMBEDDING_DIMENSION` -- that bound is enforced at
 * parse time, before this function (and its allocations) ever run.
 */
export function normalizeVector(values: readonly number[]): number[] {
  let sumSquares = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new EngineError("EMBEDDING_VECTOR_INVALID", "Ollama returned a non-finite embedding value.");
    }
    sumSquares += value * value;
  }
  if (!Number.isFinite(sumSquares)) {
    throw new EngineError("EMBEDDING_VECTOR_INVALID", "Ollama returned an embedding vector whose squared norm overflowed.");
  }
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) {
    throw new EngineError("EMBEDDING_VECTOR_INVALID", "Ollama returned a zero-magnitude embedding vector.");
  }
  const normalized = values.map((value) => value / magnitude);
  // Explicitly recomputes and re-verifies the output's norm (not merely each component's
  // finiteness) -- a per-component finite check alone cannot catch a subtle division/rounding
  // bug that leaves the result finite but not actually unit-length.
  if (!isUnitNorm(normalized)) {
    throw new EngineError("EMBEDDING_VECTOR_INVALID", "Ollama returned an embedding vector that failed to normalize to a finite unit-length vector.");
  }
  return normalized;
}

interface ParsedEmbedResponse {
  vectors: number[][];
}

function parseEmbedResponseBody(text: string, expectedModel: string, expectedCount: number): ParsedEmbedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Ollama embedding response was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Ollama embedding response was not a JSON object.");
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.error === "string") {
    throw new EngineError("EMBEDDING_REQUEST_FAILED", "Ollama embedding response reported a provider-side error.");
  }
  if (typeof body.model !== "string" || body.model !== expectedModel) {
    throw new EngineError("EMBEDDING_MODEL_MISMATCH", "Ollama embedding response did not report the configured model.");
  }
  let rawVectors: unknown;
  if (Array.isArray(body.embeddings)) {
    rawVectors = body.embeddings;
  } else if (Array.isArray(body.embedding)) {
    rawVectors = [body.embedding];
  } else {
    throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Ollama embedding response did not contain an embeddings array.");
  }
  const vectorsArray = rawVectors as unknown[];
  if (vectorsArray.length !== expectedCount) {
    throw new EngineError("EMBEDDING_COUNT_MISMATCH", "Ollama returned a different number of embeddings than requested.", { expected: expectedCount, received: vectorsArray.length });
  }
  const vectors: number[][] = [];
  let dimension: number | null = null;
  for (const rawVector of vectorsArray) {
    if (!Array.isArray(rawVector) || rawVector.length === 0 || !rawVector.every((value) => typeof value === "number")) {
      throw new EngineError("EMBEDDING_RESPONSE_INVALID", "Ollama embedding response contained a malformed vector.");
    }
    if (dimension === null) {
      if (rawVector.length > MAX_EMBEDDING_DIMENSION) {
        throw new EngineError("EMBEDDING_DIMENSION_INVALID", "Ollama embedding response vector dimension exceeds the maximum bounded dimension.", { dimension: rawVector.length, maxDimension: MAX_EMBEDDING_DIMENSION });
      }
      dimension = rawVector.length;
    } else if (rawVector.length !== dimension) {
      throw new EngineError("EMBEDDING_DIMENSION_MISMATCH", "Ollama embedding response vectors do not all share the same dimension.");
    }
    vectors.push(rawVector);
  }
  return { vectors };
}

type RequestOutcome =
  | { kind: "success"; vectors: number[][] }
  | { kind: "operation-error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "timer-error"; error: unknown };

/**
 * Marks an error as having come directly from an untrusted external seam
 * call (the injected `fetchImpl` itself, or `response.text()`) rather than
 * from this module's own validation logic. `instanceof EngineError` alone
 * cannot make that distinction: a malicious or buggy `fetchImpl`/`Response`
 * could throw an `EngineError` instance carrying a secret in its message,
 * and re-throwing that unchanged (because "it's already one of our own
 * structured errors") would leak it. Every seam call is wrapped so its
 * rejection is *always* a `SeamError`, whose payload the caller ({@link
 * OllamaEmbeddingProvider.requestOnce}) never inspects -- it only ever maps
 * a `SeamError` to the static, redacted request-failed error.
 */
class SeamError extends Error {
  constructor(readonly cause: unknown) {
    super("seam error");
    this.name = "SeamError";
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly config: ResolvedConfig;
  private readonly deps: OllamaEmbeddingProviderDeps;

  constructor(config: OllamaEmbeddingConfig, deps: OllamaEmbeddingProviderDeps) {
    this.config = resolveConfig(config);
    this.deps = deps;
  }

  async embedBatch(request: EmbeddingBatchRequest, options: EmbeddingProviderCallOptions = {}): Promise<EmbeddingBatchResult> {
    if (request.model !== this.config.model) {
      throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request model does not match the configured provider model.");
    }
    if (request.items.length === 0) {
      return { model: this.config.model, dimension: 0, items: [] };
    }
    if (request.items.length > this.config.maxTotalItems) {
      throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request exceeds the maximum bounded item count.", { count: request.items.length, maxTotalItems: this.config.maxTotalItems });
    }

    const seenIds = new Set<string>();
    const items: { id: string; text: string }[] = [];
    let totalChars = 0;
    for (const rawItem of request.items) {
      // A correlation id is an opaque token a caller expects echoed back byte-identical --
      // validateCorrelationId never trims, unlike validateBoundedIdentifier (see
      // identifierValidation.ts), so a leading/trailing-space id is rejected rather than
      // silently changed.
      const id = validateCorrelationId(rawItem.id, "Embedding request item.id", "EMBEDDING_BATCH_INVALID", MAX_ITEM_ID_LENGTH);
      if (seenIds.has(id)) {
        throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request contains a duplicate item id.");
      }
      seenIds.add(id);
      if (typeof rawItem.text !== "string") {
        throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request item text must be a string.");
      }
      // Text is note content, not an identifier: newlines and interior whitespace are always
      // valid. Only entirely blank text (empty, or whitespace-only after trimming) is rejected.
      if (rawItem.text.trim().length === 0) {
        throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request item text must not be empty or whitespace-only.");
      }
      totalChars += rawItem.text.length;
      items.push({ id, text: rawItem.text });
    }
    if (totalChars > this.config.maxTotalChars) {
      throw new EngineError("EMBEDDING_BATCH_INVALID", "Embedding request exceeds the maximum bounded total character length.", { totalChars, maxTotalChars: this.config.maxTotalChars });
    }

    const subBatches = splitIntoSubBatches(items, this.config.maxBatchSize, this.config.maxBatchChars);
    const resultItems: EmbeddingResultItem[] = [];
    let dimension: number | null = null;

    for (const subBatch of subBatches) {
      if (options.signal?.aborted) throw cancelledError();
      const vectors = await this.requestWithRetry(subBatch.map((item) => item.text), options.signal);
      for (let index = 0; index < subBatch.length; index += 1) {
        const normalized = normalizeVector(vectors[index]);
        if (dimension === null) {
          dimension = normalized.length;
        } else if (normalized.length !== dimension) {
          throw new EngineError("EMBEDDING_DIMENSION_MISMATCH", "Ollama embedding vectors across sub-batches do not all share the same dimension.");
        }
        resultItems.push({ id: subBatch[index].id, values: normalized });
      }
    }

    return { model: this.config.model, dimension: dimension ?? 0, items: resultItems };
  }

  private async requestWithRetry(texts: string[], signal: AbortSignal | undefined): Promise<number[][]> {
    const attempts = this.config.maxRetries + 1;
    let lastError: EngineError = requestFailedError(0, attempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw cancelledError();
      try {
        return await this.requestOnce(texts, signal, attempt, attempts);
      } catch (error) {
        if (!(error instanceof EngineError)) throw error;
        if (error.code === "EMBEDDING_CANCELLED") throw error;
        const transient = error.code === "EMBEDDING_TIMEOUT" || (error.code === "EMBEDDING_REQUEST_FAILED" && isTransientRequestFailure(error));
        lastError = error;
        if (!transient || attempt >= attempts) throw error;

        const backoffOutcome = await this.deps.sleep(this.config.backoffMs * attempt, signal).then(
          () => ({ ok: true as const }),
          () => ({ ok: false as const }),
        );
        if (!backoffOutcome.ok) {
          if (signal?.aborted) throw cancelledError();
          throw timerFailedError(attempt, attempts);
        }
      }
    }
    throw lastError;
  }

  /**
   * Races the COMPLETE bounded operation (fetch + `Content-Length`
   * preflight + body read + post-length check + parse) against an
   * injected-sleep-backed timeout, using a never-rejecting settled-outcome
   * pattern (`.then(ok, err)` on both sides) so neither promise can produce
   * an unhandled rejection -- whichever side loses the race is simply never
   * awaited again. A standard fetch implementation can resolve the
   * response (headers) well before a slow/stalled body finishes, so the
   * timeout must stay active through body consumption, not just header
   * resolution -- racing the whole `runOperation` promise (not just the
   * `fetch()` call) is what guarantees that. Only the loser's underlying
   * resource is aborted (the still-in-flight `controller` when the timeout
   * wins, the still-pending timeout sleep when the operation wins), so an
   * operation that has already fully completed is never retroactively
   * aborted.
   */
  private async requestOnce(texts: string[], signal: AbortSignal | undefined, attempt: number, attempts: number): Promise<number[][]> {
    if (signal?.aborted) throw cancelledError();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeoutController = new AbortController();

    try {
      const operationSettled: Promise<RequestOutcome> = this.runOperation(texts, controller.signal, attempt, attempts).then(
        (vectors): RequestOutcome => ({ kind: "success", vectors }),
        (error): RequestOutcome => ({ kind: "operation-error", error }),
      );
      const timeoutSettled: Promise<RequestOutcome> = this.deps.sleep(this.config.timeoutMs, timeoutController.signal).then(
        (): RequestOutcome => ({ kind: "timeout" }),
        (error): RequestOutcome => ({ kind: "timer-error", error }),
      );

      const outcome = await Promise.race([operationSettled, timeoutSettled]);
      if (outcome.kind === "timeout" || outcome.kind === "timer-error") {
        controller.abort();
      } else {
        timeoutController.abort();
      }

      if (outcome.kind === "timeout") throw timeoutError(attempt, attempts);
      if (outcome.kind === "timer-error") {
        if (signal?.aborted) throw cancelledError();
        throw timerFailedError(attempt, attempts);
      }
      if (outcome.kind === "operation-error") {
        if (signal?.aborted) throw cancelledError();
        // A SeamError's payload (outcome.error.cause) is never inspected or re-thrown here --
        // even if the seam threw an EngineError instance, it is untrusted and could be carrying
        // a secret in its message. Only an error thrown by this module's OWN validation logic
        // (readResponse, parseEmbedResponseBody -- never wrapped in SeamError) is trusted enough
        // to propagate structurally.
        if (outcome.error instanceof SeamError) throw requestFailedError(attempt, attempts);
        if (outcome.error instanceof EngineError) throw outcome.error;
        throw requestFailedError(attempt, attempts);
      }
      return outcome.vectors;
    } finally {
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /** Fetch through response parsing, as a single unit the timeout race in `requestOnce` covers end-to-end. The `fetchImpl` call and the `response.text()` body-read (see `readResponse`) are the only untrusted external seam calls here -- each is wrapped so its rejection always arrives at `requestOnce` as a `SeamError`, regardless of what it actually threw. Everything else in this method and `readResponse` is this module's own validation logic and throws a trusted `EngineError` directly. */
  private async runOperation(texts: string[], operationSignal: AbortSignal, attempt: number, attempts: number): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.deps.fetchImpl(`${this.config.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: operationSignal,
      });
    } catch (error) {
      throw new SeamError(error);
    }
    return await this.readResponse(response, texts.length, attempt, attempts);
  }

  private async readResponse(response: Response, expectedCount: number, attempt: number, attempts: number): Promise<number[][]> {
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > this.config.maxResponseChars) {
        throw new EngineError("EMBEDDING_RESPONSE_TOO_LARGE", "Ollama embedding response exceeds the maximum bounded length.", { attempt, attempts });
      }
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new SeamError(error);
    }
    if (text.length > this.config.maxResponseChars) {
      throw new EngineError("EMBEDDING_RESPONSE_TOO_LARGE", "Ollama embedding response exceeds the maximum bounded length.", { attempt, attempts });
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new EngineError("EMBEDDING_MODEL_NOT_FOUND", "Configured Ollama embedding model was not found.", { attempt, attempts });
      }
      throw requestFailedError(attempt, attempts, response.status);
    }
    return parseEmbedResponseBody(text, this.config.model, expectedCount).vectors;
  }
}

/** A network-level failure (no HTTP status reached) and a 5xx response are transient; any other reached status (a 4xx, or 404 modeled separately as `EMBEDDING_MODEL_NOT_FOUND`) is not. */
function isTransientRequestFailure(error: EngineError): boolean {
  const status = error.context?.status;
  return status === undefined || (typeof status === "number" && isTransientStatus(status));
}
