import path from "node:path";

export const APPLE_BOOKS_ANNOTATION_MIN_WORDS = 8;
export const READING_NOTES_ROOT = "Books/Apple Books";

export interface IndividualNoteConfig {
  allScopeFolders: string[];
  minimumWords: number;
  runtimeFolder?: string;
}

export interface ActiveNoteEligibility {
  path: string | null;
  eligible: boolean;
  reason: string;
  code: "none" | "not-markdown" | "unsafe-path" | "runtime-internal" | "out-of-scope" | "too-short" | "eligible";
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

export function isSafeIndividualNotePath(relpath: string): boolean {
  const normalized = normalizePath(relpath);
  if (!normalized || path.isAbsolute(relpath) || /^[A-Za-z]:[\\/]/.test(relpath) || relpath.startsWith("\\\\")) {
    return false;
  }
  return !normalized.split("/").includes("..")
    && !normalized.split("/").includes(".obsidian")
    && normalized.toLowerCase().endsWith(".md");
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
  if (isRuntimeInternal(normalized, config.runtimeFolder)) {
    return { path: normalized, eligible: false, reason: "Plugin/runtime internals cannot be processed as notes.", code: "runtime-internal" };
  }
  if (!isSafeIndividualNotePath(normalized)) {
    return { path: normalized, eligible: false, reason: "The active note path is not safe to process.", code: "unsafe-path" };
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

function isRuntimeInternal(relpath: string, runtimeFolder = ".obsidian"): boolean {
  const normalizedRuntimeFolder = normalizeFolder(runtimeFolder);
  return normalizedRuntimeFolder !== "." && (relpath === normalizedRuntimeFolder || relpath.startsWith(`${normalizedRuntimeFolder}/`))
    || relpath.split("/").includes(".obsidian");
}
