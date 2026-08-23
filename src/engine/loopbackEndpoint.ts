import type { EngineErrorCode } from "./errors";
import { hasControlCharacter } from "./controlCharacters";
import { EngineError } from "./errors";

const ALLOWED_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface LoopbackEndpoint {
  /**
   * `origin` + normalized `pathname` only (trailing slashes stripped, no
   * query string, fragment, or credentials) -- safe to concatenate a fixed
   * API path (e.g. `/api/embed`) directly onto, since a stray `?x=1` or
   * `#frag` in the configured URL can never leak into that concatenation.
   */
  baseUrl: string;
}

/**
 * Shared loopback-only endpoint policy for every local inference adapter
 * (Ollama embeddings, Ollama/OpenAI-compatible metadata): HTTP(S) only,
 * hostname restricted to `localhost`/`127.0.0.1`/`::1`, no embedded
 * credentials, no query string, no fragment, no `..` path segment. Each
 * caller passes its own `errorCode` (so a caller's tests can assert on its
 * own contract's error taxonomy) and a `label` used only in the static
 * message, never echoing `rawUrl` itself back into the error.
 */
export function validateLoopbackEndpoint(rawUrl: string, errorCode: EngineErrorCode, label: string): LoopbackEndpoint {
  if (typeof rawUrl !== "string" || hasControlCharacter(rawUrl)) {
    throw new EngineError(errorCode, `${label} endpoint is invalid.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new EngineError(errorCode, `${label} endpoint is invalid.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new EngineError(errorCode, `${label} endpoint must be HTTP(S).`);
  }
  if (!ALLOWED_LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new EngineError(errorCode, `${label} endpoint must be a loopback address. Remote endpoints are not supported.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new EngineError(errorCode, `${label} endpoint must not include embedded credentials.`);
  }
  if (parsed.search !== "") {
    throw new EngineError(errorCode, `${label} endpoint must not include a query string.`);
  }
  if (parsed.hash !== "") {
    throw new EngineError(errorCode, `${label} endpoint must not include a fragment.`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.split("/").includes("..")) {
    throw new EngineError(errorCode, `${label} endpoint path must not contain "..".`);
  }
  return { baseUrl: `${parsed.origin}${pathname}` };
}
