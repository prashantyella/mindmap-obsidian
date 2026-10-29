export type SchedulerMode = "manual" | "interval" | "launchAgent";
export type ReadingModeSetting = "standard" | "reading";
export type WebResearchModeSetting = "off" | "manual" | "automatic-reading";
export type ConceptCaseSetting = "lower" | "title" | "none";

export interface MindmapSettings {
  readingMode: ReadingModeSetting;
  webResearchMode: WebResearchModeSetting;
  schedulerMode: SchedulerMode;
  schedulerIntervalMinutes: number;
  launchAgentDailyHour: number;
  launchAgentDailyMinute: number;
  launchAgentWeeklyEnabled: boolean;
  launchAgentWeeklyHour: number;
  launchAgentWeeklyMinute: number;
  liveSemanticLookupEnabled: boolean;
  liveSemanticEnsureActiveNoteIndexed: boolean;
  /**
   * `true` (default) lets the active-note sidebar path queue a full
   * process-note job (embedding + local LLM summaries/tags + note write) as
   * soon as a note becomes eligible. `false` keeps real-time work to the
   * embedding only: the note is indexed for live connections immediately,
   * and the LLM metadata pass is left to scheduled or manual runs.
   */
  realtimeMetadataExtraction: boolean;
  pinnedConnections: Record<string, string[]>;

  /** Checkpoint 11: scope selection now lives entirely in plugin settings -- never a Python config.json. */
  scopeCurrentPaths: string[];
  scopeAllPaths: string[];
  minimumWords: number;

  /** Ollama embedding provider (TypeScript engine, Ollama-only). */
  embedBaseUrl: string;
  embedModel: string;
  /** `0` means "unset" -- ProductionEngine falls back to a known-model lookup table, then refuses migration until this is set explicitly for an unknown model. */
  embedDimension: number;

  /** Ollama local metadata (summary/tags/concepts) provider -- Ollama-only, mirrors the embedding provider's own contract. */
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;

  tagLimit: number;
  conceptLimit: number;
  conceptMaxWords: number;
  conceptCaseMode: ConceptCaseSetting;
  allowFreeTags: boolean;
  tagMinLen: number;
  tagMaxWords: number;
  chunkTargetTokens: number;
  chunkOverlapTokens: number;
  relatedLimit: number;
  relatedOverreach: number;
  relatedCreative: number;
  relatedCreativeMin: number;
  relatedCreativeMax: number;
  relatedCandidateLimit: number;
  relatedMinScore: number;

  /** Apple Books annotation/library database overrides -- blank means auto-discover. */
  appleAnnotationDbPath: string;
  appleLibraryDbPath: string;

  /**
   * `true` once the one-time legacy Python `config.json` migration has run
   * (successfully or as a confirmed no-op on a fresh install) -- never
   * re-attempted after this flips, and no Python config file is ever read
   * once it has.
   */
  legacyConfigMigrated: boolean;
}

/** Inclusive bounds for `relatedLimit`, the number of connections the sidebar and the Mindmap section show per note. */
export const MIN_RELATED_LIMIT = 1;
export const MAX_RELATED_LIMIT = 20;

export function normalizeRelatedLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.relatedLimit;
  return Math.min(MAX_RELATED_LIMIT, Math.max(MIN_RELATED_LIMIT, Math.round(value)));
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  readingMode: "standard",
  webResearchMode: "off",
  schedulerMode: "manual",
  schedulerIntervalMinutes: 60,
  launchAgentDailyHour: 2,
  launchAgentDailyMinute: 30,
  launchAgentWeeklyEnabled: true,
  launchAgentWeeklyHour: 3,
  launchAgentWeeklyMinute: 0,
  liveSemanticLookupEnabled: true,
  liveSemanticEnsureActiveNoteIndexed: true,
  realtimeMetadataExtraction: true,
  pinnedConnections: {},

  scopeCurrentPaths: [],
  scopeAllPaths: [],
  minimumWords: 30,

  embedBaseUrl: "http://localhost:11434",
  embedModel: "embeddinggemma-2:270m",
  embedDimension: 0,

  llmBaseUrl: "http://localhost:11434",
  llmModel: "llama3.1:8b",
  llmMaxTokens: 1024,

  tagLimit: 6,
  conceptLimit: 4,
  conceptMaxWords: 4,
  conceptCaseMode: "lower",
  allowFreeTags: true,
  tagMinLen: 2,
  tagMaxWords: 3,
  chunkTargetTokens: 300,
  chunkOverlapTokens: 40,
  relatedLimit: 8,
  relatedOverreach: 2,
  relatedCreative: 2,
  relatedCreativeMin: 0.45,
  relatedCreativeMax: 0.7,
  relatedCandidateLimit: 40,
  relatedMinScore: 0,

  appleAnnotationDbPath: "",
  appleLibraryDbPath: "",

  legacyConfigMigrated: false,
};
