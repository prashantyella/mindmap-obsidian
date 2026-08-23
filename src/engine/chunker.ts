import { EngineError } from "./errors";

/**
 * Ports `chunk_text` from python/mindmap.py behaviorally: whitespace-delimited
 * word chunking with a target size and a trailing overlap, both floored at a
 * minimum word count. See `tests/fixtures/engine/chunking.json` for the
 * golden parity cases this must match exactly.
 */
export interface ChunkOptions {
  targetTokens: number;
  overlapTokens: number;
}

/** Mirrors the production config values recorded in `tests/fixtures/engine/chunking.json`. */
export const DEFAULT_TARGET_TOKENS = 400;
export const DEFAULT_OVERLAP_TOKENS = 40;

const MIN_TARGET_WORDS = 50;
const MIN_OVERLAP_WORDS = 10;
/** Guards against an unbounded input wedging the chunker; well above any real note's size. */
const MAX_CHUNK_INPUT_CHARS = 2_000_000;

/** Configured-token sanity ceilings, independent of the `overlapWords < targetWords` progress check below (which is the actual guarantee `start` always advances -- these two constants alone don't prevent a config where the *effective*, floored overlap still reaches or exceeds the effective target). */
const MAX_OVERLAP_TOKENS = 5_000_000;
const MAX_TARGET_TOKENS = 5_000_000;

function assertBounded(text: string, options: ChunkOptions): void {
  if (text.length > MAX_CHUNK_INPUT_CHARS) {
    throw new EngineError("CHUNK_INPUT_INVALID", "Chunker input exceeds the maximum bounded character length.", { length: text.length, maxChars: MAX_CHUNK_INPUT_CHARS });
  }
  if (!Number.isInteger(options.targetTokens) || options.targetTokens <= 0 || options.targetTokens > MAX_TARGET_TOKENS) {
    throw new EngineError("CHUNK_INPUT_INVALID", "Chunker targetTokens must be a positive integer within the bounded range.", { maxTargetTokens: MAX_TARGET_TOKENS });
  }
  if (!Number.isInteger(options.overlapTokens) || options.overlapTokens < 0 || options.overlapTokens > MAX_OVERLAP_TOKENS) {
    throw new EngineError("CHUNK_INPUT_INVALID", "Chunker overlapTokens must be a non-negative integer within the bounded range.", { maxOverlapTokens: MAX_OVERLAP_TOKENS });
  }
  const targetWords = Math.max(MIN_TARGET_WORDS, Math.trunc(options.targetTokens * 0.75));
  const overlapWords = Math.max(MIN_OVERLAP_WORDS, Math.trunc(options.overlapTokens * 0.75));
  if (overlapWords >= targetWords) {
    throw new EngineError(
      "CHUNK_INPUT_INVALID",
      "Chunker overlapTokens is too large relative to targetTokens; the effective overlap must be strictly smaller than the effective target chunk size, or chunking never progresses.",
      { targetWords, overlapWords },
    );
  }
}

/**
 * Deterministic Unicode/newline normalization ahead of word-splitting:
 * NFC-normalizes the text, then splits on any run of Unicode whitespace
 * (matching Python's whitespace-arg-less `str.split()`). Because chunks are
 * rejoined with a single ASCII space, LF, CRLF, and CR inputs that differ
 * only in newline convention or in interior run-length of whitespace already
 * produce byte-identical chunks -- there is no separate "convert CRLF to LF"
 * step needed beyond this splitting.
 */
function splitWords(text: string): string[] {
  const normalized = text.normalize("NFC");
  const trimmed = normalized.trim();
  if (trimmed === "") return [];
  return trimmed.split(/\s+/u);
}

export function chunkText(text: string, options: ChunkOptions = { targetTokens: DEFAULT_TARGET_TOKENS, overlapTokens: DEFAULT_OVERLAP_TOKENS }): string[] {
  assertBounded(text, options);
  const words = splitWords(text);
  if (words.length === 0) return [];

  const targetWords = Math.max(MIN_TARGET_WORDS, Math.trunc(options.targetTokens * 0.75));
  const overlapWords = Math.max(MIN_OVERLAP_WORDS, Math.trunc(options.overlapTokens * 0.75));

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(words.length, start + targetWords);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = Math.max(0, end - overlapWords);
  }
  return chunks;
}
