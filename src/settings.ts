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
  pinnedConnections: {},

  scopeCurrentPaths: [],
  scopeAllPaths: [],
  minimumWords: 30,

  embedBaseUrl: "http://localhost:11434",
  embedModel: "mxbai-embed-large",
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
