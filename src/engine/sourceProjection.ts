import { createHash } from "node:crypto";

import type { NoteIdentityV1, SourceProjectionV1 } from "./contracts";

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

const DEFAULT_MINDMAP_HEADING = "## Mindmap";
const LEGACY_MINDMAP_HEADINGS = new Set(["## related", "## mindmap"]);
const MANAGED_CALLOUT_PATTERN = /^>\s*\[!.*\]-\s*(mindmap|related)\s*$/i;

export const MANAGED_SECTION_RELATED = "related-section";

interface SplitFrontmatter {
  frontmatterRaw: string | null;
  body: string;
}

/**
 * Mirrors `split_frontmatter` in python/mindmap.py: the frontmatter block is
 * only recognized when the document opens with `---` and a matching closing
 * `---` line follows. Anything else (no frontmatter, unterminated block) is
 * treated as body-only, exactly like the Python oracle.
 */
function splitFrontmatter(text: string): SplitFrontmatter {
  if (!text.startsWith("---")) {
    return { frontmatterRaw: null, body: text };
  }
  const lines = text.split(/(?<=\n)/);
  if (lines.length < 2) {
    return { frontmatterRaw: null, body: text };
  }
  let offset = lines[0].length;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      const frontmatterRaw = text.slice(lines[0].length, offset);
      const body = text.slice(offset + line.length);
      return { frontmatterRaw, body };
    }
    offset += line.length;
  }
  return { frontmatterRaw: null, body: text };
}

interface FrontmatterBlock {
  key: string | null;
  raw: string;
}

const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s|$)/;
/** A YAML continuation line: indented (space/tab), or an unindented block-sequence marker (`- item`) directly under its key. */
const CONTINUATION_LINE_PATTERN = /^[ \t]|^-(?:\s|$)/;

function stripLineTerminator(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function isBlankLine(line: string): boolean {
  return stripLineTerminator(line) === "";
}

/**
 * Splits a YAML frontmatter block into top-level key blocks (a key line
 * plus every following continuation line) preserving original order and
 * bytes. This is a projection helper only — it is not a general YAML
 * parser and makes no attempt at semantic fidelity beyond "which top-level
 * key does this line belong to," which is all a managed-key exclusion for
 * hashing needs. The full round-trip-preserving YAML engine is Checkpoint
 * 2's `FrontmatterEngine`.
 *
 * Two things are NOT treated as a continuation of the current key, even
 * immediately after it, and always survive as their own free-standing
 * block (`key: null`) so key exclusion can never remove them:
 *
 * - a column-0 comment or other non-blank column-0 line;
 * - a blank line that is not internal to a multi-line indented block —
 *   i.e. one whose next non-blank line is a new top-level key, a
 *   column-0 comment, or end of frontmatter.
 *
 * A blank line IS still absorbed into the current key's block when the
 * next non-blank line is itself an indented continuation (a block
 * scalar/sequence, e.g. `summary: |`, can legitimately contain blank
 * lines inside its own value). Without this lookahead, a blank line
 * inside a managed multi-line value would reset `current`, and the
 * indented text after it would leak into the projection as ordinary user
 * content — silently re-triggering processing every time Mindmap
 * regenerates that value with different line counts/wrapping.
 */
function splitFrontmatterBlocks(frontmatterRaw: string): FrontmatterBlock[] {
  const lines = frontmatterRaw.split(/(?<=\n)/);
  const blocks: FrontmatterBlock[] = [];
  let current: FrontmatterBlock | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const keyMatch = TOP_LEVEL_KEY_PATTERN.exec(line);
    if (keyMatch) {
      current = { key: keyMatch[1], raw: line };
      blocks.push(current);
      index += 1;
      continue;
    }
    if (isBlankLine(line)) {
      let runEnd = index;
      while (runEnd < lines.length && isBlankLine(lines[runEnd])) {
        runEnd += 1;
      }
      const nextLine = lines[runEnd];
      const nextContinuesBlock = nextLine !== undefined && CONTINUATION_LINE_PATTERN.test(nextLine);
      if (current && nextContinuesBlock) {
        for (let cursor = index; cursor < runEnd; cursor += 1) {
          current.raw += lines[cursor];
        }
        index = runEnd;
        continue;
      }
      for (let cursor = index; cursor < runEnd; cursor += 1) {
        blocks.push({ key: null, raw: lines[cursor] });
      }
      current = null;
      index = runEnd;
      continue;
    }
    if (current && CONTINUATION_LINE_PATTERN.test(line)) {
      current.raw += line;
      index += 1;
      continue;
    }
    current = null;
    blocks.push({ key: null, raw: line });
    index += 1;
  }
  return blocks;
}

/**
 * Removes Mindmap's managed frontmatter key blocks. Returns the remaining
 * blocks (order preserved) and which managed keys were actually present.
 */
function excludeManagedFrontmatterKeys(frontmatterRaw: string | null): { remainingRaw: string; excludedKeys: string[] } {
  if (frontmatterRaw === null) {
    return { remainingRaw: "", excludedKeys: [] };
  }
  const blocks = splitFrontmatterBlocks(frontmatterRaw);
  const excludedKeys: string[] = [];
  const remaining: string[] = [];
  for (const block of blocks) {
    if (block.key !== null && MANAGED_FRONTMATTER_KEYS.includes(block.key)) {
      excludedKeys.push(block.key);
      continue;
    }
    remaining.push(block.raw);
  }
  return { remainingRaw: remaining.join(""), excludedKeys };
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
function stripManagedRelatedSection(body: string, heading: string = DEFAULT_MINDMAP_HEADING): { text: string; changed: boolean } {
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
