import { createObsidianVaultApi, type ReadingVault } from "./readingVault";
import {
  annotationContentHash,
  annotationIsTooShort,
  baseAnnotationNotePath,
  bookFolderForNotePath,
  bookIndexPath,
  READING_ANNOTATIONS_FOLDER,
  READING_INDEX_END,
  READING_INDEX_START,
  READING_ROOT,
  READING_SOURCE_END,
  READING_SOURCE_START,
  isSafeReadingPath,
  isValidResearchPathForNote,
  sanitizePathComponent,
  type AppleBooksAnnotation,
  type ReadingState,
  type ReadingStateEntry,
  type ResearchStatus,
  validateAppleBooksReaderPayload,
} from "./readingTypes";
import {
  conceptWikilink,
  deriveHumanTitle,
  humanTitleCandidate,
  isSafeRelatedTarget,
  relatedNoteWikilink,
  replaceLeadingAnnotationSource,
} from "./readingNoteFormat";
import type { ReadingStateStore } from "./readingState";
import { RESEARCH_END, RESEARCH_START } from "./researchWriter";
import {
  extractLegacyInlineResearch,
  writeCompanionNote,
  type LegacyExtractionResult,
} from "./readingResearchCompanion";

export interface ImportFailure {
  annotationId?: string;
  stage: "validation" | "note" | "state" | "index" | "modify" | "mutate";
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
  initialImport: boolean;
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
  const preview = await stateStore.load();
  const previewEntry = preview.annotations[annotationId];
  if (!previewEntry) return false;
  const note = vault.get(previewEntry.notePath);
  if (!note) return false;
  const text = await vault.read(note);
  if (readFrontmatterValue(text, "type") !== "apple-books-annotation") return false;
  if (readFrontmatterValue(text, "annotation_id") !== annotationId) return false;
  const next = replaceFrontmatterScalar(text, "research_status", status);
  const noteChanged = next !== text;
  if (noteChanged) await vault.modify(note, next);
  try {
    const { result: found } = await stateStore.mutate((state) => {
      const entry = state.annotations[annotationId];
      if (!entry) return false;
      entry.researchStatus = status;
      if (status === "complete") entry.processedAt = null;
      return true;
    });
    return found ? "updated" : false;
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

export type AppleAnnotationCompanionResult =
  | { ok: true; companionPath: string; action: "created" | "updated" | "unchanged" }
  | { ok: false; code: string; message: string };

export async function writeAppleAnnotationCompanion(
  vault: ReadingVault,
  stateStore: ReadingStateStore,
  options: {
    annotationPath: string;
    annotationId: string;
    researchContent: string;
    storedResearchPath?: string;
  },
): Promise<AppleAnnotationCompanionResult> {
  const preState = await stateStore.load();
  const preEntry = preState.annotations[options.annotationId];
  if (!preEntry) {
    return { ok: false, code: "ANNOTATION_UNTRACKED", message: "Annotation is not tracked in Reading state." };
  }
  if (preEntry.notePath !== options.annotationPath) {
    return { ok: false, code: "PATH_MISMATCH", message: "Annotation path does not match tracked state entry." };
  }
  const note = vault.get(options.annotationPath);
  if (!note) {
    return { ok: false, code: "NOTE_MISSING", message: "Annotation note not found in vault." };
  }
  const noteText = await vault.read(note);
  if (readFrontmatterValue(noteText, "type") !== "apple-books-annotation") {
    return { ok: false, code: "TYPE_MISMATCH", message: "Annotation note is not an apple-books-annotation." };
  }
  if (readFrontmatterValue(noteText, "annotation_id") !== options.annotationId) {
    return { ok: false, code: "ANNOTATION_ID_MISMATCH", message: "Annotation note frontmatter annotation_id does not match." };
  }

  try {
    const companionResult = await writeCompanionNote(vault, {
      annotationPath: options.annotationPath,
      annotationId: options.annotationId,
      content: options.researchContent,
      storedCompanionPath: options.storedResearchPath,
    });

    const currentNote = vault.get(options.annotationPath);
    if (!currentNote) {
      return { ok: false, code: "NOTE_MISSING", message: "Annotation note disappeared after companion write." };
    }
    const currentText = await vault.read(currentNote);
    const link = `[[${companionResult.companionPath.replace(/\.md$/i, "")}|Research]]`;
    const updated = upsertFrontmatterKey(currentText, "research", link);
    if (updated !== currentText) {
      await vault.modify(currentNote, updated);
    }

    try {
      const { result: entryValid } = await stateStore.mutate((freshState) => {
        const entry = freshState.annotations[options.annotationId];
        if (!entry || entry.notePath !== options.annotationPath) return false;
        entry.researchPath = companionResult.companionPath;
        return true;
      });
      if (!entryValid) {
        return { ok: false, code: "STATE_ENTRY_STALE", message: "Companion written but state entry changed during save." };
      }
    } catch {
      return { ok: false, code: "STATE_SAVE_FAILED", message: "Companion written but state could not be saved." };
    }

    return { ok: true, companionPath: companionResult.companionPath, action: companionResult.action };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Companion write failed.";
    return { ok: false, code: "COMPANION_WRITE_FAILED", message };
  }
}

export type ResearchTargetClassification = "inline" | "companion" | "reading-state-missing" | "type-mismatch";

export function classifyResearchTarget(
  noteText: string,
  trackedAnnotationId: string | undefined,
): ResearchTargetClassification {
  const noteType = readFrontmatterValue(noteText, "type");
  if (trackedAnnotationId) {
    return noteType === "apple-books-annotation" ? "companion" : "type-mismatch";
  }
  if (noteType === "apple-books-annotation") return "reading-state-missing";
  return "inline";
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
  "location",
  "created_at",
  "imported_at",
  "research_status",
] as const;

const GENERATED_FRONTMATTER_KEYS = ["summary", "tags"] as const;

function readableAnnotationFolder(annotation: AppleBooksAnnotation): string {
  const author = sanitizePathComponent(annotation.author, "Unknown Author");
  const book = sanitizePathComponent(annotation.book_title, "Untitled Book");
  return `${READING_ROOT}/${author}/${book}/${READING_ANNOTATIONS_FOLDER}`;
}

function readableAnnotationPathCandidate(annotation: AppleBooksAnnotation, collisionIndex: number): string {
  const title = deriveHumanTitle(annotation);
  return `${readableAnnotationFolder(annotation)}/${humanTitleCandidate(title, collisionIndex)}`;
}

const LEGACY_BASENAME_PARTS_PATTERN = /^(.+)-([0-9a-f]{12})\.md$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every basename the old `annotationPathCandidate` scheme could produce for
 * this exact annotation: the base form and its collision variants
 * (`-<shortId>` and `-<shortId>-<N>`). Both the date/`undated` component and
 * the short ID must match this annotation's own recomputed legacy base path
 * exactly — a path that merely looks legacy-shaped with a different date is
 * left alone rather than migrated.
 */
function legacyAnnotationBasenamePattern(annotation: AppleBooksAnnotation): RegExp | undefined {
  const base = baseAnnotationNotePath(annotation);
  const basename = base.slice(base.lastIndexOf("/") + 1);
  const match = LEGACY_BASENAME_PARTS_PATTERN.exec(basename);
  if (!match) {
    return undefined;
  }
  const [, date, shortId] = match;
  if (!date || !shortId) {
    return undefined;
  }
  const datePart = escapeRegExp(date);
  return new RegExp(`^${datePart}-${shortId}(?:-${shortId}(?:-\\d+)?)?\\.md$`);
}

/**
 * A stored path only counts as legacy-opaque when it sits in exactly the
 * same author/book/Annotations parent folder the readable scheme also uses
 * and its basename matches one of this specific annotation's old date+hex
 * candidates (base form or a collision variant).
 */
function isLegacyAnnotationPath(path: string, annotation: AppleBooksAnnotation): boolean {
  const folder = readableAnnotationFolder(annotation);
  if (!path.startsWith(`${folder}/`)) {
    return false;
  }
  const pattern = legacyAnnotationBasenamePattern(annotation);
  return pattern ? pattern.test(path.slice(folder.length + 1)) : false;
}

export async function importAppleBooksAnnotations(
  rawPayload: unknown,
  options: AnnotationImporterOptions,
): Promise<AnnotationImportResult> {
  const payload = validateAppleBooksReaderPayload(rawPayload);
  const now = options.now ?? (() => new Date().toISOString());
  const syncAt = now();
  const state = await options.state.load();
  const isInitialImport = !state.initialImportCompletedAt;
  const failures: ImportFailure[] = [];
  const imported: ImportedAnnotationResult[] = [];
  const occupiedPaths = new Set<string>();
  const preferredPaths: Record<string, string> = {};
  for (const entry of Object.values(state.annotations)) {
    if (isSafeReadingPath(entry.notePath)) {
      occupiedPaths.add(entry.notePath);
    }
  }
  const sortedAnnotations = [...payload.annotations].sort((left, right) => left.annotation_id.localeCompare(right.annotation_id));
  for (const annotation of sortedAnnotations) {
    const storedPath = state.annotations[annotation.annotation_id]?.notePath;
    const isLegacy = storedPath !== undefined && isLegacyAnnotationPath(storedPath, annotation);
    if (storedPath && isSafeReadingPath(storedPath)) {
      if (!isLegacy) {
        const storedStatus = await probeCandidate(options.vault, storedPath, annotation.annotation_id);
        if (storedStatus !== "occupied") {
          preferredPaths[annotation.annotation_id] = storedPath;
          occupiedPaths.add(storedPath);
          continue;
        }
      }
      occupiedPaths.add(storedPath);
    }

    let collisionIndex = 0;
    while (true) {
      const candidate = readableAnnotationPathCandidate(annotation, collisionIndex);
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
  const planned = new Map(Object.entries(preferredPaths));
  let currentState = state;
  let statePersisted = false;
  let annotationFailure = false;

  for (const annotation of sortedAnnotations) {
    let notePath = planned.get(annotation.annotation_id);
    if (!notePath) {
      annotationFailure = true;
      failures.push({ annotationId: annotation.annotation_id, stage: "validation", message: "No safe note path could be allocated." });
      continue;
    }
    const contentHash = annotationContentHash(annotation);
    const previous = currentState.annotations[annotation.annotation_id];
    let existing = options.vault.get(notePath);
    if (previous?.contentHash === contentHash && previous.notePath === notePath && existing) {
      let existingText: string;
      try {
        existingText = await options.vault.read(existing);
      } catch (error) {
        annotationFailure = true;
        failures.push({ annotationId: annotation.annotation_id, stage: "note", message: errorMessage(error) });
        continue;
      }
      if (!noteNeedsFormatCleanup(existingText, annotation)) {
        const durableStatus = readFrontmatterValue(existingText, "research_status");
        if (previous.researchStatus === "too-short" || annotationIsTooShort(annotation)) {
          if (durableStatus !== "too-short") {
            try {
              await options.vault.modify(existing, replaceFrontmatterScalar(existingText, "research_status", "too-short"));
            } catch (error) {
              annotationFailure = true;
              failures.push({ annotationId: annotation.annotation_id, stage: "modify", message: errorMessage(error) });
              continue;
            }
          }
        } else if (durableStatus === "complete" && previous.researchStatus !== "complete") {
          try {
            const { state: adopted } = await options.state.mutate((state) => {
              const entry = state.annotations[annotation.annotation_id];
              if (entry && entry.researchStatus !== "complete") {
                entry.researchStatus = "complete";
                entry.processedAt = null;
              }
            });
            currentState = adopted;
          } catch (error) {
            annotationFailure = true;
            failures.push({ annotationId: annotation.annotation_id, stage: "mutate", message: errorMessage(error) });
            continue;
          }
        }
        if (!previous.researchPath) {
          const researchProp = readFrontmatterValue(existingText, "research");
          if (researchProp) {
            const target = wikilinkTarget(researchProp);
            if (target) {
              const companionPath = `${target}.md`;
              if (isValidResearchPathForNote(companionPath, notePath)) {
                try {
                  const companionEntry = options.vault.get(companionPath);
                  if (companionEntry) {
                    const companionText = await options.vault.read(companionEntry);
                    if (readFrontmatterValue(companionText, "annotation_id") === annotation.annotation_id) {
                      const { state: adopted } = await options.state.mutate((s) => {
                        const e = s.annotations[annotation.annotation_id];
                        if (e) e.researchPath = companionPath;
                      });
                      currentState = adopted;
                    }
                  }
                } catch {
                  // best-effort adoption
                }
              }
            }
          }
        }
        const effectiveResearchPath = currentState.annotations[annotation.annotation_id]?.researchPath;
        if (effectiveResearchPath && isValidResearchPathForNote(effectiveResearchPath, notePath)) {
          try {
            const companionEntry = options.vault.get(effectiveResearchPath);
            if (companionEntry) {
              const companionText = await options.vault.read(companionEntry);
              if (readFrontmatterValue(companionText, "annotation_id") === annotation.annotation_id) {
                const expectedLink = `[[${effectiveResearchPath.replace(/\.md$/i, "")}|Research]]`;
                const freshNote = options.vault.get(notePath);
                if (freshNote) {
                  const freshText = await options.vault.read(freshNote);
                  const withProp = upsertFrontmatterKey(freshText, "research", expectedLink);
                  if (withProp !== freshText) {
                    await options.vault.modify(freshNote, withProp);
                  }
                }
              }
            }
          } catch {
            // best-effort reconciliation
          }
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
    }

    try {
      const migrationSourcePath = previous && previous.notePath !== notePath ? previous.notePath : undefined;
      const oldEntry = migrationSourcePath ? options.vault.get(migrationSourcePath) : null;
      const readEntry = oldEntry ?? existing;

      const existingText = readEntry ? await options.vault.read(readEntry) : "";
      const tooShort = annotationIsTooShort(annotation);
      const importedAt = previous?.importedAt ?? readFrontmatterValue(existingText, "imported_at") ?? syncAt;
      const sourceChanged = Boolean(previous && previous.contentHash !== contentHash);
      const researchStatus = sourceChanged && !tooShort ? "off" : chooseResearchStatus(annotation, previous, existingText);
      const processedAt = previous && previous.contentHash !== contentHash ? null : previous?.processedAt ?? null;

      // Legacy inline research extraction — validates markers before any note
      // modification so incomplete/duplicate markers fail safely before rename.
      let legacyExtraction: LegacyExtractionResult | null = null;
      if (existingText) {
        legacyExtraction = extractLegacyInlineResearch(existingText);
      }

      const renderInput = legacyExtraction ? legacyExtraction.annotationText : existingText;
      let noteText = renderAnnotationNote(renderInput, annotation, {
        importedAt,
        researchStatus,
      });

      if (sourceChanged) {
        noteText = removeFrontmatterKeysFromText(noteText, ["research"]);
      }

      if (oldEntry && migrationSourcePath) {
        try {
          await ensureVaultFolders(options.vault, notePath);
          await options.vault.rename(oldEntry, notePath);
          existing = options.vault.get(notePath) ?? { path: notePath, raw: oldEntry.raw };
        } catch {
          notePath = migrationSourcePath;
          existing = oldEntry;
        }
      }

      const resolvedNotePath: string = notePath;
      await ensureVaultFolders(options.vault, resolvedNotePath);

      let researchPath = previous?.researchPath;
      if (legacyExtraction) {
        const companionResult = await writeCompanionNote(options.vault, {
          annotationPath: resolvedNotePath,
          annotationId: annotation.annotation_id,
          content: legacyExtraction.companionContent,
          storedCompanionPath: researchPath,
        });
        researchPath = companionResult.companionPath;

        if (!sourceChanged) {
          const link = `[[${companionResult.companionPath.replace(/\.md$/i, "")}|Research]]`;
          noteText = upsertFrontmatterKey(noteText, "research", link);
        }
      }

      let action: ImportedAnnotationResult["action"] = existing ? "updated" : "created";
      if (existing) {
        if (noteText !== existingText) {
          await options.vault.modify(existing, noteText);
        } else {
          action = "unchanged";
        }
      } else {
        await options.vault.create(resolvedNotePath, noteText);
      }

      try {
        const { state: nextState } = await options.state.mutate((freshState) => {
          freshState.annotations[annotation.annotation_id] = {
            contentHash,
            notePath: resolvedNotePath,
            importedAt,
            researchStatus,
            processedAt,
            ...(researchPath ? { researchPath } : {}),
          };
        });
        currentState = nextState;
      } catch (error) {
        annotationFailure = true;
        failures.push({ annotationId: annotation.annotation_id, stage: "state", message: errorMessage(error) });
        continue;
      }
      statePersisted = true;
      imported.push({
        annotationId: annotation.annotation_id,
        notePath: resolvedNotePath,
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
    try {
      const { state: nextState } = await options.state.mutate((freshState) => {
        freshState.lastSyncAt = syncAt;
      });
      currentState = nextState;
    } catch (error) {
      failures.push({ stage: "state", message: errorMessage(error) });
    }
  }

  // A note/state failure earlier in this pass can leave currentState only partially advanced
  // (e.g. a rename succeeded but its state save did not). Rebuilding indexes from that stale
  // mix would write a wrong path into a book index; skip entirely and let the next successful
  // sync (after the failed entry is adopted) regenerate indexes from a fully consistent state.
  const indexPaths: string[] = [];
  if (!annotationFailure) {
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
  }

  if (isInitialImport && failures.length === 0) {
    try {
      const { state: nextState } = await options.state.mutate((freshState) => {
        freshState.initialImportCompletedAt = syncAt;
      });
      currentState = nextState;
    } catch (error) {
      failures.push({ stage: "state", message: errorMessage(error) });
    }
  }

  return { imported, failures, state: currentState, indexPaths, initialImport: isInitialImport };
}

export function renderAnnotationNote(
  existingText: string,
  annotation: AppleBooksAnnotation,
  values: Pick<ReadingStateEntry, "importedAt" | "researchStatus">,
): string {
  const withoutGenerated = removeFrontmatterKeysFromText(existingText, GENERATED_FRONTMATTER_KEYS);
  const withReadableLinks = convertFrontmatterWikilinkLists(withoutGenerated);
  const frontmatter = upsertManagedFrontmatter(withReadableLinks, {
    type: "apple-books-annotation",
    source: "apple-books",
    annotation_id: annotation.annotation_id,
    book_title: annotation.book_title,
    book_author: annotation.author ?? "",
    chapter: annotation.chapter ?? "",
    location: annotation.location ?? "",
    created_at: annotation.created_at ?? "",
    imported_at: values.importedAt,
    research_status: values.researchStatus,
  });
  const parts = splitFrontmatter(frontmatter);
  const sourceResult = replaceLeadingAnnotationSource(parts.body, annotation);
  if (!sourceResult.ok) {
    throw new Error(`Cannot update Apple Books source: ${sourceResult.reason}`);
  }
  return composeFrontmatter(parts.frontmatter, sourceResult.text);
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

function upsertFrontmatterKey(text: string, key: string, value: string): string {
  const parts = splitFrontmatter(text);
  if (!parts.frontmatter) return text;
  const lines = parts.frontmatter.split("\n");
  const line = `${key}: ${yamlScalar(value)}`;
  const index = lines.findIndex((candidate) => new RegExp(`^${key}\\s*:`).test(candidate));
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.push(line);
  }
  return composeFrontmatter(lines.join("\n"), parts.body);
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 .,_-]*$/.test(value) && !["true", "false", "null"].includes(value.toLowerCase())
    ? value
    : JSON.stringify(value);
}

function removeFrontmatterKeysFromText(text: string, keys: readonly string[]): string {
  const parts = splitFrontmatter(text);
  if (!parts.frontmatter) {
    return text;
  }
  return composeFrontmatter(removeFrontmatterKeys(parts.frontmatter.split("\n"), keys).join("\n"), parts.body);
}

function removeFrontmatterKeys(lines: string[], keys: readonly string[]): string[] {
  const keySet = new Set(keys);
  const result: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (skipping && /^[ \t]/.test(line)) {
      continue;
    }
    skipping = false;
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match && keySet.has(match[1] ?? "")) {
      skipping = true;
      continue;
    }
    result.push(line);
  }
  return result;
}

function isAlreadyWikilink(value: string): boolean {
  return /^\[\[[^[\]]*(\|[^[\]]*)?\]\]$/.test(value);
}

const WIKILINK_TARGET_PATTERN = /^\[\[([^[\]|]*)(?:\|[^[\]]*)?\]\]$/;

function wikilinkTarget(value: string): string | undefined {
  return WIKILINK_TARGET_PATTERN.exec(value)?.[1];
}

/** relatedNoteWikilink strips the .md extension for display; isSafeRelatedTarget expects it back to validate the underlying vault path. */
function isSafeExistingRelatedWikilink(raw: string): boolean {
  const target = wikilinkTarget(raw);
  return target !== undefined && isSafeRelatedTarget(`${target}.md`);
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function yamlDoubleQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * Converts a plain YAML block list (ruamel's default `key:\n  - value`
 * shape) of raw concept/related values into readable wikilinks. Any other
 * shape (inline flow list, scalar value, empty block, missing key) is left
 * completely untouched rather than guessed at, so frontmatter never gets
 * corrupted. Items already in wikilink form are passed through unchanged
 * (byte-for-byte) so repeated imports stay idempotent, unless `keepExisting`
 * rejects one (e.g. an existing related link whose target is no longer
 * safe), in which case it is dropped rather than preserved or re-derived.
 */
function convertBlockList(
  lines: string[],
  key: string,
  transform: (raw: string) => string | undefined,
  keepExisting: (raw: string) => boolean = () => true,
): string[] {
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`).test(line));
  if (headerIndex < 0) {
    return lines;
  }
  let end = headerIndex + 1;
  const items: string[] = [];
  while (end < lines.length) {
    const match = /^ {2}-\s?(.*)$/.exec(lines[end] ?? "");
    if (!match) break;
    items.push(unquoteYamlScalar(match[1] ?? ""));
    end += 1;
  }
  if (items.length === 0) {
    return lines;
  }
  const seen = new Set<string>();
  const converted: string[] = [];
  for (const raw of items) {
    const value = isAlreadyWikilink(raw) ? (keepExisting(raw) ? raw : undefined) : transform(raw);
    if (value && !seen.has(value)) {
      seen.add(value);
      converted.push(value);
    }
  }
  const replacement = converted.length > 0
    ? [`${key}:`, ...converted.map((value) => `  - ${yamlDoubleQuoted(value)}`)]
    : [];
  return [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(end)];
}

function convertFrontmatterWikilinkLists(text: string): string {
  const parts = splitFrontmatter(text);
  if (!parts.frontmatter) {
    return text;
  }
  let lines = parts.frontmatter.split("\n");
  lines = convertBlockList(lines, "concepts", conceptWikilink);
  lines = convertBlockList(lines, "related", relatedNoteWikilink, isSafeExistingRelatedWikilink);
  return composeFrontmatter(lines.join("\n"), parts.body);
}

/**
 * True when a note's stored content still needs a full render pass even
 * though its Apple Books source content hash is unchanged: an old marker
 * (including an orphan end marker with no start), leftover generated
 * summary/tags, a concepts/related block list still holding a raw
 * (non-wikilink) value or an existing related wikilink whose target is no
 * longer safe, or a missing/outdated managed `location` field. A genuinely
 * clean, up-to-date note returns false so the unchanged fast path stays a
 * true no-op.
 */
function noteNeedsFormatCleanup(existingText: string, annotation: AppleBooksAnnotation): boolean {
  if (existingText.includes(READING_SOURCE_START) || existingText.includes(READING_SOURCE_END)) {
    return true;
  }
  if (existingText.includes(RESEARCH_START) || existingText.includes(RESEARCH_END)) {
    return true;
  }
  const frontmatter = splitFrontmatter(existingText).frontmatter;
  if (!frontmatter) {
    return false;
  }
  const lines = frontmatter.split("\n");
  if (lines.some((line) => /^(?:summary|tags)\s*:/.test(line))) {
    return true;
  }
  if (blockListNeedsCleanup(lines, "concepts", isAlreadyWikilink)) {
    return true;
  }
  if (blockListNeedsCleanup(lines, "related", (value) => isAlreadyWikilink(value) && isSafeExistingRelatedWikilink(value))) {
    return true;
  }
  const currentLocation = readFrontmatterValue(existingText, "location") ?? "";
  return currentLocation !== (annotation.location ?? "");
}

function blockListNeedsCleanup(lines: string[], key: string, isItemClean: (raw: string) => boolean): boolean {
  const headerIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`).test(line));
  if (headerIndex < 0) {
    return false;
  }
  let index = headerIndex + 1;
  while (index < lines.length) {
    const match = /^ {2}-\s?(.*)$/.exec(lines[index] ?? "");
    if (!match) break;
    if (!isItemClean(unquoteYamlScalar(match[1] ?? ""))) {
      return true;
    }
    index += 1;
  }
  return false;
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
