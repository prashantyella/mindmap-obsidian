import { parseDocument } from "yaml";

import { EngineError } from "./errors";
import {
  detectNewline,
  parseFrontmatterKeyRanges,
  serializeFrontmatterKeyLine,
  splitFrontmatter,
  toNoteNewline,
} from "./frontmatterCore";

/**
 * Mirrors `parse_frontmatter` in python/mindmap.py for the read-only case:
 * a missing/absent frontmatter block yields `{}`, and non-mapping YAML also
 * degrades to `{}` rather than throwing (this function never mutates, so
 * there is nothing to fail closed on writing).
 */
export function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const { frontmatterRaw, body } = splitFrontmatter(text);
  if (frontmatterRaw === null) {
    return { frontmatter: {}, body: text };
  }
  const parsed = parseFrontmatterKeyRanges(frontmatterRaw);
  if (!parsed.ok) {
    return { frontmatter: {}, body };
  }
  // parseFrontmatterKeyRanges already validated the document parses cleanly and is a mapping (or empty).
  if (frontmatterRaw.trim() === "") {
    return { frontmatter: {}, body };
  }
  const doc = parseDocument(frontmatterRaw, { uniqueKeys: true });
  const plain = doc.toJSON() as Record<string, unknown> | null;
  return { frontmatter: plain ?? {}, body };
}

export interface UpdateFrontmatterOptions {
  /** Key -> new value. Only keys present here are ever written. */
  updates: Record<string, unknown>;
  /** Determines the order newly-added (previously absent) keys are appended in; has no effect on keys that already exist (they keep their original position). */
  preferredOrder: string[];
  /** Keys to delete outright. Must be disjoint from `updates`. */
  removeKeys?: string[];
}

/**
 * Byte-exact frontmatter mutation: every key range not touched by
 * `updates`/`removeKeys` is copied verbatim from the source (comments,
 * quote style, block scalars, key order, unrelated fields all survive).
 * Updated keys are re-serialized in place at their original position;
 * newly-added keys are appended at the end of the frontmatter block, in
 * `preferredOrder` sequence, mirroring `update_frontmatter` in
 * python/mindmap.py. The whole document's newline convention (CRLF vs LF)
 * is preserved for both the frontmatter block and the body.
 *
 * A trailing same-line comment on a key survives too: an updated key keeps
 * its comment reattached on the same line as the new value; a removed key
 * (e.g. Apple annotation notes clearing `summary`/`tags`) leaves its
 * comment behind as a standalone comment line instead of deleting it. A
 * comment on its own line (before a key, or after a multi-line block value)
 * is never inside any key's range to begin with, so it already survives
 * untouched regardless of what happens to the keys around it.
 *
 * Throws `EngineError("FRONTMATTER_MALFORMED", ...)` -- performing no
 * mutation -- when an existing frontmatter block is not valid, unique-keyed
 * YAML, or its root is not a mapping. A note with no frontmatter block at
 * all is not malformed; a fresh block is created.
 */
export function updateFrontmatter(rawContent: string, options: UpdateFrontmatterOptions): string {
  const removeKeys = new Set(options.removeKeys ?? []);
  for (const key of removeKeys) {
    if (Object.prototype.hasOwnProperty.call(options.updates, key)) {
      throw new EngineError("FRONTMATTER_MALFORMED", `Key "${key}" cannot be both updated and removed.`, { key });
    }
  }

  const { frontmatterRaw, body } = splitFrontmatter(rawContent);
  const newline = detectNewline(rawContent);
  const sourceRaw = frontmatterRaw ?? "";

  const parsed = parseFrontmatterKeyRanges(sourceRaw);
  if (!parsed.ok) {
    throw new EngineError("FRONTMATTER_MALFORMED", `Frontmatter is not valid YAML: ${parsed.reason}`, { reason: parsed.reason });
  }

  const existingKeys = new Set(parsed.ranges.map((range) => range.key));

  let result = "";
  let cursor = 0;
  for (const range of parsed.ranges) {
    result += sourceRaw.slice(cursor, range.start);
    const hasTrailingComment = range.commentBoundary !== range.end;
    // [commentBoundary, end) is a trailing same-line comment plus its original leading
    // whitespace and line terminator, verbatim -- user-authored content that must survive
    // both an update (reattached onto the freshly-serialized value, same line) and a removal
    // (kept on its own as a standalone comment line) rather than being silently dropped.
    const commentTail = hasTrailingComment ? sourceRaw.slice(range.commentBoundary, range.end) : "";
    if (removeKeys.has(range.key)) {
      result += commentTail;
    } else if (Object.prototype.hasOwnProperty.call(options.updates, range.key)) {
      if (hasTrailingComment) {
        const serializedLine = serializeFrontmatterKeyLine(range.key, options.updates[range.key]).replace(/\n$/, "");
        result += toNoteNewline(serializedLine, newline) + commentTail;
      } else {
        result += toNoteNewline(serializeFrontmatterKeyLine(range.key, options.updates[range.key]), newline);
      }
    } else {
      result += sourceRaw.slice(range.start, range.end);
    }
    cursor = range.end;
  }
  result += sourceRaw.slice(cursor);

  const appendedKeys = new Set<string>();
  for (const key of options.preferredOrder) {
    if (
      Object.prototype.hasOwnProperty.call(options.updates, key) &&
      !existingKeys.has(key) &&
      !removeKeys.has(key) &&
      !appendedKeys.has(key)
    ) {
      result += toNoteNewline(serializeFrontmatterKeyLine(key, options.updates[key]), newline);
      appendedKeys.add(key);
    }
  }
  for (const key of Object.keys(options.updates)) {
    if (!existingKeys.has(key) && !removeKeys.has(key) && !appendedKeys.has(key)) {
      result += toNoteNewline(serializeFrontmatterKeyLine(key, options.updates[key]), newline);
      appendedKeys.add(key);
    }
  }

  if (result !== "" && !result.endsWith(newline)) {
    result += newline;
  }

  const openDelimiter = `---${newline}`;
  const closeDelimiter = "---";
  if (frontmatterRaw === null) {
    return `${openDelimiter}${result}${closeDelimiter}${newline}${body}`;
  }
  const bodySeparator = body.startsWith(newline) ? body : `${newline}${body}`;
  return `${openDelimiter}${result}${closeDelimiter}${bodySeparator}`;
}
