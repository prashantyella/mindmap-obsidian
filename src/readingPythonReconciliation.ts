import { computeBodyHash } from "./pendingScan";
import type { ReadingStateStore } from "./readingState";

/**
 * Reconciles Reading `processedAt` from the Python worker's state.json after
 * a successful scheduled run, without ever writing to the vault or to Python
 * state: it compares Python's SHA-1 body signature for a note's path against
 * the current note body and, on a match, records that Python has already
 * processed this exact body through ReadingStateStore.mutate.
 */
export interface ReadingReconciliationDeps {
  readPythonStateText(): Promise<string>;
  readNoteText(notePath: string): Promise<string | null>;
  now(): string;
  /** Mindmap heading Python strips before hashing a note body; defaults to "## Mindmap". */
  heading?: string;
}

export interface ReadingReconciliationResult {
  ok: boolean;
  reason: string;
  checked: number;
  updated: number;
}

/**
 * Strictly validates Python's state.json shape rather than tolerating a
 * malformed file: a missing/non-object `files` map, or any entry whose
 * `hash` is not a well-formed SHA-1 hex digest (Python's `file_signature()`
 * output), makes the whole state untrustworthy for reconciliation (returns
 * null) rather than silently reconciling against a partial read.
 */
const SHA1_HEX_PATTERN = /^[0-9a-f]{40}$/i;

export function parsePythonStateHashes(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const files = (raw as Record<string, unknown>).files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return null;
  }
  const hashes: Record<string, string> = {};
  for (const [relpath, value] of Object.entries(files as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const hash = (value as Record<string, unknown>).hash;
    if (typeof hash !== "string" || !SHA1_HEX_PATTERN.test(hash)) {
      return null;
    }
    hashes[relpath.replace(/\\/g, "/")] = hash;
  }
  return hashes;
}

export async function reconcileReadingProcessedFromPythonState(
  stateStore: ReadingStateStore,
  deps: ReadingReconciliationDeps,
): Promise<ReadingReconciliationResult> {
  let pythonHashes: Record<string, string>;
  try {
    const raw = await deps.readPythonStateText();
    const parsed = JSON.parse(raw) as unknown;
    const hashes = parsePythonStateHashes(parsed);
    if (hashes === null) {
      return {
        ok: false,
        reason: "Python state.json is malformed (missing/non-object files, or a malformed hash entry); reading reconciliation was skipped.",
        checked: 0,
        updated: 0,
      };
    }
    pythonHashes = hashes;
  } catch (error) {
    return {
      ok: false,
      reason: `Python state.json is missing or malformed; reading reconciliation was skipped: ${error instanceof Error ? error.message : String(error)}`,
      checked: 0,
      updated: 0,
    };
  }

  const heading = deps.heading ?? "## Mindmap";

  // Vault reads happen outside any mutate() call: hundreds of them must not
  // hold the ReadingStateStore mutation queue open and starve other writers
  // (e.g. live annotation processing) for the duration of this pass.
  const snapshot = await stateStore.load();
  const candidates: Array<{ id: string; notePath: string }> = [];
  let checked = 0;
  for (const [id, entry] of Object.entries(snapshot.annotations)) {
    if (entry.processedAt !== null) {
      continue;
    }
    checked += 1;
    candidates.push({ id, notePath: entry.notePath });
  }

  const matchedNotePathById = new Map<string, string>();
  for (const candidate of candidates) {
    const text = await deps.readNoteText(candidate.notePath);
    if (text === null) {
      continue;
    }
    const { hash } = computeBodyHash(text, heading);
    if (hash && pythonHashes[candidate.notePath] === hash) {
      matchedNotePathById.set(candidate.id, candidate.notePath);
    }
  }

  let updated = 0;
  if (matchedNotePathById.size > 0) {
    const now = deps.now();
    await stateStore.mutate((state) => {
      for (const [id, notePath] of matchedNotePathById) {
        const entry = state.annotations[id];
        // Revalidate against the freshly-loaded state before marking: the
        // entry may have been reprocessed, renamed, or removed during the
        // (potentially slow) vault-read pass above.
        if (entry && entry.processedAt === null && entry.notePath === notePath) {
          entry.processedAt = now;
          updated += 1;
        }
      }
    });
  }

  return {
    ok: true,
    reason: `Reconciled Reading processedAt from Python state.json (${updated}/${checked} pending entries matched).`,
    checked,
    updated,
  };
}

export interface LaunchAgentDetailLike {
  label: string;
  lastSuccessfulRunAt: number | null;
}

export interface DailyReconciliationWatermark {
  lastReconciledDailySuccessAt: number | null;
  lastReconciliationFailureAt: number | null;
}

export interface DailyReconciliationDecision {
  trigger: boolean;
  dailySuccessAt: number | null;
}

/**
 * Pure trigger-selection logic for daily-only reconciliation: reads only the
 * daily-labeled LaunchAgent detail (never an aggregate/weekly success time),
 * skips a run already reconciled, and suppresses immediate retry-spamming
 * after a failure until `cooldownMs` has elapsed.
 */
export function shouldTriggerDailyReconciliation(
  details: LaunchAgentDetailLike[],
  dailyLabel: string,
  watermark: DailyReconciliationWatermark,
  nowMs: number,
  cooldownMs: number,
): DailyReconciliationDecision {
  const daily = details.find((detail) => detail.label === dailyLabel);
  const dailySuccessAt = daily?.lastSuccessfulRunAt ?? null;
  if (dailySuccessAt === null || dailySuccessAt === watermark.lastReconciledDailySuccessAt) {
    return { trigger: false, dailySuccessAt };
  }
  if (watermark.lastReconciliationFailureAt !== null && nowMs - watermark.lastReconciliationFailureAt < cooldownMs) {
    return { trigger: false, dailySuccessAt };
  }
  return { trigger: true, dailySuccessAt };
}
