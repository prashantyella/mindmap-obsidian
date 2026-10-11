import type { MindmapSettings } from "./settings";

export interface SettingsEffects {
  persistOnly: boolean;
  refreshPending: boolean;
  syncScheduler: boolean;
  reconfigureEngine: boolean;
}

const SCHEDULER_KEYS = [
  "readingMode",
  "schedulerMode",
  "schedulerIntervalMinutes",
  "launchAgentDailyHour",
  "launchAgentDailyMinute",
  "launchAgentWeeklyEnabled",
  "launchAgentWeeklyHour",
  "launchAgentWeeklyMinute",
] as const satisfies readonly (keyof MindmapSettings)[];

const ENGINE_KEYS = [
  "scopeCurrentPaths", "scopeAllPaths", "minimumWords",
  "embedBaseUrl", "embedModel", "embedDimension",
  "llmBaseUrl", "llmModel", "llmMaxTokens",
  "tagLimit", "conceptLimit", "conceptMaxWords", "conceptCaseMode",
  "allowFreeTags", "tagMinLen", "tagMaxWords",
  "chunkTargetTokens", "chunkOverlapTokens",
  "relatedLimit", "relatedOverreach", "relatedCreative",
  "relatedCreativeMin", "relatedCreativeMax", "relatedCandidateLimit", "relatedMinScore",
  "appleAnnotationDbPath", "appleLibraryDbPath",
] as const satisfies readonly (keyof MindmapSettings)[];

const REFRESH_KEYS = [
  "scopeCurrentPaths", "scopeAllPaths", "minimumWords",
  "embedBaseUrl", "embedModel", "embedDimension",
  "llmBaseUrl", "llmModel", "llmMaxTokens",
  "tagLimit", "conceptLimit", "conceptMaxWords", "conceptCaseMode",
  "allowFreeTags", "tagMinLen", "tagMaxWords",
  "chunkTargetTokens", "chunkOverlapTokens",
  "relatedLimit", "relatedOverreach", "relatedCreative",
  "relatedCreativeMin", "relatedCreativeMax", "relatedCandidateLimit", "relatedMinScore",
] as const satisfies readonly (keyof MindmapSettings)[];

function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

function changed(previous: MindmapSettings, next: MindmapSettings, keys: readonly (keyof MindmapSettings)[]): boolean {
  return keys.some((key) => !equalValue(previous[key], next[key]));
}

/** Classifies a persisted settings transition into the minimum runtime work it needs. */
export function classifySettingsChanges(previous: MindmapSettings, next: MindmapSettings): SettingsEffects {
  const syncScheduler = changed(previous, next, SCHEDULER_KEYS);
  const reconfigureEngine = changed(previous, next, ENGINE_KEYS);
  const refreshPending = changed(previous, next, REFRESH_KEYS);
  return {
    persistOnly: !syncScheduler && !reconfigureEngine && !refreshPending,
    refreshPending,
    syncScheduler,
    reconfigureEngine,
  };
}

export function cloneSettings(settings: MindmapSettings): MindmapSettings {
  return {
    ...settings,
    scopeCurrentPaths: [...settings.scopeCurrentPaths],
    scopeAllPaths: [...settings.scopeAllPaths],
    pinnedConnections: Object.fromEntries(
      Object.entries(settings.pinnedConnections).map(([path, targets]) => [path, [...targets]]),
    ),
  };
}

export interface SettingsEffectHandlers {
  persist(settings: MindmapSettings): Promise<void>;
  reconfigureEngine(settings: MindmapSettings): Promise<void>;
  syncScheduler(settings: MindmapSettings): Promise<void>;
  refreshPending(): void;
}

export class SettingsApplyError extends Error {
  readonly cause: unknown;
  constructor(readonly phase: "persistence" | "activation", cause: unknown) {
    super(cause instanceof Error ? cause.message : phase === "persistence" ? "Settings could not be saved." : "Saved settings could not be activated.");
    this.name = "SettingsApplyError";
    this.cause = cause;
  }
}

export class SettingsEffectQueue {
  private applied: MindmapSettings;
  private tail: Promise<void> = Promise.resolve();

  constructor(initial: MindmapSettings) {
    this.applied = cloneSettings(initial);
  }

  enqueue(settings: MindmapSettings, handlers: SettingsEffectHandlers): Promise<void> {
    const next = cloneSettings(settings);
    const operation = this.tail.catch(() => undefined).then(async () => {
      const effects = classifySettingsChanges(this.applied, next);
      try { await handlers.persist(next); } catch (error) { throw new SettingsApplyError("persistence", error); }
      try {
        if (effects.reconfigureEngine) await handlers.reconfigureEngine(next);
        else if (effects.syncScheduler) await handlers.syncScheduler(next);
      } catch (error) {
        throw new SettingsApplyError("activation", error);
      }
      if (effects.refreshPending) handlers.refreshPending();
      this.applied = cloneSettings(next);
    });
    this.tail = operation;
    return operation;
  }
}
