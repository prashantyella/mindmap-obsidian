import path from "node:path";

import { READING_INDEX_END, READING_INDEX_FILENAME, READING_INDEX_START } from "./readingTypes";

export const APPLE_BOOKS_ANNOTATION_MIN_WORDS = 8;
export const READING_NOTES_ROOT = "Books/Apple Books";

export interface IndividualNoteConfig {
  allScopeFolders: string[];
  minimumWords: number;
  runtimeFolder?: string;
  configDir?: string;
}

export interface ActiveNoteEligibility {
  path: string | null;
  eligible: boolean;
  reason: string;
  code: "none" | "not-markdown" | "unsafe-path" | "runtime-internal" | "out-of-scope" | "too-short" | "generated-index" | "eligible";
}

export const NO_ACTIVE_NOTE: ActiveNoteEligibility = {
  path: null,
  eligible: false,
  reason: "Open a Markdown note to process it.",
  code: "none",
};

function normalizePath(relpath: string): string {
  return relpath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeFolder(folder: string): string {
  const normalized = normalizePath(folder).replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

/**
 * True when `relpath` is exactly `folder` or nested under it. `folder` is
 * normalized the same way as a scope folder (trimmed slashes, "." meaning
 * "the whole vault", which never counts as a match here since Mindmap
 * always has a real configDir/runtimeFolder to compare against).
 */
function isWithinFolder(relpath: string, folder: string): boolean {
  const normalizedFolder = normalizeFolder(folder);
  return normalizedFolder !== "."
    && (relpath === normalizedFolder || relpath.startsWith(`${normalizedFolder}/`));
}

/**
 * `configDir` is Obsidian's actual, possibly-user-renamed configuration
 * folder (Vault#configDir) -- not a hardcoded ".obsidian", and not a
 * blanket "any dot-prefixed folder" guess, since users can legitimately
 * keep ordinary notes in a hidden-looking folder (e.g. ".journal"). When
 * no configDir is available (a pure call site with no app/plugin context),
 * this check is simply skipped rather than approximated.
 */
export function isSafeIndividualNotePath(relpath: string, configDir?: string): boolean {
  const normalized = normalizePath(relpath);
  if (!normalized || path.isAbsolute(relpath) || /^[A-Za-z]:[\\/]/.test(relpath) || relpath.startsWith("\\\\")) {
    return false;
  }
  if (normalized.split("/").includes("..")) {
    return false;
  }
  if (configDir !== undefined && isWithinFolder(normalized, configDir)) {
    return false;
  }
  return normalized.toLowerCase().endsWith(".md");
}

export function isWithinScope(relpath: string, folders: string[]): boolean {
  const normalized = normalizePath(relpath).replace(/^\/+/, "");
  return folders.some((folder) => {
    const scope = normalizeFolder(folder);
    return scope === "." || normalized === scope || normalized.startsWith(`${scope}/`);
  });
}

function frontmatterBody(text: string): { type: string; body: string } {
  if (!text.startsWith("---")) {
    return { type: "", body: text };
  }
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { type: "", body: text };
  }
  const typeLine = lines.slice(1, end).find((line) => /^\s*type\s*:/i.test(line));
  const type = typeLine?.replace(/^\s*type\s*:\s*/i, "").trim().replace(/^['"]|['"]$/g, "") ?? "";
  return { type, body: lines.slice(end + 1).join("\n") };
}

export function minimumWordsForNote(text: string, configuredMinimum: number): number {
  return isAppleBooksAnnotation(text)
    ? APPLE_BOOKS_ANNOTATION_MIN_WORDS
    : configuredMinimum;
}

export function isAppleBooksAnnotation(text: string): boolean {
  return frontmatterBody(text).type === "apple-books-annotation";
}

export function isReadingAnnotationPath(relpath: string, text: string): boolean {
  const normalized = normalizePath(relpath).replace(/^\/+/, "");
  return (normalized === READING_NOTES_ROOT || normalized.startsWith(`${READING_NOTES_ROOT}/`)) && isAppleBooksAnnotation(text);
}

/**
 * Structural shape only: `Books/Apple Books/<author>/<book>/Index.md`.
 * Content markers (see isGeneratedReadingIndex) decide whether a file at
 * this exact location is actually the plugin-generated index rather than
 * an unrelated ordinary note a user happened to name Index.md.
 */
export function isGeneratedReadingIndexPath(relpath: string): boolean {
  const normalized = normalizePath(relpath).replace(/^\/+/, "");
  if (normalized !== READING_NOTES_ROOT && !normalized.startsWith(`${READING_NOTES_ROOT}/`)) {
    return false;
  }
  const rest = normalized.slice(READING_NOTES_ROOT.length).replace(/^\/+/, "");
  const parts = rest.split("/");
  return parts.length === 3 && parts[2] === READING_INDEX_FILENAME;
}

/**
 * A complete managed marker pair: exactly one start marker, exactly one end
 * marker, start before end. Reversed order, duplicated markers, or an
 * orphan marker (only one of the pair) never count as a complete pair, so a
 * corrupted or hand-edited Index.md is treated as an ordinary note rather
 * than silently excluded from processing.
 */
function hasCompleteManagedIndexMarkers(text: string): boolean {
  const startIndex = text.indexOf(READING_INDEX_START);
  const endIndex = text.indexOf(READING_INDEX_END);
  if (startIndex === -1 || endIndex === -1) {
    return false;
  }
  if (text.indexOf(READING_INDEX_START, startIndex + 1) !== -1) {
    return false;
  }
  if (text.indexOf(READING_INDEX_END, endIndex + 1) !== -1) {
    return false;
  }
  return startIndex < endIndex;
}

export function isGeneratedReadingIndex(relpath: string, text: string): boolean {
  return isGeneratedReadingIndexPath(relpath) && hasCompleteManagedIndexMarkers(text);
}

/** Any Mindmap-managed Apple Books artifact: an annotation note or a generated book index. */
export function isManagedReadingArtifact(relpath: string, text: string): boolean {
  return isReadingAnnotationPath(relpath, text) || isGeneratedReadingIndex(relpath, text);
}

export function normalizedWordCount(text: string): number {
  return text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu)?.length ?? 0;
}

export function assessActiveNote(
  relpath: string | null,
  text: string | null,
  config: IndividualNoteConfig,
): ActiveNoteEligibility {
  if (!relpath || text === null) {
    return NO_ACTIVE_NOTE;
  }
  const normalized = normalizePath(relpath);
  if (!normalized.toLowerCase().endsWith(".md")) {
    return { path: normalized, eligible: false, reason: "The active file is not a Markdown note.", code: "not-markdown" };
  }
  if (isRuntimeInternal(normalized, config.runtimeFolder, config.configDir)) {
    return { path: normalized, eligible: false, reason: "Plugin/runtime internals cannot be processed as notes.", code: "runtime-internal" };
  }
  if (!isSafeIndividualNotePath(normalized, config.configDir)) {
    return { path: normalized, eligible: false, reason: "The active note path is not safe to process.", code: "unsafe-path" };
  }
  if (isGeneratedReadingIndex(normalized, text)) {
    return { path: normalized, eligible: false, reason: "Generated Apple Books index notes cannot be processed individually.", code: "generated-index" };
  }
  if (!isWithinScope(normalized, config.allScopeFolders) && !isReadingAnnotationPath(normalized, text)) {
    return { path: normalized, eligible: false, reason: "The active note is outside the configured all-scope folders.", code: "out-of-scope" };
  }

  const { body } = frontmatterBody(text);
  const minimum = minimumWordsForNote(text, config.minimumWords);
  const count = isAppleBooksAnnotation(text)
    ? normalizedWordCount(body)
    : body.split(/\s+/).filter(Boolean).length;
  if (count < minimum) {
    return {
      path: normalized,
      eligible: false,
      reason: `The active note has ${count} words; at least ${minimum} are required.`,
      code: "too-short",
    };
  }
  return { path: normalized, eligible: true, reason: "Active note is eligible for individual processing.", code: "eligible" };
}

function isRuntimeInternal(relpath: string, runtimeFolder?: string, configDir?: string): boolean {
  if (runtimeFolder !== undefined && isWithinFolder(relpath, runtimeFolder)) {
    return true;
  }
  if (configDir !== undefined && isWithinFolder(relpath, configDir)) {
    return true;
  }
  return false;
}
