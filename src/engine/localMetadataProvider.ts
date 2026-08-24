import { hasControlCharacter } from "./controlCharacters";
import { EngineError } from "./errors";
import { validateBoundedIdentifier } from "./identifierValidation";
import { validateLoopbackEndpoint } from "./loopbackEndpoint";
import type { MetadataInferenceProvider, MetadataInferenceProviderCallOptions, MetadataInferenceRequest } from "./metadataPipeline";
import { isPlainObject } from "./metadataPipeline";

/**
 * Concrete `MetadataInferenceProvider` adapters for the two local metadata
 * backends `llm_extract` supports in python/mindmap.py (`ollama` and
 * `openai_compatible`) -- ports the `/api/chat` and `/chat/completions`
 * request/response shapes behaviorally, not line-by-line. Loopback-only
 * (via the shared `validateLoopbackEndpoint` policy), bounded
 * timeout/output, strict content extraction, and static redacted errors:
 * never the raw response body, status text, endpoint URL, API key, or an
 * arbitrary thrown message.
 *
 * No "obsidian" import here (test-reachable by `npm test`). Production
 * wiring (out of scope for this checkpoint) passes `requestUrlFetch` from
 * `obsidianRequestUrlFetch.ts` as `fetchImpl`, mirroring
 * `createConfiguredLocalResearchModel` in `localResearchModel.ts`.
 *
 * No remote endpoint support and no embedding implementation here --
 * embeddings remain Ollama-only via `ollamaEmbeddingProvider.ts`.
 */
export interface LocalMetadataProviderDeps {
  fetchImpl: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RESPONSE_CHARS = 2_000_000;
const MAX_MAX_RESPONSE_CHARS = 20_000_000;
const MAX_MODEL_LENGTH = 256;
const MAX_API_KEY_LENGTH = 4_096;
const MAX_MESSAGE_COUNT = 50;
const MAX_MESSAGE_CONTENT_CHARS = 100_000;
const MAX_TOTAL_CONTENT_CHARS = 500_000;
const MAX_MAX_TOKENS = 32_000;
const MAX_JSON_BODY_CHARS = 2_000_000;
const MAX_CHAT_TEMPLATE_KWARGS_CHARS = 20_000;
const MAX_CHAT_TEMPLATE_KWARGS_DEPTH = 6;
const MAX_CHAT_TEMPLATE_KWARGS_ITEMS = 200;
const MAX_CHAT_TEMPLATE_KWARGS_STRING_LENGTH = 2_000;

function clampTimeout(timeoutMs: number | undefined, errorCode: "METADATA_ENDPOINT_INVALID" | "METADATA_CONFIG_INVALID"): number {
  const candidate = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_TIMEOUT_MS) {
    throw new EngineError(errorCode, `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return candidate;
}

function clampMaxResponseChars(value: number | undefined): number {
  const candidate = value ?? DEFAULT_MAX_RESPONSE_CHARS;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > MAX_MAX_RESPONSE_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", `maxResponseChars must be an integer between 1 and ${MAX_MAX_RESPONSE_CHARS}.`);
  }
  return candidate;
}

/**
 * Single POST + bounded timeout/cancellation + bounded response length
 * (`Content-Length` preflight when present, plus a post-read check) shared
 * by both adapters below. Static, redacted errors only -- never the raw
 * response body, provider error text, or thrown message.
 */
async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxResponseChars: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) {
    throw new EngineError("METADATA_CANCELLED", "Metadata inference request was cancelled.");
  }
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) throw new EngineError("METADATA_CANCELLED", "Metadata inference request was cancelled.");
      if (timedOut) throw new EngineError("METADATA_TIMEOUT", "Local metadata provider request timed out.");
      throw new EngineError("METADATA_PROVIDER_FAILED", "Local metadata provider request failed.");
    }

    // Our own validation (Content-Length preflight), never wrapped in the seam try/catch below --
    // its thrown EngineError must propagate structurally, unlike anything response.text() itself
    // throws (see the next comment).
    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > maxResponseChars) {
        throw new EngineError("METADATA_RESPONSE_TOO_LARGE", "Local metadata provider response exceeds the maximum bounded length.");
      }
    }

    // The timeout (via `controller`, still armed here) stays active through body consumption,
    // not just header resolution -- a standard fetch implementation can resolve the response
    // well before a slow/stalled body finishes. `response.text()` is an untrusted external seam
    // call: whatever it throws is classified generically below WITHOUT ever inspecting its class
    // or re-throwing it -- even an EngineError instance thrown by the seam is untrusted and could
    // be carrying a secret in its message.
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (signal?.aborted) throw new EngineError("METADATA_CANCELLED", "Metadata inference request was cancelled.");
      if (timedOut) throw new EngineError("METADATA_TIMEOUT", "Local metadata provider request timed out.");
      throw new EngineError("METADATA_PROVIDER_FAILED", "Local metadata provider request failed.");
    }

    if (text.length > maxResponseChars) {
      throw new EngineError("METADATA_RESPONSE_TOO_LARGE", "Local metadata provider response exceeds the maximum bounded length.");
    }
    if (!response.ok) {
      throw new EngineError("METADATA_PROVIDER_FAILED", "Local metadata provider returned a non-success status.");
    }
    return text;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Local metadata provider response was not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Local metadata provider response was not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function validateModel(model: string): string {
  return validateBoundedIdentifier(model, "Metadata inference request.model", "METADATA_CONFIG_INVALID", MAX_MODEL_LENGTH);
}

/**
 * Both concrete providers are public `MetadataInferenceProvider`
 * implementations and must stay safe even when called directly, outside
 * `runMetadataPipeline` -- never trust a runtime shape just because it
 * type-checks. Validates `request.messages` (non-empty, bounded count,
 * every entry a `{role, content}` pair with a recognized role and bounded
 * string content, bounded total content length) and `request.maxTokens`
 * (a bounded positive integer) before any HTTP call.
 */
function validateChatMessages(messages: unknown): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages must be a non-empty array.");
  }
  if (messages.length > MAX_MESSAGE_COUNT) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages exceeds the maximum bounded count.");
  }
  let totalChars = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages contains a malformed entry.");
    }
    const { role, content } = message as Record<string, unknown>;
    if (role !== "system" && role !== "user") {
      throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages contains an unrecognized role.");
    }
    if (typeof content !== "string") {
      throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages contains non-string content.");
    }
    if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages contains a message exceeding the maximum bounded length.");
    }
    totalChars += content.length;
  }
  if (totalChars > MAX_TOTAL_CONTENT_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.messages exceeds the maximum bounded total content length.");
  }
}

function validateMaxTokens(maxTokens: unknown): number {
  if (!Number.isInteger(maxTokens) || (maxTokens as number) <= 0 || (maxTokens as number) > MAX_MAX_TOKENS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request.maxTokens must be a positive integer within the bounded range.");
  }
  return maxTokens as number;
}

/** Bounds the final serialized request body -- a caller could otherwise pass validated-but-numerous messages that still add up to an oversized JSON payload. */
function assertBoundedBody(body: string): void {
  if (body.length > MAX_JSON_BODY_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata inference request body exceeds the maximum bounded serialized size.");
  }
}

/** Rejects empty/whitespace-only extracted model content rather than returning it for `parseMetadataResponse` to fail on less specifically. */
function assertNonBlankContent(content: string): string {
  if (content.trim().length === 0) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response content was empty.");
  }
  return content;
}

/**
 * Recursively validates a JSON-safe value: plain objects/arrays only,
 * `string`/finite-`number`/`boolean`/`null` leaves, bounded nesting depth,
 * bounded total item count (object keys + array entries, summed across the
 * whole tree), and bounded string length. Rejects `undefined`, a function,
 * a `symbol`, a `bigint`, a non-finite number, a cycle, or a non-plain
 * object (`Date`, `Map`, a class instance) outright -- `JSON.stringify`
 * would otherwise silently drop `undefined`/functions (rather than
 * throwing) and throw an unhelpfully raw `TypeError` on a cycle, so this
 * walk is what actually confirms the value is safe to send, not merely
 * JSON-shaped at the top level. `visiting` detects a cycle by identity
 * (an object/array already on the current path being revisited).
 */
function validateBoundedJsonValue(value: unknown, depth: number, budget: { remaining: number }, visiting: Set<unknown>): unknown {
  if (depth > MAX_CHAT_TEMPLATE_KWARGS_DEPTH) {
    throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs exceeds the maximum bounded nesting depth.");
  }
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > MAX_CHAT_TEMPLATE_KWARGS_STRING_LENGTH) {
      throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a string exceeding the maximum bounded length.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (visiting.has(value)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a cyclic value.");
    }
    visiting.add(value);
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a sparse array.");
      }
      if (budget.remaining <= 0) {
        throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs exceeds the maximum bounded item count.");
      }
      budget.remaining -= 1;
      result.push(validateBoundedJsonValue(value[index], depth + 1, budget, visiting));
    }
    visiting.delete(value);
    return result;
  }
  if (isPlainObject(value)) {
    if (visiting.has(value)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a cyclic value.");
    }
    visiting.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (budget.remaining <= 0) {
        throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs exceeds the maximum bounded item count.");
      }
      budget.remaining -= 1;
      if (hasControlCharacter(key)) {
        throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a key with a control character.");
      }
      if (key.length > MAX_CHAT_TEMPLATE_KWARGS_STRING_LENGTH) {
        throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains a key exceeding the maximum bounded length.");
      }
      result[key] = validateBoundedJsonValue(entryValue, depth + 1, budget, visiting);
    }
    visiting.delete(value);
    return result;
  }
  // undefined, function, symbol, bigint, or a non-plain object (Date, Map, class instance, ...).
  throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs contains an unsupported value type.");
}

/**
 * A plain, JSON-safe object with a bounded serialized size -- optional
 * parity with python/mindmap.py's `llm_chat_template_kwargs` config for the
 * `openai_compatible` provider (`build_openai_compatible_chat_payload`).
 * Recursively validated by `validateBoundedJsonValue` (never trusts
 * `JSON.stringify` alone -- see that function's own comment), then
 * stringified/re-parsed as a final bounded-size confirmation of the exact
 * value that will be sent.
 */
function validateChatTemplateKwargs(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs must be a plain JSON object.");
  }
  const validated = validateBoundedJsonValue(value, 0, { remaining: MAX_CHAT_TEMPLATE_KWARGS_ITEMS }, new Set());
  const serialized = JSON.stringify(validated);
  if (serialized.length > MAX_CHAT_TEMPLATE_KWARGS_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "chatTemplateKwargs exceeds the maximum bounded serialized size.");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export interface OllamaMetadataConfig {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseChars?: number;
}

/** Ports the `provider == "ollama"` branch of `llm_extract`: `POST {baseUrl}/api/chat` with `{model, messages, format: "json", stream: false}`; content extracted from `response.message.content`. */
export function createOllamaMetadataProvider(config: OllamaMetadataConfig, deps: LocalMetadataProviderDeps): MetadataInferenceProvider {
  const { baseUrl } = validateLoopbackEndpoint(config.baseUrl, "METADATA_ENDPOINT_INVALID", "Ollama metadata");
  const timeoutMs = clampTimeout(config.timeoutMs, "METADATA_ENDPOINT_INVALID");
  const maxResponseChars = clampMaxResponseChars(config.maxResponseChars);

  return {
    async complete(request: MetadataInferenceRequest, options: MetadataInferenceProviderCallOptions = {}): Promise<string> {
      const model = validateModel(request.model);
      validateChatMessages(request.messages);
      validateMaxTokens(request.maxTokens);
      const body = JSON.stringify({ model, messages: request.messages, format: "json", stream: false });
      assertBoundedBody(body);
      const text = await postJson(deps.fetchImpl, `${baseUrl}/api/chat`, body, {}, timeoutMs, maxResponseChars, options.signal);
      const parsed = parseJsonObject(text);
      const message = parsed.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        throw new EngineError("METADATA_RESPONSE_INVALID", "Ollama metadata response did not contain a message object.");
      }
      const content = (message as Record<string, unknown>).content;
      if (typeof content !== "string") {
        throw new EngineError("METADATA_RESPONSE_INVALID", "Ollama metadata response did not contain string content.");
      }
      return assertNonBlankContent(content);
    },
  };
}

export interface OpenAiCompatibleMetadataConfig {
  baseUrl: string;
  timeoutMs?: number;
  maxResponseChars?: number;
  /** Optional API key for a local OpenAI-compatible server only -- never used for a remote endpoint, since `validateLoopbackEndpoint` rejects any non-loopback `baseUrl` before this is ever read. */
  apiKey?: string;
  /** Optional parity with python/mindmap.py's `llm_chat_template_kwargs` -- a plain, JSON-safe object with a bounded serialized size (see `validateChatTemplateKwargs`), forwarded as `chat_template_kwargs` in the request body only when provided. */
  chatTemplateKwargs?: Record<string, unknown>;
}

/**
 * Extracts `message.content`, either a plain string or an array of
 * `{text: string}`-shaped parts (some OpenAI-compatible servers return
 * content this way). Any array entry that is neither a string nor a
 * `{text: string}` object fails the whole response closed rather than
 * being silently skipped -- an unrecognized part could be carrying real
 * content this adapter would otherwise drop without any signal.
 */
function extractOpenAiCompatibleContent(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Local OpenAI-compatible metadata response did not contain a message object.");
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return assertNonBlankContent(content);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as Record<string, unknown>).text === "string") {
        parts.push((item as Record<string, unknown>).text as string);
        continue;
      }
      throw new EngineError("METADATA_RESPONSE_INVALID", "Local OpenAI-compatible metadata response contained an unrecognized content part.");
    }
    return assertNonBlankContent(parts.join(""));
  }
  throw new EngineError("METADATA_RESPONSE_INVALID", "Local OpenAI-compatible metadata response did not contain usable content.");
}

/** Ports the `provider == "openai_compatible"` branch of `llm_extract`: `POST {baseUrl}/chat/completions` with a `response_format: {type: "json_object"}` chat payload; content extracted from `response.choices[0].message.content` (string, or an array of `{text}`-shaped parts). */
export function createOpenAiCompatibleMetadataProvider(config: OpenAiCompatibleMetadataConfig, deps: LocalMetadataProviderDeps): MetadataInferenceProvider {
  const { baseUrl } = validateLoopbackEndpoint(config.baseUrl, "METADATA_ENDPOINT_INVALID", "Local OpenAI-compatible metadata");
  const timeoutMs = clampTimeout(config.timeoutMs, "METADATA_ENDPOINT_INVALID");
  const maxResponseChars = clampMaxResponseChars(config.maxResponseChars);
  const apiKey = config.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length > 0) {
    validateBoundedIdentifier(apiKey, "Local OpenAI-compatible metadata config.apiKey", "METADATA_ENDPOINT_INVALID", MAX_API_KEY_LENGTH);
  }
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const chatTemplateKwargs = validateChatTemplateKwargs(config.chatTemplateKwargs);

  return {
    async complete(request: MetadataInferenceRequest, options: MetadataInferenceProviderCallOptions = {}): Promise<string> {
      const model = validateModel(request.model);
      validateChatMessages(request.messages);
      const maxTokens = validateMaxTokens(request.maxTokens);
      const payload: Record<string, unknown> = {
        model,
        messages: request.messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        stream: false,
      };
      if (chatTemplateKwargs) {
        payload.chat_template_kwargs = chatTemplateKwargs;
      }
      const body = JSON.stringify(payload);
      assertBoundedBody(body);
      const text = await postJson(deps.fetchImpl, `${baseUrl}/chat/completions`, body, headers, timeoutMs, maxResponseChars, options.signal);
      const parsed = parseJsonObject(text);
      const choices = parsed.choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        throw new EngineError("METADATA_RESPONSE_INVALID", "Local OpenAI-compatible metadata response did not contain choices.");
      }
      const message = (choices[0] as Record<string, unknown> | undefined)?.message;
      return extractOpenAiCompatibleContent(message);
    },
  };
}
