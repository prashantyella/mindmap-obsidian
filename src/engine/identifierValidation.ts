import type { EngineErrorCode } from "./errors";
import { EngineError } from "./errors";
import { hasControlCharacter } from "./controlCharacters";

/**
 * Bounded, control-free, non-blank identifier (a model name, a caller-
 * assigned correlation id) -- never a path, where leading/trailing
 * whitespace can be meaningful filename bytes (see canonicalizePath in
 * contracts.ts). Returns the trimmed value. The thrown error never
 * includes value itself: a correlation id may be a note path, and a
 * model name, while not typically sensitive, is kept out of error context
 * on the same static-redacted-errors principle the rest of this seam
 * follows.
 */
export function validateBoundedIdentifier(value: unknown, field: string, errorCode: EngineErrorCode, maxLength: number): string {
  if (typeof value !== "string") {
    throw new EngineError(errorCode, `${field} must be a string.`, { field });
  }
  if (hasControlCharacter(value)) {
    throw new EngineError(errorCode, `${field} must not contain control characters.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new EngineError(errorCode, `${field} must be a non-empty identifier.`, { field });
  }
  if (trimmed.length > maxLength) {
    throw new EngineError(errorCode, `${field} exceeds the maximum bounded length.`, { field, maxLength });
  }
  return trimmed;
}

/**
 * Strict correlation-ID validator: unlike validateBoundedIdentifier, this
 * NEVER trims -- a caller-assigned correlation ID (e.g. an embedding
 * request item's id) is an opaque token a caller expects echoed back
 * byte-identical, not a display-oriented identifier where surrounding
 * whitespace is obviously accidental. An ID with leading/trailing
 * whitespace, a control character, or that is empty/too long is rejected
 * outright rather than silently normalized, so the "echoed back unchanged"
 * contract can never be silently violated by trimming.
 */
export function validateCorrelationId(value: unknown, field: string, errorCode: EngineErrorCode, maxLength: number): string {
  if (typeof value !== "string") {
    throw new EngineError(errorCode, `${field} must be a string.`, { field });
  }
  if (value.length === 0) {
    throw new EngineError(errorCode, `${field} must be a non-empty identifier.`, { field });
  }
  if (value.length > maxLength) {
    throw new EngineError(errorCode, `${field} exceeds the maximum bounded length.`, { field, maxLength });
  }
  if (hasControlCharacter(value)) {
    throw new EngineError(errorCode, `${field} must not contain control characters.`, { field });
  }
  if (value.trim() !== value) {
    throw new EngineError(errorCode, `${field} must not have leading or trailing whitespace.`, { field });
  }
  return value;
}
