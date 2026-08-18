import { createHash } from "node:crypto";

export const READING_RESPONSE_VERSION = 1 as const;
export const READING_STATE_VERSION = 1 as const;
export const READING_ANNOTATION_MIN_WORDS = 8;
export const READING_ROOT = "Books/Apple Books";
export const READING_ANNOTATIONS_FOLDER = "Annotations";
export const READING_INDEX_FILENAME = "Index.md";
export const READING_SOURCE_START = "<!-- mindmap:apple-books-source:start -->";
export const READING_SOURCE_END = "<!-- mindmap:apple-books-source:end -->";
export const READING_INDEX_START = "<!-- mindmap:apple-books-index:start -->";
export const READING_INDEX_END = "<!-- mindmap:apple-books-index:end -->";

const MAX_COMPONENT_LENGTH = 80;
const RESERVED_COMPONENTS = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export type ReaderPayloadStatus = "success" | "partial" | "empty";
export type ResearchStatus = "off" | "too-short" | "retryable" | "complete";

export interface AppleBooksSourceMetadata {
  role: string;
  filename: string;
  schema: string;
  snapshot: string;
  wal_present: boolean;
}

export interface AppleBooksAnnotation {
  annotation_id: string;
  quote: string;
  user_note?: string;
  book_title: string;
  author?: string;
  chapter?: string;
  location?: string;
  created_at?: string;
  modified_at?: string;
}

export interface AppleBooksReaderPayload {
  version: typeof READING_RESPONSE_VERSION;
  status: ReaderPayloadStatus;
  annotations: AppleBooksAnnotation[];
  diagnostics: Array<Record<string, unknown>>;
  count: number;
  skipped_rows?: number;
  sources?: AppleBooksSourceMetadata[];
}

export interface ReadingStateEntry {
  contentHash: string;
  notePath: string;
  importedAt: string;
  researchStatus: ResearchStatus;
  processedAt: string | null;
}

export interface ReadingState {
  version: typeof READING_STATE_VERSION;
  lastSyncAt: string | null;
  annotations: Record<string, ReadingStateEntry>;
}

export interface PlannedAnnotationPath {
  annotationId: string;
  notePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`Invalid Apple Books payload: ${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, field, true);
}

function validateAnnotation(value: unknown, index: number): AppleBooksAnnotation {
  if (!isRecord(value)) {
    throw new Error(`Invalid Apple Books payload: annotation ${index} must be an object.`);
  }
  const annotation: AppleBooksAnnotation = {
    annotation_id: requireString(value.annotation_id, `annotations[${index}].annotation_id`),
    quote: requireString(value.quote, `annotations[${index}].quote`),
    book_title: requireString(value.book_title, `annotations[${index}].book_title`, true),
  };
  for (const field of ["user_note", "author", "chapter", "location", "created_at", "modified_at"] as const) {
    const parsed = optionalString(value[field], `annotations[${index}].${field}`);
    if (parsed !== undefined) {
      if ((field === "created_at" || field === "modified_at") && !isIsoDateTime(parsed)) {
        throw new Error(`Invalid Apple Books payload: annotations[${index}].${field} must be a valid ISO date-time.`);
      }
      annotation[field] = parsed;
    }
  }
  return annotation;
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateSources(value: unknown): AppleBooksSourceMetadata[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid Apple Books payload: sources must be an array.");
  }
  return value.map((source, index) => {
    if (!isRecord(source)
      || typeof source.role !== "string"
      || typeof source.filename !== "string"
      || typeof source.schema !== "string"
      || typeof source.snapshot !== "string"
      || typeof source.wal_present !== "boolean") {
      throw new Error(`Invalid Apple Books payload: sources[${index}] is malformed.`);
    }
    return {
      role: source.role,
      filename: source.filename,
      schema: source.schema,
      snapshot: source.snapshot,
      wal_present: source.wal_present,
    };
  });
}

export function validateAppleBooksReaderPayload(value: unknown): AppleBooksReaderPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid Apple Books payload: expected an object.");
  }
  if (value.version !== READING_RESPONSE_VERSION) {
    throw new Error(`Unsupported Apple Books payload version: ${String(value.version)}.`);
  }
  if (value.status !== "success" && value.status !== "partial" && value.status !== "empty") {
    throw new Error(`Apple Books payload is not usable: ${String(value.status)}.`);
  }
  if (!Array.isArray(value.annotations)) {
    throw new Error("Invalid Apple Books payload: annotations must be an array.");
  }
  if (!Number.isInteger(value.count) || value.count !== value.annotations.length) {
    throw new Error("Invalid Apple Books payload: count does not match annotations.");
  }
  if (!Array.isArray(value.diagnostics)) {
    throw new Error("Invalid Apple Books payload: diagnostics must be an array.");
  }
  const skippedRows = value.skipped_rows;
  if (skippedRows !== undefined && (typeof skippedRows !== "number" || !Number.isInteger(skippedRows) || skippedRows < 1)) {
    throw new Error("Invalid Apple Books payload: skipped_rows must be a positive integer.");
  }
  if (value.status === "partial" && (typeof skippedRows !== "number" || skippedRows < 1)) {
    throw new Error("Invalid Apple Books payload: partial results must report skipped rows.");
  }
  if (value.status === "empty" && (value.count !== 0 || value.annotations.length !== 0)) {
    throw new Error("Invalid Apple Books payload: empty results must contain zero annotations.");
  }
  const diagnostics = value.diagnostics.map((diagnostic, index) => {
    if (!isRecord(diagnostic)) {
      throw new Error(`Invalid Apple Books payload: diagnostics[${index}] must be an object.`);
    }
    return diagnostic;
  });
  const annotations = value.annotations.map(validateAnnotation);
  const ids = new Set<string>();
  for (const annotation of annotations) {
    if (ids.has(annotation.annotation_id)) {
      throw new Error(`Invalid Apple Books payload: duplicate annotation ID ${annotation.annotation_id}.`);
    }
    ids.add(annotation.annotation_id);
  }
  return {
    version: READING_RESPONSE_VERSION,
    status: value.status,
    annotations,
    diagnostics,
    count: value.count,
    ...(skippedRows === undefined ? {} : { skipped_rows: skippedRows }),
    ...(value.sources === undefined ? {} : { sources: validateSources(value.sources) }),
  };
}

export function createEmptyReadingState(): ReadingState {
  return { version: READING_STATE_VERSION, lastSyncAt: null, annotations: {} };
}

export function isSafeReadingPath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.startsWith(`${READING_ROOT}/`)
    && !normalized.startsWith("/")
    && !normalized.split("/").some((part) => part === ".." || part === "." || part.length === 0)
    && !normalized.split("/").includes(".obsidian")
    && normalized.toLowerCase().endsWith(".md");
}

export function parseReadingState(value: unknown): ReadingState {
  if (!isRecord(value) || value.version !== READING_STATE_VERSION || (value.lastSyncAt !== null && typeof value.lastSyncAt !== "string")) {
    throw new Error("Invalid Reading Mode state: unsupported version or lastSyncAt.");
  }
  if (!isRecord(value.annotations)) {
    throw new Error("Invalid Reading Mode state: annotations must be an object.");
  }
  const annotations: Record<string, ReadingStateEntry> = {};
  const notePaths = new Set<string>();
  for (const [id, rawEntry] of Object.entries(value.annotations)) {
    if (!isRecord(rawEntry)
      || typeof rawEntry.contentHash !== "string"
      || typeof rawEntry.notePath !== "string"
      || !isSafeReadingPath(rawEntry.notePath)
      || typeof rawEntry.importedAt !== "string"
      || (rawEntry.researchStatus !== "off" && rawEntry.researchStatus !== "too-short" && rawEntry.researchStatus !== "retryable" && rawEntry.researchStatus !== "complete")
      || (rawEntry.processedAt !== null && typeof rawEntry.processedAt !== "string")) {
      throw new Error(`Invalid Reading Mode state: annotation ${id} is malformed.`);
    }
    if (notePaths.has(rawEntry.notePath)) {
      throw new Error(`Invalid Reading Mode state: duplicate note path ${rawEntry.notePath}.`);
    }
    notePaths.add(rawEntry.notePath);
    annotations[id] = {
      contentHash: rawEntry.contentHash,
      notePath: rawEntry.notePath,
      importedAt: rawEntry.importedAt,
      researchStatus: rawEntry.researchStatus,
      processedAt: rawEntry.processedAt,
    };
  }
  return { version: READING_STATE_VERSION, lastSyncAt: value.lastSyncAt, annotations };
}

export function sanitizePathComponent(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .replace(/[\\/]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/[<>:"|?*#[\]]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  const bounded = Array.from(normalized).slice(0, MAX_COMPONENT_LENGTH).join("");
  if (!bounded || bounded === "." || bounded === ".." || !/[\p{L}\p{N}]/u.test(bounded)) {
    return fallback;
  }
  if (RESERVED_COMPONENTS.has(bounded.toLowerCase())) {
    return `${bounded}-`;
  }
  return bounded;
}

function dateComponent(value: string | undefined): string {
  if (!value) {
    return "undated";
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "undated" : parsed.toISOString().slice(0, 10);
}

function shortId(annotationId: string): string {
  return createHash("sha256").update(annotationId).digest("hex").slice(0, 12);
}

export function baseAnnotationNotePath(annotation: AppleBooksAnnotation): string {
  const author = sanitizePathComponent(annotation.author, "Unknown Author");
  const book = sanitizePathComponent(annotation.book_title, "Untitled Book");
  const date = dateComponent(annotation.created_at);
  return `${READING_ROOT}/${author}/${book}/${READING_ANNOTATIONS_FOLDER}/${date}-${shortId(annotation.annotation_id)}.md`;
}

export function annotationPathCandidate(annotation: AppleBooksAnnotation, collisionIndex = 0): string {
  const base = baseAnnotationNotePath(annotation);
  if (collisionIndex === 0) {
    return base;
  }
  const extension = ".md";
  const stem = base.slice(0, -extension.length);
  const suffix = shortId(annotation.annotation_id);
  return `${stem}-${suffix}${collisionIndex === 1 ? "" : `-${collisionIndex}`}${extension}`;
}

export function bookFolderForNotePath(notePath: string): string {
  const parts = notePath.replace(/\\/g, "/").split("/");
  return parts.slice(0, -2).join("/");
}

export function bookIndexPath(bookFolder: string): string {
  return `${bookFolder}/${READING_INDEX_FILENAME}`;
}

export function planAnnotationPaths(
  annotations: AppleBooksAnnotation[],
  state: ReadingState,
  occupiedPaths: Iterable<string> = [],
  preferredPaths: Record<string, string> = {},
): PlannedAnnotationPath[] {
  const occupied = new Set(occupiedPaths);
  const assigned = new Map<string, string>();
  for (const entry of Object.entries(state.annotations)) {
    if (isSafeReadingPath(entry[1].notePath)) {
      occupied.add(entry[1].notePath);
    }
  }
  const pending = [...annotations].sort((left, right) => left.annotation_id.localeCompare(right.annotation_id));
  for (const annotation of pending) {
    const stored = preferredPaths[annotation.annotation_id] ?? state.annotations[annotation.annotation_id]?.notePath;
    if (stored && isSafeReadingPath(stored) && (!assigned.has(stored) || assigned.get(stored) === annotation.annotation_id)) {
      assigned.set(stored, annotation.annotation_id);
      occupied.add(stored);
    }
  }
  for (const annotation of pending) {
    const preferred = preferredPaths[annotation.annotation_id] ?? state.annotations[annotation.annotation_id]?.notePath;
    if (preferred && assigned.get(preferred) === annotation.annotation_id) {
      continue;
    }
    let collisionIndex = 0;
    let candidate = annotationPathCandidate(annotation, collisionIndex);
    while (occupied.has(candidate)) {
      collisionIndex += 1;
      candidate = annotationPathCandidate(annotation, collisionIndex);
    }
    occupied.add(candidate);
    assigned.set(candidate, annotation.annotation_id);
  }
  return [...assigned.entries()]
    .map(([notePath, annotationId]) => ({ annotationId, notePath }))
    .filter((item) => pending.some((annotation) => annotation.annotation_id === item.annotationId));
}

export function annotationContentHash(annotation: AppleBooksAnnotation): string {
  return createHash("sha256").update(JSON.stringify({
    quote: annotation.quote,
    user_note: annotation.user_note ?? null,
    book_title: annotation.book_title,
    author: annotation.author ?? null,
    chapter: annotation.chapter ?? null,
    location: annotation.location ?? null,
    created_at: annotation.created_at ?? null,
    modified_at: annotation.modified_at ?? null,
  })).digest("hex");
}

export function annotationIsTooShort(annotation: AppleBooksAnnotation): boolean {
  const text = `${annotation.quote} ${annotation.user_note ?? ""}`;
  const count = text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu)?.length ?? 0;
  return count < READING_ANNOTATION_MIN_WORDS;
}
