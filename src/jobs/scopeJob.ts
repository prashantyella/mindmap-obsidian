import { createHash } from "node:crypto";

import { parseNoteIdentityV1, type NoteIdentityV1 } from "../engine/contracts";
import { EngineError, isEngineError } from "../engine/errors";
import type { JobPhaseRunner, PhaseStepOutcome } from "./jobEngine";
import { assertBoundedControlFreeIdentifier, MAX_SCOPE_DISCOVERY_ITEMS, noteIdentityStableKey, toFailureCode, type JobReceiptV1, type PersistedJobV1 } from "./jobTypes";

export { MAX_SCOPE_DISCOVERY_ITEMS };

export interface ScopeDiscoveryItem {
  identity: NoteIdentityV1;
  sourceHash: string;
  embeddingModel: string;
}

/**
 * The vault-scanning seam both `"reading-sync"` and `"scope-refresh"` jobs
 * run through. Must be side-effect-free and idempotent -- called again on
 * every cold restart that lands on any phase after `discover` (this
 * runner keeps no cross-restart-durable copy of the discovered item list
 * itself, which would be neither bounded nor content-free; only its
 * COUNT is persisted, in the receipt). Returns at most
 * `MAX_SCOPE_DISCOVERY_ITEMS` entries. `signal` is aborted when
 * `JobEngine.dispose()` runs -- a well-behaved implementation should stop
 * promptly.
 */
export interface ScopeDiscoverySeam {
  discover(scopeId: string, signal: AbortSignal): Promise<ScopeDiscoveryItem[]>;
}

/** `"reading-sync"` only: e.g. importing newly-read Apple Books annotations into the vault before any per-note job is enqueued for them. Must be idempotent -- safe to re-run against the same discovered set after a restart. REQUIRED (Checkpoint 7 final-closure requirement 8): every `"reading-sync"` job reaches the `"import"` phase, so a runner missing this dependency would otherwise silently skip an entire phase's worth of work rather than failing closed. */
export interface ScopeImportSeam {
  import(scopeId: string, items: readonly ScopeDiscoveryItem[], signal: AbortSignal): Promise<void>;
}

/** Submits (or coalesces onto an already-queued) one `"process-note"` job per discovered item -- expected to be backed by `JobEngine.submit`, whose own idempotency-key coalescing is what makes re-running the whole `enqueue` phase after a restart safe: re-submitting an identical item is always a no-op onto the same existing job, never a duplicate. */
export interface ScopeEnqueueSeam {
  enqueueProcessNote(item: ScopeDiscoveryItem, pipelineVersion: number, signal: AbortSignal): Promise<void>;
}

export interface ScopeJobDeps {
  discovery: ScopeDiscoverySeam;
  /** REQUIRED -- see `ScopeImportSeam`. Never referenced for a `"scope-refresh"` job (its phase list structurally never includes `"import"`), but always required at construction so a caller composing this runner for `"reading-sync"` can never forget it. */
  import: ScopeImportSeam;
  enqueue: ScopeEnqueueSeam;
}

type ScopeReceipt = Extract<JobReceiptV1, { kind: "scope" }>;

function scopeReceiptOf(persisted: PersistedJobV1): ScopeReceipt | undefined {
  return persisted.receipt?.kind === "scope" ? persisted.receipt : undefined;
}

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DISCOVERY_MODEL_LENGTH = 200;

/**
 * Validates every discovered item's RUNTIME shape (Checkpoint 7
 * final-closure requirement 8) BEFORE any effect (import/enqueue) is ever
 * attempted against ANY of them: `identity` must be a well-formed
 * `NoteIdentityV1` (`parseNoteIdentityV1` -- the same strict contract
 * parser every other identity in this codebase goes through, never a
 * hand-rolled shape check), `sourceHash` a lowercase hex64 hash,
 * `embeddingModel` a short bounded non-empty string, and no two items may
 * share the same stable identity. A discovery seam is caller-supplied
 * code, not a trusted internal source -- its output gets exactly as
 * little trust as a runner's outcome code does elsewhere in this module.
 * Every thrown message here is deliberately generic (no scopeId, no path,
 * no identity value interpolated) so nothing scope/vault-specific ever
 * risks surfacing through a persisted failure code's context.
 */
function assertValidDiscoveryItems(items: unknown): asserts items is ScopeDiscoveryItem[] {
  // A discovery seam is caller-supplied code -- its result's ACTUAL runtime shape gets checked
  // before ANYTHING else touches it (Checkpoint 7 acceptance guard 7): a non-array result must
  // fail closed with a structured error here, never reach a bare `.length`/iteration that could
  // throw a raw TypeError instead.
  if (!Array.isArray(items)) {
    throw new EngineError("CONTRACT_SHAPE_INVALID", "Scope discovery must return an array.", {});
  }
  const seenKeys = new Set<string>();
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "ScopeDiscoveryItem must be an object.", {});
    }
    const record = item as Record<string, unknown>;
    const identity = parseNoteIdentityV1(record.identity, "ScopeDiscoveryItem");
    if (typeof record.sourceHash !== "string" || !HEX_64_PATTERN.test(record.sourceHash)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "ScopeDiscoveryItem.sourceHash must be a lowercase hex64 hash.", {});
    }
    assertBoundedControlFreeIdentifier(record.embeddingModel, MAX_DISCOVERY_MODEL_LENGTH, "ScopeDiscoveryItem.embeddingModel");
    const key = noteIdentityStableKey(identity);
    if (seenKeys.has(key)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "Scope discovery returned duplicate items for the same stable identity.", {});
    }
    seenKeys.add(key);
  }
}

/**
 * A bounded, content-free, order-independent fingerprint of exactly WHICH
 * items a discovery run saw -- each item's stable identity key +
 * sourceHash + embeddingModel, never note content, sorted before hashing
 * so re-discovering the identical set in a different enumeration order
 * still produces the identical fingerprint (Checkpoint 7 acceptance guard
 * 8). `assertValidDiscoveryItems` has already rejected duplicate stable
 * identities by the time this runs, so sorting the full "key|hash|model"
 * rows is a safe, unambiguous canonicalization.
 */
function computeDiscoveryFingerprint(items: readonly ScopeDiscoveryItem[]): string {
  const rows = items.map((item) => `${noteIdentityStableKey(item.identity)}|${item.sourceHash}|${item.embeddingModel}`).sort();
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * Implements the durable phase order for `"reading-sync"`
 * (`discover -> import -> enqueue -> complete`) and `"scope-refresh"`
 * (`discover -> enqueue -> complete`) jobs (Checkpoint 7 requirement 14) --
 * the two officially-submittable scope job kinds that had no runner at all
 * before this, and so would fail immediately (`JOB_SHAPE_INVALID`, "no
 * runner registered for this job kind") the moment anything ever
 * submitted one. No production wiring: the discovery/import/enqueue seams
 * this constructor takes are injected exactly like every other job kind's
 * dependencies, and remain a later checkpoint's job to back with the real
 * vault/Apple Books/`JobEngine.submit` implementations.
 *
 * Every phase re-runs `discovery.discover()` rather than caching its
 * result across phase-steps or persisting it: the discovered item list
 * itself is neither bounded (a whole scope's worth of notes) nor
 * content-free (it carries identities), so only its COUNT is ever
 * persisted (`receipt.discoveredCount`) -- restart-safety instead comes
 * from every phase's own idempotency (`ScopeImportSeam`/`ScopeEnqueueSeam`
 * must both be safe to re-run against the same discovered set, exactly
 * like `NoteJobRunner`'s phases are safe to redo against the same source).
 *
 * Receipt semantics (Checkpoint 7 final-closure requirement 8):
 * `discovered` becomes `true` the moment `discover` itself succeeds (not
 * merely at the very end) -- it means "this job's discovery phase
 * completed", the natural reading of the field name; `imported` becomes
 * `true` only after `import` succeeds (`"reading-sync"` only, never set
 * for `"scope-refresh"`); `enqueuedCount` is set only after `enqueue`
 * succeeds. `signal` (aborted on `JobEngine.dispose()`) is threaded
 * through to every seam call, and is also checked BETWEEN every item in
 * the `enqueue` loop so a long enqueue run stops promptly rather than
 * working through a large discovered set after disposal.
 */
export class ScopeJobRunner implements JobPhaseRunner {
  constructor(private readonly deps: ScopeJobDeps) {
    // A runtime guard, not merely a TypeScript-time one (final-closure requirement 8): a caller
    // that bypasses the type system (plain JS, an `any`-typed composition root) must still fail
    // closed immediately, rather than silently skipping the entire "import" phase's effects the
    // first time a "reading-sync" job reaches it.
    if (!deps.import) {
      throw new EngineError("JOB_SHAPE_INVALID", 'ScopeJobRunner requires an "import" seam (used by "reading-sync" jobs).', {});
    }
  }

  async step(persisted: PersistedJobV1, signal: AbortSignal): Promise<PhaseStepOutcome> {
    if ((persisted.job.kind !== "reading-sync" && persisted.job.kind !== "scope-refresh") || persisted.job.target.kind !== "scope") {
      throw new EngineError("JOB_SHAPE_INVALID", 'ScopeJobRunner only handles "reading-sync"/"scope-refresh" jobs with a scope target.', {});
    }
    const scopeId = persisted.job.target.scopeId;
    const priorReceipt = scopeReceiptOf(persisted);
    try {
      switch (persisted.job.phase) {
        case "discover":
          return await this.stepDiscover(scopeId, persisted.job.kind, signal);
        case "import":
          if (persisted.job.kind !== "reading-sync") {
            throw new EngineError("JOB_TRANSITION_INVALID", 'ScopeJobRunner: "import" phase is only reachable by "reading-sync" jobs.', {});
          }
          return await this.stepImport(scopeId, priorReceipt, signal);
        case "enqueue":
          return await this.stepEnqueue(scopeId, persisted.job.pipelineVersion, priorReceipt, signal);
        default:
          throw new EngineError("JOB_TRANSITION_INVALID", `ScopeJobRunner cannot execute phase "${persisted.job.phase}".`, {});
      }
    } catch (error) {
      if (isEngineError(error)) throw error;
      return { type: "retry", failureCode: toFailureCode(error) };
    }
  }

  private async discoverValidated(scopeId: string, signal: AbortSignal): Promise<ScopeDiscoveryItem[]> {
    const items: unknown = await this.deps.discovery.discover(scopeId, signal);
    // Array-shape (and every item's own shape) is checked FIRST, before the length cap below --
    // a malformed non-array result must never reach a bare `.length` access.
    assertValidDiscoveryItems(items);
    if (items.length > MAX_SCOPE_DISCOVERY_ITEMS) {
      // Deliberately no count/scopeId interpolated into the message (Checkpoint 7 acceptance
      // guard 7) -- only the fixed, non-sensitive bound is ever named.
      throw new EngineError("JOB_CAP_EXCEEDED", `Scope discovery returned more items than the enforced maximum (${MAX_SCOPE_DISCOVERY_ITEMS}).`, {});
    }
    return items;
  }

  private async stepDiscover(scopeId: string, kind: "reading-sync" | "scope-refresh", signal: AbortSignal): Promise<PhaseStepOutcome> {
    const items = await this.discoverValidated(scopeId, signal);
    const receipt: ScopeReceipt = { kind: "scope", discovered: true, discoveredCount: items.length, discoveryFingerprint: computeDiscoveryFingerprint(items) };
    return { type: "advance", nextPhase: kind === "reading-sync" ? "import" : "enqueue", receipt };
  }

  private async stepImport(scopeId: string, priorReceipt: ScopeReceipt | undefined, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const items = await this.discoverValidated(scopeId, signal);
    const fingerprint = computeDiscoveryFingerprint(items);
    // Re-discovery may legitimately see a DIFFERENT set than the one "discover" recorded (the
    // vault keeps changing) -- but this phase must never silently import that different set under
    // the discover receipt's stale discoveredCount. Any drift supersedes this job outright, via
    // the exact same durable successor mechanism rebuildJob.ts uses for a stale rebuild plan.
    if (priorReceipt?.discoveryFingerprint !== undefined && priorReceipt.discoveryFingerprint !== fingerprint) {
      return { type: "superseded", failureCode: "SCOPE_SUPERSEDED" };
    }
    await this.deps.import.import(scopeId, items, signal);
    const receipt: ScopeReceipt = { kind: "scope", discovered: true, discoveredCount: priorReceipt?.discoveredCount ?? items.length, discoveryFingerprint: fingerprint, imported: true };
    return { type: "advance", nextPhase: "enqueue", receipt };
  }

  private async stepEnqueue(scopeId: string, pipelineVersion: number, priorReceipt: ScopeReceipt | undefined, signal: AbortSignal): Promise<PhaseStepOutcome> {
    const items = await this.discoverValidated(scopeId, signal);
    const fingerprint = computeDiscoveryFingerprint(items);
    // Same drift check as stepImport -- prevents importing set B (or skipping import for
    // scope-refresh) then enqueueing a DIFFERENT set C under a receipt still describing set A.
    if (priorReceipt?.discoveryFingerprint !== undefined && priorReceipt.discoveryFingerprint !== fingerprint) {
      return { type: "superseded", failureCode: "SCOPE_SUPERSEDED" };
    }
    for (const item of items) {
      // Checked BETWEEN every item (final-closure requirement 8): a long enqueue run stops
      // promptly on dispose() rather than working through a large discovered set regardless.
      // A genuine cancellation, not a transient failure (Checkpoint 7 acceptance guard 7) --
      // dispose() is a deliberate shutdown signal, so this reports as "cancelled" rather than an
      // "UNKNOWN_TRANSIENT" retry/backoff, which would misleadingly suggest a bare retry could
      // succeed. Re-running enqueue from scratch after a restart is idempotent either way.
      if (signal.aborted) {
        return { type: "cancelled" };
      }
      await this.deps.enqueue.enqueueProcessNote(item, pipelineVersion, signal);
    }
    const receipt: ScopeReceipt = {
      kind: "scope",
      discovered: true,
      discoveredCount: priorReceipt?.discoveredCount ?? items.length,
      discoveryFingerprint: fingerprint,
      imported: priorReceipt?.imported,
      enqueuedCount: items.length,
    };
    return { type: "complete", receipt };
  }
}
