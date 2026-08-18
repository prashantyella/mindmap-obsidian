import path from "node:path";

import type { ReadingStateFileSystem } from "./readingState";

export const AUTOMATIC_RESEARCH_POLICY_VERSION = 1 as const;
export const AUTOMATIC_RESEARCH_PER_SYNC_LIMIT = 5;
export const AUTOMATIC_RESEARCH_DAILY_LIMIT = 10;
export const AUTOMATIC_RESEARCH_MAX_ERROR_CHARS = 500;

export type AutomaticPauseReason = "daily-limit" | "provider-auth" | "provider-quota" | "provider-network" | "provider-timeout" | "credential" | "local-model" | "invalid-result" | null;

export interface AutomaticResearchPolicyState {
  version: typeof AUTOMATIC_RESEARCH_POLICY_VERSION;
  day: string;
  attempted: number;
  pauseReason: AutomaticPauseReason;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface AutomaticResearchPolicyStore {
  load(day: string): Promise<AutomaticResearchPolicyState>;
  save(state: AutomaticResearchPolicyState): Promise<void>;
}

export interface AutomaticResearchPolicyLoadResult {
  state: AutomaticResearchPolicyState;
  error: string | null;
}

export function localResearchDay(now: Date): string {
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function createAutomaticResearchPolicy(day: string): AutomaticResearchPolicyState {
  return { version: AUTOMATIC_RESEARCH_POLICY_VERSION, day, attempted: 0, pauseReason: null, lastError: null, lastErrorAt: null };
}

export function validateAutomaticResearchPolicy(value: unknown): AutomaticResearchPolicyState {
  if (!value || typeof value !== "object") throw new Error("Automatic research policy is invalid.");
  const state = value as Record<string, unknown>;
  const reasons = new Set([null, "daily-limit", "provider-auth", "provider-quota", "provider-network", "provider-timeout", "credential", "local-model", "invalid-result"]);
  if (
    state.version !== AUTOMATIC_RESEARCH_POLICY_VERSION
    || typeof state.day !== "string" || !isCalendarDay(state.day)
    || !Number.isInteger(state.attempted) || Number(state.attempted) < 0 || Number(state.attempted) > AUTOMATIC_RESEARCH_DAILY_LIMIT
    || (state.attempted === AUTOMATIC_RESEARCH_DAILY_LIMIT && state.pauseReason !== "daily-limit")
    || !reasons.has(state.pauseReason as AutomaticPauseReason)
    || (state.lastError !== null && (typeof state.lastError !== "string" || state.lastError.length > AUTOMATIC_RESEARCH_MAX_ERROR_CHARS))
    || (state.lastErrorAt !== null && (typeof state.lastErrorAt !== "string" || !isFullIsoDateTime(state.lastErrorAt)))
  ) throw new Error("Automatic research policy is invalid.");
  return state as unknown as AutomaticResearchPolicyState;
}

/** Keeps optional persisted policy failures from preventing the plugin from starting. */
export async function loadAutomaticResearchPolicySafely(store: AutomaticResearchPolicyStore, day: string): Promise<AutomaticResearchPolicyLoadResult> {
  try {
    return { state: await store.load(day), error: null };
  } catch {
    return { state: createAutomaticResearchPolicy(day), error: "Automatic research policy is unavailable." };
  }
}

export function canAttemptAutomaticResearch(state: AutomaticResearchPolicyState): boolean {
  return state.pauseReason !== "daily-limit" && state.pauseReason === null && state.attempted < AUTOMATIC_RESEARCH_DAILY_LIMIT;
}

export function recordAutomaticAttempt(state: AutomaticResearchPolicyState): AutomaticResearchPolicyState {
  const attempted = state.attempted + 1;
  return { ...state, attempted, ...(attempted >= AUTOMATIC_RESEARCH_DAILY_LIMIT ? { pauseReason: "daily-limit" as const } : {}) };
}

/** Retry may clear only a transient pause; it never bypasses the daily cap. */
export function clearTransientAutomaticPause(state: AutomaticResearchPolicyState): AutomaticResearchPolicyState {
  if (state.pauseReason === "daily-limit") return state;
  return { ...state, pauseReason: null, lastError: null, lastErrorAt: null };
}

export function createAutomaticResearchPolicyStore(filePath: string, fs: ReadingStateFileSystem): AutomaticResearchPolicyStore {
  const temporaryPath = `${filePath}.tmp`;
  return {
    async load(day) {
      try {
        const current = validateAutomaticResearchPolicy(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
        return current.day === day ? current : createAutomaticResearchPolicy(day);
      } catch (error) {
        if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") return createAutomaticResearchPolicy(day);
        throw error;
      }
    },
    async save(state) {
      const normalized = normalizePolicyForSave(state);
      const serialized = `${JSON.stringify(validateAutomaticResearchPolicy(normalized), null, 2)}\n`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      let renamed = false;
      try {
        await fs.writeFile(temporaryPath, serialized, "utf8");
        await fs.rename(temporaryPath, filePath);
        renamed = true;
      } finally {
        if (!renamed && fs.unlink) {
          try { await fs.unlink(temporaryPath); } catch { /* Preserve original failure. */ }
        }
      }
    },
  };
}

function normalizePolicyForSave(state: AutomaticResearchPolicyState): AutomaticResearchPolicyState {
  return {
    ...state,
    pauseReason: state.attempted >= AUTOMATIC_RESEARCH_DAILY_LIMIT ? "daily-limit" : state.pauseReason,
    lastError: state.lastError?.slice(0, AUTOMATIC_RESEARCH_MAX_ERROR_CHARS) ?? null,
  };
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isFullIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
}
