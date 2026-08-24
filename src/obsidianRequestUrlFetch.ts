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
  // Normalizing through the platform Request constructor (rather than
  // reading init.* directly) means a caller passing a Request as `input`
  // keeps its method/headers/body/signal even when `init` is omitted --
  // exactly like the global fetch it stands in for.
  const request = new Request(input, init);
  const signal = request.signal;

  if (signal.aborted) {
    throw abortError();
  }

  const method = request.method;
  const headers = normalizeHeaders(request.headers);
  // arrayBuffer() (not text()) so an arbitrary-bytes body survives
  // unchanged; requestUrl's RequestUrlParam.body accepts ArrayBuffer directly.
  const body = request.body === null ? undefined : await request.arrayBuffer();

  const pending = requestUrl({ url: request.url, method, headers, body, throw: false }).then((response) => new Response(response.text, {
    status: response.status,
    headers: response.headers,
  }));

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};
