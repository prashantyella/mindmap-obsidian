import { requestUrl } from "obsidian";

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => { record[key] = value; });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * A `fetch`-compatible adapter backed by Obsidian's `requestUrl`, so
 * production network calls go through the platform's own HTTP client
 * (avoids the raw global `fetch` the official Obsidian plugin guidelines
 * flag). Production callers (main.ts) pass this explicitly wherever a
 * `fetchImpl`-shaped seam is required (ExaResearchProvider,
 * createConfiguredLocalResearchModel); those modules take no default and
 * never import "obsidian" themselves, so their existing tests keep
 * injecting their own fakes unchanged.
 *
 * `requestUrl` has no native AbortSignal support, so a caller-provided
 * signal is honored by racing the request against a rejection that fires
 * on abort, mirroring `fetch`'s own AbortError so existing
 * `error.name === "AbortError"` timeout handling keeps working unchanged.
 * The underlying HTTP request may continue in the background after an
 * abort (requestUrl cannot cancel it), which only affects resource usage,
 * not the caller-visible timeout behavior.
 */
export const requestUrlFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers = normalizeHeaders(init?.headers);
  const body = typeof init?.body === "string" ? init.body : undefined;
  const signal = init?.signal ?? undefined;

  const request = requestUrl({ url, method, headers, body, throw: false }).then((response) => new Response(response.text, {
    status: response.status,
    headers: response.headers,
  }));

  if (!signal) {
    return await request;
  }
  if (signal.aborted) {
    throw abortError();
  }
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  return await Promise.race([request, aborted]);
};
