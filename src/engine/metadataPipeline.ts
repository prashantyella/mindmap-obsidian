import { canonicalizePath, parseNoteIdentityV1 } from "./contracts";
import type { MetadataOutputV1, NoteIdentityV1 } from "./contracts";
import { parseMetadataOutputV1 } from "./contracts";
import { hasControlCharacter } from "./controlCharacters";
import { EngineError } from "./errors";
import { validateBoundedIdentifier } from "./identifierValidation";
import { closestMatches } from "./textSimilarity";

/** True only for `{}`/`Object.create(null)`-shaped values -- never a `Date`, `Map`, array, or other class instance, which `typeof value === "object"` alone cannot distinguish from a plain settings object. Exported for reuse by `localMetadataProvider.ts`'s recursive JSON-value validator. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Ports `build_metadata_messages`, `parse_llm_metadata_json`,
 * `normalize_tags`, `normalize_concepts`, `filter_and_map_tags`,
 * `apply_tag_aliases`, and `apply_tag_frequency_filter` from
 * python/mindmap.py behaviorally, plus `runMetadataPipeline`, a pure
 * coordinator that ties them together in the exact order `llm_extract`'s
 * caller applies them in python/mindmap.py (around line 3469: summary ->
 * normalize tags -> aliases -> controlled mapping/filter -> tag limit ->
 * normalize concepts).
 *
 * Deliberately provider-neutral, plain-value-only, and does not know about
 * Apple Books annotation notes at all: `MetadataOutputV1` here is always
 * the plain `{summary, tags, concepts, related}` shape for every note kind.
 * Apple-annotation-specific write formatting (clearing summary/tags,
 * rendering concepts/related as wikilinks via
 * `appleAnnotationConceptWikilinks`/`appleAnnotationRelatedWikilinks`) is
 * `NoteWriter`'s job alone (`noteWriter.ts`'s `buildMetadataUpdates`) --
 * doing it here too would double-format and could corrupt/drop related
 * links by wikilink-rendering an already-wikilinked value.
 *
 * This module never writes a note, index record, job, or piece of state --
 * it only builds prompts, defines the inference seam, strictly parses/
 * validates a model response, and normalizes the result into a
 * `MetadataOutputV1`. Malformed, partial, or extra-shape JSON fails closed
 * (`METADATA_RESPONSE_INVALID`) with a static message; the raw response
 * text is never included in a thrown error.
 */

const MAX_METADATA_INPUT_CHARS = 40_000;
const MAX_METADATA_RESPONSE_CHARS = 20_000;

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Mirrors `build_metadata_messages`. `text` is the note body fed to the model; bounded to `MAX_METADATA_INPUT_CHARS` before use so an oversized note fails closed rather than building an unbounded prompt. */
export function buildMetadataMessages(text: string, tagLimit: number, conceptLimit: number, controlledTags: readonly string[], allowFreeTags: boolean): ChatMessage[] {
  if (text.length > MAX_METADATA_INPUT_CHARS) {
    throw new EngineError("METADATA_PROMPT_TOO_LARGE", "Note text exceeds the maximum bounded length for metadata inference.", { length: text.length, maxChars: MAX_METADATA_INPUT_CHARS });
  }
  const system = "You label personal reflection notes. Return exactly one JSON object, not an array. Use concise, grounded language.";
  let tagRule = "Tags must be short, broad themes derived from the note (avoid overly specific phrases).";
  if (controlledTags.length > 0) {
    tagRule += ` Use only tags from this list:\n${controlledTags.join(", ")}`;
    if (!allowFreeTags) {
      tagRule += "\nReturn only tags from the list.";
    }
  }
  const user = [
    "Extract metadata from the note.",
    'Return a single JSON object shaped like {"summary":"...","tags":["tag-one"],"concepts":["concept one"]}.',
    `Required keys: summary (1-2 sentences), tags (3-${tagLimit} kebab-case), concepts (3-${conceptLimit} core noun phrases).`,
    "Rules:",
    `- ${tagRule}`,
    "- Tags must be lowercase kebab-case, no single letters, 1-3 words.",
    "- Concepts should be the core ideas only (no fluff).",
    "",
    `Note:\n${text.trim()}`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Provider-neutral inference seam: independent of note/index/state writes. Ollama and local OpenAI-compatible endpoints implement this via their own adapters (production wiring, out of scope here); embeddings remain Ollama-only, but this metadata inference seam is provider-neutral. */
export interface MetadataInferenceRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
}

export interface MetadataInferenceProviderCallOptions {
  signal?: AbortSignal;
}

export interface MetadataInferenceProvider {
  /** Returns the raw model response content string (not yet parsed as JSON). */
  complete(request: MetadataInferenceRequest, options?: MetadataInferenceProviderCallOptions): Promise<string>;
}

interface RawMetadataResponse {
  summary: string;
  tags: string[];
  concepts: string[];
}

const ALLOWED_RESPONSE_KEYS = new Set(["summary", "tags", "concepts"]);

/**
 * Ports `parse_llm_metadata_json`'s JSON-extraction fallback (direct parse,
 * else the substring between the first `{` and the last `}`), then applies
 * strict shape validation the Python oracle did not: exactly the keys
 * `summary`/`tags`/`concepts`, correctly typed, no extra/missing keys. Any
 * deviation fails closed with a static `METADATA_RESPONSE_INVALID` message
 * -- the raw response content is never included in the thrown error.
 */
export function parseMetadataResponse(content: string): RawMetadataResponse {
  if (content.length > MAX_METADATA_RESPONSE_CHARS) {
    throw new EngineError("METADATA_RESPONSE_TOO_LARGE", "Metadata inference response exceeds the maximum bounded length.", { length: content.length, maxChars: MAX_METADATA_RESPONSE_CHARS });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response did not contain valid JSON.");
    }
    try {
      parsed = JSON.parse(content.slice(start, end + 1));
    } catch {
      throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response did not contain valid JSON.");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response JSON was not an object.");
  }
  const body = parsed as Record<string, unknown>;
  const extraKeys = Object.keys(body).filter((key) => !ALLOWED_RESPONSE_KEYS.has(key));
  if (extraKeys.length > 0) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response contained unrecognized fields.");
  }
  if (typeof body.summary !== "string") {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response is missing a string \"summary\".");
  }
  if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string")) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response is missing a string array \"tags\".");
  }
  if (!Array.isArray(body.concepts) || !body.concepts.every((concept) => typeof concept === "string")) {
    throw new EngineError("METADATA_RESPONSE_INVALID", "Metadata inference response is missing a string array \"concepts\".");
  }
  return { summary: body.summary, tags: body.tags, concepts: body.concepts };
}

/** Mirrors `normalize_tags`: lowercases, strips to `[a-z0-9\s-]`, collapses whitespace/hyphen runs into single hyphens, trims edge hyphens, and dedupes while preserving first-seen order. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (let tag of tags) {
    tag = tag.trim().toLowerCase();
    tag = tag.replace(/[^a-z0-9\s-]/g, "");
    tag = tag.replace(/\s+/g, "-");
    tag = tag.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Mirrors `normalize_list_field`. */
export function normalizeListField(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  if (typeof value === "string") {
    return value.split(/[\\\n,;]+/).map((part) => part.trim()).filter((part) => part.length > 0);
  }
  return [];
}

export type ConceptCaseMode = "lower" | "title" | "none";

/** A Unicode "cased" character (has an uppercase/lowercase/titlecase distinction) -- the same notion Python's `str.title()` uses to decide word boundaries. */
const CASED_CHAR_PATTERN = /\p{Cased}/u;

/**
 * A faithful port of Python's `str.title()`: unlike a whitespace-only
 * "capitalize the first letter of each token" implementation, Python resets
 * the capitalize/lowercase state on *any* non-cased character -- a hyphen,
 * apostrophe, underscore, or digit -- so `"state-of-the-art"` becomes
 * `"State-Of-The-Art"` and `"3d-printing"` becomes `"3D-Printing"`, not
 * `"State-of-the-art"`/`"3d-Printing"`. See
 * `tests/fixtures/engine/normalization.json`'s `normalize_concepts title
 * case` cases (oracle-generated from `str.title()`) for the exact parity
 * this must match.
 */
function pythonTitleCase(value: string): string {
  let result = "";
  let previousCased = false;
  for (const char of value) {
    if (CASED_CHAR_PATTERN.test(char)) {
      result += previousCased ? char.toLowerCase() : char.toUpperCase();
      previousCased = true;
    } else {
      result += char;
      previousCased = false;
    }
  }
  return result;
}

/** Mirrors `normalize_concepts`: drops blanks and phrases longer than `maxWords`, applies `caseMode`, dedupes case-insensitively while preserving first-seen casing, and stops once `limit` is reached (`limit <= 0` means unlimited, matching Python's falsy-`limit` check). */
export function normalizeConcepts(concepts: readonly string[], limit: number, maxWords: number, caseMode: ConceptCaseMode): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let concept of concepts) {
    concept = concept.trim();
    if (!concept) continue;
    if (maxWords && concept.split(/\s+/u).length > maxWords) continue;
    if (caseMode === "lower") concept = concept.toLowerCase();
    else if (caseMode === "title") concept = pythonTitleCase(concept);
    const key = concept.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(concept);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/**
 * Mirrors `filter_and_map_tags`: length/word-count filters, then maps to
 * the closest controlled-vocabulary tag (`difflib.get_close_matches`,
 * cutoff 0.75) when not an exact controlled match, dropping (or keeping,
 * if `allowFree`) anything unmapped. An empty `controlled` list disables
 * the controlled-vocabulary mapping entirely, matching Python's
 * falsy-list check.
 *
 * A tag (or controlled-vocabulary entry) longer than
 * `textSimilarity.ts`'s `MAX_JUNK_FREE_LENGTH` is never fuzzy-matched --
 * `closestMatches` excludes it itself -- and falls through the same
 * "no match found" path an ordinary non-matching tag takes.
 */
export function filterAndMapTags(tags: readonly string[], controlled: readonly string[], allowFree: boolean, minLen: number, maxWords: number): string[] {
  const controlledNorm = normalizeTags(controlled);
  const controlledSet = new Set(controlledNorm);
  const out: string[] = [];
  for (const tag of tags) {
    if (minLen && tag.length < minLen) continue;
    if (maxWords && tag.split("-").length > maxWords) continue;
    if (controlledSet.size === 0) {
      if (!out.includes(tag)) out.push(tag);
      continue;
    }
    if (controlledSet.has(tag)) {
      if (!out.includes(tag)) out.push(tag);
      continue;
    }
    const [mapped] = closestMatches(tag, controlledNorm, 1, 0.75);
    if (mapped) {
      if (!out.includes(mapped)) out.push(mapped);
      continue;
    }
    if (allowFree && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Mirrors `apply_tag_aliases`. */
export function applyTagAliases(tags: readonly string[], aliases: Readonly<Record<string, string>>): string[] {
  if (Object.keys(aliases).length === 0) return [...tags];
  const out: string[] = [];
  for (const tag of tags) {
    const mapped = aliases[tag] ?? tag;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Mirrors `apply_tag_frequency_filter`: operates across a batch of notes'
 * tag sets at once (a corpus-wide frequency filter, not a per-note
 * operation), keeping only tags that recur at least `minFreq` times across
 * the batch, falling back to each note's first `fallback` original tags
 * when none survive. `minFreq <= 1` disables filtering entirely.
 */
export function applyTagFrequencyFilter(tagSets: readonly (readonly string[])[], minFreq: number, fallback: number): string[][] {
  if (minFreq <= 1) return tagSets.map((tags) => [...tags]);
  const counts = new Map<string, number>();
  for (const tags of tagSets) {
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return tagSets.map((tags) => {
    const kept = tags.filter((tag) => (counts.get(tag) ?? 0) >= minFreq);
    if (kept.length === 0 && fallback > 0) return tags.slice(0, fallback);
    return kept;
  });
}

/**
 * Builds the plain, provider-neutral `MetadataOutputV1` shape -- the same
 * shape for every note kind. Apple-annotation-specific formatting
 * (clearing summary/tags, wikilink-rendering concepts/related) happens
 * exactly once, at the `NoteWriter` write seam, never here. Strictly
 * validates the result against the `MetadataOutputV1` contract before
 * returning.
 */
export function buildMetadataOutputV1(identity: NoteIdentityV1, summary: string, tags: readonly string[], concepts: readonly string[], related: readonly string[]): MetadataOutputV1 {
  return parseMetadataOutputV1({
    schemaVersion: 1,
    identity,
    summary,
    tags: [...tags],
    concepts: [...concepts],
    related: [...related],
  });
}

const MAX_TAG_LIMIT = 100;
const MAX_CONCEPT_LIMIT = 100;
const MAX_TAG_MAX_WORDS = 20;
const MAX_CONCEPT_MAX_WORDS = 50;
const MAX_TAG_MIN_LEN = 100;
const MAX_CONTROLLED_TAGS_COUNT = 500;
const MAX_CONTROLLED_TAGS_TOTAL_CHARS = 50_000;
const MAX_CONTROLLED_TAG_LENGTH = 200;
const MAX_TAG_ALIASES_COUNT = 1_000;
const MAX_TAG_ALIASES_TOTAL_CHARS = 100_000;
const MAX_TAG_ALIAS_ENTRY_LENGTH = 200;
const MAX_MAX_TOKENS = 32_000;
const MAX_MODEL_LENGTH = 256;
const MAX_RELATED_COUNT = 1_000;
const MAX_RELATED_PATH_LENGTH = 1_024;
const MAX_RELATED_TOTAL_CHARS = 200_000;

export interface MetadataPipelineConfig {
  model: string;
  maxTokens: number;
  tagLimit: number;
  conceptLimit: number;
  conceptMaxWords: number;
  conceptCaseMode: ConceptCaseMode;
  controlledTags: readonly string[];
  allowFreeTags: boolean;
  tagMinLen: number;
  tagMaxWords: number;
  tagAliases: Readonly<Record<string, string>>;
}

export interface MetadataPipelineInput {
  identity: NoteIdentityV1;
  /** Note text fed to the model (bounded by `buildMetadataMessages`). */
  text: string;
  /**
   * Already-selected plain related paths (e.g. from
   * `relatedSelector.ts`'s output), passed straight through into the
   * returned `MetadataOutputV1.related` unchanged -- this coordinator
   * never selects, ranks, or renders related notes itself.
   */
  related: readonly string[];
}

export interface RunMetadataPipelineOptions {
  signal?: AbortSignal;
}

function validatePositiveIntBound(value: number, field: string, max: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new EngineError("METADATA_CONFIG_INVALID", `${field} must be a positive integer within the bounded range.`, { field, max });
  }
  return value;
}

function validateNonNegativeIntBound(value: number, field: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new EngineError("METADATA_CONFIG_INVALID", `${field} must be a non-negative integer within the bounded range.`, { field, max });
  }
  return value;
}

/**
 * `MetadataPipelineConfig`'s static type is not a runtime guarantee: a
 * caller can (and, across a JSON-configured settings boundary, likely
 * will) hand this a value that merely happens to compile. Every field is
 * therefore checked at its actual runtime type -- never assumed to already
 * be the array/record/string shape the type annotation claims -- and every
 * collection is bounded both in element count and per-element/total
 * character length before any provider call.
 */
function validateMetadataPipelineConfig(config: MetadataPipelineConfig): string {
  const model = validateBoundedIdentifier(config.model, "MetadataPipelineConfig.model", "METADATA_CONFIG_INVALID", MAX_MODEL_LENGTH);
  validatePositiveIntBound(config.maxTokens, "maxTokens", MAX_MAX_TOKENS);
  validatePositiveIntBound(config.tagLimit, "tagLimit", MAX_TAG_LIMIT);
  validatePositiveIntBound(config.conceptLimit, "conceptLimit", MAX_CONCEPT_LIMIT);
  validateNonNegativeIntBound(config.conceptMaxWords, "conceptMaxWords", MAX_CONCEPT_MAX_WORDS);
  validateNonNegativeIntBound(config.tagMaxWords, "tagMaxWords", MAX_TAG_MAX_WORDS);
  validateNonNegativeIntBound(config.tagMinLen, "tagMinLen", MAX_TAG_MIN_LEN);
  if (config.conceptCaseMode !== "lower" && config.conceptCaseMode !== "title" && config.conceptCaseMode !== "none") {
    throw new EngineError("METADATA_CONFIG_INVALID", "conceptCaseMode must be \"lower\", \"title\", or \"none\".");
  }

  if (!Array.isArray(config.controlledTags)) {
    throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags must be an array.");
  }
  if (config.controlledTags.length > MAX_CONTROLLED_TAGS_COUNT) {
    throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags exceeds the maximum bounded count.", { max: MAX_CONTROLLED_TAGS_COUNT });
  }
  let controlledTagsChars = 0;
  for (const tag of config.controlledTags) {
    if (typeof tag !== "string") {
      throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags contains a non-string entry.");
    }
    if (tag.length > MAX_CONTROLLED_TAG_LENGTH) {
      throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags contains an entry exceeding the maximum bounded length.", { max: MAX_CONTROLLED_TAG_LENGTH });
    }
    // Rejected, not stripped: a controlled tag is interpolated verbatim into the model prompt
    // (buildMetadataMessages), so a control character here (e.g. a newline) could inject an
    // extra prompt line. The offending value is never included in the error.
    if (hasControlCharacter(tag)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags contains an entry with a control character.");
    }
    controlledTagsChars += tag.length;
  }
  if (controlledTagsChars > MAX_CONTROLLED_TAGS_TOTAL_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "controlledTags exceeds the maximum bounded total character length.", { max: MAX_CONTROLLED_TAGS_TOTAL_CHARS });
  }

  if (!isPlainObject(config.tagAliases)) {
    throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases must be a plain object.");
  }
  const aliasEntries = Object.entries(config.tagAliases);
  if (aliasEntries.length > MAX_TAG_ALIASES_COUNT) {
    throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases exceeds the maximum bounded count.", { max: MAX_TAG_ALIASES_COUNT });
  }
  let aliasChars = 0;
  for (const [key, value] of aliasEntries) {
    if (typeof value !== "string") {
      throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases contains a non-string value.");
    }
    if (key.length > MAX_TAG_ALIAS_ENTRY_LENGTH || value.length > MAX_TAG_ALIAS_ENTRY_LENGTH) {
      throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases contains an entry exceeding the maximum bounded length.", { max: MAX_TAG_ALIAS_ENTRY_LENGTH });
    }
    if (hasControlCharacter(key) || hasControlCharacter(value)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases contains an entry with a control character.");
    }
    aliasChars += key.length + value.length;
  }
  if (aliasChars > MAX_TAG_ALIASES_TOTAL_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "tagAliases exceeds the maximum bounded total character length.", { max: MAX_TAG_ALIASES_TOTAL_CHARS });
  }
  return model;
}

/**
 * Validates `related` as unique, already-canonical, vault-relative
 * Markdown paths with bounded count and total character length -- never
 * assumes a `readonly string[]`-typed value actually holds only strings at
 * runtime, and never silently re-canonicalizes a non-canonical path (that
 * would mask a caller bug rather than surface it). No path value appears
 * in a thrown error -- a related path is a note path, kept out of error
 * context on the same static-redacted-errors principle the rest of this
 * seam follows.
 */
function validateRelatedPaths(related: readonly unknown[]): string[] {
  if (related.length > MAX_RELATED_COUNT) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input exceeds the maximum bounded count.", { max: MAX_RELATED_COUNT });
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  let totalChars = 0;
  for (const item of related) {
    if (typeof item !== "string" || item.length === 0) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains a malformed entry.");
    }
    if (item.length > MAX_RELATED_PATH_LENGTH) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains an entry exceeding the maximum bounded length.", { max: MAX_RELATED_PATH_LENGTH });
    }
    if (!item.toLowerCase().endsWith(".md")) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains a non-Markdown entry.");
    }
    let canonical: string;
    try {
      canonical = canonicalizePath(item);
    } catch {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains an invalid vault-relative path.");
    }
    if (canonical !== item) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains a non-canonical path.");
    }
    if (seen.has(canonical)) {
      throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input contains a duplicate path.");
    }
    seen.add(canonical);
    totalChars += canonical.length;
    validated.push(canonical);
  }
  if (totalChars > MAX_RELATED_TOTAL_CHARS) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Related-path input exceeds the maximum bounded total character length.", { max: MAX_RELATED_TOTAL_CHARS });
  }
  return validated;
}

/**
 * Validates `MetadataPipelineInput` at its actual runtime shape -- never
 * assumed to already be the object/string/array the type annotation
 * claims. `input` itself must be a plain, non-null, non-array object;
 * `identity` is validated with `parseNoteIdentityV1` (its own structured
 * `EngineError`s, e.g. `IDENTITY_INVALID`/`CONTRACT_SHAPE_INVALID`,
 * propagate unchanged); `text` must be a string (its length bound is then
 * enforced by `buildMetadataMessages`); `related` must be an actual array
 * before `validateRelatedPaths` ever indexes into it. Every check here
 * runs before any inference spend -- a malformed `identity`/`text`/
 * `related` is rejected before `provider.complete` is ever called, not
 * merely before a raw `TypeError` would otherwise escape.
 */
function validateMetadataPipelineInput(input: MetadataPipelineInput): { identity: NoteIdentityV1; text: string; related: readonly unknown[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata pipeline input must be a plain object.");
  }
  const identity = parseNoteIdentityV1(input.identity, "MetadataPipelineInput.identity");
  if (typeof input.text !== "string") {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata pipeline input.text must be a string.");
  }
  if (!Array.isArray(input.related)) {
    throw new EngineError("METADATA_CONFIG_INVALID", "Metadata pipeline input.related must be an array.");
  }
  return { identity, text: input.text, related: input.related };
}

/**
 * Pure coordinator: builds bounded messages, calls the injected
 * `MetadataInferenceProvider` (with cancellation), strictly parses the
 * response, and normalizes `summary`/`tags`/`concepts` in the exact order
 * `python/mindmap.py`'s caller applies them (around line 3469 in
 * `llm_extract`'s caller): `normalize_tags` -> `apply_tag_aliases` ->
 * `filter_and_map_tags` -> truncate to `tagLimit`; then
 * `normalize_concepts` (limit/max-words/case together). `related` is
 * accepted as already-selected plain paths and passed straight through.
 *
 * Never writes a note, index record, job, or piece of state -- returns a
 * plain `MetadataOutputV1` only. A provider failure that is not already a
 * structured `EngineError` is wrapped in a static, redacted
 * `METADATA_PROVIDER_FAILED` rather than propagating the provider's raw
 * thrown error/message.
 */
export async function runMetadataPipeline(
  provider: MetadataInferenceProvider,
  config: MetadataPipelineConfig,
  input: MetadataPipelineInput,
  options: RunMetadataPipelineOptions = {},
): Promise<MetadataOutputV1> {
  const model = validateMetadataPipelineConfig(config);
  const { identity, text, related: relatedInput } = validateMetadataPipelineInput(input);
  const related = validateRelatedPaths(relatedInput);

  const messages = buildMetadataMessages(text, config.tagLimit, config.conceptLimit, config.controlledTags, config.allowFreeTags);

  let raw: string;
  try {
    raw = await provider.complete({ model, messages, maxTokens: config.maxTokens }, { signal: options.signal });
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError("METADATA_PROVIDER_FAILED", "Metadata inference provider call failed.");
  }

  const parsed = parseMetadataResponse(raw);

  let tags = normalizeTags(parsed.tags);
  tags = applyTagAliases(tags, config.tagAliases);
  tags = filterAndMapTags(tags, config.controlledTags, config.allowFreeTags, config.tagMinLen, config.tagMaxWords).slice(0, config.tagLimit);

  const concepts = normalizeConcepts(parsed.concepts, config.conceptLimit, config.conceptMaxWords, config.conceptCaseMode);

  return buildMetadataOutputV1(identity, parsed.summary.trim(), tags, concepts, related);
}
