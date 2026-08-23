import { createHash } from "node:crypto";

import type { JobKind, SchemaVersion } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { assertValidIanaTimeZone, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, type Cadence } from "./scheduleTime";

/**
 * Checkpoint 8's persisted schedule model: versioned, strictly parsed, and
 * deliberately content-free -- see the module doc on `PersistedScheduleV1`.
 * Nothing here ever carries a note path, job payload, vault content,
 * provider body, credential, or raw caught error; only static, bounded,
 * redacted fields.
 */

/** Codepoint check duplicated locally (never imported from `src/jobs`) so this module stays leaf-level within `src/scheduling` -- mirrors the same duplication choice `src/jobs/jobTypes.ts` documents for `noteIdentityStableKey`. */
function hasControlOrNulCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertIsoTimestamp(value: unknown, field: string, contractName: string): asserts value is string {
  if (typeof value !== "string") {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.${field} must be a string.`, {});
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.${field} must be a real UTC ISO-8601 timestamp in canonical toISOString() form.`, {});
  }
}

export const MAX_SCHEDULE_COUNT = 16;
export const MAX_SCHEDULE_ID_LENGTH = 64;
export const MAX_TIMEZONE_LENGTH = 100;
export const MAX_FAILURE_CODE_LENGTH = 64;
export const MAX_SCOPE_ID_LENGTH = 200;
export const MAX_CONSECUTIVE_FAILURES = 1000;
export const MAX_STORE_SERIALIZED_BYTES = 1 * 1024 * 1024;

/** The closed set of schedule kinds Checkpoint 8 models -- see requirement 5's job mappings. */
export const SCHEDULE_KINDS = ["daily-maintenance", "weekly-refresh", "reading-sync"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** One schedule per kind (a singleton set for now); the stable id is deliberately the kind string itself -- kept as a separate field so a future multi-instance schedule of the same kind has somewhere to diverge without a breaking schema change. */
export type ScheduleId = ScheduleKind;

/** Maps each schedule kind to the exact `JobKind` its catch-up submission targets -- requirement 5: "daily maintenance maps to scope-refresh... reading sync maps to reading-sync scope job... weekly refresh/rebuild maps to rebuild-index." */
export const SCHEDULE_KIND_TO_JOB_KIND: Readonly<Record<ScheduleKind, JobKind>> = {
  "daily-maintenance": "scope-refresh",
  "weekly-refresh": "rebuild-index",
  "reading-sync": "reading-sync",
};

/** Which `JobKind`s require a configured `scopeId` on the schedule definition -- mirrors `JOB_KIND_TARGET_KIND` in `src/engine/contracts.ts` (duplicated as a narrow local list, not imported, to avoid pulling that whole map into this leaf module). */
const SCOPE_TARGETED_JOB_KINDS: ReadonlySet<JobKind> = new Set(["scope-refresh", "reading-sync"]);

/** Which cadence shape each schedule kind requires -- daily maintenance runs once a day, weekly refresh once a week, and Reading sync is Checkpoint 8's one bounded-interval schedule. */
const SCHEDULE_KIND_CADENCE_TYPE: Readonly<Record<ScheduleKind, Cadence["type"]>> = {
  "daily-maintenance": "daily",
  "weekly-refresh": "weekly",
  "reading-sync": "interval",
};

function assertCadence(value: unknown, expectedType: Cadence["type"], contractName: string): Cadence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence must be a JSON object.`, {});
  }
  const record = value as Record<string, unknown>;
  if (record.type !== expectedType) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence.type must be "${expectedType}" for this schedule kind.`, {});
  }
  if (expectedType === "interval") {
    if (typeof record.intervalMinutes !== "number" || !Number.isInteger(record.intervalMinutes) || record.intervalMinutes < MIN_INTERVAL_MINUTES || record.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence.intervalMinutes must be an integer in [${MIN_INTERVAL_MINUTES}, ${MAX_INTERVAL_MINUTES}].`, {});
    }
    const extra = Object.keys(record).filter((key) => key !== "type" && key !== "intervalMinutes");
    if (extra.length > 0) throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence has unrecognized field(s): ${extra.join(", ")}.`, {});
    return { type: "interval", intervalMinutes: record.intervalMinutes };
  }
  if (typeof record.hour !== "number" || !Number.isInteger(record.hour) || record.hour < 0 || record.hour > 23) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence.hour must be an integer in [0, 23].`, {});
  }
  if (typeof record.minute !== "number" || !Number.isInteger(record.minute) || record.minute < 0 || record.minute > 59) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence.minute must be an integer in [0, 59].`, {});
  }
  if (expectedType === "weekly") {
    if (typeof record.weekday !== "number" || !Number.isInteger(record.weekday) || record.weekday < 0 || record.weekday > 6) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence.weekday must be an integer in [0, 6].`, {});
    }
    const extra = Object.keys(record).filter((key) => !["type", "hour", "minute", "weekday"].includes(key));
    if (extra.length > 0) throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence has unrecognized field(s): ${extra.join(", ")}.`, {});
    return { type: "weekly", weekday: record.weekday, hour: record.hour, minute: record.minute };
  }
  const extra = Object.keys(record).filter((key) => !["type", "hour", "minute"].includes(key));
  if (extra.length > 0) throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.cadence has unrecognized field(s): ${extra.join(", ")}.`, {});
  return { type: "daily", hour: record.hour, minute: record.minute };
}

export interface ScheduleDefinitionV1 {
  schemaVersion: SchemaVersion;
  id: ScheduleId;
  kind: ScheduleKind;
  enabled: boolean;
  timezone: string;
  cadence: Cadence;
  pipelineVersion: number;
  /** Required exactly when `SCHEDULE_KIND_TO_JOB_KIND[kind]` targets a scope job (`scope-refresh`/`reading-sync`); absent for `rebuild-index`. A configured scope identifier only -- never a note path or vault content. */
  scopeId?: string;
}

export function parseScheduleDefinitionV1(value: unknown): ScheduleDefinitionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.schemaVersion must be 1.", {});
  }
  if (typeof record.kind !== "string" || !SCHEDULE_KINDS.includes(record.kind as ScheduleKind)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.kind is not a recognized schedule kind.", {});
  }
  const kind = record.kind as ScheduleKind;
  if (record.id !== kind) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.id must equal kind.", {});
  }
  if (typeof record.enabled !== "boolean") {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.enabled must be a boolean.", {});
  }
  assertValidIanaTimeZone(record.timezone);
  const timezone = record.timezone;
  const cadence = assertCadence(record.cadence, SCHEDULE_KIND_CADENCE_TYPE[kind], "ScheduleDefinitionV1");
  if (typeof record.pipelineVersion !== "number" || !Number.isSafeInteger(record.pipelineVersion) || record.pipelineVersion < 1) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.pipelineVersion must be a positive safe integer.", {});
  }
  const jobKind = SCHEDULE_KIND_TO_JOB_KIND[kind];
  const requiresScope = SCOPE_TARGETED_JOB_KINDS.has(jobKind);
  let scopeId: string | undefined;
  if (record.scopeId !== undefined) {
    if (typeof record.scopeId !== "string" || record.scopeId.trim().length === 0 || record.scopeId.length > MAX_SCOPE_ID_LENGTH || hasControlOrNulCharacter(record.scopeId)) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleDefinitionV1.scopeId must be a short, bounded, control-free, non-empty string.", {});
    }
    scopeId = record.scopeId;
  }
  if (requiresScope !== (scopeId !== undefined)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `ScheduleDefinitionV1.scopeId must be present iff schedule kind "${kind}" targets a scope job.`, {});
  }
  const extra = Object.keys(record).filter((key) => !["schemaVersion", "id", "kind", "enabled", "timezone", "cadence", "pipelineVersion", "scopeId"].includes(key));
  if (extra.length > 0) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `ScheduleDefinitionV1 has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  return { schemaVersion: 1, id: kind, kind, enabled: record.enabled, timezone, cadence, pipelineVersion: record.pipelineVersion, scopeId };
}

/** Static, redacted -- never a raw caught error/message. `"submitted"` records a successful `JobEngine.submit` call (queued or coalesced, either way durable); `"submit-failed"` records that the submit call itself threw (a `JobStore`/persistence failure, not a job-level failure -- a job that later fails is tracked entirely within the job store, not here). */
export type ScheduleOutcome = "submitted" | "submit-failed";
const SCHEDULE_OUTCOMES: readonly ScheduleOutcome[] = ["submitted", "submit-failed"];

/** The closed, bounded allow-list a schedule's `lastFailureCode` is ever drawn from -- deliberately narrow (not the full `EngineErrorCode` set): a submit failure at this layer is a coordinator/store-health condition, not a job-content failure. */
export const SCHEDULE_FAILURE_CODES = ["SCHEDULE_SUBMIT_STORE_FAILED", "SCHEDULE_SUBMIT_UNKNOWN"] as const;
export type ScheduleFailureCode = (typeof SCHEDULE_FAILURE_CODES)[number];

const OCCURRENCE_HEX_64_PATTERN = /^[0-9a-f]{64}$/;

function assertOccurrenceHex64(value: unknown, field: string, contractName: string): asserts value is string {
  if (typeof value !== "string" || !OCCURRENCE_HEX_64_PATTERN.test(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${contractName}.${field} must be a 64-character lowercase hex hash.`, {});
  }
}

/**
 * A bounded, content-free fingerprint of exactly the part of a schedule's
 * definition that determines what JOB an occurrence of it submits -- the
 * target `JobKind` (derived from `kind`), `scopeId`, and `pipelineVersion`.
 * Deliberately excludes `enabled`/`timezone`/`cadence`/`id`: those affect
 * WHEN a schedule fires or whether it fires at all, never WHAT job a firing
 * produces. `ScheduleStore.reconfigure` compares this against a persisted
 * pending occurrence's own fingerprint to decide whether that pending
 * occurrence's work identity is still current, or must be invalidated.
 */
export function computeScheduleWorkFingerprint(definition: Pick<ScheduleDefinitionV1, "kind" | "scopeId" | "pipelineVersion">): string {
  // Runtime input validation (final-integration requirement 13) -- this function is called from
  // `parsePersistedScheduleV1` against caller/corruption-supplied data, not only against
  // already-validated in-memory definitions, so it must not blindly trust its own parameter types.
  // Value-free on failure: never echoes the offending field, which may be corrupt/attacker data.
  if (typeof definition !== "object" || definition === null || !SCHEDULE_KINDS.includes(definition.kind)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeScheduleWorkFingerprint: definition.kind is not a recognized schedule kind.", {});
  }
  if (definition.scopeId !== undefined && (typeof definition.scopeId !== "string" || definition.scopeId.trim().length === 0 || definition.scopeId.length > MAX_SCOPE_ID_LENGTH || hasControlOrNulCharacter(definition.scopeId))) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeScheduleWorkFingerprint: definition.scopeId must be a short, bounded, control-free, non-empty string when present.", {});
  }
  if (typeof definition.pipelineVersion !== "number" || !Number.isSafeInteger(definition.pipelineVersion) || definition.pipelineVersion < 1) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeScheduleWorkFingerprint: definition.pipelineVersion must be a positive safe integer.", {});
  }
  const jobKind = SCHEDULE_KIND_TO_JOB_KIND[definition.kind];
  const canonical = { jobKind, scopeId: definition.scopeId ?? null, pipelineVersion: definition.pipelineVersion };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * The deterministic, content-free identity of ONE scheduled occurrence:
 * `sha256(scheduleId + logical due instant + work fingerprint)`. Two
 * `processSchedule` attempts (e.g. a retry after a crash) for the exact
 * same schedule/due-instant/work-identity always compute the IDENTICAL
 * `occurrenceId` -- this is the sole mechanism `JobStore.
 * submitScheduledOccurrence` uses to recognize "this is the same logical
 * occurrence I already tried" across a crash, regardless of whether the
 * job it produced has since reached a terminal status. Never derived from
 * (and never carries) a note path, job payload, or any vault content --
 * only the three bounded, already-validated inputs above.
 */
export function computeScheduleOccurrenceId(scheduleId: ScheduleId, dueAtIso: string, workFingerprint: string): string {
  // Runtime input validation (final-integration requirement 13), value-free on failure -- see
  // `computeScheduleWorkFingerprint`'s own doc comment for why this cannot trust its parameter
  // types alone.
  if (typeof scheduleId !== "string" || !SCHEDULE_KINDS.includes(scheduleId)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeScheduleOccurrenceId: scheduleId is not a recognized schedule id.", {});
  }
  assertIsoTimestamp(dueAtIso, "dueAtIso", "computeScheduleOccurrenceId");
  assertOccurrenceHex64(workFingerprint, "workFingerprint", "computeScheduleOccurrenceId");
  const canonical = { scheduleId, dueAt: dueAtIso, workFingerprint };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export interface ScheduleStateV1 {
  lastDueAt?: string;
  lastSubmittedAt?: string;
  lastOutcome?: ScheduleOutcome;
  lastFailureCode?: ScheduleFailureCode;
  /** The next instant this schedule becomes due; always present, always strictly greater than every previously-persisted `nextDueAt` for this schedule. */
  nextDueAt: string;
  /** Bounded consecutive submit-failure count; reset to 0 on the next successful submit. Actionable, never a raw error trail. */
  consecutiveFailures: number;
  /**
   * A not-yet-finished scheduled occurrence's durable identity -- persisted
   * BEFORE `CoreScheduler` ever calls `JobEngine.submitScheduledOccurrence`
   * (crash protocol step a) and cleared only once that occurrence's
   * outcome is durably recorded as `"submitted"` (step c). All three
   * fields appear together or not at all; while present, a retry of this
   * SAME due occurrence (whether from a submit failure's bounded backoff or
   * from a process crash/restart) MUST reuse this exact `pendingOccurrenceId`
   * rather than computing a fresh one -- see `CoreScheduler.processSchedule`.
   */
  pendingOccurrenceId?: string;
  pendingDueAt?: string;
  pendingWorkFingerprint?: string;
  /**
   * The occurrenceId of the LAST SUCCESSFULLY submitted occurrence (final-
   * integration requirement 2) -- set together with `lastWorkFingerprint`
   * in the SAME commit that records a `"submitted"` outcome, and otherwise
   * left completely untouched (in particular, a LATER `"submit-failed"`
   * outcome for a newer occurrence never clears or overwrites it). This is
   * what lets `CoreScheduler` best-effort re-acknowledge a occurrence whose
   * `JobStore` ack was lost to a crash between outcome-persist and ack
   * (crash protocol step c/d) on every subsequent start/tick, without
   * needing to remember anything beyond what's already durably persisted
   * here. `lastWorkFingerprint` is recorded explicitly (never recomputed
   * from the CURRENT definition, which may have since been reconfigured)
   * so `lastOccurrenceId` can still be verified self-consistent against
   * `lastDueAt` -- see `parsePersistedScheduleV1`.
   */
  lastOccurrenceId?: string;
  lastWorkFingerprint?: string;
  /**
   * A bounded, deduplicated queue of occurrenceIds still awaiting
   * acknowledgement in `JobStore` (last-acceptance requirement 1) --
   * replaces unconditionally re-acknowledging `lastOccurrenceId` on every
   * single tick. An id is appended here in the SAME commit that records
   * the successful outcome that produced it, or (via `ScheduleStore.
   * reconfigure`) in the same commit that invalidates a not-yet-finished
   * pending occurrence -- never via a separate, later write. An id is
   * removed ONLY after `CoreScheduler.reconcileAcknowledgements` has
   * confirmed the corresponding `JobStore.acknowledgeScheduledOccurrence`
   * call actually succeeded; a crash between that success and the removal
   * commit simply re-acks (a harmless idempotent no-op per `JobStore`'s own
   * ack contract) on the next attempt. Once empty, a tick that finds
   * nothing here performs zero `JobStore` writes.
   */
  pendingAcknowledgementIds?: string[];
}

export const MAX_PENDING_ACKNOWLEDGEMENT_IDS = 64;

/**
 * Appends `occurrenceId` to `current` (deduplicated, order-preserving),
 * bounded at `MAX_PENDING_ACKNOWLEDGEMENT_IDS` -- shared by every caller
 * that ever adds to this queue (`ScheduleStore.reconfigure`'s invalidation
 * path, `CoreScheduler.processSchedule`'s successful-outcome path) so the
 * bound/dedup policy can never drift between them.
 *
 * NEVER evicts an unacknowledged id to make room (last-acceptance
 * requirement 1): an entry here is the ONLY durable record that a
 * particular `JobStore` occurrence still needs acknowledging, so silently
 * dropping one to admit a new one would create a permanently-orphaned
 * unacknowledged `JobStore` registry entry with no path back to being
 * acknowledged. Re-adding an id already present is always safe (a no-op,
 * since it's deduplicated) -- only a genuinely DISTINCT 65th id can ever
 * exceed the cap, and that throws `SCHEDULE_CAP_EXCEEDED` instead, so the
 * caller's own commit fails closed and the schedule's pre-commit state
 * (including whatever pending occurrence identity it already had) remains
 * exactly as it was, fully recoverable on a later retry. `CoreScheduler.
 * reconcileAcknowledgements` runs before due-work processing on every
 * tick, draining acknowledged capacity back out of this queue first -- a
 * healthy system (`JobStore` acks are actually succeeding) never
 * accumulates enough entries to hit this cap in practice; hitting it is
 * itself the signal that acknowledgement has been failing repeatedly and
 * needs attention, not something to paper over by dropping a record.
 */
export function appendPendingAcknowledgementId(current: readonly string[] | undefined, occurrenceId: string): string[] {
  const withoutDuplicate = (current ?? []).filter((entry) => entry !== occurrenceId);
  if (withoutDuplicate.length >= MAX_PENDING_ACKNOWLEDGEMENT_IDS) {
    throw new EngineError(
      "SCHEDULE_CAP_EXCEEDED",
      `Cannot enqueue occurrence for acknowledgement: ${withoutDuplicate.length} distinct unacknowledged occurrence(s) already pending (max ${MAX_PENDING_ACKNOWLEDGEMENT_IDS}).`,
      {},
    );
  }
  return [...withoutDuplicate, occurrenceId];
}

export function parseScheduleStateV1(value: unknown): ScheduleStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.lastDueAt !== undefined) assertIsoTimestamp(record.lastDueAt, "lastDueAt", "ScheduleStateV1");
  if (record.lastSubmittedAt !== undefined) assertIsoTimestamp(record.lastSubmittedAt, "lastSubmittedAt", "ScheduleStateV1");
  assertIsoTimestamp(record.nextDueAt, "nextDueAt", "ScheduleStateV1");
  if (record.lastOutcome !== undefined && !SCHEDULE_OUTCOMES.includes(record.lastOutcome as ScheduleOutcome)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastOutcome is not a recognized outcome.", {});
  }
  if (record.lastFailureCode !== undefined && !SCHEDULE_FAILURE_CODES.includes(record.lastFailureCode as ScheduleFailureCode)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastFailureCode is not a recognized failure code.", {});
  }
  if ((record.lastOutcome === "submit-failed") !== (record.lastFailureCode !== undefined)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", 'ScheduleStateV1.lastFailureCode must be present iff lastOutcome is "submit-failed".', {});
  }
  if (typeof record.consecutiveFailures !== "number" || !Number.isInteger(record.consecutiveFailures) || record.consecutiveFailures < 0 || record.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `ScheduleStateV1.consecutiveFailures must be an integer in [0, ${MAX_CONSECUTIVE_FAILURES}].`, {});
  }
  // Pending-occurrence fields (requirement 6): appear together, bounded -- never a partial triple.
  const pendingFieldsPresent = [record.pendingOccurrenceId, record.pendingDueAt, record.pendingWorkFingerprint];
  const pendingPresentCount = pendingFieldsPresent.filter((field) => field !== undefined).length;
  if (pendingPresentCount !== 0 && pendingPresentCount !== 3) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.pendingOccurrenceId/pendingDueAt/pendingWorkFingerprint must appear together.", {});
  }
  if (record.pendingOccurrenceId !== undefined) {
    assertOccurrenceHex64(record.pendingOccurrenceId, "pendingOccurrenceId", "ScheduleStateV1");
    assertIsoTimestamp(record.pendingDueAt, "pendingDueAt", "ScheduleStateV1");
    assertOccurrenceHex64(record.pendingWorkFingerprint, "pendingWorkFingerprint", "ScheduleStateV1");
  }
  // lastOccurrenceId/lastWorkFingerprint (final-integration requirement 2): appear together,
  // bounded, and require lastSubmittedAt -- they only ever get set alongside a successful submit.
  if ((record.lastOccurrenceId !== undefined) !== (record.lastWorkFingerprint !== undefined)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastOccurrenceId/lastWorkFingerprint must appear together.", {});
  }
  if (record.lastOccurrenceId !== undefined) {
    assertOccurrenceHex64(record.lastOccurrenceId, "lastOccurrenceId", "ScheduleStateV1");
    assertOccurrenceHex64(record.lastWorkFingerprint, "lastWorkFingerprint", "ScheduleStateV1");
    if (record.lastSubmittedAt === undefined) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastOccurrenceId requires lastSubmittedAt.", {});
    }
  }
  // pendingAcknowledgementIds (last-acceptance requirement 1/3): bounded, unique, hex64 entries.
  let pendingAcknowledgementIds: string[] | undefined;
  if (record.pendingAcknowledgementIds !== undefined) {
    if (!Array.isArray(record.pendingAcknowledgementIds) || record.pendingAcknowledgementIds.length > MAX_PENDING_ACKNOWLEDGEMENT_IDS) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", `ScheduleStateV1.pendingAcknowledgementIds must be an array of at most ${MAX_PENDING_ACKNOWLEDGEMENT_IDS} entries.`, {});
    }
    const seen = new Set<string>();
    for (const entry of record.pendingAcknowledgementIds) {
      assertOccurrenceHex64(entry, "pendingAcknowledgementIds[]", "ScheduleStateV1");
      if (seen.has(entry)) {
        throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.pendingAcknowledgementIds must not contain a duplicate occurrenceId.", {});
      }
      seen.add(entry);
    }
    pendingAcknowledgementIds = record.pendingAcknowledgementIds;
  }

  const extra = Object.keys(record).filter(
    (key) =>
      ![
        "lastDueAt",
        "lastSubmittedAt",
        "lastOutcome",
        "lastFailureCode",
        "nextDueAt",
        "consecutiveFailures",
        "pendingOccurrenceId",
        "pendingDueAt",
        "pendingWorkFingerprint",
        "lastOccurrenceId",
        "lastWorkFingerprint",
        "pendingAcknowledgementIds",
      ].includes(key),
  );
  if (extra.length > 0) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `ScheduleStateV1 has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  // Cross-field state invariants (requirement 7) -- reject any extra/impossible shape a caller
  // (or a corrupt persisted document) might otherwise construct.
  if (record.lastOutcome !== undefined && record.lastDueAt === undefined) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastOutcome requires lastDueAt to be present.", {});
  }
  if (record.lastOutcome === "submitted") {
    if (record.lastSubmittedAt === undefined) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", 'ScheduleStateV1: lastOutcome "submitted" requires lastSubmittedAt.', {});
    }
    if (record.consecutiveFailures !== 0) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", 'ScheduleStateV1: lastOutcome "submitted" requires consecutiveFailures to be 0.', {});
    }
  }
  if (record.lastOutcome === "submit-failed" && record.consecutiveFailures < 1) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", 'ScheduleStateV1: lastOutcome "submit-failed" requires consecutiveFailures >= 1.', {});
  }
  if (record.lastDueAt !== undefined && new Date(record.nextDueAt).getTime() <= new Date(record.lastDueAt).getTime()) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.nextDueAt must be strictly after lastDueAt.", {});
  }
  // Only meaningful when lastOutcome is "submitted": lastSubmittedAt and lastDueAt then refer to
  // the SAME occurrence, so submission can never precede its own due instant. When lastOutcome is
  // "submit-failed", lastSubmittedAt (if present at all) is carried over from an EARLIER,
  // successfully-submitted occurrence -- it legitimately precedes the current (still-failing)
  // lastDueAt, so this ordering check must not apply in that case.
  if (record.lastOutcome === "submitted" && record.lastSubmittedAt !== undefined && record.lastDueAt !== undefined && new Date(record.lastSubmittedAt).getTime() < new Date(record.lastDueAt).getTime()) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "ScheduleStateV1.lastSubmittedAt must not precede lastDueAt.", {});
  }
  return {
    lastDueAt: record.lastDueAt,
    lastSubmittedAt: record.lastSubmittedAt,
    lastOutcome: record.lastOutcome as ScheduleOutcome | undefined,
    lastFailureCode: record.lastFailureCode as ScheduleFailureCode | undefined,
    nextDueAt: record.nextDueAt,
    consecutiveFailures: record.consecutiveFailures,
    pendingOccurrenceId: record.pendingOccurrenceId,
    pendingDueAt: record.pendingDueAt as string | undefined,
    pendingWorkFingerprint: record.pendingWorkFingerprint as string | undefined,
    lastOccurrenceId: record.lastOccurrenceId,
    lastWorkFingerprint: record.lastWorkFingerprint as string | undefined,
    pendingAcknowledgementIds,
  };
}

export interface PersistedScheduleV1 {
  schemaVersion: SchemaVersion;
  definition: ScheduleDefinitionV1;
  state: ScheduleStateV1;
}

export function parsePersistedScheduleV1(value: unknown): PersistedScheduleV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1.schemaVersion must be 1.", {});
  }
  const definition = parseScheduleDefinitionV1(record.definition);
  const state = parseScheduleStateV1(record.state);
  const extra = Object.keys(record).filter((key) => !["schemaVersion", "definition", "state"].includes(key));
  if (extra.length > 0) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `PersistedScheduleV1 has unrecognized field(s): ${extra.join(", ")}.`, {});
  }

  // Cross-checks against `definition` (final-integration requirement 3) -- only possible here,
  // where both `definition` and `state` are in scope together.
  if (state.pendingOccurrenceId !== undefined) {
    const expectedFingerprint = computeScheduleWorkFingerprint(definition);
    if (state.pendingWorkFingerprint !== expectedFingerprint) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1.state.pendingWorkFingerprint does not match its definition's current work identity.", {});
    }
    const expectedOccurrenceId = computeScheduleOccurrenceId(definition.id, state.pendingDueAt as string, state.pendingWorkFingerprint);
    if (state.pendingOccurrenceId !== expectedOccurrenceId) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1.state.pendingOccurrenceId does not match its own recorded (scheduleId, pendingDueAt, pendingWorkFingerprint).", {});
    }
    // A pending occurrence being retried after a submit failure must be retrying the SAME logical
    // occurrence `lastDueAt` already records -- pendingDueAt can never silently drift to a
    // different due instant than the one the last (failed) attempt was actually for.
    if (state.lastOutcome === "submit-failed" && state.pendingDueAt !== state.lastDueAt) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1.state.pendingDueAt must equal lastDueAt while retrying a submit-failed occurrence.", {});
    }
  }
  // Self-consistency only (never against the CURRENT definition, which may have moved on since
  // this success was recorded) -- see `lastOccurrenceId`'s own doc comment.
  if (state.lastOutcome === "submitted" && state.lastOccurrenceId !== undefined) {
    const expectedOccurrenceId = computeScheduleOccurrenceId(definition.id, state.lastDueAt as string, state.lastWorkFingerprint as string);
    if (state.lastOccurrenceId !== expectedOccurrenceId) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", "PersistedScheduleV1.state.lastOccurrenceId does not match its own recorded (scheduleId, lastDueAt, lastWorkFingerprint).", {});
    }
  }

  return { schemaVersion: 1, definition, state };
}

export interface ScheduleStoreDocumentV1 {
  schemaVersion: SchemaVersion;
  schedules: PersistedScheduleV1[];
}

export function parseScheduleStoreDocumentV1(value: unknown): ScheduleStoreDocumentV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("SCHEDULE_STORE_CORRUPT", "ScheduleStoreDocumentV1 must be a JSON object.", {});
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new EngineError("SCHEDULE_STORE_CORRUPT", "ScheduleStoreDocumentV1.schemaVersion must be 1.", {});
  }
  if (!Array.isArray(record.schedules)) {
    throw new EngineError("SCHEDULE_STORE_CORRUPT", "ScheduleStoreDocumentV1.schedules must be an array.", {});
  }
  if (record.schedules.length > MAX_SCHEDULE_COUNT) {
    throw new EngineError("SCHEDULE_CAP_EXCEEDED", `ScheduleStoreDocumentV1.schedules exceeds max schedule count (${MAX_SCHEDULE_COUNT}).`, {});
  }
  const schedules = record.schedules.map((entry) => parsePersistedScheduleV1(entry));
  const seenIds = new Set<string>();
  for (const persisted of schedules) {
    if (seenIds.has(persisted.definition.id)) {
      throw new EngineError("SCHEDULE_STORE_CORRUPT", `Duplicate schedule id "${persisted.definition.id}" in schedule store.`, {});
    }
    seenIds.add(persisted.definition.id);
  }
  const extra = Object.keys(record).filter((key) => !["schemaVersion", "schedules"].includes(key));
  if (extra.length > 0) {
    throw new EngineError("SCHEDULE_STORE_CORRUPT", `ScheduleStoreDocumentV1 has unrecognized field(s): ${extra.join(", ")}.`, {});
  }
  return { schemaVersion: 1, schedules };
}

/** `id`/`kind` are the only truly immutable fields once a schedule is created -- everything else (`enabled`, `timezone`, `cadence`, `pipelineVersion`, `scopeId`) is reconfigurable through `ScheduleStore.upsertDefinition`'s `configure` callback. `state` is a structurally separate path (`ScheduleStore.updateState`), never touched by `configure`. */
export function assertScheduleIdentityUnchanged(current: ScheduleDefinitionV1, next: ScheduleDefinitionV1): void {
  if (next.id !== current.id || next.kind !== current.kind) {
    throw new EngineError("SCHEDULE_TRANSITION_INVALID", "Schedule id/kind must never change once created.", {});
  }
}

/** `nextDueAt` may only ever move strictly forward -- requirement 2's "nextDueAt strictly advances; no replay cascade." */
export function assertNextDueAtAdvances(current: ScheduleStateV1, next: ScheduleStateV1): void {
  if (new Date(next.nextDueAt).getTime() <= new Date(current.nextDueAt).getTime()) {
    throw new EngineError("SCHEDULE_TRANSITION_INVALID", "ScheduleStateV1.nextDueAt must strictly advance.", {});
  }
}
