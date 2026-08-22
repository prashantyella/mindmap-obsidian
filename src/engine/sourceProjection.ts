import { createHash } from "node:crypto";

import type { NoteIdentityV1, SourceProjectionV1 } from "./contracts";
import { parseFrontmatterKeyRanges, splitFrontmatter as splitFrontmatterCore } from "./frontmatterCore";

/**
 * Frontmatter keys Mindmap writes as generated output (see
 * `build_metadata_updates` in python/mindmap.py and its TypeScript
 * counterparts). Excluding exactly these keys — never guessing at
 * "unknown" keys — keeps every other user-authored frontmatter field,
 * including fields Mindmap doesn't know about, inside the projection.
 *
 * The Reading annotation quote/user-note content (whether behind the
 * legacy `mindmap:apple-books-source` markers or the current leading
 * blockquote format) is deliberately NOT excluded anywhere in this module:
 * it is Mindmap's processing *input* (the annotation source text), not
 * generated output, so a changed quote must change `sourceHash` the same
 * way any other body edit does.
 */
export const MANAGED_FRONTMATTER_KEYS: readonly string[] = ["summary", "tags", "concepts", "related"];

export const DEFAULT_MINDMAP_HEADING = "## Mindmap";
const LEGACY_MINDMAP_HEADINGS = new Set(["## related", "## mindmap"]);
const MANAGED_CALLOUT_PATTERN = /^>\s*\[!.*\]-\s*(mindmap|related)\s*$/i;

export const MANAGED_SECTION_RELATED = "related-section";

type SplitFrontmatter = ReturnType<typeof splitFrontmatterCore>;

/**
 * Mirrors `split_frontmatter` in python/mindmap.py: the frontmatter block is
 * only recognized when the document opens with `---` and a matching closing
 * `---` line follows. Anything else (no frontmatter, unterminated block) is
 * treated as body-only, exactly like the Python oracle.
 */
function splitFrontmatter(text: string): SplitFrontmatter {
  return splitFrontmatterCore(text);
}

/**
 * Removes Mindmap's managed frontmatter key blocks using the real YAML
 * parser's key ranges (`parseFrontmatterKeyRanges`) rather than a line-based
 * regex heuristic, so quoted keys, flow mappings, and other YAML shapes the
 * old heuristic could misread are excluded/retained correctly. Byte ranges
 * between/around managed keys (comments, blank lines, unrelated fields) are
 * always copied verbatim.
 *
 * When the frontmatter fails to parse as YAML or its root is not a mapping,
 * this fails safe for a read-only hash computation: nothing is excluded
 * (the whole frontmatter block stays hash-relevant) rather than throwing —
 * mutation's fail-closed behavior lives in `FrontmatterEngine`, not here.
 */
function excludeManagedFrontmatterKeys(frontmatterRaw: string | null): { remainingRaw: string; excludedKeys: string[] } {
  if (frontmatterRaw === null) {
    return { remainingRaw: "", excludedKeys: [] };
  }
  const parsed = parseFrontmatterKeyRanges(frontmatterRaw);
  if (!parsed.ok) {
    return { remainingRaw: frontmatterRaw, excludedKeys: [] };
  }
  const excludedKeys: string[] = [];
  let remaining = "";
  let cursor = 0;
  for (const range of parsed.ranges) {
    if (!MANAGED_FRONTMATTER_KEYS.includes(range.key)) continue;
    remaining += frontmatterRaw.slice(cursor, range.start);
    excludedKeys.push(range.key);
    // Only the `key: value` content itself is excluded/generated output. A trailing same-line
    // comment (commentBoundary < end) is user-authored, byte-preserved, and stays hash-relevant --
    // cursor stops at commentBoundary, not end, so [commentBoundary, end) rejoins `remaining` below
    // (either via the next iteration's leading slice, or the final flush).
    cursor = range.commentBoundary;
  }
  remaining += frontmatterRaw.slice(cursor);
  return { remainingRaw: remaining, excludedKeys };
}

interface LineToken {
  content: string;
  terminator: "" | "\n" | "\r\n";
}

/** Splits on line boundaries while preserving each line's original terminator (or none, for the final line), so a CRLF body stays CRLF after stripping. */
function tokenizeLines(text: string): LineToken[] {
  const tokens: LineToken[] = [];
  let pos = 0;
  while (pos <= text.length) {
    const newline = text.indexOf("\n", pos);
    if (newline === -1) {
      tokens.push({ content: text.slice(pos), terminator: "" });
      break;
    }
    const hasCr = newline > pos && text[newline - 1] === "\r";
    const contentEnd = hasCr ? newline - 1 : newline;
    tokens.push({ content: text.slice(pos, contentEnd), terminator: hasCr ? "\r\n" : "\n" });
    pos = newline + 1;
  }
  return tokens;
}

function joinLines(tokens: LineToken[]): string {
  return tokens.map((token) => token.content + token.terminator).join("");
}

/**
 * Exact legacy marker line shape: an HTML comment whose entire (trimmed)
 * content is the marker, nothing else — e.g. `<!-- mindmap:start -->`.
 * Case-insensitive and tolerant of the whitespace around `mindmap:start`/
 * `mindmap:end` inside the comment, but the line as a whole must be
 * exactly that comment. A sentence that merely mentions the words
 * "mindmap:start"/"mindmap:end" is not this shape and never matches.
 */
const LEGACY_MARKER_START_PATTERN = /^<!--\s*mindmap:start\s*-->$/i;
const LEGACY_MARKER_END_PATTERN = /^<!--\s*mindmap:end\s*-->$/i;

/**
 * Removes exactly one well-formed legacy `mindmap:start`/`mindmap:end`
 * marker region: exactly one exact-shape start-marker line, exactly one
 * exact-shape end-marker line, start strictly before end. The entire
 * inclusive range is removed (the whole region the markers wrap), not
 * just the marker lines themselves.
 *
 * Any other shape — no markers, an orphan (only one of the pair),
 * duplicated markers, or a reversed pair (end before start) — is left
 * completely untouched: it fails closed as ordinary user content rather
 * than guessing at intent. Because matching requires the exact marker
 * line shape rather than a substring, ordinary prose that happens to
 * mention "mindmap:start"/"mindmap:end" — even split across two separate
 * lines, one containing each word — is never mistaken for a marker pair
 * and always stays in the projection, hash-relevant.
 */
function stripLegacyMarkerPair(tokens: LineToken[]): { tokens: LineToken[]; changed: boolean } {
  const startIndices: number[] = [];
  const endIndices: number[] = [];
  tokens.forEach((token, index) => {
    const trimmed = token.content.trim();
    if (LEGACY_MARKER_START_PATTERN.test(trimmed)) startIndices.push(index);
    if (LEGACY_MARKER_END_PATTERN.test(trimmed)) endIndices.push(index);
  });
  if (startIndices.length !== 1 || endIndices.length !== 1 || startIndices[0] >= endIndices[0]) {
    return { tokens, changed: false };
  }
  const start = startIndices[0];
  const end = endIndices[0];
  return { tokens: [...tokens.slice(0, start), ...tokens.slice(end + 1)], changed: true };
}

/**
 * Mirrors `strip_trailing_dividers` in python/mindmap.py, which
 * `update_related_section` always runs on the pre-existing body
 * immediately before appending its own `"\n\n---\n\n" + calloutBlock`.
 * Repeatedly strips trailing blank lines, then a trailing `---` divider
 * line, then the blank lines around it, for as long as the last
 * non-blank line is a divider. Applying the identical algorithm here when
 * removing the callout reconstructs exactly the body Mindmap started
 * from, so a body with no managed section and that same body after
 * Mindmap has written its callout output hash identically.
 */
function stripTrailingDividerRun(tokens: LineToken[]): LineToken[] {
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].content.trim() === "") {
    end -= 1;
  }
  while (end > 0 && tokens[end - 1].content.trim() === "---") {
    end -= 1;
    while (end > 0 && tokens[end - 1].content.trim() === "") {
      end -= 1;
    }
  }
  return tokens.slice(0, end);
}

/**
 * Removes the first `> [!...]- Mindmap`/`> [!...]- Related` callout block
 * (the current related-section output format) together with its owned
 * preceding blank-line/`---`-divider run — see `stripTrailingDividerRun`.
 * Only the divider run immediately preceding the callout is owned by it;
 * everything before that divider run is left untouched.
 */
function stripCalloutAndOwnedDivider(tokens: LineToken[]): { tokens: LineToken[]; changed: boolean } {
  const start = tokens.findIndex((token) => MANAGED_CALLOUT_PATTERN.test(token.content.trim()));
  if (start === -1) {
    return { tokens, changed: false };
  }
  let end = start + 1;
  while (end < tokens.length && tokens[end].content.startsWith(">")) {
    end += 1;
  }
  const prefix = stripTrailingDividerRun(tokens.slice(0, start));
  const suffix = tokens.slice(end);
  return { tokens: [...prefix, ...suffix], changed: true };
}

/**
 * Mirrors `strip_related_section` in python/mindmap.py, plus the divider
 * ownership `update_related_section` relies on when it regenerates output
 * (see `stripCalloutAndOwnedDivider`): a complete legacy
 * `mindmap:start`/`mindmap:end` marker region, legacy `## Related`/
 * `## Mindmap` headings (and their body until the next heading), and the
 * current `> [!...]- Mindmap`/`> [!...]- Related` callout block (with its
 * owned preceding divider) are all Mindmap-managed and excluded from the
 * source projection. Original line terminators are preserved on every
 * surviving line — this strips managed content, it never normalizes
 * newline convention.
 *
 * This is the ONLY body content this module excludes. Reading annotation
 * quote/source content is never touched here (see the module-level note on
 * `MANAGED_FRONTMATTER_KEYS`).
 */
export function stripManagedRelatedSection(body: string, heading: string = DEFAULT_MINDMAP_HEADING): { text: string; changed: boolean } {
  const originalTokens = tokenizeLines(body);
  let tokens = originalTokens;
  let changed = false;

  const markerResult = stripLegacyMarkerPair(tokens);
  tokens = markerResult.tokens;
  changed = changed || markerResult.changed;

  const headingLine = heading.trim().toLowerCase();
  const legacyHeadings = new Set([headingLine, ...LEGACY_MINDMAP_HEADINGS]);
  {
    const cleaned: LineToken[] = [];
    let index = 0;
    const before = tokens.length;
    while (index < tokens.length) {
      if (legacyHeadings.has(tokens[index].content.trim().toLowerCase())) {
        index += 1;
        while (index < tokens.length && !tokens[index].content.startsWith("#")) {
          index += 1;
        }
        continue;
      }
      cleaned.push(tokens[index]);
      index += 1;
    }
    tokens = cleaned;
    changed = changed || tokens.length !== before;
  }

  const calloutResult = stripCalloutAndOwnedDivider(tokens);
  tokens = calloutResult.tokens;
  changed = changed || calloutResult.changed;

  return { text: joinLines(tokens), changed };
}

/**
 * Normalizes CRLF/CR to LF for hashing only. The returned projection's
 * `projectedBody`/`projectedFrontmatterJson` retain whatever newline
 * convention the original note used; only the hash input is normalized, so
 * a CRLF note and its LF-converted twin produce the same `sourceHash`
 * without Mindmap ever rewriting the original bytes.
 */
function normalizeNewlinesForHashing(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** JSON-encodes the surviving frontmatter text verbatim (original bytes, including CRLF) — normalization happens only in the separate hash input, never here. */
function canonicalFrontmatterJson(remainingRaw: string): string {
  return JSON.stringify(remainingRaw);
}

export interface ProjectSourceOptions {
  mindmapHeading?: string;
}

/**
 * Pure projection + `sourceHash` seam. Input is the note's current raw
 * content (frontmatter + body, original bytes). Output excludes only
 * Mindmap-managed frontmatter keys (`MANAGED_FRONTMATTER_KEYS`) and the
 * managed Mindmap/Related body section, preserves every other
 * user-authored key/section verbatim — including Reading annotation
 * quote/source content, which is processing input rather than generated
 * output — and normalizes newlines only inside the hash computation.
 */
export function projectSource(
  identity: NoteIdentityV1,
  rawContent: string,
  options: ProjectSourceOptions = {},
): SourceProjectionV1 {
  const { frontmatterRaw, body } = splitFrontmatter(rawContent);
  const { remainingRaw, excludedKeys } = excludeManagedFrontmatterKeys(frontmatterRaw);

  const excludedManagedSections: string[] = [];
  const afterRelated = stripManagedRelatedSection(body, options.mindmapHeading);
  if (afterRelated.changed) {
    excludedManagedSections.push(MANAGED_SECTION_RELATED);
  }

  const projectedFrontmatterJson = canonicalFrontmatterJson(remainingRaw);
  const projectedBody = afterRelated.text;
  const hashInput = `${JSON.stringify(normalizeNewlinesForHashing(remainingRaw))}\n${normalizeNewlinesForHashing(projectedBody)}`;

  return {
    schemaVersion: 1,
    identity,
    projectedFrontmatterJson,
    projectedBody,
    excludedFrontmatterKeys: excludedKeys,
    excludedManagedSections,
    sourceHash: sha256Hex(hashInput),
  };
}
