import { isSafeIndividualNotePath } from "./individualNote";
import {
  READING_SOURCE_END,
  READING_SOURCE_START,
  sanitizePathComponent,
  type AppleBooksAnnotation,
} from "./readingTypes";

const MAX_TITLE_WORDS = 12;
const PHRASE_BOUNDARY_PATTERN = /[.,:;!?]|--|—|–/;
const LEADING_STOPWORDS = new Set([
  "and", "but", "or", "so", "yet", "nor",
  "because", "since", "although", "though", "however", "well", "just",
]);

function stripMarkdownNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`/g, "")
    .replace(/\*\*|\*|__|_/g, "")
    .replace(/^#+\s*/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[[\]{}]/g, "")
    .replace(/[“”"]/g, "");
}

function normalizeForTitle(raw: string): string {
  const withoutControls = Array.from(raw.normalize("NFKC"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");
  return stripMarkdownNoise(withoutControls).replace(/\s+/g, " ").trim();
}

function stripLeadingStopwords(text: string): string {
  let result = text;
  while (true) {
    const match = /^([A-Za-z']+)[\s,:;-]+(.*)$/s.exec(result);
    if (!match) break;
    const [, word, rest] = match;
    if (!word || !LEADING_STOPWORDS.has(word.toLowerCase())) break;
    result = rest ?? "";
  }
  return result.trim();
}

function extractPhrase(text: string): string {
  const collapsed = text.replace(/\n+/g, " ").trim();
  const boundary = PHRASE_BOUNDARY_PATTERN.exec(collapsed);
  const candidate = boundary ? collapsed.slice(0, boundary.index) : collapsed;
  const words = candidate.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS);
  return words.join(" ");
}

function capitalizeFirst(text: string): string {
  const characters = Array.from(text);
  if (characters.length === 0) return text;
  characters[0] = characters[0].toUpperCase();
  return characters.join("");
}

function toTitleText(raw: string | undefined): string {
  if (!raw) return "";
  const normalized = normalizeForTitle(raw);
  if (!normalized) return "";
  const withoutStopwords = stripLeadingStopwords(normalized) || normalized;
  return capitalizeFirst(extractPhrase(withoutStopwords));
}

/**
 * Fallback order mirrors the design doc: quote, then Apple user note, then
 * chapter, then location, then a literal "Annotation" when nothing usable
 * survives normalization (e.g. a punctuation-only quote).
 */
export function deriveHumanTitle(
  annotation: Pick<AppleBooksAnnotation, "quote" | "user_note" | "chapter" | "location">,
): string {
  const candidates = [annotation.quote, annotation.user_note, annotation.chapter, annotation.location];
  for (const candidate of candidates) {
    const safe = sanitizePathComponent(toTitleText(candidate), "");
    if (safe) return safe;
  }
  return "Annotation";
}

export function humanTitleCandidate(title: string, collisionIndex = 0): string {
  return collisionIndex <= 0 ? `${title}.md` : `${title} · ${collisionIndex + 1}.md`;
}

function blockquoteLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const escaped = line.replace(/```/g, "\\`\\`\\`");
      return escaped.length ? `> ${escaped}` : ">";
    });
}

export function renderLeadingBlockquote(
  annotation: Pick<AppleBooksAnnotation, "quote" | "user_note">,
): string {
  const lines = blockquoteLines(annotation.quote);
  if (annotation.user_note) {
    lines.push(">", ...blockquoteLines(annotation.user_note));
  }
  return lines.join("\n");
}

interface LineToken {
  content: string;
  terminator: "" | "\n" | "\r\n";
}

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

function isBlockquoteLine(content: string | undefined): boolean {
  return content !== undefined && content.startsWith(">");
}

function detectNewline(tokens: LineToken[]): "\n" | "\r\n" {
  for (const token of tokens) {
    if (token.terminator === "\r\n" || token.terminator === "\n") {
      return token.terminator;
    }
  }
  return "\n";
}

function firstNonBlankIndex(tokens: LineToken[]): number {
  let index = 0;
  while (index < tokens.length && tokens[index]?.content === "") {
    index += 1;
  }
  return index;
}

export type ReplaceLeadingSourceResult =
  | { ok: true; text: string }
  | { ok: false; reason: "incomplete-managed-source-markers" };

/**
 * Replaces whatever currently occupies the leading managed-source region
 * (an old marker block, or an already-migrated leading blockquote, plus any
 * purely formatting blank lines immediately before it) with a freshly
 * rendered blockquote using the body's own newline convention. Everything
 * outside that region — including its original line-ending style — is
 * copied through untouched. Either an orphan start marker (no matching end)
 * or an orphan end marker (no preceding start) is refused rather than
 * risking a silent overwrite of unrelated content.
 */
export function replaceLeadingAnnotationSource(
  body: string,
  annotation: Pick<AppleBooksAnnotation, "quote" | "user_note">,
): ReplaceLeadingSourceResult {
  const tokens = tokenizeLines(body);
  const newline = detectNewline(tokens);
  const newTokens: LineToken[] = renderLeadingBlockquote(annotation)
    .split("\n")
    .map((content) => ({ content, terminator: newline }));

  const startIndex = tokens.findIndex((token) => token.content === READING_SOURCE_START);
  if (startIndex >= 0) {
    const endIndex = tokens.findIndex((token, index) => index > startIndex && token.content === READING_SOURCE_END);
    if (endIndex < 0) {
      return { ok: false, reason: "incomplete-managed-source-markers" };
    }
    return { ok: true, text: joinLines([...tokens.slice(0, startIndex), ...newTokens, ...tokens.slice(endIndex + 1)]) };
  }
  if (tokens.some((token) => token.content === READING_SOURCE_END)) {
    return { ok: false, reason: "incomplete-managed-source-markers" };
  }

  const leadingBlankEnd = firstNonBlankIndex(tokens);
  if (isBlockquoteLine(tokens[leadingBlankEnd]?.content)) {
    let end = leadingBlankEnd;
    while (end < tokens.length && isBlockquoteLine(tokens[end]?.content)) {
      end += 1;
    }
    return { ok: true, text: joinLines([...newTokens, ...tokens.slice(end)]) };
  }

  if (body.length === 0) {
    return { ok: true, text: joinLines(newTokens) };
  }

  return { ok: true, text: joinLines([...newTokens, { content: "", terminator: newline }, ...tokens]) };
}

function stripMarkdownExtension(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function conceptWikilink(concept: string): string {
  return `[[${sanitizePathComponent(concept, "Concept")}]]`;
}

export function conceptWikilinks(concepts: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const concept of concepts) {
    const link = conceptWikilink(concept);
    if (!seen.has(link)) {
      seen.add(link);
      result.push(link);
    }
  }
  return result;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function hasWikilinkDelimiter(value: string): boolean {
  return /[[\]|]/.test(value);
}

/** Reuses the general vault-relative Markdown path rules (not limited to Books/Apple Books), plus the extra checks a wikilink target needs. */
export function isSafeRelatedTarget(fullPath: string): boolean {
  return isSafeIndividualNotePath(fullPath) && !hasControlCharacter(fullPath) && !hasWikilinkDelimiter(fullPath);
}

export function relatedNoteWikilink(fullPath: string): string | undefined {
  if (!isSafeRelatedTarget(fullPath)) {
    return undefined;
  }
  const target = stripMarkdownExtension(fullPath);
  const label = target.split("/").pop() || target;
  return `[[${target}|${label}]]`;
}

export function relatedNoteWikilinks(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const link = relatedNoteWikilink(path);
    if (link && !seen.has(link)) {
      seen.add(link);
      result.push(link);
    }
  }
  return result;
}
