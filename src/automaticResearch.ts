import { AUTOMATIC_RESEARCH_MAX_ERROR_CHARS, AUTOMATIC_RESEARCH_PER_SYNC_LIMIT, canAttemptAutomaticResearch, localResearchDay, recordAutomaticAttempt, type AutomaticPauseReason, type AutomaticResearchPolicyStore } from "./automaticResearchPolicy";
import type { ReadingStateEntry } from "./readingTypes";
import { WebResearchError } from "./webResearchTypes";

export class TerminalAutomaticResearchError extends Error {
  constructor(message: string) { super(message); this.name = "TerminalAutomaticResearchError"; }
}

export type AutomaticResearchOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function isTerminalAutomaticResearchCode(code: string): boolean {
  return code === "NO_USABLE_SOURCES" || code === "RESEARCH_INPUT_EMPTY";
}

export async function persistAutomaticResearchOutcome(options: {
  outcome: AutomaticResearchOutcome;
  updateStatus(status: "complete" | "retryable" | "unresearchable"): Promise<"updated" | "state-pending" | false>;
}): Promise<true> {
  if (options.outcome.ok) {
    return await commitAutomaticResearchAttempt({ runResearch: async () => true, updateStatus: options.updateStatus });
  }
  const status = isTerminalAutomaticResearchCode(options.outcome.code) ? "unresearchable" : "retryable";
  if ((await options.updateStatus(status)) === false) {
    throw new WebResearchError("RESEARCH_STATUS_NOT_APPLIED", "Automatic research status could not be applied.");
  }
  if (status === "unresearchable") throw new TerminalAutomaticResearchError(options.outcome.message);
  throw new WebResearchError(options.outcome.code, options.outcome.message);
}

export interface AutomaticResearchCandidate {
  annotationId: string;
  notePath: string;
  eligible: boolean;
  action: "created" | "updated" | "unchanged";
}

/** Stable backlog selection: complete and too-short entries never reach Exa. */
export function selectAutomaticResearchCandidates(entries: Record<string, ReadingStateEntry>): AutomaticResearchCandidate[] {
  return Object.entries(entries)
    .filter(([, entry]) => entry.researchStatus === "off" || entry.researchStatus === "retryable")
    .map(([annotationId, entry]) => ({ annotationId, notePath: entry.notePath, eligible: true, action: "unchanged" as const }))
    .sort((left, right) => left.annotationId.localeCompare(right.annotationId));
}

export function selectSyncResearchCandidates(
  imported: ReadonlyArray<{ annotationId: string; notePath: string; action: "created" | "updated" | "unchanged"; eligible: boolean }>,
  entries: Record<string, ReadingStateEntry>,
): AutomaticResearchCandidate[] {
  return imported
    .filter((item) => item.eligible && item.action !== "unchanged")
    .filter((item) => {
      const entry = entries[item.annotationId];
      return entry && (entry.researchStatus === "off" || entry.researchStatus === "retryable");
    })
    .map((item) => ({ annotationId: item.annotationId, notePath: item.notePath, eligible: true, action: item.action }))
    .sort((left, right) => left.annotationId.localeCompare(right.annotationId));
}

/**
 * Keeps automatic provider work and its single durable lifecycle transition
 * together. This module has no UI dependency, so automatic callers remain
 * silent by construction.
 */
export async function commitAutomaticResearchAttempt(options: {
  runResearch(): Promise<boolean>;
  updateStatus(status: "complete" | "retryable"): Promise<"updated" | "state-pending" | false>;
}): Promise<true> {
  if (!(await options.runResearch())) {
    const retryable = await options.updateStatus("retryable");
    if (retryable === false) {
      throw new WebResearchError("RESEARCH_STATUS_NOT_APPLIED", "Automatic research status could not be applied.");
    }
    throw new WebResearchError("INVALID_AUTOMATIC_RESULT", "Automatic research failed.");
  }
  const status = await options.updateStatus("complete");
  if (status === false) {
    throw new WebResearchError("RESEARCH_STATUS_NOT_APPLIED", "Automatic research status could not be applied.");
  }
  if (status === "state-pending") {
    throw new WebResearchError("RESEARCH_STATUS_PENDING", "Research saved; annotation status will repair on next sync.");
  }
  return true;
}

export function pauseReasonFor(error: unknown): AutomaticPauseReason {
  const code = error instanceof WebResearchError ? error.code : "";
  if (code === "CREDENTIAL_UNAVAILABLE") return "credential";
  if (code.startsWith("LOCAL_MODEL")) return "local-model";
  if (code === "EXA_HTTP_401" || code === "EXA_HTTP_403") return "provider-auth";
  if (code === "EXA_HTTP_429") return "provider-quota";
  if (code === "EXA_TIMEOUT") return "provider-timeout";
  if (code === "EXA_NETWORK") return "provider-network";
  return "invalid-result";
}

export async function runAutomaticResearch<T>(options: {
  store: AutomaticResearchPolicyStore;
  now: Date;
  candidates: T[];
  attempt(candidate: T): Promise<boolean>;
  shouldContinue?(): boolean;
}): Promise<{ attempted: number; pauseReason: AutomaticPauseReason; lastError: string | null }> {
  let policy = await options.store.load(localResearchDay(options.now));
  let attempted = 0;
  for (const candidate of options.candidates.slice(0, AUTOMATIC_RESEARCH_PER_SYNC_LIMIT)) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    if (!canAttemptAutomaticResearch(policy)) break;
    policy = recordAutomaticAttempt(policy);
    await options.store.save(policy);
    attempted += 1;
    try {
      await options.attempt(candidate);
    } catch (error) {
      if (error instanceof TerminalAutomaticResearchError) continue;
      const pauseReason = policy.pauseReason === "daily-limit" ? "daily-limit" : pauseReasonFor(error);
      const message = error instanceof Error ? error.message : "Automatic research failed.";
      policy = { ...policy, pauseReason, lastError: message.slice(0, AUTOMATIC_RESEARCH_MAX_ERROR_CHARS), lastErrorAt: options.now.toISOString() };
      await options.store.save(policy);
      break;
    }
  }
  return { attempted, pauseReason: policy.pauseReason, lastError: policy.lastError };
}
