import { createObsidianVaultApi, type ReadingVault } from "./readingVault";
import {
  annotationContentHash,
  annotationIsTooShort,
  annotationPathCandidate,
  bookFolderForNotePath,
  bookIndexPath,
  planAnnotationPaths,
  READING_INDEX_END,
  READING_INDEX_START,
  READING_SOURCE_END,
  READING_SOURCE_START,
  isSafeReadingPath,
  type AppleBooksAnnotation,
  type ReadingState,
  type ReadingStateEntry,
  type ResearchStatus,
  validateAppleBooksReaderPayload,
} from "./readingTypes";
import type { ReadingStateStore } from "./readingState";

export interface ImportFailure {
  annotationId?: string;
  stage: "validation" | "note" | "state" | "index";
  message: string;
}

export interface ImportedAnnotationResult {
  annotationId: string;
  notePath: string;
  action: "created" | "updated" | "unchanged";
  tooShort: boolean;
  eligible: boolean;
}

export interface AnnotationImportResult {
  imported: ImportedAnnotationResult[];
  failures: ImportFailure[];
  state: ReadingState;
  indexPaths: string[];
}

export interface AnnotationImporterOptions {
  vault: ReadingVault;
  state: ReadingStateStore;
  now?: () => string;
}

export async function updateAppleAnnotationResearchStatus(
  vault: ReadingVault,
  stateStore: ReadingStateStore,
  annotationId: string,
  status: Extract<ResearchStatus, "complete" | "retryable" | "unresearchable">,
): Promise<"updated" | "state-pending" | false> {
  const state = await stateStore.load();
  const entry = state.annotations[annotationId];
  if (!entry) return false;
  const note = vault.get(entry.notePath);
  if (!note) return false;
  const text = await vault.read(note);
  if (readFrontmatterValue(text, "annotation_id") !== annotationId) return false;
  const next = replaceFrontmatterScalar(text, "research_status", status);
  const noteChanged = next !== text;
  if (noteChanged) await vault.modify(note, next);
  entry.researchStatus = status;
  if (status === "complete") entry.processedAt = null;
  try {
    await stateStore.save(state);
    return "updated";
  } catch (error) {
    // The frontmatter is the durable, user-visible half of this transition.
    // A retryable state write must not turn a committed complete status back
    // into a provider retry on the next sync.
    if (noteChanged || readFrontmatterValue(next, "research_status") === status) return "state-pending";
    throw error;
  }
}

/** Completes a tracked Apple annotation without affecting ordinary notes. */
export async function completeAppleAnnotationResearchForNote(
  vault: ReadingVault,
  stateStore: ReadingStateStore,
  notePath: string,
): Promise<"updated" | "state-pending" | false> {
  const state = await stateStore.load();
  const annotationId = Object.entries(state.annotations).find(([, entry]) => entry.notePath === notePath)?.[0];
  if (!annotationId) return false;
  return await updateAppleAnnotationResearchStatus(vault, stateStore, annotationId, "complete");
}

interface FrontmatterParts {
  frontmatter: string;
  body: string;
}

const MANAGED_FRONTMATTER_KEYS = [
  "type",
  "source",
  "annotation_id",
  "book_title",
  "book_author",
  "chapter",
  "created_at",
  "imported_at",
  "research_status",
] as const;

export async function importAppleBooksAnnotations(
  rawPayload: unknown,
  options: AnnotationImporterOptions,
): Promise<AnnotationImportResult> {
  const payload = validateAppleBooksReaderPayload(rawPayload);
  const now = options.now ?? (() => new Date().toISOString());
  const syncAt = now();
  const state = await options.state.load();
  const failures: ImportFailure[] = [];
  const imported: ImportedAnnotationResult[] = [];
  const occupiedPaths = new Set<string>();
  const preferredPaths: Record<string, string> = {};
  for (const entry of Object.values(state.annotations)) {
    if (isSafeReadingPath(entry.notePath)) {
      occupiedPaths.add(entry.notePath);
    }
  }
  for (const annotation of [...payload.annotations].sort((left, right) => left.annotation_id.localeCompare(right.annotation_id))) {
    const storedPath = state.annotations[annotation.annotation_id]?.notePath;
    if (storedPath && isSafeReadingPath(storedPath)) {
      const storedStatus = await probeCandidate(options.vault, storedPath, annotation.annotation_id);
      if (storedStatus !== "occupied") {
        preferredPaths[annotation.annotation_id] = storedPath;
        occupiedPaths.add(storedPath);
        continue;
      }
      occupiedPaths.add(storedPath);
    }

    let collisionIndex = 0;
    while (true) {
      const candidate = annotationPathCandidate(annotation, collisionIndex);
      const status = await probeCandidate(options.vault, candidate, annotation.annotation_id);
      if (status === "match") {
        preferredPaths[annotation.annotation_id] = candidate;
        occupiedPaths.add(candidate);
        break;
      }
      if (status === "free" && !occupiedPaths.has(candidate)) {
        preferredPaths[annotation.annotation_id] = candidate;
        occupiedPaths.add(candidate);
        break;
      }
      occupiedPaths.add(candidate);
      collisionIndex += 1;
    }
  }
  const planned = new Map(planAnnotationPaths(payload.annotations, state, occupiedPaths, preferredPaths).map((item) => [item.annotationId, item.notePath]));
  let currentState = state;
  let statePersisted = false;
  let annotationFailure = false;

  for (const annotation of [...payload.annotations].sort((left, right) => left.annotation_id.localeCompare(right.annotation_id))) {
    const notePath = planned.get(annotation.annotation_id);
    if (!notePath) {
      annotationFailure = true;
      failures.push({ annotationId: annotation.annotation_id, stage: "validation", message: "No safe note path could be allocated." });
      continue;
    }
    const contentHash = annotationContentHash(annotation);
    const previous = currentState.annotations[annotation.annotation_id];
    const existing = options.vault.get(notePath);
    if (previous?.contentHash === contentHash && existing) {
      const existingText = await options.vault.read(existing);
      const durableStatus = readFrontmatterValue(existingText, "research_status");
      if (previous.researchStatus === "too-short" || annotationIsTooShort(annotation)) {
        if (durableStatus !== "too-short") {
          await options.vault.modify(existing, replaceFrontmatterScalar(existingText, "research_status", "too-short"));
        }
      } else if (durableStatus === "complete" && previous.researchStatus !== "complete") {
        const adopted = cloneState(currentState);
        adopted.annotations[annotation.annotation_id] = { ...previous, researchStatus: "complete", processedAt: null };
        await options.state.save(adopted);
        currentState = adopted;
      }
      imported.push({
        annotationId: annotation.annotation_id,
        notePath,
        action: "unchanged",
        tooShort: currentState.annotations[annotation.annotation_id]?.researchStatus === "too-short",
        eligible: currentState.annotations[annotation.annotation_id]?.researchStatus !== "too-short",
      });
      continue;
    }

    try {
      const existingText = existing ? await options.vault.read(existing) : "";
      const tooShort = annotationIsTooShort(annotation);
      const importedAt = previous?.importedAt ?? readFrontmatterValue(existingText, "imported_at") ?? syncAt;
      const sourceChanged = Boolean(previous && previous.contentHash !== contentHash);
      const researchStatus = sourceChanged && !tooShort ? "off" : chooseResearchStatus(annotation, previous, existingText);
      const processedAt = previous && previous.contentHash !== contentHash ? null : previous?.processedAt ?? null;
      const noteText = renderAnnotationNote(existingText, annotation, {
        importedAt,
        researchStatus,
      });
      await ensureVaultFolders(options.vault, notePath);
      let action: ImportedAnnotationResult["action"] = existing ? "updated" : "created";
      if (existing) {
        if (noteText !== existingText) {
          await options.vault.modify(existing, noteText);
        } else {
          action = "unchanged";
        }
      } else {
        await options.vault.create(notePath, noteText);
      }

      const nextState = cloneState(currentState);
      nextState.annotations[annotation.annotation_id] = {
        contentHash,
        notePath,
        importedAt,
        researchStatus,
        processedAt,
      };
      nextState.lastSyncAt = state.lastSyncAt;
      try {
        await options.state.save(nextState);
      } catch (error) {
        annotationFailure = true;
        failures.push({ annotationId: annotation.annotation_id, stage: "state", message: errorMessage(error) });
        continue;
      }
      currentState = nextState;
      statePersisted = true;
      imported.push({
        annotationId: annotation.annotation_id,
        notePath,
        action,
        tooShort,
        eligible: !tooShort,
      });
    } catch (error) {
      annotationFailure = true;
      failures.push({ annotationId: annotation.annotation_id, stage: "note", message: errorMessage(error) });
    }
  }

  if (!annotationFailure && (!statePersisted || currentState.lastSyncAt !== syncAt)) {
    const nextState = cloneState(currentState);
    nextState.lastSyncAt = syncAt;
    try {
      await options.state.save(nextState);
      currentState = nextState;
    } catch (error) {
      failures.push({ stage: "state", message: errorMessage(error) });
    }
  }

  const indexPaths: string[] = [];
  for (const bookFolder of [...new Set(Object.values(currentState.annotations).map((entry) => bookFolderForNotePath(entry.notePath)))].sort()) {
    try {
      const indexPath = bookIndexPath(bookFolder);
      const existing = options.vault.get(indexPath);
      const existingText = existing ? await options.vault.read(existing) : "";
      const entries = Object.entries(currentState.annotations)
        .filter(([, entry]) => bookFolderForNotePath(entry.notePath) === bookFolder)
        .sort((left, right) => left[1].notePath.localeCompare(right[1].notePath));
      const indexText = upsertManagedBlock(existingText, READING_INDEX_START, READING_INDEX_END, renderIndexBlock(entries));
      await ensureVaultFolders(options.vault, indexPath);
      if (existing) {
        if (indexText !== existingText) {
          await options.vault.modify(existing, indexText);
        }
      } else {
        await options.vault.create(indexPath, indexText);
      }
      indexPaths.push(indexPath);
    } catch (error) {
      failures.push({ stage: "index", message: errorMessage(error) });
    }
  }

  return { imported, failures, state: currentState, indexPaths };
}

export function renderAnnotationNote(
  existingText: string,
  annotation: AppleBooksAnnotation,
  values: Pick<ReadingStateEntry, "importedAt" | "researchStatus">,
): string {
  const frontmatter = upsertManagedFrontmatter(existingText, {
    type: "apple-books-annotation",
    source: "apple-books",
    annotation_id: annotation.annotation_id,
    book_title: annotation.book_title,
    book_author: annotation.author ?? "",
    chapter: annotation.chapter ?? "",
    created_at: annotation.created_at ?? "",
    imported_at: values.importedAt,
    research_status: values.researchStatus,
  });
  const parts = splitFrontmatter(frontmatter);
  return composeFrontmatter(parts.frontmatter, upsertManagedBlock(parts.body, READING_SOURCE_START, READING_SOURCE_END, renderSourceBlock(annotation)));
}

async function probeCandidate(vault: ReadingVault, candidate: string, annotationId: string): Promise<"free" | "match" | "occupied"> {
  const existing = vault.get(candidate);
  if (!existing) {
    return "free";
  }
  try {
    return readFrontmatterValue(await vault.read(existing), "annotation_id") === annotationId ? "match" : "occupied";
  } catch {
    return "occupied";
  }
}

function chooseResearchStatus(
  annotation: AppleBooksAnnotation,
  previous: ReadingStateEntry | undefined,
  existingText: string,
): ResearchStatus {
  if (annotationIsTooShort(annotation)) {
    return "too-short";
  }
  if (previous?.researchStatus && previous.researchStatus !== "too-short") {
    return previous.researchStatus;
  }
  const existing = readFrontmatterValue(existingText, "research_status");
  return existing === "retryable" ? "retryable" : "off";
}

function cloneState(state: ReadingState): ReadingState {
  return {
    version: state.version,
    lastSyncAt: state.lastSyncAt,
    annotations: Object.fromEntries(Object.entries(state.annotations).map(([id, entry]) => [id, { ...entry }])),
  };
}

async function ensureVaultFolders(vault: ReadingVault, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  for (let index = 1; index < parts.length - 1; index += 1) {
    const folderPath = parts.slice(0, index + 1).join("/");
    if (!vault.get(folderPath)) {
      await vault.createFolder(folderPath);
    }
  }
}

function splitFrontmatter(text: string): FrontmatterParts {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: "", body: text };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) {
    return { frontmatter: "", body: text };
  }
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

function composeFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) {
    return body;
  }
  return `---\n${frontmatter}\n---\n${body}`;
}

function upsertManagedFrontmatter(text: string, values: Record<typeof MANAGED_FRONTMATTER_KEYS[number], string>): string {
  const parts = splitFrontmatter(text);
  const lines = parts.frontmatter ? parts.frontmatter.split("\n") : [];
  for (const key of MANAGED_FRONTMATTER_KEYS) {
    const line = `${key}: ${yamlScalar(values[key])}`;
    const index = lines.findIndex((candidate) => new RegExp(`^${key}\\s*:`).test(candidate));
    if (index >= 0) {
      lines[index] = line;
    } else {
      lines.push(line);
    }
  }
  return composeFrontmatter(lines.join("\n"), parts.body);
}

function readFrontmatterValue(text: string, key: string): string | undefined {
  const frontmatter = splitFrontmatter(text).frontmatter;
  const line = frontmatter.split("\n").find((candidate) => new RegExp(`^${key}\\s*:`).test(candidate));
  if (!line) {
    return undefined;
  }
  const raw = line.replace(new RegExp(`^${key}\\s*:`), "").trim();
  return raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1") || undefined;
}

function replaceFrontmatterScalar(text: string, key: string, value: string): string {
  const pattern = new RegExp(`(^${key}\\s*:)\\s*[^\\r\\n]*`, "m");
  return text.replace(pattern, `$1 ${yamlScalar(value)}`);
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(value) && !["true", "false", "null"].includes(value.toLowerCase())
    ? value
    : JSON.stringify(value);
}

function renderSourceBlock(annotation: AppleBooksAnnotation): string {
  const lines = [
    READING_SOURCE_START,
    "## Apple Books Source",
    "> **Quote**",
    ...blockquote(annotation.quote),
  ];
  if (annotation.user_note) {
    lines.push("> **Note**", ...blockquote(annotation.user_note));
  }
  if (annotation.location) {
    lines.push(`> **Location:** ${escapeInline(annotation.location)}`);
  }
  if (annotation.chapter) {
    lines.push(`> **Chapter:** ${escapeInline(annotation.chapter)}`);
  }
  lines.push(READING_SOURCE_END);
  return lines.join("\n");
}

function renderIndexBlock(entries: Array<[string, ReadingStateEntry]>): string {
  const lines = [READING_INDEX_START, "## Apple Books Annotations"];
  for (const [, entry] of entries) {
    const link = entry.notePath.replace(/\.md$/i, "");
    const label = link.split("/").pop() ?? link;
    lines.push(`- [[${link}|${escapeInline(label)}]]`);
  }
  lines.push(READING_INDEX_END);
  return lines.join("\n");
}

function blockquote(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line.replace(/```/g, "\\`\\`\\`")}`);
}

function escapeInline(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|]/g, "\\$&");
}

function upsertManagedBlock(text: string, startMarker: string, endMarker: string, block: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === startMarker);
  const end = start >= 0 ? lines.findIndex((line, index) => index > start && line === endMarker) : -1;
  if (start >= 0 && end >= 0) {
    return [...lines.slice(0, start), ...block.split("\n"), ...lines.slice(end + 1)].join("\n");
  }
  if (start >= 0 || end >= 0) {
    throw new Error("Managed Apple Books markers are incomplete.");
  }
  if (!text) {
    return `${block}\n`;
  }
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${block}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown importer error.";
}

export { createObsidianVaultApi };
