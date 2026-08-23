import { createHash } from "node:crypto";

import { EngineError } from "./errors";

/**
 * Every persistent/exchanged Mindmap engine shape carries an explicit
 * `schemaVersion` literal. Bumping a contract means adding a new version
 * union member and a new parser, never mutating a shipped version in place,
 * so old persisted/fixture data fails closed instead of being silently
 * reinterpreted.
 */
export type SchemaVersion = 1;

export type CanonicalPath = string & { readonly __brand: "CanonicalPath" };

// eslint-disable-next-line no-control-regex -- intentionally matches control/NUL bytes so canonicalizePath can reject them
const CONTROL_OR_NUL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Vault-relative, forward-slash, NFC-normalized, non-traversing path. This
 * is the identity surface ordinary notes are keyed by; Apple annotation
 * notes additionally carry a stable `appleAnnotationId` (see
 * `NoteIdentityV1`) because their path can be regenerated/renamed while the
 * annotation itself stays the same.
 *
 * `.trim()` is used only to detect an all-whitespace (effectively empty)
 * input. A vault can legitimately contain a filename with meaningful
 * leading/trailing spaces (e.g. "Notes/ Draft.md"), so those bytes are
 * preserved rather than trimmed away here.
 */
export function canonicalizePath(rawPath: string): CanonicalPath {
  if (rawPath.trim() === "") {
    throw new EngineError("PATH_EMPTY", "Path is empty.");
  }
  if (CONTROL_OR_NUL_CHAR_PATTERN.test(rawPath)) {
    throw new EngineError("PATH_CONTROL_CHARACTER", "Path contains a control or NUL character.", { path: rawPath });
  }
  const normalizedSlashes = rawPath.replace(/\\/g, "/").normalize("NFC");
  if (normalizedSlashes.startsWith("/") || /^[A-Za-z]:\//.test(normalizedSlashes) || normalizedSlashes.startsWith("//")) {
    throw new EngineError("PATH_ABSOLUTE", "Path must be vault-relative.", { path: rawPath });
  }
  const collapsed = normalizedSlashes
    .split("/")
    .filter((segment) => segment !== "." && segment !== "");
  if (collapsed.includes("..")) {
    throw new EngineError("PATH_TRAVERSAL", "Path traversal is not allowed.", { path: rawPath });
  }
  if (collapsed.length === 0) {
    throw new EngineError("PATH_EMPTY", "Path is empty after normalization.", { path: rawPath });
  }
  return collapsed.join("/") as CanonicalPath;
}

export type NoteIdentityKind = "path" | "apple-annotation";

export interface NoteIdentityV1 {
  schemaVersion: SchemaVersion;
  kind: NoteIdentityKind;
  canonicalPath: CanonicalPath;
  appleAnnotationId?: string;
}

/**
 * Ordinary notes are identified by canonical path alone. Apple annotation
 * notes are identified primarily by their stable `annotation_id` (adoption
 * and collision handling survive a path rename), with the canonical path
 * kept only as the current on-disk location.
 *
 * Passing `appleAnnotationId` at all commits to an apple-annotation
 * identity: a blank/whitespace-only id throws rather than silently
 * downgrading to a `"path"` identity. Omit the argument entirely to build
 * an ordinary path identity.
 */
export function stableNoteIdentity(canonicalPath: CanonicalPath, appleAnnotationId?: string): NoteIdentityV1 {
  if (appleAnnotationId === undefined) {
    return { schemaVersion: 1, kind: "path", canonicalPath };
  }
  if (CONTROL_OR_NUL_CHAR_PATTERN.test(appleAnnotationId)) {
    throw new EngineError("IDENTITY_INVALID", "Apple annotation id must not contain control characters.", { canonicalPath });
  }
  const trimmed = appleAnnotationId.trim();
  if (!trimmed) {
    throw new EngineError("IDENTITY_INVALID", "Apple annotation identity requires a non-blank annotation id.", { canonicalPath });
  }
  return { schemaVersion: 1, kind: "apple-annotation", canonicalPath, appleAnnotationId: trimmed };
}

function assertSchemaVersion(value: unknown, expected: SchemaVersion, contractName: string): asserts value is SchemaVersion {
  if (value === undefined || value === null) {
    throw new EngineError("CONTRACT_SCHEMA_VERSION_MISSING", `${contractName} is missing schemaVersion.`, { contractName });
  }
  if (value !== expected) {
    const receivedDisplay = typeof value === "number" || typeof value === "string" ? String(value) : JSON.stringify(value);
    throw new EngineError(
      "CONTRACT_SCHEMA_VERSION_MISMATCH",
      `${contractName} has unsupported schemaVersion ${receivedDisplay}; expected ${expected}.`,
      { contractName, received: value, expected },
    );
  }
}

function assertPlainObject(value: unknown, contractName: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName} must be a JSON object.`, { contractName });
  }
}

function assertString(value: unknown, field: string, contractName: string): asserts value is string {
  if (typeof value !== "string") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a string.`, { contractName, field });
  }
}

function assertStringArray(value: unknown, field: string, contractName: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a string array.`, { contractName, field });
  }
}

function assertFiniteNumberArray(value: unknown, field: string, contractName: string): asserts value is number[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be an array of finite numbers.`, { contractName, field });
  }
}

/**
 * For identifier-shaped fields only (job/scope/annotation ids, model
 * names, codes) — never for paths, where leading/trailing spaces can be
 * meaningful filename bytes. Rejects control/NUL characters and returns
 * the trimmed value, since surrounding whitespace on an identifier is
 * never semantically significant.
 */
function assertIdentifier(value: unknown, field: string, contractName: string): string {
  if (typeof value !== "string") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a string.`, { contractName, field });
  }
  if (CONTROL_OR_NUL_CHAR_PATTERN.test(value)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must not contain control characters.`, { contractName, field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a non-empty identifier.`, { contractName, field });
  }
  return trimmed;
}

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

function assertHex64(value: unknown, field: string, contractName: string): asserts value is string {
  if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a 64-character lowercase hex hash.`, { contractName, field });
  }
}

function assertPositiveInteger(value: unknown, field: string, contractName: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a positive integer.`, { contractName, field });
  }
}

/**
 * Requires exactly the canonical form `Date.prototype.toISOString()`
 * writes (millisecond-precision UTC, e.g. "2026-08-22T00:00:00.000Z") and
 * round-trips the value through `new Date(...).toISOString()` to confirm
 * it. A regex shape check alone is not enough: `Date` silently
 * calendar-normalizes an impossible date like "2026-02-30" into "2026-03-02",
 * so only comparing the round-tripped `toISOString()` output back against
 * the original string catches that rollover instead of accepting it.
 */
function assertIsoTimestamp(value: unknown, field: string, contractName: string): asserts value is string {
  if (typeof value !== "string") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.${field} must be a string.`, { contractName, field });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.${field} must be a real UTC ISO-8601 timestamp in canonical toISOString() form.`,
      { contractName, field },
    );
  }
}

/**
 * A `"path"` identity and an `"apple-annotation"` identity are mutually
 * exclusive shapes, not a spectrum: an apple-annotation identity requires a
 * non-blank `appleAnnotationId` (never silently downgraded to `"path"`),
 * and a `"path"` identity rejects an `appleAnnotationId` field outright
 * rather than ignoring it.
 */
export function parseNoteIdentityV1(value: unknown, contractName = "NoteIdentityV1"): NoteIdentityV1 {
  return parseNoteIdentity(value, contractName);
}

function parseNoteIdentity(value: unknown, contractName: string): NoteIdentityV1 {
  const label = `${contractName}.identity`;
  assertPlainObject(value, label);
  assertSchemaVersion(value.schemaVersion, 1, label);
  if (value.kind !== "path" && value.kind !== "apple-annotation") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${label}.kind must be "path" or "apple-annotation".`, { contractName });
  }
  assertString(value.canonicalPath, "canonicalPath", label);
  const canonicalPath = canonicalizePath(value.canonicalPath);
  if (value.kind === "apple-annotation") {
    const appleAnnotationId = assertIdentifier(value.appleAnnotationId, "appleAnnotationId", label);
    return { schemaVersion: 1, kind: "apple-annotation", canonicalPath, appleAnnotationId };
  }
  if (value.appleAnnotationId !== undefined) {
    throw new EngineError("IDENTITY_INVALID", `${label}.appleAnnotationId must be absent for a "path" identity.`, { contractName });
  }
  return { schemaVersion: 1, kind: "path", canonicalPath };
}

export interface NoteSnapshotV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  /** Exact original bytes: frontmatter + body, original newline convention preserved. */
  rawContent: string;
  isAppleAnnotation: boolean;
}

/** `isAppleAnnotation` must agree with `identity.kind`; a contradictory pairing is rejected rather than trusted. */
export function parseNoteSnapshotV1(value: unknown): NoteSnapshotV1 {
  const contractName = "NoteSnapshotV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const identity = parseNoteIdentity(value.identity, contractName);
  assertString(value.rawContent, "rawContent", contractName);
  if (typeof value.isAppleAnnotation !== "boolean") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.isAppleAnnotation must be a boolean.`, { contractName });
  }
  const identityIsAnnotation = identity.kind === "apple-annotation";
  if (value.isAppleAnnotation !== identityIsAnnotation) {
    throw new EngineError(
      "IDENTITY_INVALID",
      `${contractName}.isAppleAnnotation (${String(value.isAppleAnnotation)}) is inconsistent with identity.kind ("${identity.kind}").`,
      { contractName },
    );
  }
  return { schemaVersion: 1, identity, rawContent: value.rawContent, isAppleAnnotation: value.isAppleAnnotation };
}

export interface SourceProjectionV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  projectedFrontmatterJson: string;
  projectedBody: string;
  excludedFrontmatterKeys: string[];
  excludedManagedSections: string[];
  sourceHash: string;
}

export function parseSourceProjectionV1(value: unknown): SourceProjectionV1 {
  const contractName = "SourceProjectionV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const identity = parseNoteIdentity(value.identity, contractName);
  assertString(value.projectedFrontmatterJson, "projectedFrontmatterJson", contractName);
  assertString(value.projectedBody, "projectedBody", contractName);
  assertStringArray(value.excludedFrontmatterKeys, "excludedFrontmatterKeys", contractName);
  assertStringArray(value.excludedManagedSections, "excludedManagedSections", contractName);
  assertHex64(value.sourceHash, "sourceHash", contractName);
  return {
    schemaVersion: 1,
    identity,
    projectedFrontmatterJson: value.projectedFrontmatterJson,
    projectedBody: value.projectedBody,
    excludedFrontmatterKeys: value.excludedFrontmatterKeys,
    excludedManagedSections: value.excludedManagedSections,
    sourceHash: value.sourceHash,
  };
}

export interface MetadataOutputV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  summary: string;
  tags: string[];
  concepts: string[];
  related: string[];
}

export function parseMetadataOutputV1(value: unknown): MetadataOutputV1 {
  const contractName = "MetadataOutputV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const identity = parseNoteIdentity(value.identity, contractName);
  assertString(value.summary, "summary", contractName);
  assertStringArray(value.tags, "tags", contractName);
  assertStringArray(value.concepts, "concepts", contractName);
  assertStringArray(value.related, "related", contractName);
  return {
    schemaVersion: 1,
    identity,
    summary: value.summary,
    tags: value.tags,
    concepts: value.concepts,
    related: value.related,
  };
}

export interface EmbeddingVectorV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  model: string;
  dimension: number;
  values: number[];
}

export function parseEmbeddingVectorV1(value: unknown): EmbeddingVectorV1 {
  const contractName = "EmbeddingVectorV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const identity = parseNoteIdentity(value.identity, contractName);
  const model = assertIdentifier(value.model, "model", contractName);
  if (typeof value.dimension !== "number" || !Number.isInteger(value.dimension) || value.dimension <= 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.dimension must be a positive integer.`, { contractName });
  }
  assertFiniteNumberArray(value.values, "values", contractName);
  if (value.values.length !== value.dimension) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.values length (${value.values.length}) must equal dimension (${value.dimension}).`,
      { contractName },
    );
  }
  return { schemaVersion: 1, identity, model, dimension: value.dimension, values: value.values };
}

export type RelatedCandidateKind = "core" | "overreach" | "creative" | "fill";

export interface RelatedCandidateV1 {
  schemaVersion: SchemaVersion;
  path: CanonicalPath;
  score: number;
  kind: RelatedCandidateKind;
}

export function parseRelatedCandidateV1(value: unknown): RelatedCandidateV1 {
  const contractName = "RelatedCandidateV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  assertString(value.path, "path", contractName);
  const path = canonicalizePath(value.path);
  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.score must be a finite number.`, { contractName });
  }
  if (value.kind !== "core" && value.kind !== "overreach" && value.kind !== "creative" && value.kind !== "fill") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.kind is not a recognized related-candidate kind.`, { contractName });
  }
  return { schemaVersion: 1, path, score: value.score, kind: value.kind };
}

export interface IndexRecordV1 {
  schemaVersion: SchemaVersion;
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
  chunkCount: number;
}

export function parseIndexRecordV1(value: unknown): IndexRecordV1 {
  const contractName = "IndexRecordV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const identity = parseNoteIdentity(value.identity, contractName);
  assertHex64(value.sourceHash, "sourceHash", contractName);
  const embeddingModel = assertIdentifier(value.embeddingModel, "embeddingModel", contractName);
  if (typeof value.chunkCount !== "number" || !Number.isInteger(value.chunkCount) || value.chunkCount < 0) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.chunkCount must be a non-negative integer.`, { contractName });
  }
  return { schemaVersion: 1, identity, sourceHash: value.sourceHash, embeddingModel, chunkCount: value.chunkCount };
}

/**
 * What caused a job to be enqueued — origin only, never a duplicate of
 * `JobKind` (what the job does). `"startup"` covers the at-most-one
 * catch-up job `CoreScheduler` submits per overdue schedule when Obsidian
 * launches. Rebuild and migration are `JobKind`s, not triggers: a rebuild
 * or migration job can itself originate from any of these (an explicit
 * user action is `"manual"`, an overdue schedule discovered at launch is
 * `"startup"`).
 */
export type JobTrigger = "manual" | "reading" | "scheduled" | "startup";

/**
 * What kind of work a job performs. Only `"process-note"` acts on a single
 * note; the others act on a scope (Reading root, a configured scope
 * folder) or globally (a full index rebuild or migration), never on a
 * single note identity. `JOB_KIND_TARGET_KIND` is the single source of
 * truth for which `JobTargetV1["kind"]` each `JobKind` requires.
 */
export type JobKind = "process-note" | "reading-sync" | "scope-refresh" | "rebuild-index" | "migrate-index";

export type JobPhase =
  | "discover"
  | "embed"
  | "extract-metadata"
  | "confirm-source"
  | "write-note"
  | "write-overlay"
  | "import"
  | "enqueue"
  | "build-generation"
  | "verify-generation"
  | "activate-generation"
  | "complete";

/**
 * The union of everything a job can act on. Per-note work targets a single
 * `NoteIdentityV1`; Reading sync and scope-wide processing target a scope
 * id (e.g. the Reading root, or a configured scope folder); rebuild and
 * migration target the whole index/vault and carry no further identity.
 */
export type JobTargetV1 =
  | { schemaVersion: SchemaVersion; kind: "note"; identity: NoteIdentityV1 }
  | { schemaVersion: SchemaVersion; kind: "scope"; scopeId: string }
  | { schemaVersion: SchemaVersion; kind: "global" };

export interface QueueJobV1 {
  schemaVersion: SchemaVersion;
  jobId: string;
  trigger: JobTrigger;
  kind: JobKind;
  target: JobTargetV1;
  /** Present only when `kind === "process-note"`; absent for every scope/global kind. */
  sourceHash?: string;
  /** Present only when `kind === "process-note"`; absent for every scope/global kind. */
  embeddingModel?: string;
  pipelineVersion: number;
  phase: JobPhase;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

const JOB_TRIGGERS: readonly JobTrigger[] = ["manual", "reading", "scheduled", "startup"];
const JOB_KINDS: readonly JobKind[] = ["process-note", "reading-sync", "scope-refresh", "rebuild-index", "migrate-index"];

/** The single source of truth for which target shape each job kind requires. Kept in one place so the parser's compatibility check and any future job-construction code cannot drift apart. */
export const JOB_KIND_TARGET_KIND: Readonly<Record<JobKind, JobTargetV1["kind"]>> = {
  "process-note": "note",
  "reading-sync": "scope",
  "scope-refresh": "scope",
  "rebuild-index": "global",
  "migrate-index": "global",
};

/**
 * The single source of truth for which phases are reachable by each job
 * kind. Only `"process-note"` runs the full per-note pipeline
 * (embed/extract-metadata/confirm-source/write-note/write-overlay are
 * exclusive to it and meaningless for a job with no single note or
 * embedding to act on). Every other kind gets its own durable high-level
 * phases rather than collapsing straight to `"discover"`/`"complete"`: a
 * crash mid-generation-build needs a phase to resume from, distinct from a
 * crash mid-verify or mid-activate, so persisted recovery can tell exactly
 * how far a rebuild/migration/sync got.
 */
export const JOB_KIND_PHASES: Readonly<Record<JobKind, readonly JobPhase[]>> = {
  "process-note": ["discover", "embed", "extract-metadata", "confirm-source", "write-note", "write-overlay", "complete"],
  "reading-sync": ["discover", "import", "enqueue", "complete"],
  "scope-refresh": ["discover", "enqueue", "complete"],
  "rebuild-index": ["discover", "build-generation", "verify-generation", "activate-generation", "complete"],
  "migrate-index": ["discover", "build-generation", "verify-generation", "activate-generation", "complete"],
};

/**
 * Minimal, genuinely-invalid trigger/kind restrictions only -- everything
 * else that's a legitimate manual/scheduled/startup flow stays allowed.
 * `"migrate-index"` only ever runs from an explicit user action or the
 * one-time startup migration decision, never off a recurring schedule or a
 * Reading sync tick. The `"reading"` trigger fans out into per-note or
 * Reading-scope work only; it never causes a full index rebuild or a
 * migration.
 */
export const JOB_TRIGGER_KINDS: Readonly<Record<JobTrigger, readonly JobKind[]>> = {
  manual: ["process-note", "reading-sync", "scope-refresh", "rebuild-index", "migrate-index"],
  reading: ["process-note", "reading-sync", "scope-refresh"],
  scheduled: ["process-note", "reading-sync", "scope-refresh", "rebuild-index"],
  startup: ["process-note", "reading-sync", "scope-refresh", "rebuild-index", "migrate-index"],
};

/**
 * Canonical, collision-safe target value for the idempotency key: an
 * explicit `{ kind, ... }` object (never a joined/delimited string), so
 * structurally different targets can never serialize to the same JSON no
 * matter what characters their id/path fields contain.
 */
function canonicalJobTargetValue(target: JobTargetV1): Record<string, unknown> {
  switch (target.kind) {
    case "note":
      return target.identity.kind === "apple-annotation"
        ? { kind: "note", identityKind: "apple-annotation", appleAnnotationId: target.identity.appleAnnotationId }
        : { kind: "note", identityKind: "path", canonicalPath: target.identity.canonicalPath };
    case "scope":
      return { kind: "scope", scopeId: target.scopeId };
    case "global":
      return { kind: "global" };
  }
}

/**
 * Deterministic idempotency key covering the full canonical target: same
 * trigger + kind + target (note identity, scope id, or global) + pipeline
 * version + (for note jobs) source hash + embedding model always coalesce
 * to the same key, so duplicate manual/Reading/scheduled/startup triggers
 * for identical work collapse into one queue entry -- including duplicate
 * scope/global jobs, which a note-identity-only key could never express.
 *
 * The input is a fixed-shape JSON object with explicit named fields
 * (`JSON.stringify` on an object literal serializes its own keys in a
 * fixed insertion order), not a delimiter-joined string: every field is
 * independently JSON-string-escaped, so no value any field can legally
 * hold (paths/ids reject control characters; JSON escapes quotes/braces in
 * the rest) can forge a collision by injecting a would-be separator.
 */
export function computeJobIdempotencyKey(
  trigger: JobTrigger,
  kind: JobKind,
  target: JobTargetV1,
  pipelineVersion: number,
  sourceHash?: string,
  embeddingModel?: string,
): string {
  const canonical = {
    trigger,
    kind,
    target: canonicalJobTargetValue(target),
    pipelineVersion,
    sourceHash: sourceHash ?? null,
    embeddingModel: embeddingModel ?? null,
  };
  return sha256Hex(JSON.stringify(canonical));
}

function parseJobTarget(value: unknown, contractName: string): JobTargetV1 {
  const label = `${contractName}.target`;
  assertPlainObject(value, label);
  assertSchemaVersion(value.schemaVersion, 1, label);
  if (value.kind === "note") {
    const identity = parseNoteIdentity(value.identity, label);
    return { schemaVersion: 1, kind: "note", identity };
  }
  if (value.kind === "scope") {
    const scopeId = assertIdentifier(value.scopeId, "scopeId", label);
    return { schemaVersion: 1, kind: "scope", scopeId };
  }
  if (value.kind === "global") {
    return { schemaVersion: 1, kind: "global" };
  }
  throw new EngineError("CONTRACT_SHAPE_INVALID", `${label}.kind must be "note", "scope", or "global".`, { contractName });
}

/**
 * Rejects, rather than silently coercing, any incompatible kind/target
 * combination (e.g. `"process-note"` with a scope target, or
 * `"rebuild-index"` with a note target) and any presence/absence mismatch
 * of the note-only `sourceHash`/`embeddingModel` fields.
 */
export function parseQueueJobV1(value: unknown): QueueJobV1 {
  const contractName = "QueueJobV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const jobId = assertIdentifier(value.jobId, "jobId", contractName);
  if (typeof value.trigger !== "string" || !JOB_TRIGGERS.includes(value.trigger as JobTrigger)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.trigger is not a recognized job trigger.`, { contractName });
  }
  if (typeof value.kind !== "string" || !JOB_KINDS.includes(value.kind as JobKind)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.kind is not a recognized job kind.`, { contractName });
  }
  const trigger = value.trigger as JobTrigger;
  const kind = value.kind as JobKind;
  if (!JOB_TRIGGER_KINDS[trigger].includes(kind)) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.trigger "${trigger}" cannot produce kind "${kind}".`,
      { contractName, trigger, kind },
    );
  }

  const target = parseJobTarget(value.target, contractName);
  const expectedTargetKind = JOB_KIND_TARGET_KIND[kind];
  if (target.kind !== expectedTargetKind) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.kind "${kind}" requires a "${expectedTargetKind}" target, got "${target.kind}".`,
      { contractName, kind, targetKind: target.kind },
    );
  }

  let sourceHash: string | undefined;
  let embeddingModel: string | undefined;
  if (kind === "process-note") {
    assertHex64(value.sourceHash, "sourceHash", contractName);
    embeddingModel = assertIdentifier(value.embeddingModel, "embeddingModel", contractName);
    sourceHash = value.sourceHash;
  } else if (value.sourceHash !== undefined || value.embeddingModel !== undefined) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.sourceHash/embeddingModel must be absent for kind "${kind}".`,
      { contractName, kind },
    );
  }

  assertPositiveInteger(value.pipelineVersion, "pipelineVersion", contractName);
  if (typeof value.phase !== "string" || !JOB_KIND_PHASES[kind].includes(value.phase as JobPhase)) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `${contractName}.phase is not a recognized phase for kind "${kind}".`,
      { contractName, kind, phase: value.phase },
    );
  }
  const phase = value.phase as JobPhase;
  const idempotencyKey = assertIdentifier(value.idempotencyKey, "idempotencyKey", contractName);
  assertIsoTimestamp(value.createdAt, "createdAt", contractName);
  assertIsoTimestamp(value.updatedAt, "updatedAt", contractName);

  const expectedKey = computeJobIdempotencyKey(trigger, kind, target, value.pipelineVersion, sourceHash, embeddingModel);
  if (idempotencyKey !== expectedKey) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.idempotencyKey does not match its derived value.`, { contractName });
  }

  return {
    schemaVersion: 1,
    jobId,
    trigger,
    kind,
    target,
    sourceHash,
    embeddingModel,
    pipelineVersion: value.pipelineVersion,
    phase,
    idempotencyKey,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export type HealthStatus = "ok" | "degraded" | "unavailable";

export interface HealthCheckV1 {
  schemaVersion: SchemaVersion;
  code: string;
  status: HealthStatus;
  message: string;
  guidance?: string;
  context?: Record<string, unknown>;
}

export function parseHealthCheckV1(value: unknown): HealthCheckV1 {
  const contractName = "HealthCheckV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const code = assertIdentifier(value.code, "code", contractName);
  if (value.status !== "ok" && value.status !== "degraded" && value.status !== "unavailable") {
    throw new EngineError("CONTRACT_SHAPE_INVALID", `${contractName}.status is not a recognized health status.`, { contractName });
  }
  assertString(value.message, "message", contractName);
  if (value.guidance !== undefined) {
    assertString(value.guidance, "guidance", contractName);
  }
  if (value.context !== undefined) {
    assertPlainObject(value.context, `${contractName}.context`);
  }
  return {
    schemaVersion: 1,
    code,
    status: value.status,
    message: value.message,
    guidance: value.guidance,
    context: value.context,
  };
}

export interface StructuredFailureV1 {
  schemaVersion: SchemaVersion;
  code: string;
  message: string;
  guidance?: string;
  context?: Record<string, unknown>;
}

export function parseStructuredFailureV1(value: unknown): StructuredFailureV1 {
  const contractName = "StructuredFailureV1";
  assertPlainObject(value, contractName);
  assertSchemaVersion(value.schemaVersion, 1, contractName);
  const code = assertIdentifier(value.code, "code", contractName);
  assertString(value.message, "message", contractName);
  if (value.guidance !== undefined) {
    assertString(value.guidance, "guidance", contractName);
  }
  if (value.context !== undefined) {
    assertPlainObject(value.context, `${contractName}.context`);
  }
  return {
    schemaVersion: 1,
    code,
    message: value.message,
    guidance: value.guidance,
    context: value.context,
  };
}

/**
 * Already-approved aggregate production scale, recorded verbatim from the
 * rewrite plan. Never computed from a live vault; Checkpoint 1 does not
 * access any vault.
 */
export interface ApprovedProductionBenchmarkV1 {
  schemaVersion: SchemaVersion;
  scopedNoteCount: number;
  indexedNoteCount: number;
  chunkCount: number;
  embeddingDimension: number;
}

export const APPROVED_PRODUCTION_BENCHMARK_V1: ApprovedProductionBenchmarkV1 = {
  schemaVersion: 1,
  scopedNoteCount: 1094,
  indexedNoteCount: 275,
  chunkCount: 436,
  embeddingDimension: 1024,
};

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
