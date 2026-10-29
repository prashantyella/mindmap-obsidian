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

export const ENGINE_KEYS = [
  "scopeCurrentPaths", "scopeAllPaths", "minimumWords",
  "embedBaseUrl", "embedModel", "embedDimension",
  "llmBaseUrl", "llmModel", "llmMaxTokens",
  "tagLimit", "conceptLimit", "conceptMaxWords", "conceptCaseMode",
  "allowFreeTags", "tagMinLen", "tagMaxWords",
  "chunkTargetTokens", "chunkOverlapTokens",
  "relatedLimit", "relatedOverreach", "relatedCreative",
  "relatedCreativeMin", "relatedCreativeMax", "relatedCandidateLimit", "relatedMinScore",
  "realtimeMetadataExtraction",
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

export function sameEngineSettings(left: MindmapSettings, right: MindmapSettings): boolean {
  return !changed(left, right, ENGINE_KEYS);
}

export function withEngineSettings(settings: MindmapSettings, engineSource: MindmapSettings): MindmapSettings {
  const merged = cloneSettings(settings);
  for (const key of ENGINE_KEYS) {
    (merged as unknown as Record<keyof MindmapSettings, unknown>)[key] = cloneSettingValue(engineSource[key]);
  }
  return merged;
}

export function restoreEngineSettingsInPlace(target: MindmapSettings, attempted: MindmapSettings, restored: MindmapSettings): void {
  for (const key of ENGINE_KEYS) {
    if (equalValue(target[key], attempted[key])) {
      (target as unknown as Record<keyof MindmapSettings, unknown>)[key] = cloneSettingValue(restored[key]);
    }
  }
}

function cloneSettingValue<T>(value: T): T {
  return Array.isArray(value) ? [...value] as T : value;
}

export interface SettingsEffectHandlers {
  persist(settings: MindmapSettings): Promise<void>;
  adoptPersisted?(persisted: MindmapSettings, requested: MindmapSettings): void;
  reconfigureEngine(settings: MindmapSettings): Promise<void>;
  syncScheduler(settings: MindmapSettings): Promise<void>;
  refreshPending(): void;
  recoverActivation(previous: MindmapSettings, attempted: MindmapSettings): Promise<MindmapSettings>;
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
  private failedEngineAttempt: MindmapSettings | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(initial: MindmapSettings) {
    this.applied = cloneSettings(initial);
  }

  enqueue(settings: MindmapSettings, handlers: SettingsEffectHandlers, options: { explicitEngineActivation?: boolean; forceEngineActivation?: boolean | (() => boolean) } = {}): Promise<void> {
    const requested = cloneSettings(settings);
    const operation = this.tail.catch(() => undefined).then(async () => {
      const next = !options.explicitEngineActivation && this.failedEngineAttempt && sameEngineSettings(requested, this.failedEngineAttempt)
        ? withEngineSettings(requested, this.applied)
        : requested;
      const effects = classifySettingsChanges(this.applied, next);
      const forceEngineActivation = typeof options.forceEngineActivation === "function"
        ? options.forceEngineActivation()
        : options.forceEngineActivation === true;
      const shouldReconfigureEngine = effects.reconfigureEngine || forceEngineActivation;
      try { await handlers.persist(next); } catch (error) { throw new SettingsApplyError("persistence", error); }
      handlers.adoptPersisted?.(next, requested);
      try {
        if (shouldReconfigureEngine) await handlers.reconfigureEngine(next);
        else if (effects.syncScheduler) await handlers.syncScheduler(next);
      } catch (error) {
        const attempted = cloneSettings(next);
        this.failedEngineAttempt = attempted;
        let restored: MindmapSettings;
        try {
          restored = await handlers.recoverActivation(this.applied, attempted);
        } catch (recoveryError) {
          throw new SettingsApplyError("persistence", recoveryError);
        }
        this.applied = cloneSettings(restored);
        throw new SettingsApplyError("activation", error);
      }
      if (effects.refreshPending) handlers.refreshPending();
      this.applied = cloneSettings(next);
      if (shouldReconfigureEngine) this.failedEngineAttempt = null;
    });
    this.tail = operation;
    return operation;
  }

  getAppliedSnapshot(): MindmapSettings {
    return cloneSettings(this.applied);
  }
}
