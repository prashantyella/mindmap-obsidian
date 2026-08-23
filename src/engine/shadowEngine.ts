import { createHash } from "node:crypto";

import { parseNoteIdentityV1, type NoteIdentityV1 } from "./contracts";
import { EngineError } from "./errors";
import { chunkText, DEFAULT_OVERLAP_TOKENS, DEFAULT_TARGET_TOKENS, validateChunkTokenOptions } from "./chunker";
import { projectSource } from "./sourceProjection";
import type { QueryRelatedOptions } from "../index/indexStore";
import type { ScoredNote } from "../index/vectorTypes";
import type { AppleBooksReadResult, AppleBooksReadStatus } from "../reading/appleBooksSqlite";

/**
 * Development-only, read-only sample source: reads the same eligible notes
 * production Python currently would, bounded to `maxCount`. Deliberately
 * has no write method of any shape -- this is the entire surface a real
 * vault-facing adapter (kept in its own Obsidian-importing module, per
 * Checkpoint 9 requirement 3) needs to implement for the shadow engine to
 * consume it. `signal`, when provided, cancels a hung/slow enumeration --
 * an implementation is expected to check it between individual reads, not
 * only at entry (mirrors this module's own AbortSignal-checking loop).
 */
export interface ShadowNoteSource {
  listEligibleSample(maxCount: number, signal?: AbortSignal): Promise<readonly { identity: NoteIdentityV1; rawContent: string }[]>;
  /** Optional: a source-specific bounded skip-reason tally from its most recent `listEligibleSample` call (e.g. the catalog planner's `CatalogSkipReasonCode` counts) -- surfaced generically as `ShadowReportV1.sourceSkipReasonCounts` when present, so every consumer of a report gets it directly rather than only through a concrete source's own getter/log (Checkpoint 9 closure review item 8). Deliberately untyped beyond `string` keys: this module has no opinion on what a source's own reason codes are. */
  getSkipReasonCounts?(): Partial<Record<string, number>>;
}

/**
 * The exact subset of `IndexStore` the shadow engine is allowed to touch --
 * `queryRelated` only. `IndexStore.upsertNote`/`deleteNote`/`compact` are
 * structurally absent from this type, not merely unused: a caller cannot
 * satisfy this interface by passing a wider object typed as `IndexStore`
 * and have the mutation methods stay reachable through it, because nothing
 * in this module ever imports or names `IndexStore` -- see
 * `shadowEngineIsolation.test.ts`.
 */
export interface ReadOnlyIndexQuery {
  queryRelated(options: QueryRelatedOptions): Promise<ScoredNote[]>;
}

/** Already a read-only reader in production (`AppleBooksSqliteReader` never mutates a source database) -- narrowed here to just the one read method the shadow engine needs. */
export interface ReadOnlyAppleBooksReader {
  read(signal?: AbortSignal): Promise<AppleBooksReadResult>;
}

export interface ShadowEngineCapabilities {
  noteSource: ShadowNoteSource;
  /** Absent when no committed index generation exists yet, or when a related-preview comparison is out of scope for this run -- an absent index capability degrades only the related-preview metrics, never the projection/chunk metrics. */
  indexQuery?: ReadOnlyIndexQuery;
  /** Bounded, pre-normalized query vectors keyed by hashed note id -- the shadow engine never computes an embedding itself (no live model call is required for automated tests; a caller wires this only for an explicit, manual live run). */
  queryVectorsByHashedId?: ReadonlyMap<string, Float32Array>;
  appleReader?: ReadOnlyAppleBooksReader;
}

export const MAX_SHADOW_SAMPLE_NOTES = 50;
const MAX_REASON_CODES_PER_ITEM = 6;
const RELATED_PREVIEW_LIMIT = 8;
/** Per-note bound on `rawContent.length` before it is even handed to `projectSource`/`chunkText` -- an oversized note is skipped (`CONTENT_TOO_LARGE`) rather than processed unbounded. */
const MAX_RAW_NOTE_CHARS = 500_000;
/** Bound on the SUM of every processed note's `rawContent.length` in one run -- caps total work even when every individual note is under `MAX_RAW_NOTE_CHARS`. Sampling stops (not throws) once this is reached; already-processed items are still returned. */
const MAX_TOTAL_SAMPLE_CHARS = 5_000_000;
const MAX_BASELINE_ENTRIES = 500;
/** Final safety net on the whole assembled report's JSON-encoded size (Checkpoint 9 closure review item 2) -- every field is individually bounded already (≤50 items, closed reason codes, fixed-shape comparison), so this should never actually trip; it exists as defense-in-depth against a future field growing unbounded rather than as the primary bound. */
const MAX_REPORT_ENCODED_BYTES = 2_000_000;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_SAFE_COUNT = 100_000_000;
/** Mirrors `AppleBooksReadStatus` (`reading/appleBooksSqlite.ts`) exactly -- kept as a local closed literal set (rather than a runtime-reflectable export from that module) so a baseline's `appleReader.status` can be validated against the SAME closed vocabulary the real reader ever produces, not "any short string". */
const APPLE_BOOKS_READ_STATUSES: ReadonlySet<AppleBooksReadStatus> = new Set(["success", "partial", "empty", "unavailable", "permission_denied", "unsupported_schema", "malformed_rows", "source_changing"]);

/**
 * Closed, deterministic reason-code allow-list -- every code this module
 * ever emits is one of these, so a redaction/report-shape audit can
 * enumerate them exhaustively.
 */
export const SHADOW_REASON_CODES = [
  "PROJECTION_OK",
  "PROJECTION_FAILED",
  "CHUNKS_EMPTY",
  "CHUNKS_NONEMPTY",
  "APPLE_ANNOTATION_NOTE",
  "RELATED_PREVIEW_EMPTY",
  "RELATED_PREVIEW_NONEMPTY",
  "RELATED_PREVIEW_UNAVAILABLE",
  "RELATED_PREVIEW_SKIPPED_NO_VECTOR",
  "CONTENT_TOO_LARGE",
  "SOURCE_ITEM_INVALID",
] as const;

export type ShadowReasonCode = (typeof SHADOW_REASON_CODES)[number];

function hashIdentity(identity: NoteIdentityV1): string {
  const key = identity.kind === "apple-annotation" ? `apple-annotation:${identity.appleAnnotationId}` : `path:${identity.canonicalPath}`;
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function hashCanonicalPath(canonicalPath: string): string {
  return createHash("sha256").update(`path:${canonicalPath}`, "utf8").digest("hex");
}

/**
 * Normalizes CRLF/CR to LF before hashing -- Python's `Path.read_text()`
 * (used by the baseline generator) already performs universal-newline
 * translation on read, so hashing raw, possibly-CRLF, TS-side bytes
 * without the same normalization could disagree with the Python oracle
 * for a reason having nothing to do with genuine content divergence. Both
 * `projectionDigest` and every digest built from `digestText` go through
 * this first (Checkpoint 9 parity-signal correction item 1). The
 * SAME formula is documented and implemented in the dev-only baseline
 * generator's own `normalize_newlines_for_digest` (see this module's own
 * isolation test for why that script's path is never named here in the clear).
 */
function normalizeNewlinesForDigest(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** sha256 hex digest of `text`, newline-normalized first -- see `normalizeNewlinesForDigest`. The one digest primitive every hash in this module is built from. */
function digestText(text: string): string {
  return createHash("sha256").update(normalizeNewlinesForDigest(text), "utf8").digest("hex");
}

/**
 * A CONTENT-SENSITIVE digest over each chunk's own one-way hash, never
 * chunk text -- distinguishes "same chunk count, same length sequence, but
 * genuinely different content" (which a lengths-only digest could never
 * catch) while still never exposing anything reconstructible about the
 * text itself: each `digestText(chunk)` is one-way, and this function only
 * ever hashes the CONCATENATION of those digests, never a chunk's raw
 * content or length.
 */
function chunkContentDigest(chunks: readonly string[]): string {
  return digestText(chunks.map((chunk) => digestText(chunk)).join(","));
}

export interface ShadowNoteResultV1 {
  hashedId: string;
  isAppleAnnotation: boolean;
  projected: boolean;
  chunkCount: number;
  relatedPreviewCount: number | null;
  reasonCodes: ShadowReasonCode[];
}

export interface ShadowMetricsV1 {
  sampleSize: number;
  projectedCount: number;
  projectionFailedCount: number;
  chunkCountTotal: number;
  emptyRelatedCount: number;
  nonEmptyRelatedCount: number;
  relatedUnavailableCount: number;
}

/**
 * Strict, redacted baseline schema a caller may supply (Checkpoint 9
 * requirement 10) -- produced by dev Python tooling OUT OF this module,
 * already redacted/hashed before it ever reaches here. Every field is a
 * hashed id, a digest, a count, or a closed boolean/reason code -- NEVER
 * raw text, a full path, or a candidate's identity in the clear.
 * `parseShadowBaselineV1` validates this shape strictly (exact key sets,
 * canonical timestamps, bounded safe-integer counts, no duplicate hashed
 * ids) and throws (fails closed) rather than silently tolerating a
 * malformed baseline.
 */
export interface ShadowBaselineEntryV1 {
  /** Must match this module's own `hashIdentity` scheme exactly (sha256 of `"path:<canonicalPath>"` or `"apple-annotation:<id>"`) for any comparison against it to be meaningful. */
  hashedId: string;
  /**
   * Whether Python's own eligibility pass included this note. Entries MAY
   * be `eligible: false` -- representing a near-boundary candidate Python
   * explicitly considered and rejected -- though the current dev-only
   * baseline generator never emits one this pass (it only records notes
   * it already included). Only
   * `eligible: true` entries count toward `sampleCount` (Checkpoint 9
   * parity-signal correction item 3): `sampleCount` is DEFINED as the
   * count of eligible entries specifically, enforced by
   * `parseShadowBaselineV1`, not "however many entries happen to be in
   * the array".
   */
  eligible: boolean;
  /** sha256 hex digest of Python's normalized projected/frontmatter-stripped body, when available. */
  projectionDigest?: string;
  chunkCount?: number;
  /** sha256 hex digest of Python's own per-chunk content-hash sequence -- see `chunkContentDigest`. */
  chunkBoundaryDigest?: string;
  /** Whether Python's own related-notes query returned any candidate for this note. */
  relatedNonEmpty?: boolean;
  /** Up to 8 hashed candidate ids (same `hashCanonicalPath` scheme) from Python's related-notes result, bounded, no duplicates -- used ONLY to compute an aggregate overlap@8 metric; never re-emitted in the comparison report. */
  relatedCandidateHashedIds?: string[];
}

export interface ShadowBaselineV1 {
  schemaVersion: 1;
  generatedAtIso: string;
  /**
   * The SAME bounded/capped comparison population size as this module's
   * own `ShadowMetricsV1.sampleSize` -- i.e. however many notes Python's
   * OWN bounded sample pass actually processed, not a whole-vault
   * eligible total. Named `sampleCount` (not `noteCount`) specifically so
   * `comparison.noteCountDelta` compares like-for-like capped samples on
   * both sides, never a capped TS sample against an unrelated whole-vault
   * Python count (Checkpoint 9 closure review item 2).
   */
  sampleCount: number;
  /** Total notes in Python's own committed index generation, when known. */
  indexCount?: number;
  entries: ShadowBaselineEntryV1[];
  appleReader?: {
    /** Must be one of the closed `AppleBooksReadStatus` values the real reader ever produces. */
    status: AppleBooksReadStatus;
    count: number;
    /** sha256 hex digest of Python's own sorted, joined annotation id list -- never the ids themselves. */
    annotationIdDigest?: string;
  };
}

const BASELINE_TOP_LEVEL_KEYS = new Set(["schemaVersion", "generatedAtIso", "sampleCount", "indexCount", "entries", "appleReader"]);
const BASELINE_ENTRY_KEYS = new Set(["hashedId", "eligible", "projectionDigest", "chunkCount", "chunkBoundaryDigest", "relatedNonEmpty", "relatedCandidateHashedIds"]);
const BASELINE_APPLE_READER_KEYS = new Set(["status", "count", "annotationIdDigest"]);

function assertExactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", `${label} contains an unrecognized field.`, { field: key.length > 64 ? "[redacted:long-key]" : key });
    }
  }
}

function assertHex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HEX64_PATTERN.test(value)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${label} must be a 64-character lowercase hex digest.`);
  }
}

function assertSafeCount(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SAFE_COUNT) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${label} must be a non-negative safe integer within the bounded range.`);
  }
}

function assertCanonicalIso(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${label} must be a canonical ISO-8601 UTC timestamp.`);
  }
}

/**
 * Strict, fail-closed parser for a caller-supplied baseline (Checkpoint 9
 * requirement 10/11, hardened per the closure review item 2): exact
 * allowed key sets at every level (an unrecognized field is rejected, not
 * silently ignored), canonical timestamps, safe-integer bounded counts, no
 * duplicate `hashedId` across `entries`, no duplicate id within one
 * entry's `relatedCandidateHashedIds`, a closed `AppleBooksReadStatus`
 * enum, and a correlation check (a non-empty `relatedCandidateHashedIds`
 * requires `relatedNonEmpty === true` -- the two fields must not
 * contradict each other).
 */
export function parseShadowBaselineV1(value: unknown): ShadowBaselineV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", "Shadow baseline must be a plain object.");
  }
  const raw = value as Record<string, unknown>;
  assertExactKeys(raw, BASELINE_TOP_LEVEL_KEYS, "Shadow baseline");
  if (raw.schemaVersion !== 1) {
    throw new EngineError("CONTRACT_SCHEMA_VERSION_MISMATCH", "Shadow baseline schemaVersion must be 1.");
  }
  assertCanonicalIso(raw.generatedAtIso, "Shadow baseline generatedAtIso");
  assertSafeCount(raw.sampleCount, "Shadow baseline sampleCount");
  if (raw.indexCount !== undefined) assertSafeCount(raw.indexCount, "Shadow baseline indexCount");
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_BASELINE_ENTRIES) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries must be an array of at most ${MAX_BASELINE_ENTRIES} items.`);
  }
  const seenHashedIds = new Set<string>();
  const entries: ShadowBaselineEntryV1[] = raw.entries.map((entryValue, index) => {
    if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}] must be a plain object.`);
    }
    const entry = entryValue as Record<string, unknown>;
    assertExactKeys(entry, BASELINE_ENTRY_KEYS, `Shadow baseline entries[${index}]`);
    assertHex64(entry.hashedId, `Shadow baseline entries[${index}].hashedId`);
    if (seenHashedIds.has(entry.hashedId)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries contains a duplicate hashedId at index ${index}.`);
    }
    seenHashedIds.add(entry.hashedId);
    if (typeof entry.eligible !== "boolean") {
      throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}].eligible must be a boolean.`);
    }
    if (entry.projectionDigest !== undefined) assertHex64(entry.projectionDigest, `Shadow baseline entries[${index}].projectionDigest`);
    if (entry.chunkBoundaryDigest !== undefined) assertHex64(entry.chunkBoundaryDigest, `Shadow baseline entries[${index}].chunkBoundaryDigest`);
    if (entry.chunkCount !== undefined) assertSafeCount(entry.chunkCount, `Shadow baseline entries[${index}].chunkCount`);
    if (entry.relatedNonEmpty !== undefined && typeof entry.relatedNonEmpty !== "boolean") {
      throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}].relatedNonEmpty must be a boolean when present.`);
    }
    let relatedCandidateHashedIds: string[] | undefined;
    if (entry.relatedCandidateHashedIds !== undefined) {
      if (!Array.isArray(entry.relatedCandidateHashedIds) || entry.relatedCandidateHashedIds.length > RELATED_PREVIEW_LIMIT) {
        throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}].relatedCandidateHashedIds must be an array of at most ${RELATED_PREVIEW_LIMIT} items.`);
      }
      const seenCandidates = new Set<string>();
      relatedCandidateHashedIds = entry.relatedCandidateHashedIds.map((candidate, candidateIndex) => {
        assertHex64(candidate, `Shadow baseline entries[${index}].relatedCandidateHashedIds[${candidateIndex}]`);
        if (seenCandidates.has(candidate)) {
          throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}].relatedCandidateHashedIds contains a duplicate at index ${candidateIndex}.`);
        }
        seenCandidates.add(candidate);
        return candidate;
      });
      if (relatedCandidateHashedIds.length > 0 && entry.relatedNonEmpty !== true) {
        throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline entries[${index}] has relatedCandidateHashedIds but relatedNonEmpty is not true -- the two fields must not contradict each other.`);
      }
    }
    return {
      hashedId: entry.hashedId,
      eligible: entry.eligible,
      projectionDigest: entry.projectionDigest,
      chunkCount: entry.chunkCount,
      chunkBoundaryDigest: entry.chunkBoundaryDigest,
      relatedNonEmpty: entry.relatedNonEmpty,
      relatedCandidateHashedIds,
    };
  });
  let appleReader: ShadowBaselineV1["appleReader"];
  if (raw.appleReader !== undefined) {
    if (typeof raw.appleReader !== "object" || raw.appleReader === null || Array.isArray(raw.appleReader)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "Shadow baseline appleReader must be a plain object when present.");
    }
    const appleRaw = raw.appleReader as Record<string, unknown>;
    assertExactKeys(appleRaw, BASELINE_APPLE_READER_KEYS, "Shadow baseline appleReader");
    if (typeof appleRaw.status !== "string" || !APPLE_BOOKS_READ_STATUSES.has(appleRaw.status as AppleBooksReadStatus)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "Shadow baseline appleReader.status must be a recognized AppleBooksReadStatus value.");
    }
    assertSafeCount(appleRaw.count, "Shadow baseline appleReader.count");
    if (appleRaw.annotationIdDigest !== undefined) assertHex64(appleRaw.annotationIdDigest, "Shadow baseline appleReader.annotationIdDigest");
    appleReader = { status: appleRaw.status as AppleBooksReadStatus, count: appleRaw.count, annotationIdDigest: appleRaw.annotationIdDigest };
  }
  // sampleCount is DEFINED as the count of ELIGIBLE entries specifically (see
  // ShadowBaselineEntryV1.eligible's doc comment) -- enforced here, not left as an unverified
  // caller convention, so a baseline can never silently claim a sample size that doesn't match
  // what it actually recorded (Checkpoint 9 parity-signal correction item 3).
  const eligibleEntryCount = entries.filter((entry) => entry.eligible).length;
  if (raw.sampleCount !== eligibleEntryCount) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow baseline sampleCount (${String(raw.sampleCount)}) must equal the number of eligible entries (${eligibleEntryCount}).`);
  }
  return {
    schemaVersion: 1,
    generatedAtIso: raw.generatedAtIso,
    sampleCount: raw.sampleCount,
    indexCount: raw.indexCount,
    entries,
    appleReader,
  };
}

/**
 * Which comparison DOMAINS actually produced a real signal this run --
 * distinct from merely "the baseline had this optional field somewhere".
 * Each flag is `true` only when at least one genuine per-note (or
 * whole-run, for `apple`/`index`) comparison of that domain actually
 * happened -- a baseline carrying only `hashedId`/`eligible` never makes
 * `projection`/`chunks`/`related`/`apple`/`index` `true` just because the
 * file parsed (Checkpoint 9 parity-signal correction item 1/5: "A baseline
 * with eligibility/projection/chunk fields but no related/apple must not
 * imply full parity").
 */
export interface ShadowComparisonAvailabilityV1 {
  /** `true` when the baseline carried at least one entry -- membership (eligibility) comparison is meaningful the moment a baseline has any entries at all. */
  eligibility: boolean;
  /** `true` when at least one note's projectionDigest was actually compared (baseline entry had the field AND the TS side projected successfully). */
  projection: boolean;
  /** `true` when at least one note's chunkCount or chunkBoundaryDigest was actually compared. */
  chunks: boolean;
  /** `true` when at least one note's related-preview result was actually compared against a baseline relatedNonEmpty/relatedCandidateHashedIds field. */
  related: boolean;
  /** `true` when the Apple reader comparison actually produced a result (not merely attempted -- a throw/cancel leaves this `false`). */
  apple: boolean;
  /** `true` when both sides supplied an index note count to compare. */
  index: boolean;
}

export interface ShadowComparisonV1 {
  /** `true` when no baseline was supplied, OR a baseline was supplied but not a single comparison domain in `availability` actually produced a signal -- never `false` on the strength of identities/counts alone with nothing comparable behind them (Checkpoint 9 parity-signal correction item 1). */
  comparisonUnavailable: boolean;
  /** See `ShadowComparisonAvailabilityV1` -- always present, even when `comparisonUnavailable` is `true` (every flag `false` in that case). */
  availability: ShadowComparisonAvailabilityV1;
  eligibilityDisagreementCount: number;
  projectionDigestAgreementCount: number;
  projectionDigestDisagreementCount: number;
  chunkDigestAgreementCount: number;
  chunkDigestDisagreementCount: number;
  /** Compares baseline `chunkCount` against the TS side's own chunk count -- independent of (and cheaper than) the content-sensitive `chunkDigest*` counters above, so a chunk-COUNT-only baseline entry (no `chunkBoundaryDigest`) still yields a real signal. */
  chunkCountAgreementCount: number;
  chunkCountDisagreementCount: number;
  /** Average of (overlap between TS's and Python's top-8 related-candidate hashed ids) / 8, across every note where both sides had a related comparison available; `null` when no such note existed. */
  relatedOverlapAt8: number | null;
  /** Count of notes where Python's related result was non-empty but TS's was empty (a specific, actionable regression direction). */
  pythonNonEmptyTsEmptyCount: number;
  /** Count of notes where the two sides simply disagreed on empty-vs-nonempty (superset of the above, also covers the reverse direction). */
  emptyNonEmptyDisagreementCount: number;
  /** This run's `metrics.sampleSize` minus `baseline.sampleCount` -- a LIKE-FOR-LIKE comparison of two equally-bounded sample populations (never a capped sample against a whole-vault total; see `ShadowBaselineV1.sampleCount`'s doc comment). Positive means TS's sample was larger. */
  noteCountDelta: number;
  /** `null` unless the caller supplied both a baseline `indexCount` and `options.tsIndexNoteCount`. */
  indexCountDelta: number | null;
  appleStatusMatches: boolean | null;
  appleCountDelta: number | null;
  appleAnnotationIdDigestMatches: boolean | null;
}

function emptyAvailability(): ShadowComparisonAvailabilityV1 {
  return { eligibility: false, projection: false, chunks: false, related: false, apple: false, index: false };
}

function emptyComparison(): ShadowComparisonV1 {
  return {
    comparisonUnavailable: true,
    availability: emptyAvailability(),
    eligibilityDisagreementCount: 0,
    projectionDigestAgreementCount: 0,
    projectionDigestDisagreementCount: 0,
    chunkDigestAgreementCount: 0,
    chunkDigestDisagreementCount: 0,
    chunkCountAgreementCount: 0,
    chunkCountDisagreementCount: 0,
    relatedOverlapAt8: null,
    pythonNonEmptyTsEmptyCount: 0,
    emptyNonEmptyDisagreementCount: 0,
    noteCountDelta: 0,
    indexCountDelta: null,
    appleStatusMatches: null,
    appleCountDelta: null,
    appleAnnotationIdDigestMatches: null,
  };
}

export interface ShadowReportV1 {
  schemaVersion: 1;
  generatedAtIso: string;
  metrics: ShadowMetricsV1;
  items: ShadowNoteResultV1[];
  reasonCodeCounts: Partial<Record<ShadowReasonCode, number>>;
  comparison: ShadowComparisonV1;
  /** `true` when the run was cut short by `options.signal` aborting -- either mid-sample, or (Checkpoint 9 closure review item 8) because the SOURCE ENUMERATION itself was cancelled, which is treated distinctly from an ordinary empty/throwing sample rather than silently folded into `metrics.sampleSize === 0`. `items`/`metrics` still reflect exactly what was processed before that point, never a partial/inconsistent mix. */
  aborted: boolean;
  /** The note source's own bounded skip-reason tally, when it exposes one via `ShadowNoteSource.getSkipReasonCounts` -- `undefined` when the source doesn't implement that optional method. Surfaced here so every consumer of a report gets it directly. */
  sourceSkipReasonCounts?: Partial<Record<string, number>>;
}

export interface RunShadowOptions {
  sampleSize?: number;
  chunkTargetTokens?: number;
  chunkOverlapTokens?: number;
  nowIso?: string;
  /** Cancels the run between notes/operations (Checkpoint 9 requirement 11) -- checked at the top of every note's processing and inside the Apple reader step; never mid-note. Also forwarded to `noteSource.listEligibleSample` so a hung source enumeration itself can be cancelled. */
  signal?: AbortSignal;
  /** Already-validated (`parseShadowBaselineV1`) redacted baseline to compare this run's TS-side results against. Absent means `comparison.comparisonUnavailable === true`. */
  baseline?: ShadowBaselineV1;
  /** Caller-supplied count of notes in the TS-side committed index generation, when known -- enables `comparison.indexCountDelta` against `baseline.indexCount`. */
  tsIndexNoteCount?: number;
}

function validateOptions(options: RunShadowOptions): void {
  if (options.sampleSize !== undefined) assertSafeCount(options.sampleSize, "RunShadowOptions.sampleSize");
  if (options.nowIso !== undefined) assertCanonicalIso(options.nowIso, "RunShadowOptions.nowIso");
  if (options.tsIndexNoteCount !== undefined) assertSafeCount(options.tsIndexNoteCount, "RunShadowOptions.tsIndexNoteCount");
  if (options.baseline !== undefined) {
    // Re-validated HERE, even though `options.baseline` is already typed `ShadowBaselineV1` --
    // TypeScript's structural typing (or an outright `as ShadowBaselineV1` cast) cannot be trusted
    // to guarantee the value was ever actually produced by `parseShadowBaselineV1`; re-parsing it
    // is the only way to make the strict contract unconditional rather than caller-optional
    // (Checkpoint 9 closure review item 8).
    parseShadowBaselineV1(options.baseline);
  }
  // Validated up front -- including for an EMPTY sample, where chunkText() itself would otherwise
  // never run and a bad configuration would silently go unchecked (closure review item 2).
  validateChunkTokenOptions({ targetTokens: options.chunkTargetTokens ?? DEFAULT_TARGET_TOKENS, overlapTokens: options.chunkOverlapTokens ?? DEFAULT_OVERLAP_TOKENS });
}

/** Validates one raw sample entry's SHAPE before it is trusted, using the SAME strict contract parser (`parseNoteIdentityV1`) every other identity in this codebase goes through -- a malicious/misbehaving `ShadowNoteSource` cannot smuggle a non-string `rawContent` or a malformed/spoofed identity past this boundary; such an entry is skipped (`SOURCE_ITEM_INVALID`), never processed. */
function parseValidSampleEntry(entry: unknown): { identity: NoteIdentityV1; rawContent: string } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const candidate = entry as { identity?: unknown; rawContent?: unknown };
  if (typeof candidate.rawContent !== "string") return null;
  try {
    return { identity: parseNoteIdentityV1(candidate.identity), rawContent: candidate.rawContent };
  } catch {
    return null;
  }
}

/** Final defense-in-depth size check on the fully-assembled report (Checkpoint 9 closure review item 2) -- every field is already individually bounded, so this should never actually trip; if it somehow does, the report is rejected rather than silently handed to a caller who might log/serialize an unexpectedly huge payload. */
function assertBoundedReport(report: ShadowReportV1): void {
  const encodedLength = Buffer.byteLength(JSON.stringify(report), "utf8");
  if (encodedLength > MAX_REPORT_ENCODED_BYTES) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `Shadow report exceeds the bounded encoded size (${encodedLength} > ${MAX_REPORT_ENCODED_BYTES} bytes).`);
  }
}

/**
 * Runs the entire bounded, read-only comparison pass: samples up to
 * `sampleSize` (capped at `MAX_SHADOW_SAMPLE_NOTES`) eligible notes,
 * projects + chunks each one (pure, in-process; never writes), and -- only
 * when both `indexQuery` and a matching pre-computed query vector are
 * present for a note -- previews a bounded related-note candidate COUNT
 * (never the candidate paths/scores themselves, which stay out of the
 * redacted report). Performs zero note/index/job/schedule/state writes:
 * every capability this module is given is read-only by TYPE, not by
 * convention (see `ReadOnlyIndexQuery`/`ShadowNoteSource`).
 *
 * When `options.baseline` is supplied, additionally compares this run's
 * TS-side results against it (Checkpoint 9 requirement 10) and, when
 * `capabilities.appleReader` is supplied, reads it ONCE (bounded, via its
 * own read-only `read()` contract) and folds its status/count/annotation-
 * id-digest into that comparison -- never serializing the reader's raw
 * source metadata/paths into the report.
 */
export async function runShadowComparison(capabilities: ShadowEngineCapabilities, options: RunShadowOptions = {}): Promise<ShadowReportV1> {
  validateOptions(options);
  const sampleSize = Math.max(0, Math.min(options.sampleSize ?? MAX_SHADOW_SAMPLE_NOTES, MAX_SHADOW_SAMPLE_NOTES));
  const chunkOptions = { targetTokens: options.chunkTargetTokens ?? DEFAULT_TARGET_TOKENS, overlapTokens: options.chunkOverlapTokens ?? DEFAULT_OVERLAP_TOKENS };
  const signal = options.signal;

  let rawSample: readonly unknown[];
  let sourceEnumerationAborted = false;
  try {
    rawSample = await capabilities.noteSource.listEligibleSample(sampleSize, signal);
  } catch {
    // A misbehaving/throwing source never propagates a raw error out of this module. If the
    // signal was already aborted, this is a CANCELLED enumeration -- tracked distinctly
    // (`sourceEnumerationAborted`) rather than folded into an ordinary empty sample (Checkpoint 9
    // closure review item 8); otherwise it is treated as an empty sample, per requirement 11.
    rawSample = [];
    if (signal?.aborted) sourceEnumerationAborted = true;
  }
  const sample = (Array.isArray(rawSample) ? rawSample : []).slice(0, sampleSize);
  const sourceSkipReasonCounts = capabilities.noteSource.getSkipReasonCounts?.();

  const items: ShadowNoteResultV1[] = [];
  const reasonCodeCounts: Partial<Record<ShadowReasonCode, number>> = {};
  const metrics: ShadowMetricsV1 = {
    sampleSize: 0,
    projectedCount: 0,
    projectionFailedCount: 0,
    chunkCountTotal: 0,
    emptyRelatedCount: 0,
    nonEmptyRelatedCount: 0,
    relatedUnavailableCount: 0,
  };

  const baseline = options.baseline;
  const baselineByHashedId = baseline ? new Map(baseline.entries.map((entry) => [entry.hashedId, entry])) : null;
  const comparison = emptyComparison();
  let overlapSum = 0;
  let overlapComparisons = 0;
  let relatedComparisonsMade = 0;
  const seenEligibleHashedIds = new Set<string>();

  let totalCharsProcessed = 0;
  let aborted = sourceEnumerationAborted;

  for (const rawEntry of sample) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const note = parseValidSampleEntry(rawEntry);
    if (!note) {
      reasonCodeCounts.SOURCE_ITEM_INVALID = (reasonCodeCounts.SOURCE_ITEM_INVALID ?? 0) + 1;
      continue;
    }
    metrics.sampleSize += 1;

    const hashedId = hashIdentity(note.identity);
    seenEligibleHashedIds.add(hashedId);
    const isAppleAnnotation = note.identity.kind === "apple-annotation";
    const reasonCodes: ShadowReasonCode[] = [];
    const record = (code: ShadowReasonCode) => {
      if (reasonCodes.length < MAX_REASON_CODES_PER_ITEM) reasonCodes.push(code);
      reasonCodeCounts[code] = (reasonCodeCounts[code] ?? 0) + 1;
    };

    if (isAppleAnnotation) record("APPLE_ANNOTATION_NOTE");

    let chunkCount = 0;
    let projected = false;
    if (note.rawContent.length > MAX_RAW_NOTE_CHARS || totalCharsProcessed + note.rawContent.length > MAX_TOTAL_SAMPLE_CHARS) {
      record("CONTENT_TOO_LARGE");
    } else {
      totalCharsProcessed += note.rawContent.length;
      try {
        const projection = projectSource(note.identity, note.rawContent);
        projected = true;
        metrics.projectedCount += 1;
        record("PROJECTION_OK");
        const chunks = chunkText(projection.projectedBody, chunkOptions);
        chunkCount = chunks.length;
        metrics.chunkCountTotal += chunkCount;
        record(chunkCount === 0 ? "CHUNKS_EMPTY" : "CHUNKS_NONEMPTY");

        if (baselineByHashedId) {
          const baselineEntry = baselineByHashedId.get(hashedId);
          if (baselineEntry?.projectionDigest) {
            if (digestText(projection.projectedBody) === baselineEntry.projectionDigest) comparison.projectionDigestAgreementCount += 1;
            else comparison.projectionDigestDisagreementCount += 1;
          }
          if (baselineEntry?.chunkBoundaryDigest) {
            if (chunkContentDigest(chunks) === baselineEntry.chunkBoundaryDigest) comparison.chunkDigestAgreementCount += 1;
            else comparison.chunkDigestDisagreementCount += 1;
          }
          if (baselineEntry?.chunkCount !== undefined) {
            if (chunkCount === baselineEntry.chunkCount) comparison.chunkCountAgreementCount += 1;
            else comparison.chunkCountDisagreementCount += 1;
          }
        }
      } catch {
        // Never let a raw error (its message could embed user note content) escape this bounded
        // loop; the reason code above already records the failure without echoing anything from it.
        metrics.projectionFailedCount += 1;
        record("PROJECTION_FAILED");
      }
    }

    let relatedPreviewCount: number | null = null;
    if (capabilities.indexQuery) {
      const queryVector = capabilities.queryVectorsByHashedId?.get(hashedId);
      if (!queryVector) {
        record("RELATED_PREVIEW_SKIPPED_NO_VECTOR");
      } else {
        try {
          const scored = await capabilities.indexQuery.queryRelated({
            queryVector,
            queryChunkVectors: [],
            excludePath: note.identity.canonicalPath,
            limit: RELATED_PREVIEW_LIMIT,
          });
          relatedPreviewCount = scored.length;
          if (scored.length === 0) {
            metrics.emptyRelatedCount += 1;
            record("RELATED_PREVIEW_EMPTY");
          } else {
            metrics.nonEmptyRelatedCount += 1;
            record("RELATED_PREVIEW_NONEMPTY");
          }

          if (baselineByHashedId) {
            const baselineEntry = baselineByHashedId.get(hashedId);
            if (baselineEntry?.relatedNonEmpty !== undefined) {
              relatedComparisonsMade += 1;
              const tsNonEmpty = scored.length > 0;
              if (baselineEntry.relatedNonEmpty && !tsNonEmpty) comparison.pythonNonEmptyTsEmptyCount += 1;
              if (baselineEntry.relatedNonEmpty !== tsNonEmpty) comparison.emptyNonEmptyDisagreementCount += 1;
            }
            if (baselineEntry?.relatedCandidateHashedIds && baselineEntry.relatedCandidateHashedIds.length > 0) {
              const tsCandidateIds = new Set(scored.slice(0, RELATED_PREVIEW_LIMIT).map((entry) => hashCanonicalPath(entry.path)));
              const overlap = baselineEntry.relatedCandidateHashedIds.filter((id) => tsCandidateIds.has(id)).length;
              overlapSum += overlap / RELATED_PREVIEW_LIMIT;
              overlapComparisons += 1;
            }
          }
        } catch {
          metrics.relatedUnavailableCount += 1;
          record("RELATED_PREVIEW_UNAVAILABLE");
        }
      }
    }

    items.push({ hashedId, isAppleAnnotation, projected, chunkCount, relatedPreviewCount, reasonCodes });
  }

  if (baseline) {
    comparison.relatedOverlapAt8 = overlapComparisons > 0 ? overlapSum / overlapComparisons : null;
    comparison.noteCountDelta = metrics.sampleSize - baseline.sampleCount;
    comparison.indexCountDelta = baseline.indexCount !== undefined && options.tsIndexNoteCount !== undefined ? options.tsIndexNoteCount - baseline.indexCount : null;

    // Symmetric difference, each id counted EXACTLY once (Checkpoint 9 parity-signal correction
    // item 3): a TS id absent from the baseline's ELIGIBLE set is a real disagreement (the prior
    // implementation silently ignored this direction entirely -- a TS-only inclusion was
    // invisible), and a baseline-eligible id absent from TS is the mirror-image disagreement. An
    // id present in both contributes nothing (agreement). `entry.eligible === false` entries are
    // explicitly supported by `parseShadowBaselineV1` but never contribute to this set -- only
    // `eligible === true` entries represent "Python considered this note eligible".
    const baselineEligibleIds = new Set(baseline.entries.filter((entry) => entry.eligible).map((entry) => entry.hashedId));
    for (const id of seenEligibleHashedIds) {
      if (!baselineEligibleIds.has(id)) comparison.eligibilityDisagreementCount += 1;
    }
    for (const id of baselineEligibleIds) {
      if (!seenEligibleHashedIds.has(id)) comparison.eligibilityDisagreementCount += 1;
    }

    if (baseline.appleReader && capabilities.appleReader && !aborted && !signal?.aborted) {
      try {
        const appleResult = await capabilities.appleReader.read(signal);
        comparison.appleStatusMatches = appleResult.status === baseline.appleReader.status;
        comparison.appleCountDelta = appleResult.count - baseline.appleReader.count;
        if (baseline.appleReader.annotationIdDigest) {
          const sortedIds = [...appleResult.annotations].map((entry) => entry.annotation_id).sort();
          comparison.appleAnnotationIdDigestMatches = digestText(sortedIds.join(",")) === baseline.appleReader.annotationIdDigest;
        }
      } catch {
        // A throwing Apple reader leaves the three apple* comparison fields at their default
        // `null` -- never a raw error escaping this module.
      }
    }

    // Availability is computed POST-HOC from whether a domain actually produced a signal, never
    // from whether the baseline merely CARRIED an optional field for it (Checkpoint 9
    // parity-signal correction item 1/5).
    comparison.availability = {
      eligibility: baseline.entries.length > 0,
      projection: comparison.projectionDigestAgreementCount + comparison.projectionDigestDisagreementCount > 0,
      chunks: comparison.chunkDigestAgreementCount + comparison.chunkDigestDisagreementCount + comparison.chunkCountAgreementCount + comparison.chunkCountDisagreementCount > 0,
      related: relatedComparisonsMade > 0,
      apple: comparison.appleStatusMatches !== null,
      index: comparison.indexCountDelta !== null,
    };
    const availability = comparison.availability;
    comparison.comparisonUnavailable = !(availability.eligibility || availability.projection || availability.chunks || availability.related || availability.apple || availability.index);
  }

  const report: ShadowReportV1 = {
    schemaVersion: 1,
    generatedAtIso: options.nowIso ?? new Date().toISOString(),
    metrics,
    items,
    reasonCodeCounts,
    comparison,
    aborted,
    sourceSkipReasonCounts,
  };
  assertBoundedReport(report);
  return report;
}
