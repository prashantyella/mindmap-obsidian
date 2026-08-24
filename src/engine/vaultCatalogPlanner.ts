import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "./contracts";
import { EngineError } from "./errors";
import { parseFrontmatter } from "./frontmatterEngine";
import { projectSource } from "./sourceProjection";
import { READING_ANNOTATIONS_FOLDER } from "../readingTypes";
import {
  isSafeIndividualNotePath,
  isWithinScope,
  minimumWordsForNote,
  normalizedWordCount,
  READING_NOTES_ROOT,
} from "../individualNote";

/**
 * Obsidian-free vault-sample planner (Checkpoint 9 requirement 9): computes
 * exactly which candidate paths are eligible for a bounded sample, using
 * the SAME eligibility rules production's `individualNote.ts` already
 * enforces (`isSafeIndividualNotePath`, `isWithinScope`,
 * `minimumWordsForNote`) -- never a parallel, drift-prone reimplementation.
 * A thin Obsidian adapter (`vaultCatalogReader.ts`) only enumerates paths
 * and reads text according to the PLAN this module computes; it makes no
 * eligibility decision of its own.
 *
 * No `obsidian` import anywhere in this file -- fully Node-testable.
 */

/** Closed set of reasons ONE candidate can be skipped without aborting the whole sample -- Checkpoint 9 requirement 9: "per-file read failures become bounded reason counts, not raw run failure". */
export const CATALOG_SKIP_REASON_CODES = [
  "UNSAFE_PATH",
  "OUT_OF_SCOPE",
  "MANAGED_ARTIFACT",
  "RESEARCH_COMPANION",
  "READ_FAILED",
  "MISSING_ANNOTATION_ID",
  "TOO_SHORT",
  "IDENTITY_INVALID",
] as const;

export type CatalogSkipReasonCode = (typeof CATALOG_SKIP_REASON_CODES)[number];

export interface CatalogPlannerConfig {
  /** Configured "all scope" folders (`ScopeSelection.currentPaths`, or equivalent) -- validated/canonicalized before use (requirement 9: "never treat malformed/empty folder as vault root"). */
  scopeFolders: readonly string[];
  /** Whether the strict, structurally-validated Reading-annotation inclusion path (`Books/Apple Books/<author>/<book>/Annotations/*.md` only -- never a broad grant over the whole Reading root) is active at all. Defaults to `true`. */
  includeReadingAnnotations?: boolean;
  minimumWords: number;
  /** Obsidian's actual `Vault#configDir` (may be renamed by the user) -- never a hardcoded `.obsidian` (requirement 9: "add source audit for configDir support rather than hardcoded .obsidian"). */
  configDir?: string;
  runtimeFolder?: string;
}

export interface CatalogTextReader {
  /** Reads one candidate's full text. A rejection is caught and counted as a bounded `READ_FAILED` skip -- never aborts the whole plan. `signal`, when provided, should be honored promptly by a real implementation. */
  readText(relpath: string, signal?: AbortSignal): Promise<string>;
}

export interface CatalogPlanItem {
  relpath: string;
  identity: NoteIdentityV1;
  isAppleAnnotation: boolean;
  rawContent: string;
}

export interface CatalogPlanResult {
  items: CatalogPlanItem[];
  /** Every skip this run recorded, keyed by its closed reason code, bounded to `CATALOG_SKIP_REASON_CODES` -- never a raw per-file message/path. */
  skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>>;
  /** `true` when `signal` aborted the walk before every sorted candidate was considered. */
  aborted: boolean;
}



/**
 * Canonicalizes and strictly validates one folder-scope entry via
 * `canonicalizePath` ITSELF -- never a hand-rolled partial normalizer that
 * pre-strips slashes before validating (closure review item 4: a prior
 * version stripped LEADING slashes before calling `canonicalizePath`,
 * which silently turned an absolute path like `/Secret` into the
 * relative-looking `Secret` instead of rejecting it -- repairing unsafe
 * input into safe-looking input is exactly the bug being fixed here).
 * `canonicalizePath` alone already rejects: an absolute POSIX path
 * (leading `/`), a Windows drive path (`C:\`/`C:/`), a UNC path
 * (`\\server\share`, which normalizes to a leading `//`), `..` traversal,
 * a control/NUL character, and an empty/malformed value -- a rejection
 * here returns `null` (dropped, never included) rather than letting any
 * of those silently widen matching. The literal sentinel `"."` (an
 * explicit whole-vault scope) is preserved as-is because
 * `canonicalizePath` itself rejects a bare `"."` (it collapses to nothing
 * after normalization) -- special-cased here as the one deliberate
 * exception, not a malformed value.
 */
function canonicalizeScopeFolder(folder: unknown): string | null {
  if (typeof folder !== "string") return null;
  const trimmed = folder.trim();
  if (trimmed === "" || trimmed === ".") return trimmed === "." ? "." : null;
  try {
    return canonicalizePath(trimmed);
  } catch {
    return null; // traversal, absolute (POSIX/Windows drive/UNC), control character, or malformed -- dropped, never repaired
  }
}

/** Canonicalizes every entry via `canonicalizeScopeFolder` and deduplicates the RESULT (two different spellings of the same folder collapse to one entry; a dropped/malformed entry never fills in for a valid one). */
function canonicalizeScopeFolders(folders: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const folder of folders) {
    const result = canonicalizeScopeFolder(folder);
    if (result !== null) seen.add(result);
  }
  return [...seen];
}

/**
 * Structural shape only: exactly `Books/Apple Books/<author>/<book>/
 * Annotations/<note>.md` (four path segments after the Reading root,
 * with `Annotations` as the third). This is the ONLY shape that admits a
 * candidate through the Reading-root inclusion path -- an ordinary file
 * anywhere else under the broad Reading root (a book-level note, a
 * malformed/shallow path, a `Research` companion, a generated `Index.md`)
 * is excluded by this check alone (Checkpoint 9 closure review item 3:
 * "not arbitrary ordinary files anywhere under the broad Reading root").
 */
function isStructurallyValidAnnotationPath(relpath: string): boolean {
  const normalized = relpath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized !== READING_NOTES_ROOT && !normalized.startsWith(`${READING_NOTES_ROOT}/`)) return false;
  const rest = normalized.slice(READING_NOTES_ROOT.length).replace(/^\/+/, "");
  const parts = rest.split("/");
  return parts.length === 4 && parts[0] !== "" && parts[1] !== "" && parts[2] === READING_ANNOTATIONS_FOLDER && parts[3].toLowerCase().endsWith(".md");
}

/** Structural shape only: `Books/Apple Books/<author>/<book>/Index.md`. Used only to positively identify the generated-index shape for the `MANAGED_ARTIFACT` skip reason (content markers are checked by the caller before trusting this). */
function isReadingIndexShapedPath(relpath: string): boolean {
  const normalized = relpath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized !== READING_NOTES_ROOT && !normalized.startsWith(`${READING_NOTES_ROOT}/`)) return false;
  const rest = normalized.slice(READING_NOTES_ROOT.length).replace(/^\/+/, "");
  const parts = rest.split("/");
  return parts.length === 3 && parts[2] === "Index.md";
}

const READING_INDEX_START = "<!-- mindmap:apple-books-index:start -->";
const READING_INDEX_END = "<!-- mindmap:apple-books-index:end -->";

function hasCompleteManagedIndexMarkers(text: string): boolean {
  const startIndex = text.indexOf(READING_INDEX_START);
  const endIndex = text.indexOf(READING_INDEX_END);
  if (startIndex === -1 || endIndex === -1) return false;
  if (text.indexOf(READING_INDEX_START, startIndex + 1) !== -1) return false;
  if (text.indexOf(READING_INDEX_END, endIndex + 1) !== -1) return false;
  return startIndex < endIndex;
}

/** Reads `annotation_id` out of the frontmatter block via the SAME strict YAML frontmatter parser (`parseFrontmatter`, backed by the real `yaml` package with `uniqueKeys: true`) every other engine module uses -- never a hand-rolled regex scrape. A duplicate-key frontmatter block, a non-scalar `annotation_id` value, or a blank/whitespace-only value all return `undefined` (never a malformed id silently accepted) -- the caller treats that as `MISSING_ANNOTATION_ID`, not a crash. */
function readAnnotationIdFrontmatter(text: string): string | undefined {
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(text).frontmatter;
  } catch {
    return undefined;
  }
  const raw = frontmatter.annotation_id;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isAppleBooksAnnotationType(text: string): boolean {
  try {
    const type = parseFrontmatter(text).frontmatter.type;
    return typeof type === "string" && type.trim().toLowerCase() === "apple-books-annotation";
  } catch {
    return false;
  }
}

function bodyAfterFrontmatter(text: string): string {
  try {
    return parseFrontmatter(text).body;
  } catch {
    return text;
  }
}

export const DEFAULT_MAX_CATALOG_SAMPLE = 50;

function assertValidMaxCount(maxCount: number): void {
  if (!Number.isInteger(maxCount) || maxCount < 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", "planCatalogSample maxCount must be a non-negative integer.");
  }
}

function assertValidMinimumWords(minimumWords: number): void {
  if (!Number.isInteger(minimumWords) || minimumWords < 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", "planCatalogSample config.minimumWords must be a non-negative integer.");
  }
}

/**
 * Canonicalizes, validates, and dedupes candidate paths via
 * `canonicalizePath` ITSELF -- the same fix as `canonicalizeScopeFolder`
 * above (closure review item 4): no hand-rolled partial normalizer that
 * could repair an absolute/traversal/control-character path into a
 * safe-looking relative one before validating it. `canonicalizePath`
 * rejects all of those outright; a rejected candidate is dropped, never
 * repaired. Two different spellings of the same path (extra slashes,
 * backslashes, a leading `./`) canonicalize to the same string and
 * collapse to one candidate.
 */
function canonicalizeCandidatePaths(candidatePaths: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const raw of candidatePaths) {
    if (typeof raw !== "string") continue;
    try {
      seen.add(canonicalizePath(raw));
    } catch {
      continue; // absolute, traversal, control character, or malformed -- dropped, never repaired
    }
  }
  return [...seen];
}

/**
 * Deterministically plans a bounded, eligible sample from `candidatePaths`:
 *
 * 1. Canonicalizes/validates every input: `config.scopeFolders`/
 *    `readingFolders`/`runtimeFolder` (traversal, absolute, and control-
 *    character entries are dropped, never widening scope), `candidatePaths`
 *    (canonicalized and deduped), and `maxCount`/`config.minimumWords`
 *    (strictly validated, rejected outright if malformed).
 * 2. Sorts every canonicalized candidate path BEFORE any read or sampling
 *    decision -- the resulting sample is reproducible across runs/machines
 *    regardless of the order the caller's directory listing happened to
 *    return (requirement 9: "deterministic canonical-path sort BEFORE
 *    sampling").
 * 3. Walks the sorted list in order, reading and classifying each
 *    candidate via `reader` until `maxCount` ELIGIBLE items have been
 *    collected (or the candidates are exhausted, or `signal` aborts) -- a
 *    per-file read failure or ineligibility is recorded as a bounded
 *    reason count and the walk continues, never aborting the whole plan.
 */
/** `classifyCandidate`'s own result: `item` is the classified `CatalogPlanItem` (or `null` for anything ineligible); `bytesRead` is the UTF-8 byte length of whatever `reader.readText` actually returned for this candidate -- `0` when the candidate was rejected BEFORE ever reaching a read (`UNSAFE_PATH`/`OUT_OF_SCOPE`/`RESEARCH_COMPANION`), and the real byte count for every other outcome, INCLUDING a later skip (`READ_FAILED` reads nothing so stays `0`; `MANAGED_ARTIFACT`/further `OUT_OF_SCOPE`/`TOO_SHORT`/`MISSING_ANNOTATION_ID`/`IDENTITY_INVALID` all read the file first, so all report the real byte count even though `item` is `null`). A byte-bounded streaming caller (`streamFullCatalogDiscovery`, item 4 of the 10B cutover) needs this to bound EVERY file body it actually reads, not merely the ones that end up eligible. */
interface ClassifyCandidateResult {
  item: CatalogPlanItem | null;
  bytesRead: number;
}

/**
 * Classifies ONE candidate path against the shared eligibility rules --
 * factored out of `planCatalogSample` so `planFullCatalogDiscovery` (real
 * migration/production discovery, Checkpoint 10A) walks the EXACT same
 * decision tree instead of a parallel, drift-prone copy. Calls `skip` with
 * the closed reason code and reports `item: null` for anything ineligible;
 * reports the classified `CatalogPlanItem` on success. Never throws for an
 * ordinary skip -- only a truly unexpected internal error would escape.
 */
async function classifyCandidate(
  relpath: string,
  config: CatalogPlannerConfig,
  scopeFolders: string[],
  runtimeFolder: string | null,
  reader: CatalogTextReader,
  signal: AbortSignal | undefined,
  skip: (code: CatalogSkipReasonCode) => void,
): Promise<ClassifyCandidateResult> {
  if (!isSafeIndividualNotePath(relpath, config.configDir)) {
    skip("UNSAFE_PATH");
    return { item: null, bytesRead: 0 };
  }
  if (runtimeFolder !== null && isWithinFolder(relpath, runtimeFolder)) {
    skip("UNSAFE_PATH");
    return { item: null, bytesRead: 0 };
  }

  const readingIncluded = config.includeReadingAnnotations !== false;
  const isAnnotationShaped = readingIncluded && isStructurallyValidAnnotationPath(relpath);
  const isIndexShaped = readingIncluded && isReadingIndexShapedPath(relpath);
  const inOrdinaryScope = isWithinScope(relpath, scopeFolders);
  // Reading-root inclusion is STRICT: only a structurally valid annotation path (or the
  // generated-index shape, so it can still be positively identified and excluded below) is ever
  // admitted through this branch -- never an arbitrary ordinary file anywhere else under the
  // broad Reading root (Checkpoint 9 closure review item 3). An ordinary note that merely LIVES
  // under the Reading root but isn't shaped like either of these is only visible at all if the
  // caller's ORDINARY `scopeFolders` independently cover it.
  if (!inOrdinaryScope && !isAnnotationShaped && !isIndexShaped) {
    skip("OUT_OF_SCOPE");
    return { item: null, bytesRead: 0 };
  }
  if (isResearchCompanionPath(relpath)) {
    skip("RESEARCH_COMPANION");
    return { item: null, bytesRead: 0 };
  }

  let text: string;
  try {
    text = await reader.readText(relpath, signal);
  } catch {
    skip("READ_FAILED");
    return { item: null, bytesRead: 0 };
  }
  const bytesRead = Buffer.byteLength(text, "utf8");

  if (isIndexShaped && hasCompleteManagedIndexMarkers(text)) {
    skip("MANAGED_ARTIFACT");
    return { item: null, bytesRead };
  }

  // Only a note both STRUCTURALLY shaped like a real annotation AND carrying the annotation
  // frontmatter type gets annotation-identity treatment -- an ordinary note elsewhere that
  // copy-pasted the type value, or a structurally-shaped file missing the type, is never mistaken
  // for a real annotation (Checkpoint 9 requirement 9/closure review item 3).
  const annotation = isAnnotationShaped && isAppleBooksAnnotationType(text);
  // A candidate admitted through the STRICT Reading-annotation path ONLY (not independently
  // covered by the caller's ordinary scopeFolders) must actually BE a real annotation -- if its
  // frontmatter type doesn't match, it is skipped outright, never silently downgraded into an
  // ordinary path-identity note just because it happened to pass the annotation-shape gate
  // (Checkpoint 9 closure review item 4). A candidate the caller's ORDINARY scope independently
  // covers keeps the pre-existing, explicitly-tested ordinary-note policy: it is still included
  // as an ordinary note when it isn't a real annotation.
  if (isAnnotationShaped && !inOrdinaryScope && !annotation) {
    skip("OUT_OF_SCOPE");
    return { item: null, bytesRead };
  }
  const body = bodyAfterFrontmatter(text);
  const minimum = minimumWordsForNote(text, config.minimumWords);
  // `normalizedWordCount` (Unicode-aware word matching) is used uniformly for BOTH ordinary and
  // annotation notes here (closure review item 3) -- unlike `individualNote.ts`'s own
  // `assessActiveNote`, which only applies it to annotations; this module's own eligibility
  // count does not need to byte-for-byte match that one code path's historical behavior.
  const wordCount = normalizedWordCount(body);
  if (wordCount < minimum) {
    skip("TOO_SHORT");
    return { item: null, bytesRead };
  }

  try {
    const canonical = canonicalizePath(relpath);
    if (annotation) {
      const annotationId = readAnnotationIdFrontmatter(text);
      if (!annotationId) {
        skip("MISSING_ANNOTATION_ID");
        return { item: null, bytesRead };
      }
      return { item: { relpath, identity: stableNoteIdentity(canonical, annotationId), isAppleAnnotation: true, rawContent: text }, bytesRead };
    }
    return { item: { relpath, identity: stableNoteIdentity(canonical), isAppleAnnotation: false, rawContent: text }, bytesRead };
  } catch {
    skip("IDENTITY_INVALID");
    return { item: null, bytesRead };
  }
}

export async function planCatalogSample(candidatePaths: readonly string[], config: CatalogPlannerConfig, reader: CatalogTextReader, maxCount: number = DEFAULT_MAX_CATALOG_SAMPLE, signal?: AbortSignal): Promise<CatalogPlanResult> {
  assertValidMaxCount(maxCount);
  assertValidMinimumWords(config.minimumWords);
  const scopeFolders = canonicalizeScopeFolders(config.scopeFolders);
  const runtimeFolder = config.runtimeFolder !== undefined ? canonicalizeScopeFolder(config.runtimeFolder) : null;
  const sorted = canonicalizeCandidatePaths(candidatePaths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bound = Math.min(maxCount, DEFAULT_MAX_CATALOG_SAMPLE);

  const items: CatalogPlanItem[] = [];
  const skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>> = {};
  const skip = (code: CatalogSkipReasonCode) => {
    skipReasonCounts[code] = (skipReasonCounts[code] ?? 0) + 1;
  };

  let aborted = false;
  for (const relpath of sorted) {
    if (items.length >= bound) break;
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const { item } = await classifyCandidate(relpath, config, scopeFolders, runtimeFolder, reader, signal, skip);
    if (item) items.push(item);
  }

  return { items, skipReasonCounts, aborted };
}

/**
 * Checkpoint 10A: the safety ceiling on a FULL production catalog
 * discovery pass (migration/rebuild note enumeration) -- deliberately much
 * higher than `DEFAULT_MAX_CATALOG_SAMPLE` (a 50-note DEV DIAGNOSTIC
 * sample, Checkpoint 9's own bound, left completely untouched here) since
 * migration must discover every eligible note in a real vault, not a
 * capped preview. Still a hard, explicit cap -- defense-in-depth against
 * an unbounded scan, never silently unbounded.
 */
export const MAX_CATALOG_DISCOVERY_ITEMS = 20_000;

/**
 * Full (non-sampled) catalog discovery for real production use
 * (Checkpoint 10A migration/rebuild note enumeration): walks EVERY
 * canonicalized, sorted candidate and classifies each one via the exact
 * same `classifyCandidate` decision tree `planCatalogSample` itself uses
 * -- never a parallel reimplementation -- collecting every eligible item
 * up to `MAX_CATALOG_DISCOVERY_ITEMS`, not a small fixed sample. Still
 * fully Node-testable/Obsidian-free; a caller in `src/engine` or
 * `src/migration` supplies real vault paths/text via `CatalogTextReader`.
 */
export async function planFullCatalogDiscovery(candidatePaths: readonly string[], config: CatalogPlannerConfig, reader: CatalogTextReader, signal?: AbortSignal, maxItems: number = MAX_CATALOG_DISCOVERY_ITEMS): Promise<CatalogPlanResult> {
  assertValidMaxCount(maxItems);
  assertValidMinimumWords(config.minimumWords);
  const scopeFolders = canonicalizeScopeFolders(config.scopeFolders);
  const runtimeFolder = config.runtimeFolder !== undefined ? canonicalizeScopeFolder(config.runtimeFolder) : null;
  const sorted = canonicalizeCandidatePaths(candidatePaths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bound = Math.min(maxItems, MAX_CATALOG_DISCOVERY_ITEMS);

  const items: CatalogPlanItem[] = [];
  const skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>> = {};
  const skip = (code: CatalogSkipReasonCode) => {
    skipReasonCounts[code] = (skipReasonCounts[code] ?? 0) + 1;
  };

  let aborted = false;
  for (const relpath of sorted) {
    if (items.length >= bound) break;
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const { item } = await classifyCandidate(relpath, config, scopeFolders, runtimeFolder, reader, signal, skip);
    if (item) items.push(item);
  }

  return { items, skipReasonCounts, aborted };
}

/**
 * Checkpoint 10A item 8: the safety ceiling on total UTF-8 bytes a single
 * `streamFullCatalogDiscovery` pass will ever read across every candidate
 * combined -- a second, independent bound alongside `MAX_CATALOG_DISCOVERY_ITEMS`
 * (a 10,000-note vault of unusually large files could exceed a sane memory/
 * time budget well before hitting the item-count cap alone).
 */
export const MAX_CATALOG_DISCOVERY_TOTAL_BYTES = 500_000_000;

export interface CatalogDiscoveryStreamItem {
  identity: NoteIdentityV1;
  sourceHash: string;
}

export interface CatalogDiscoveryStreamResult {
  items: CatalogDiscoveryStreamItem[];
  /** Every skip this run recorded, keyed by its closed reason code -- see `CatalogPlanResult`. */
  skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>>;
  /** `true` when `signal` aborted the walk, OR `maxTotalBytes` was reached, before every sorted candidate was considered. */
  aborted: boolean;
  /** Bounded, content-free running total of UTF-8 bytes read across every classified candidate this pass -- never a byte of the content itself. */
  totalBytesRead: number;
}

function assertValidMaxBytes(maxTotalBytes: number): void {
  if (!Number.isFinite(maxTotalBytes) || !Number.isInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", "streamFullCatalogDiscovery maxTotalBytes must be a positive integer.", {});
  }
}

/**
 * Checkpoint 10A item 8: "do not retain 10,000 note bodies" -- a
 * content-free streaming counterpart to `planFullCatalogDiscovery` for
 * migration/scope-refresh discovery. Reads, classifies, and projects
 * (`sourceHash` only, via the SAME `projectSource` every write path uses)
 * exactly ONE candidate's raw text at a time; that text is never appended
 * to any array or otherwise retained past the single loop iteration that
 * read it -- only the tiny `{identity, sourceHash}` pair survives. Bounded
 * by both item count (`maxItems`, capped at `MAX_CATALOG_DISCOVERY_ITEMS`)
 * and total bytes read (`maxTotalBytes`, capped at
 * `MAX_CATALOG_DISCOVERY_TOTAL_BYTES`), and cancellable via `signal`,
 * checked between every candidate exactly like `planFullCatalogDiscovery`.
 *
 * A caller that later needs a specific note's full body again (e.g.
 * migration ingestion re-reading one identity to embed it) re-reads that
 * ONE identity through `NoteSourceReader`/`CatalogTextReader` directly --
 * never by re-running this discovery pass and searching its output for
 * content that was never retained in the first place.
 */
export async function streamFullCatalogDiscovery(
  candidatePaths: readonly string[],
  config: CatalogPlannerConfig,
  reader: CatalogTextReader,
  signal?: AbortSignal,
  maxItems: number = MAX_CATALOG_DISCOVERY_ITEMS,
  maxTotalBytes: number = MAX_CATALOG_DISCOVERY_TOTAL_BYTES,
): Promise<CatalogDiscoveryStreamResult> {
  assertValidMaxCount(maxItems);
  assertValidMaxBytes(maxTotalBytes);
  assertValidMinimumWords(config.minimumWords);
  const scopeFolders = canonicalizeScopeFolders(config.scopeFolders);
  const runtimeFolder = config.runtimeFolder !== undefined ? canonicalizeScopeFolder(config.runtimeFolder) : null;
  const sorted = canonicalizeCandidatePaths(candidatePaths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bound = Math.min(maxItems, MAX_CATALOG_DISCOVERY_ITEMS);
  const byteBound = Math.min(maxTotalBytes, MAX_CATALOG_DISCOVERY_TOTAL_BYTES);

  const items: CatalogDiscoveryStreamItem[] = [];
  const skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>> = {};
  const skip = (code: CatalogSkipReasonCode) => {
    skipReasonCounts[code] = (skipReasonCounts[code] ?? 0) + 1;
  };

  let aborted = false;
  let totalBytesRead = 0;
  for (const relpath of sorted) {
    if (items.length >= bound) break;
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    if (totalBytesRead >= byteBound) {
      aborted = true;
      break;
    }
    // Item 4 (10B cutover): `classifyCandidate` reports `bytesRead` for EVERY candidate whose body
    // was actually pulled off disk -- including one later skipped as ineligible (too short, a
    // managed artifact, a non-matching annotation type, etc.) -- never only the ones that end up
    // accepted into `items`. Those bytes count toward the budget regardless of the classification
    // outcome, so a large run of skipped-but-read files can never blow through `byteBound`
    // unnoticed just because none of them individually became an accepted item.
    const { item, bytesRead } = await classifyCandidate(relpath, config, scopeFolders, runtimeFolder, reader, signal, skip);
    totalBytesRead += bytesRead;
    if (totalBytesRead > byteBound) {
      aborted = true;
      break;
    }
    if (!item) continue;
    const sourceHash = projectSource(item.identity, item.rawContent).sourceHash;
    items.push({ identity: item.identity, sourceHash });
    // `item`/`item.rawContent` fall out of scope here -- never accumulated across iterations.
  }

  return { items, skipReasonCounts, aborted, totalBytesRead };
}

/**
 * Checkpoint 10A item 8: resolves a SINGLE apple-annotation identity by its
 * `appleAnnotationId` without ever retaining more than one candidate's raw
 * text at a time -- a content-free counterpart to scanning
 * `planFullCatalogDiscovery`'s full retained-body result for a match.
 * Returns as soon as a match is found (never keeps scanning the rest of
 * the vault), and returns `null` if no candidate matches within
 * `maxCandidates`/before `signal` aborts.
 */
export async function findCatalogItemByAnnotationId(
  candidatePaths: readonly string[],
  config: CatalogPlannerConfig,
  reader: CatalogTextReader,
  appleAnnotationId: string,
  signal?: AbortSignal,
  maxCandidates: number = MAX_CATALOG_DISCOVERY_ITEMS,
): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
  assertValidMaxCount(maxCandidates);
  assertValidMinimumWords(config.minimumWords);
  const scopeFolders = canonicalizeScopeFolders(config.scopeFolders);
  const runtimeFolder = config.runtimeFolder !== undefined ? canonicalizeScopeFolder(config.runtimeFolder) : null;
  const sorted = canonicalizeCandidatePaths(candidatePaths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bound = Math.min(maxCandidates, MAX_CATALOG_DISCOVERY_ITEMS);
  const skipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>> = {};
  const skip = (code: CatalogSkipReasonCode) => {
    skipReasonCounts[code] = (skipReasonCounts[code] ?? 0) + 1;
  };

  let considered = 0;
  for (const relpath of sorted) {
    if (considered >= bound) break;
    if (signal?.aborted) break;
    const { item } = await classifyCandidate(relpath, config, scopeFolders, runtimeFolder, reader, signal, skip);
    considered += 1;
    if (item && item.isAppleAnnotation && item.identity.appleAnnotationId === appleAnnotationId) {
      return { identity: item.identity, rawContent: item.rawContent };
    }
    // A non-matching `item` (and its `rawContent`) is discarded here -- never accumulated.
  }
  return null;
}

/** Structural shape only: `Books/Apple Books/<author>/<book>/Research/<file>.md` -- the Mindmap-managed research-companion folder sits alongside `Annotations`. Checked only for a candidate that already passed the strict annotation/index-shape-or-ordinary-scope gate above, so this can never itself be a scope-widening check. */
function isResearchCompanionPath(relpath: string): boolean {
  const normalized = relpath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized !== READING_NOTES_ROOT && !normalized.startsWith(`${READING_NOTES_ROOT}/`)) return false;
  const rest = normalized.slice(READING_NOTES_ROOT.length).replace(/^\/+/, "");
  const parts = rest.split("/");
  return parts.length === 4 && parts[2] === "Research";
}

function isWithinFolder(relpath: string, folder: string): boolean {
  if (folder === ".") return true;
  return relpath === folder || relpath.startsWith(`${folder}/`);
}
