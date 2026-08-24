import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { FileSystemAdapter, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";

import { buildSpawnFailureResult, formatPreflightNotice, parsePreflightOutput, type PreflightResult } from "./diagnostics";
import { listVaultFolderOptions, readScopeSelection, type ScopeSelection, type VaultFolderOption } from "./onboarding";
import { createProductionPendingScanService, ProductionPendingScanService } from "./engine/productionPendingScan";
import { formatCommandPreview, getPluginRuntimeDir, resolveRuntime, type ResolvedRuntime, type RuntimeContext } from "./pathResolver";
import { createNodeDiscoveryFs, createNodeProcessInvoker, getDefaultAppSupportRoot } from "./runtimeDiscovery";
import { createNodeSetupFs, createNodeSetupSpawner } from "./runtimeSetup";
import { PYTHON_MACOS_DOWNLOAD_URL, RUNTIME_SETUP_CONFIRMATION_COPY, RuntimeReadinessCoordinator, shouldTriggerRuntimeReadyKickoff, type CoordinatorState } from "./runtimeSetupCoordinator";
import { buildRuntimePreflightVerifier } from "./runtimeVerifier";
import type { PendingSnapshot } from "./pendingScan";
import { discoverAppleBooksDatabasePaths } from "./appleBooksDiscovery";
import { classifyResearchTarget, completeAppleAnnotationResearchForNote, importAppleBooksAnnotations, updateAppleAnnotationResearchStatus, writeAppleAnnotationCompanion } from "./appleBooksImport";
import { clearTransientAutomaticPause, createAutomaticResearchPolicy, createAutomaticResearchPolicyStore, loadAutomaticResearchPolicySafely, localResearchDay, type AutomaticResearchPolicyState, type AutomaticResearchPolicyStore } from "./automaticResearchPolicy";
import { persistAutomaticResearchOutcome, runAutomaticResearch, selectSyncResearchCandidates } from "./automaticResearch";
import { ExaResearchProvider } from "./exaResearchProvider";
import { requestUrlFetch } from "./obsidianRequestUrlFetch";
import { getExaCredential, hasExaCredential } from "./keychainCredential";
import { createConfiguredLocalResearchModel } from "./localResearchModel";
import { resolveLocalModelApiKey } from "./localModelApiKey";
import { isSafeManualResearchPath } from "./manualResearchGuard";
import { collectResearch, researchNote } from "./webResearch";
import { startAppleBooksReaderProcess } from "./appleBooksReaderProcess";
import { prepareActiveNoteResearchInput } from "./researchInput";
import { renderCompanionResearchContent } from "./researchWriter";
import { MAX_RESEARCH_INPUT_CHARS, WebResearchError } from "./webResearchTypes";
import { createReadingStateStore, type ReadingStateStore } from "./readingState";
import { createObsidianVaultApi } from "./readingVault";
import { ReadingModeController, type ReadingHealth, type ReadingMode, type ReadingPreview } from "./readingMode";
import { registerMindmapCommands } from "./pluginCommands";
import { createDevShadowIntegration, type DevShadowIntegration } from "virtual:mindmap-dev-shadow";
import {
  coerceConfigString,
  getLlmProviderConfigStatus as resolveLlmProviderConfigStatus,
  getScopeSetupStatus as resolveScopeSetupStatus,
  saveLlmProviderConfig as writeLlmProviderConfig,
  saveScopeSetup as writeScopeSetup,
  type LlmProviderConfig,
  type LlmProviderConfigStatus,
  type ScopeSetupStatus,
} from "./pluginConfig";
import type { DiagnosticsSummaryState, SchedulerSummaryState } from "./pluginSummaries";
import { buildOverviewState, type OverviewState } from "./settingsOverview";
import { buildDiagnosticsOneLine, buildDiagnosticsReport } from "./diagnosticsReport";
import { assertAllowedPluginArgs } from "./runArguments";
import { getRunProfile, type RunProfile, type RunScope } from "./runProfiles";
import { NO_ACTIVE_NOTE, type ActiveNoteEligibility } from "./individualNote";
import { resolveActiveNoteEligibility } from "./individualNoteActions";
import { confirmMindmapRun } from "./runConfirmModal";
import { migrateLegacyPluginVaultRoot } from "./runtimeConfigMigration";
import { ensureBundledRuntimeAssets, type BundledRuntimeAssets } from "./runtimeAssets";
import { MindmapSemanticEnvironment, type SemanticEnvironmentStatus } from "./semanticEnvironment";
import type { LiveRelatedResponse, LiveRelatedResult, LookupRelatedResponse } from "./semanticTypes";
import { buildMindmapLocalGraphState, isMindmapLocalGraphLeaf } from "./localGraph";
import {
  normalizeHour,
  normalizeMinute,
  type LaunchAgentHealth,
} from "./launchAgent";
import { buildLaunchAgentCatchUpStatus } from "./launchAgentHealth";
import {
  computeNextRunAt,
  formatTimestamp,
  getSchedulerAction,
  isLaunchAgentSchedulerEnabled,
  isSchedulerEnabled,
  normalizeSchedulerInterval,
  type SchedulerConfig,
} from "./scheduler";
import { DEFAULT_SETTINGS, type MindmapSettings, type SchedulerMode } from "./settings";
import { MindmapSettingTab } from "./settingsTab";
import { MindmapWorkspaceView, MINDMAP_VIEW_TYPE } from "./workspaceView";
import { BUNDLED_RUNTIME_ASSETS as UNTYPED_BUNDLED_RUNTIME_ASSETS } from "virtual:runtime-assets";

// The "virtual:runtime-assets" specifier only resolves at bundle time (see
// esbuild.config.mjs); its ambient declaration in runtime-assets.d.ts types
// it correctly for plain tsc, but typescript-eslint's typed-linting program
// cannot resolve a no-substitution ambient module the same way and reports
// its export as an error type. Re-asserting through the declared type here
// (not a rule suppression) restores the real, already-verified shape.
const BUNDLED_RUNTIME_ASSETS = UNTYPED_BUNDLED_RUNTIME_ASSETS as unknown as BundledRuntimeAssets;
import {
  configureStatusBarElement,
  renderStatusBarElement,
} from "./statusBarMenu";
import { buildMindmapStatusBarState, openMindmapStatusMenu, type StatusBarInternalState } from "./statusBarIntegration";
import { buildStatusSummary } from "./statusBarState";
import type { LaunchAgentDetail } from "./launchAgentHealth";
import { registerVaultRefreshEvents } from "./vaultRefreshEvents";
import { ProductionEngine, type ProductionEngineOptions, type ProductionRelatedResult, PRODUCTION_SCOPE_CURRENT, PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_READING } from "./engine/productionEngine";
import { createNodeBackgroundSchedulerFs, createNodeBackgroundSchedulerProcessRunner } from "./scheduling/backgroundSchedulerNodeAdapters";
import { toSystemLocalWakeCadence, type WakeCadence } from "./scheduling/backgroundScheduler";
import { parseScheduleDefinitionV1 } from "./scheduling/scheduleTypes";
import { NodeOwnedFs } from "./engine/nodeFs";
import { OllamaEmbeddingProvider, createWindowSleep } from "./engine/ollamaEmbeddingProvider";
import { createOllamaMetadataProvider } from "./engine/localMetadataProvider";
import {
  createAppleBooksReadinessProbe,
  createLocalMetadataReadinessProbe,
  createOllamaEmbeddingReadinessProbe,
  createResearchCredentialReadinessProbe,
} from "./engine/preflightProbes";
import type { MigrationStatusV1 } from "./migration/migrationContract";
import type { PreflightReportV1 } from "./engine/preflight";
import { AppleBooksSqliteReader, createNodeAppleBooksFsAdapter } from "./reading/appleBooksSqlite";
import { createNodeSqliteProcess } from "./reading/sqliteProcess";
import type { ConceptCaseMode } from "./engine/metadataPipeline";

const LOG_LIMIT = 50;

/** Checkpoint 10B: the current TypeScript engine pipeline (chunking/embedding/metadata) version this vault's engine is composed under -- bumped only if this cutover's own pipeline shape changes, never tied to the retired Python pipeline's own versioning. */
const PRODUCTION_PIPELINE_VERSION = 1;
/** Same bound `devShadowIntegration.ts` uses for `config.json` -- well above any real config file's size but far below anything that would make an unbounded read a concern. */
const PRODUCTION_CONFIG_MAX_BYTES = 1 * 1024 * 1024;
const PRODUCTION_DEFAULT_MINIMUM_WORDS = 30;
const PRODUCTION_DEFAULT_LLM_MAX_TOKENS = 1024;
const PRODUCTION_DEFAULT_TAG_LIMIT = 6;
const PRODUCTION_DEFAULT_CONCEPT_LIMIT = 4;
const PRODUCTION_DEFAULT_CONCEPT_MAX_WORDS = 4;
const PRODUCTION_DEFAULT_TAG_MIN_LEN = 2;
const PRODUCTION_DEFAULT_TAG_MAX_WORDS = 3;
const PRODUCTION_DEFAULT_CHUNK_TARGET_TOKENS = 300;
const PRODUCTION_DEFAULT_CHUNK_OVERLAP_TOKENS = 40;
/** Mirrors `python/mindmap.py`'s own `related_*` config defaults (see `build_runtime_context`) -- see `ProductionEngineOptions.relatedSelectionConfig`. */
const PRODUCTION_DEFAULT_RELATED_LIMIT = 8;
const PRODUCTION_DEFAULT_RELATED_OVERREACH = 2;
const PRODUCTION_DEFAULT_RELATED_CREATIVE = 2;
const PRODUCTION_DEFAULT_RELATED_CREATIVE_MIN = 0.45;
const PRODUCTION_DEFAULT_RELATED_CREATIVE_MAX = 0.7;
const PRODUCTION_DEFAULT_RELATED_CANDIDATE_LIMIT = 40;
const PRODUCTION_DEFAULT_RELATED_MIN_SCORE = 0;

/**
 * Best-effort, explicitly-documented fallback for a handful of common
 * Ollama embedding models -- `MigrationRunner` requires an explicit,
 * bounded positive integer `dimension` before it will ever start a run
 * (see its own `beginFreshRun` guard), and this vault's `config.json` has
 * no such field today. A vault running an unlisted custom embedding model
 * can still override it explicitly via an `embed_dimension` integer field
 * in `config.json` (`toProductionRuntimeConfig` reads it); absent both,
 * `embeddingDimension` stays `undefined` and migration surfaces a closed
 * `MIGRATION_NOT_STARTABLE` guidance message rather than guessing.
 */
const KNOWN_OLLAMA_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  "mxbai-embed-large": 1024,
  "nomic-embed-text": 768,
  "all-minilm": 384,
  "bge-m3": 1024,
  "bge-large": 1024,
  "snowflake-arctic-embed": 1024,
};

function resolveKnownEmbeddingDimension(model: string, explicitOverride: number | undefined): number | undefined {
  if (explicitOverride !== undefined) return explicitOverride;
  return KNOWN_OLLAMA_EMBEDDING_DIMENSIONS[model];
}

interface ProductionRuntimeConfig {
  minimumWords: number;
  embedProvider?: string;
  embedBaseUrl?: string;
  embedModel?: string;
  embedDimension?: number;
  /** Ollama-only contract (item 7): the local-metadata provider production ever wires is `"ollama"`, never `"openai_compatible"`. */
  llmProvider?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  llmMaxTokens: number;
  tagLimit: number;
  conceptLimit: number;
  conceptMaxWords: number;
  conceptCaseMode: ConceptCaseMode;
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
  appleAnnotationDbPath?: string;
  appleLibraryDbPath?: string;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(coerceConfigString(value, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(coerceConfigString(value, String(fallback)), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Derives the narrow production runtime config this composition needs from a freshly-read raw `config.json` object -- mirrors `devShadowIntegration.ts`'s identical `toDevRuntimeConfig`, extended with the metadata-pipeline/chunk fields production actually wires (dev shadow never writes notes, so it never needed them). */
function toProductionRuntimeConfig(raw: Record<string, unknown> | null): ProductionRuntimeConfig {
  if (!raw) {
    return {
      minimumWords: PRODUCTION_DEFAULT_MINIMUM_WORDS,
      llmMaxTokens: PRODUCTION_DEFAULT_LLM_MAX_TOKENS,
      tagLimit: PRODUCTION_DEFAULT_TAG_LIMIT,
      conceptLimit: PRODUCTION_DEFAULT_CONCEPT_LIMIT,
      conceptMaxWords: PRODUCTION_DEFAULT_CONCEPT_MAX_WORDS,
      conceptCaseMode: "lower",
      allowFreeTags: true,
      tagMinLen: PRODUCTION_DEFAULT_TAG_MIN_LEN,
      tagMaxWords: PRODUCTION_DEFAULT_TAG_MAX_WORDS,
      chunkTargetTokens: PRODUCTION_DEFAULT_CHUNK_TARGET_TOKENS,
      chunkOverlapTokens: PRODUCTION_DEFAULT_CHUNK_OVERLAP_TOKENS,
      relatedLimit: PRODUCTION_DEFAULT_RELATED_LIMIT,
      relatedOverreach: PRODUCTION_DEFAULT_RELATED_OVERREACH,
      relatedCreative: PRODUCTION_DEFAULT_RELATED_CREATIVE,
      relatedCreativeMin: PRODUCTION_DEFAULT_RELATED_CREATIVE_MIN,
      relatedCreativeMax: PRODUCTION_DEFAULT_RELATED_CREATIVE_MAX,
      relatedCandidateLimit: PRODUCTION_DEFAULT_RELATED_CANDIDATE_LIMIT,
      relatedMinScore: PRODUCTION_DEFAULT_RELATED_MIN_SCORE,
    };
  }
  const minimumWordsCandidate = Number(raw.min_note_words ?? PRODUCTION_DEFAULT_MINIMUM_WORDS);
  const conceptCase = raw.concept_case === "title" || raw.concept_case === "none" ? raw.concept_case : "lower";
  const appleBooks = typeof raw.apple_books === "object" && raw.apple_books !== null && !Array.isArray(raw.apple_books) ? (raw.apple_books as Record<string, unknown>) : {};
  const annotationDbPath = coerceConfigString(appleBooks.annotation_database_path, "").trim();
  const libraryDbPath = coerceConfigString(appleBooks.library_database_path, "").trim();
  const embedDimension = Number.isInteger(raw.embed_dimension) && (raw.embed_dimension as number) > 0 ? (raw.embed_dimension as number) : undefined;
  return {
    minimumWords: Number.isFinite(minimumWordsCandidate) && minimumWordsCandidate >= 0 ? minimumWordsCandidate : PRODUCTION_DEFAULT_MINIMUM_WORDS,
    embedProvider: typeof raw.embed_provider === "string" ? raw.embed_provider : undefined,
    embedBaseUrl: typeof raw.embed_base_url === "string" ? raw.embed_base_url : undefined,
    embedModel: typeof raw.embed_model === "string" ? raw.embed_model : undefined,
    embedDimension,
    llmProvider: typeof raw.llm_provider === "string" ? raw.llm_provider : undefined,
    llmBaseUrl: typeof raw.llm_base_url === "string" ? raw.llm_base_url : undefined,
    llmModel: typeof raw.llm_model === "string" ? raw.llm_model : undefined,
    llmMaxTokens: toPositiveInt(raw.llm_max_tokens, PRODUCTION_DEFAULT_LLM_MAX_TOKENS),
    tagLimit: toPositiveInt(raw.tag_limit, PRODUCTION_DEFAULT_TAG_LIMIT),
    conceptLimit: toPositiveInt(raw.concept_limit, PRODUCTION_DEFAULT_CONCEPT_LIMIT),
    conceptMaxWords: toPositiveInt(raw.concept_max_words, PRODUCTION_DEFAULT_CONCEPT_MAX_WORDS),
    conceptCaseMode: conceptCase,
    allowFreeTags: raw.allow_free_tags !== false,
    tagMinLen: toPositiveInt(raw.min_tag_length, PRODUCTION_DEFAULT_TAG_MIN_LEN),
    tagMaxWords: toPositiveInt(raw.tag_max_words, PRODUCTION_DEFAULT_TAG_MAX_WORDS),
    chunkTargetTokens: toPositiveInt(raw.chunk_target_tokens, PRODUCTION_DEFAULT_CHUNK_TARGET_TOKENS),
    chunkOverlapTokens: toPositiveInt(raw.chunk_overlap_tokens, PRODUCTION_DEFAULT_CHUNK_OVERLAP_TOKENS),
    relatedLimit: toPositiveInt(raw.related_limit, PRODUCTION_DEFAULT_RELATED_LIMIT),
    relatedOverreach: toNonNegativeInt(raw.related_overreach, PRODUCTION_DEFAULT_RELATED_OVERREACH),
    relatedCreative: toNonNegativeInt(raw.related_creative, PRODUCTION_DEFAULT_RELATED_CREATIVE),
    relatedCreativeMin: toFiniteNumber(raw.related_creative_min, PRODUCTION_DEFAULT_RELATED_CREATIVE_MIN),
    relatedCreativeMax: toFiniteNumber(raw.related_creative_max, PRODUCTION_DEFAULT_RELATED_CREATIVE_MAX),
    relatedCandidateLimit: toPositiveInt(raw.related_candidate_limit, PRODUCTION_DEFAULT_RELATED_CANDIDATE_LIMIT),
    relatedMinScore: toFiniteNumber(raw.related_min_score, PRODUCTION_DEFAULT_RELATED_MIN_SCORE),
    appleAnnotationDbPath: annotationDbPath.length > 0 ? annotationDbPath : undefined,
    appleLibraryDbPath: libraryDbPath.length > 0 ? libraryDbPath : undefined,
  };
}

/** Checkpoint 10B LAUNCHAGENT: maps `BackgroundScheduler`'s own closed `BackgroundReconcileStatus` onto the existing coarse `LaunchAgentHealth` UI union -- a purely mechanical rename, never a behavior change to the status-bar surface itself. */
function mapBackgroundReconcileStatusToHealth(status: import("./scheduling/backgroundScheduler").BackgroundReconcileStatus): LaunchAgentHealth {
  switch (status) {
    case "installed":
      return "healthy";
    case "not-loaded":
      return "waiting";
    case "removed":
    case "disabled":
    case "unsupported-platform":
      return "disabled";
    case "foreign-conflict":
    case "ambiguous-launchctl-output":
    case "load-failed":
    case "unload-failed":
      return "failing";
    default:
      return "waiting";
  }
}

function splitLogLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

type RunTrigger = "manual" | "scheduled" | "reading";

interface SchedulerState extends SchedulerSummaryState {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastTrigger: RunTrigger | null;
  lastExitCode: number | null;
  lastMessage: string;
  launchAgentMessage: string;
  launchAgentPaths: string[];
  launchAgentDetails: LaunchAgentDetail[];
}

interface DiagnosticsState extends DiagnosticsSummaryState {
  inProgress: boolean;
  lastRunAt: number | null;
  result: PreflightResult | null;
}

export default class MindmapPlugin extends Plugin {
  settings: MindmapSettings = DEFAULT_SETTINGS;

  private currentProcess: ChildProcess | null = null;
  private schedulerTimer: unknown = null;
  private launchAgentManagedThisSession = false;
  private launchAgentSyncId = 0;
  private launchAgentHealthRefreshInFlight: Promise<void> | null = null;
  private schedulerState: SchedulerState = {
    nextRunAt: null,
    lastRunAt: null,
    lastTrigger: null,
    lastExitCode: null,
    lastMessage: "Manual mode.",
    launchAgentMessage: "LaunchAgent scheduler not reconciled yet.",
    launchAgentPaths: [],
    launchAgentDetails: [],
    launchAgentHealth: null,
    launchAgentLastSuccessfulRunAt: null,
    launchAgentLastExitCode: null,
    pendingAllCount: null,
  };
  private readonly recentLog: string[] = [];
  statusBarEl: HTMLElement | null = null;
  private activeRunStatus: string | null = null;
  private activeNoteEligibility: ActiveNoteEligibility = NO_ACTIVE_NOTE;
  private pendingScanService: ProductionPendingScanService | null = null;
  private readingModeController: ReadingModeController | null = null;
  private readingStateStore: ReadingStateStore | null = null;
  private automaticResearchPolicyStore: AutomaticResearchPolicyStore | null = null;
  private automaticResearchPolicyStatus: AutomaticResearchPolicyState = createAutomaticResearchPolicy(localResearchDay(new Date()));
  private webResearchActivity: "off" | "ready" | "deriving" | "searching" | "writing" | "error" = "off";
  private webResearchLastError: string | null = null;
  private webResearchPromise: Promise<ResearchFileResult> | null = null;
  private activeReaderChild: ChildProcess | null = null;
  private semanticEnvironment: MindmapSemanticEnvironment | null = null;
  private mindmapLocalGraphLeaf: WorkspaceLeaf | null = null;
  private mindmapLocalGraphPath: string | null = null;
  private focusLookupOnNextRender = false;
  private diagnosticsState: DiagnosticsState = {
    inProgress: false,
    lastRunAt: null,
    result: null,
  };
  private runtimeCoordinator: RuntimeReadinessCoordinator | null = null;
  private runtimeReadyKicked = false;
  /**
   * The Checkpoint 9 TypeScript engine/shadow coordinator, resolved through
   * `virtual:mindmap-dev-shadow` (a real implementation for a dev build, a
   * zero-import no-op stub for a production build -- see
   * `src/engine/devShadowIntegration.ts`/`devShadowStub.ts`). Constructed
   * lazily -- only the first time the development-only shadow command
   * actually runs, never during ordinary `onload()`. The integration owns
   * and disposes its own `MindmapEngine`; this plugin holds no production
   * `mindmapEngine` property. Production commands/writes stay entirely on
   * the Python path this checkpoint; nothing here is wired into
   * `registerMindmapCommands` or any other production entry point.
   */
  private diagOverlay: DevShadowIntegration | null = null;

  /**
   * Checkpoint 10B: the ONE production, write-capable TypeScript engine
   * this plugin now owns for real -- composed once in `onload()` (never
   * lazily, unlike the dev-only `diagOverlay` above) with real Obsidian
   * `Vault`/`Workspace`/`TFile`/`TFolder`, a real `NodeOwnedFs` confined to
   * `<pluginDir>/data/production-engine` (a namespace the Python-era
   * `data/state.json`/Chroma DB never touches -- see this field's own
   * lifecycle in `startProductionEngine()`), and this vault's current
   * Ollama-only embedding/local-metadata config read from the SAME
   * `config.json` the Python runtime already reads. `null` only when
   * `getResolvedRuntime()` itself is not valid (e.g. a non-desktop
   * filesystem adapter) -- Standard Mode (manual note editing, settings)
   * stays fully usable regardless.
   */
  productionEngine: ProductionEngine | null = null;
  /**
   * `true` only when `startProductionEngine()` actually ATTEMPTED to
   * construct/start a `ProductionEngine` (i.e. `buildProductionEngineOptions()`
   * returned real options) and that attempt threw -- distinct from
   * `productionEngine === null` on a genuinely non-desktop filesystem
   * adapter, where construction was never attempted at all and the
   * existing Python fallback remains the intentional behavior. Every
   * command that would otherwise silently fall back to a Python/semantic-
   * worker subprocess checks this FIRST and fails closed with a static
   * Notice instead when it is `true` -- a construction/start failure must
   * never be observed by the user as "quietly running Python again."
   */
  private productionEngineFailed = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBundledRuntime();

    this.statusBarEl = this.addStatusBarItem();
    configureStatusBarElement(this.statusBarEl, (event) => this.openStatusMenu(event));
    this.readingStateStore = createReadingStateStore(path.join(this.getRuntimeContext().pluginDir, "data", "reading-state.json"));
    this.automaticResearchPolicyStore = createAutomaticResearchPolicyStore(path.join(this.getRuntimeContext().pluginDir, "data", "automatic-research-policy.json"), {
      mkdir: async (directory, options) => { await fs.promises.mkdir(directory, options); },
      readFile: async (filePath, encoding) => await fs.promises.readFile(filePath, encoding),
      writeFile: async (filePath, content, encoding) => await fs.promises.writeFile(filePath, content, encoding),
      rename: async (source, target) => await fs.promises.rename(source, target),
      unlink: async (filePath) => await fs.promises.unlink(filePath),
    });
    await this.refreshAutomaticResearchPolicyStatus();
    this.readingModeController = this.createReadingModeController();
    this.registerView(MINDMAP_VIEW_TYPE, (leaf) => new MindmapWorkspaceView(leaf, this));
    this.registerHoverLinkSource(MINDMAP_VIEW_TYPE, {
      display: "Mindmap AI",
      defaultMod: false,
    });
    this.addRibbonIcon("orbit", "Open mindmap", () => {
      void this.openMindmapView();
    });
    this.addSettingTab(new MindmapSettingTab(this.app, this));
    this.pendingScanService = createProductionPendingScanService(
      () => this.productionEngine,
      (message) => this.appendLog(message),
      () => this.updateStatusBar(),
    );
    this.semanticEnvironment = new MindmapSemanticEnvironment(
      () => this.getResolvedRuntime(),
      (message) => this.appendLog(message),
      () => this.updateStatusBar(),
    );

    registerMindmapCommands(this);
    if (__MINDMAP_DEV_BUILD__) {
      this.addCommand({
        id: "mindmap-dev-run-shadow-diagnostics",
        name: "Development: Run TypeScript shadow diagnostics (read-only)",
        callback: () => { void this.getOrCreateDiagOverlay().run(); },
      });
    }
    this.syncScheduler();
    registerVaultRefreshEvents(this.app.vault, (event) => this.registerEvent(event), (reason, paths) => {
      this.pendingScanService?.requestRefresh(reason, paths);
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { void this.refreshActiveNoteEligibility(); }));
    await this.startProductionEngine();
    void this.pendingScanService.warm().then(() => this.updateStatusBar());
    await this.startRuntimeCoordinator();
    if (this.settings.readingMode === "reading") {
      void this.readingModeController.start();
    }
  }

  onunload(): void {
    if (__MINDMAP_DEV_BUILD__) {
      this.diagOverlay?.dispose();
    }
    void this.productionEngine?.dispose();
    this.productionEngine = null;
    this.runtimeCoordinator?.dispose();
    this.activeReaderChild?.kill();
    this.activeReaderChild = null;
    this.pendingScanService?.dispose();
    void this.readingModeController?.dispose();
    void this.semanticEnvironment?.shutdown();
    this.stopScheduler("Plugin unloaded. Internal scheduler stopped.");
    if (this.currentProcess) {
      this.appendLog("Stopping active Mindmap run because the plugin is unloading.");
      this.currentProcess.kill();
      this.currentProcess = null;
      this.activeRunStatus = null;
    }
  }

  async loadSettings(): Promise<void> {
    const savedData = (await this.loadData()) as Partial<MindmapSettings> | null | undefined;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, savedData ?? {});
    this.settings.readingMode = this.settings.readingMode === "reading" ? "reading" : "standard";
    this.settings.webResearchMode = this.settings.webResearchMode === "manual" || this.settings.webResearchMode === "automatic-reading" ? this.settings.webResearchMode : "off";
    this.webResearchActivity = this.settings.webResearchMode === "off" ? "off" : "ready";
    if (typeof this.settings.pinnedConnections !== "object" || this.settings.pinnedConnections === null || Array.isArray(this.settings.pinnedConnections)) {
      this.settings.pinnedConnections = {};
    }
    this.settings.schedulerIntervalMinutes = normalizeSchedulerInterval(this.settings.schedulerIntervalMinutes);
    this.settings.launchAgentDailyHour = normalizeHour(this.settings.launchAgentDailyHour);
    this.settings.launchAgentDailyMinute = normalizeMinute(this.settings.launchAgentDailyMinute);
    this.settings.launchAgentWeeklyHour = normalizeHour(this.settings.launchAgentWeeklyHour);
    this.settings.launchAgentWeeklyMinute = normalizeMinute(this.settings.launchAgentWeeklyMinute);
  }

  async saveSettings(): Promise<void> {
    this.settings.schedulerIntervalMinutes = normalizeSchedulerInterval(this.settings.schedulerIntervalMinutes);
    this.settings.launchAgentDailyHour = normalizeHour(this.settings.launchAgentDailyHour);
    this.settings.launchAgentDailyMinute = normalizeMinute(this.settings.launchAgentDailyMinute);
    this.settings.launchAgentWeeklyHour = normalizeHour(this.settings.launchAgentWeeklyHour);
    this.settings.launchAgentWeeklyMinute = normalizeMinute(this.settings.launchAgentWeeklyMinute);
    await this.saveData(this.settings);
    this.syncScheduler();
    this.pendingScanService?.requestRefresh("settings updated");
  }

  getResolvedRuntime(): ResolvedRuntime {
    return resolveRuntime(this.settings, this.getRuntimeContext());
  }

  /**
   * True whenever the runtime is known to require setup, and also before
   * discovery has even started (the coordinator is constructed only partway
   * through onload()). The safe default while unknown is "blocked": nothing
   * gated on this may run ahead of the discovery result it depends on.
   */
  private isRuntimeSetupBlocking(): boolean {
    return this.runtimeCoordinator?.getState().blocking ?? true;
  }

  getRuntimeSetupState(): CoordinatorState | null {
    return this.runtimeCoordinator?.getState() ?? null;
  }

  /** Live runtime-setup state updates, including cancellable in-progress phases. Callers must invoke the returned unsubscribe on teardown. */
  subscribeRuntimeSetupState(listener: (state: CoordinatorState) => void): () => void {
    return this.runtimeCoordinator?.subscribe(listener) ?? (() => {});
  }

  async startRuntimeSetup(): Promise<void> {
    const state = this.runtimeCoordinator?.getState();
    if (!state?.canSetup) return;
    await this.runtimeCoordinator?.beginSetup();
  }

  retryRuntimeSetup(): Promise<void> {
    return this.startRuntimeSetup();
  }

  cancelRuntimeSetup(): void {
    this.runtimeCoordinator?.cancel();
  }

  /** Opens the official Python macOS download page in the user's default browser. */
  openPythonRuntimeDownloadPage(): void {
    window.open(PYTHON_MACOS_DOWNLOAD_URL, "_blank");
  }

  private async confirmRuntimeSetup(): Promise<boolean> {
    return await confirmMindmapRun(this.app, RUNTIME_SETUP_CONFIRMATION_COPY);
  }

  private async startRuntimeCoordinator(): Promise<void> {
    const context = this.getRuntimeContext();
    const runtimeDir = getPluginRuntimeDir(context);
    const runtime = this.getResolvedRuntime();

    let requirementsFileContents = "";
    try {
      requirementsFileContents = await fs.promises.readFile(path.join(runtimeDir, "requirements.txt"), "utf8");
    } catch (error) {
      this.appendLog(`[runtime] Could not read bundled requirements.txt: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const invoke = createNodeProcessInvoker();
    const verifyPreflight = buildRuntimePreflightVerifier({
      scriptPath: runtime.scriptPath,
      configPath: runtime.configPath,
      invoke,
    });

    this.runtimeCoordinator = new RuntimeReadinessCoordinator({
      platform: process.platform,
      pythonCommandSetting: this.settings.pythonCommand,
      homeDir: os.homedir(),
      pathEnv: process.env.PATH ?? "",
      arch: os.arch() === "arm64" ? "arm64" : "x64",
      appSupportRoot: getDefaultAppSupportRoot(os.homedir()),
      requirementsFileContents,
      requirementsFilePath: path.join(runtimeDir, "requirements.txt"),
      scriptPath: runtime.scriptPath,
      configPath: runtime.configPath,
      discoveryFs: createNodeDiscoveryFs(),
      invoke,
      setupFs: createNodeSetupFs(),
      spawner: createNodeSetupSpawner(),
      confirm: () => this.confirmRuntimeSetup(),
      persist: async (interpreterPath) => {
        this.settings.pythonCommand = interpreterPath;
        await this.saveSettings();
      },
      verifyPreflight,
      onStateChange: (state) => {
        this.updateStatusBar();
        if (shouldTriggerRuntimeReadyKickoff(state.phase, this.runtimeReadyKicked)) {
          this.runtimeReadyKicked = true;
          // The scheduler/LaunchAgent branches syncScheduler() gates on
          // isRuntimeSetupBlocking() were skipped every time this coordinator
          // reported blocking:true (including via persist()'s own saveSettings()
          // call mid-install, which runs before this phase flips to ready) — so
          // they must be re-evaluated now that blocking has actually cleared.
          this.syncScheduler();
          void this.runPreflight("startup");
          if (this.settings.liveSemanticLookupEnabled) {
            void this.startSemanticEnvironment(false);
          }
        }
      },
      log: (line) => this.appendLog(line),
    });

    await this.runtimeCoordinator.startDiscovery();
  }

  getSemanticStatus(): SemanticEnvironmentStatus {
    return this.semanticEnvironment?.getStatus() ?? {
      state: "off",
      message: "Semantic environment is off.",
      health: null,
    };
  }

  /**
   * Checkpoint 10B FINAL AUDIT: starting the Python semantic worker is a
   * production-reachable command ("Start mindmap semantic environment").
   * Whenever a TypeScript `ProductionEngine` is available for this vault,
   * `queryLiveRelated`/`queryLookupRelated` already prefer it and never
   * consult `semanticEnvironment` at all -- starting the Python worker in
   * that case would only ever run an unused subprocess. This command is
   * therefore a TS-engine no-op (an informational Notice, never a spawn)
   * whenever `productionEngine` exists; it starts the Python worker ONLY
   * as the non-desktop-adapter fallback path.
   */
  async startSemanticEnvironment(showNotice: boolean): Promise<void> {
    if (this.productionEngine) {
      if (showNotice) {
        new Notice("The Mindmap TypeScript engine already handles semantic search in this vault.", 8000);
      }
      return;
    }
    if (this.productionEngineFailed) {
      if (showNotice) {
        new Notice("The Mindmap TypeScript engine failed to start for this vault. Semantic search is unavailable.", 8000);
      }
      return;
    }
    if (!this.semanticEnvironment) {
      return;
    }
    if (this.isRuntimeSetupBlocking()) {
      if (showNotice) {
        new Notice("Mindmap runtime setup is required before the semantic environment can start.", 8000);
      }
      return;
    }
    const status = await this.semanticEnvironment.start("current");
    if (showNotice) {
      new Notice(status.message, 8000);
    }
  }

  /** Checkpoint 10B SIDEBAR: maps `ProductionEngine.queryLiveRelated`/`queryLookupRelated`'s own wider `ProductionRelatedResult.kind` union onto the existing, unchanged `LiveRelatedResult` UI contract -- a purely mechanical rename, never a behavior change. */
  private static toLiveRelatedResults(related: readonly ProductionRelatedResult[]): LiveRelatedResult[] {
    return related.map((item) => ({ path: item.path, score: item.score, kind: item.kind }));
  }

  /**
   * Checkpoint 10B SIDEBAR: the TypeScript `ProductionEngine` is the ONLY
   * backend for live/lookup related queries whenever one is available for
   * this vault -- the Python `semanticWorkerClient`/`semanticEnvironment`
   * path below is used ONLY as a fallback for a vault with no production
   * engine composed (e.g. a non-desktop filesystem adapter). Neither path
   * is ever consulted for the other: once `productionEngine` exists,
   * `semanticEnvironment` is never started/queried from here.
   */
  async queryLiveRelated(path: string): Promise<LiveRelatedResponse> {
    if (!this.settings.liveSemanticLookupEnabled) {
      throw new Error("Live semantic lookup is disabled.");
    }
    if (this.productionEngine) {
      const result = await this.productionEngine.queryLiveRelated(path, this.settings.liveSemanticEnsureActiveNoteIndexed);
      return {
        path: result.path,
        hash: result.sourceHash,
        indexed: result.indexed,
        stale: result.stale,
        index_result: null,
        related: MindmapPlugin.toLiveRelatedResults(result.related),
      };
    }
    if (this.productionEngineFailed) {
      throw new Error("The Mindmap TypeScript engine failed to start for this vault.");
    }
    if (!this.semanticEnvironment) {
      throw new Error("Semantic environment is not available.");
    }
    return this.semanticEnvironment.queryRelated(path, this.settings.liveSemanticEnsureActiveNoteIndexed);
  }

  async queryLookupRelated(query: string, limit?: number): Promise<LookupRelatedResponse> {
    if (!this.settings.liveSemanticLookupEnabled) {
      throw new Error("Live semantic lookup is disabled.");
    }
    if (this.productionEngine) {
      const related = await this.productionEngine.queryLookupRelated(query, limit ?? PRODUCTION_DEFAULT_RELATED_LIMIT);
      return { query, related: MindmapPlugin.toLiveRelatedResults(related) };
    }
    if (this.productionEngineFailed) {
      throw new Error("The Mindmap TypeScript engine failed to start for this vault.");
    }
    if (!this.semanticEnvironment) {
      throw new Error("Semantic environment is not available.");
    }
    return this.semanticEnvironment.queryText(query, limit);
  }

  getSchedulerConfig(): SchedulerConfig {
    return {
      mode: this.settings.schedulerMode,
      intervalMinutes: this.settings.schedulerIntervalMinutes,
    };
  }


  getLaunchAgentCatchUpStatus(): { available: boolean; message: string } {
    return buildLaunchAgentCatchUpStatus(this.settings.schedulerMode, this.schedulerState.launchAgentHealth, this.getPendingSnapshot());
  }

  private openStatusMenu(event?: MouseEvent | KeyboardEvent): void {
    void openMindmapStatusMenu(this, event);
  }

  getStatusBarInternalState(): StatusBarInternalState {
    return {
      running: this.currentProcess !== null,
      runStatus: this.activeRunStatus,
      preflightInProgress: this.diagnosticsState.inProgress,
      preflightOk: this.diagnosticsState.result?.ok ?? null,
      schedulerHealth: this.schedulerState.launchAgentHealth,
      schedulerDetails: this.schedulerState.launchAgentDetails,
    };
  }

  getReadingHealth(): ReadingHealth {
    return this.readingModeController?.getHealth() ?? {
      mode: this.settings.readingMode,
      activity: this.settings.readingMode === "reading" ? "ready" : "disabled",
      annotationCount: 0,
      eligibleCount: 0,
      pendingCount: 0,
      importedCount: 0,
      unresearchableCount: 0,
      lastSyncAt: null,
      lastError: null,
    };
  }

  /**
   * Explicit, idempotent radio selection between Standard and Reading Mode:
   * selecting the mode that is already active is a no-op (the controller
   * itself guards both enable() and disable() against this), so callers
   * never need to branch on the current mode first.
   */
  async selectReadingMode(mode: ReadingMode): Promise<void> {
    if (!this.readingModeController) {
      return;
    }
    if (mode === "standard") {
      await this.readingModeController.disable();
      return;
    }
    const outcome = await this.readingModeController.enable();
    if (outcome.enabled && outcome.initialImport) {
      const health = this.readingModeController.getHealth();
      if (health.pendingCount > 0) {
        if (this.isRuntimeSetupBlocking()) {
          new Notice(`${health.pendingCount} annotation${health.pendingCount === 1 ? "" : "s"} imported. Finish Mindmap runtime setup in Settings to process them.`, 10000);
        } else {
          const shouldProcess = await confirmMindmapRun(this.app, {
            title: "Process Reading backlog?",
            message: `${health.pendingCount} annotation${health.pendingCount === 1 ? "" : "s"} ready for processing. Process them now?`,
            confirmText: "Process now",
            confirmClass: "mod-cta",
          });
          if (shouldProcess) {
            await this.readingModeController.processBacklog();
          }
        }
      }
    }
  }

  async syncReadingMode(): Promise<void> {
    await this.readingModeController?.syncNow();
  }

  async processReadingBacklog(): Promise<void> {
    if (this.isRuntimeSetupBlocking()) {
      new Notice("Mindmap runtime setup is required before the reading backlog can be processed. Finish setup in settings.", 10000);
      return;
    }
    await this.readingModeController?.processBacklog();
  }

  getWebResearchStatus(): { mode: "off" | "manual" | "automatic-reading"; activity: string; lastError: string | null; automatic: AutomaticResearchPolicyState } {
    return { mode: this.settings.webResearchMode, activity: this.webResearchActivity, lastError: this.webResearchLastError, automatic: { ...this.automaticResearchPolicyStatus } };
  }

  async toggleWebResearchMode(): Promise<void> {
    if (this.webResearchPromise) {
      new Notice("Web research is already running; mode cannot change yet.", 8000);
      return;
    }
    if (this.settings.webResearchMode === "manual") {
      const previous = this.settings.webResearchMode;
      this.settings.webResearchMode = "off";
      this.webResearchActivity = "off";
      this.webResearchLastError = null;
      try { await this.saveSettings(); } catch {
        this.settings.webResearchMode = previous;
        this.webResearchActivity = "error";
        this.webResearchLastError = "Could not save Web Research mode.";
        new Notice(this.webResearchLastError, 8000);
        this.updateStatusBar();
        return;
      }
      this.updateStatusBar();
      new Notice("Manual web research disabled.", 5000);
      return;
    }
    const confirmed = await confirmMindmapRun(this.app, {
      title: "Enable Manual Web Research?",
      message: "Selected text or a bounded active-note excerpt is processed locally by Qwen. Exa receives only one or two derived queries and returns up to five bounded source excerpts and metadata. Unrelated vault content is never sent externally.",
      confirmText: "Enable manual research",
      confirmClass: "mod-cta",
    });
    if (!confirmed) return;
    try {
      await this.getWebResearchPrerequisites();
    } catch (error) {
      this.webResearchActivity = "error";
      this.webResearchLastError = error instanceof WebResearchError ? error.message : "Web Research is not ready.";
      new Notice(this.webResearchLastError, 8000);
      this.updateStatusBar();
      return;
    }
    const previous = this.settings.webResearchMode;
    this.settings.webResearchMode = "manual";
    this.webResearchActivity = "ready";
    this.webResearchLastError = null;
    try { await this.saveSettings(); } catch {
      this.settings.webResearchMode = previous;
      this.webResearchActivity = "error";
      this.webResearchLastError = "Could not save Web Research mode.";
      new Notice(this.webResearchLastError, 8000);
      this.updateStatusBar();
      return;
    }
    this.updateStatusBar();
    new Notice("Manual web research enabled.", 5000);
  }

  async toggleAutomaticReadingResearch(): Promise<void> {
    if (this.webResearchPromise) {
      new Notice("Web research is already running; automatic mode cannot change yet.", 8000);
      return;
    }
    if (this.settings.webResearchMode === "automatic-reading") {
      const previousMode = this.settings.webResearchMode;
      const previousActivity = this.webResearchActivity;
      const previousError = this.webResearchLastError;
      this.settings.webResearchMode = "manual";
      this.webResearchActivity = "ready";
      try { await this.saveSettings(); } catch {
        this.settings.webResearchMode = previousMode;
        this.webResearchActivity = previousActivity;
        this.webResearchLastError = previousError ?? "Could not save Automatic Reading Research mode.";
        new Notice(this.webResearchLastError, 8000);
        this.updateStatusBar();
        return;
      }
      new Notice("Automatic reading research paused; manual research remains available.", 5000);
      this.updateStatusBar();
      return;
    }
    if (this.settings.readingMode !== "reading") {
      new Notice("Enable reading mode before automatic research.", 8000);
      return;
    }
    if (this.isRuntimeSetupBlocking()) {
      new Notice("Mindmap runtime setup is required before automatic reading research can be enabled.", 8000);
      return;
    }
    const confirmed = await confirmMindmapRun(this.app, {
      title: "Enable Automatic Reading Research?",
      message: "Apple annotation excerpts stay local to Qwen. Exa receives only one or two derived queries and returns up to five bounded source excerpts and metadata. Automatic work is limited to five notes per sync and ten per day.",
      confirmText: "Enable automatic research",
      confirmClass: "mod-cta",
    });
    if (!confirmed) return;
    try { await this.getWebResearchPrerequisites(); } catch (error) {
      this.webResearchActivity = "error";
      this.webResearchLastError = error instanceof WebResearchError ? error.message : "Automatic research is not ready.";
      new Notice(this.webResearchLastError, 8000);
      this.updateStatusBar();
      return;
    }
    const previousMode = this.settings.webResearchMode;
    const previousActivity = this.webResearchActivity;
    const previousError = this.webResearchLastError;
    this.settings.webResearchMode = "automatic-reading";
    this.webResearchActivity = "ready";
    this.webResearchLastError = null;
    try { await this.saveSettings(); } catch {
      this.settings.webResearchMode = previousMode;
      this.webResearchActivity = previousActivity;
      this.webResearchLastError = previousError ?? "Could not save Automatic Reading Research mode.";
      new Notice(this.webResearchLastError, 8000);
      this.updateStatusBar();
      return;
    }
    await this.refreshAutomaticResearchPolicyStatus();
    await this.syncReadingMode();
    new Notice("Automatic reading research enabled.", 5000);
  }

  async retryAutomaticResearch(): Promise<void> {
    if (!this.automaticResearchPolicyStore || this.settings.webResearchMode !== "automatic-reading" || this.readingModeController?.getMode() !== "reading") {
      new Notice("Automatic research retry requires active reading mode.", 8000);
      return;
    }
    if (this.isRuntimeSetupBlocking()) {
      new Notice("Mindmap runtime setup is required before automatic reading research can retry.", 8000);
      return;
    }
    const day = localResearchDay(new Date());
    const loaded = await loadAutomaticResearchPolicySafely(this.automaticResearchPolicyStore, day);
    const policy = loaded.state;
    this.automaticResearchPolicyStatus = policy;
    if (loaded.error) {
      this.webResearchActivity = "error";
      this.webResearchLastError = loaded.error;
      new Notice(loaded.error, 8000);
      this.updateStatusBar();
      return;
    }
    if (policy.pauseReason === "daily-limit") {
      new Notice("Daily automatic research limit has been reached.", 8000);
      this.updateStatusBar();
      return;
    }
    if (!policy.pauseReason) return;
    try {
      await this.automaticResearchPolicyStore.save(clearTransientAutomaticPause(policy));
      await this.refreshAutomaticResearchPolicyStatus();
      this.webResearchLastError = null;
      this.webResearchActivity = "ready";
    } catch (error) {
      this.webResearchActivity = "error";
      this.webResearchLastError = error instanceof Error ? error.message : "Automatic research retry could not be saved.";
      new Notice(this.webResearchLastError, 8000);
      this.updateStatusBar();
      return;
    }
    await this.syncReadingMode();
  }

  private async refreshAutomaticResearchPolicyStatus(now = new Date()): Promise<void> {
    if (!this.automaticResearchPolicyStore) return;
    const result = await loadAutomaticResearchPolicySafely(this.automaticResearchPolicyStore, localResearchDay(now));
    this.automaticResearchPolicyStatus = result.state;
    if (result.error) {
      this.webResearchActivity = "error";
      this.webResearchLastError = result.error;
    }
  }

  async researchSelectedText(): Promise<void> {
    const selected = this.app.workspace.activeEditor?.editor?.getSelection()?.trim() ?? "";
    if (!selected) {
      new Notice("Select text in a Markdown note to research.", 8000);
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") {
      new Notice("Web research requires a Markdown note.", 8000);
      return;
    }
    if (!isSafeManualResearchPath(file.path, this.app.vault.configDir)) {
      new Notice("Web research cannot write to this note path.", 8000);
      return;
    }
    await this.researchFile(file, selected, false, "manual");
  }

  async researchActiveNote(reprocess = false): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension.toLowerCase() !== "md") {
      new Notice("Open an eligible Markdown note to research.", 8000);
      return;
    }
    if (!isSafeManualResearchPath(file.path, this.app.vault.configDir)) {
      new Notice("Web research cannot write to this note path.", 8000);
      return;
    }
    const text = prepareActiveNoteResearchInput(await this.app.vault.cachedRead(file), MAX_RESEARCH_INPUT_CHARS);
    if (!text.trim()) {
      new Notice("The active note is empty.", 8000);
      return;
    }
    await this.researchFile(file, text, reprocess, "manual");
  }

  private async researchFile(file: TFile, text: string, reprocess: boolean, origin: "manual" | "automatic"): Promise<ResearchFileResult> {
    const readingActivity = this.readingModeController?.getHealth().activity;
    if (origin === "manual" && (readingActivity === "syncing" || readingActivity === "processing")) {
      new Notice("Reading mode is updating notes; try web research again when the sync finishes.", 8000);
      return { ok: false, code: "READING_BUSY", message: "Reading Mode is updating notes." };
    }
    if (this.currentProcess) {
      if (origin === "manual") new Notice("Mindmap is already running. Web research will not start.", 8000);
      return { ok: false, code: "MINDMAP_BUSY", message: "Mindmap is already running." };
    }
    if (this.webResearchPromise) {
      if (origin === "manual") new Notice("Web research is already running.", 8000);
      return { ok: false, code: "RESEARCH_BUSY", message: "Web Research is already running." };
    }
    const work = this.runResearchFile(file, text, reprocess, origin);
    this.webResearchPromise = work;
    try { return await work; } finally { this.webResearchPromise = null; }
  }

  private async runResearchFile(file: TFile, text: string, reprocess: boolean, origin: "manual" | "automatic"): Promise<ResearchFileResult> {
    if (this.settings.webResearchMode === "off") {
      new Notice("Enable manual web research before starting a request.", 8000);
      return { ok: false, code: "RESEARCH_DISABLED", message: "Web Research is disabled." };
    }
    this.webResearchActivity = "deriving";
    this.webResearchLastError = null;
    this.updateStatusBar();
    try {
      const { credential, model } = await this.getWebResearchPrerequisites();
      const vault = createObsidianVaultApi(this.app.vault);
      const note = vault.get(file.path);
      if (!note) throw new WebResearchError("NOTE_MISSING", "The active note is unavailable.");

      let trackedAnnotationId: string | undefined;
      let trackedEntry: { researchPath?: string } | undefined;
      if (this.readingStateStore) {
        const currentState = await this.readingStateStore.load();
        const found = Object.entries(currentState.annotations).find(([, entry]) => entry.notePath === file.path);
        if (found) {
          trackedAnnotationId = found[0];
          trackedEntry = found[1];
        }
      }

      const noteContent = await vault.read(note);
      const classification = classifyResearchTarget(noteContent, trackedAnnotationId);
      if (classification === "reading-state-missing") {
        throw new WebResearchError("READING_STATE_MISSING", "This Apple Books annotation is not tracked in Reading state.");
      }
      if (classification === "type-mismatch") {
        throw new WebResearchError("TYPE_MISMATCH", "Note type does not match its tracked Reading state entry.");
      }

      this.webResearchActivity = "searching";
      this.updateStatusBar();

      if (classification === "companion" && trackedAnnotationId && this.readingStateStore) {
        const result = await collectResearch({ provider: new ExaResearchProvider(credential, requestUrlFetch), model }, { text, title: file.basename, maxChars: MAX_RESEARCH_INPUT_CHARS });
        if (!result) throw new WebResearchError("NO_USABLE_SOURCES", "Web Research returned no usable sources.");
        const companionContent = renderCompanionResearchContent(result);
        if (!companionContent) throw new WebResearchError("NO_USABLE_SOURCES", "Web Research returned no usable sources.");
        this.webResearchActivity = "writing";
        this.updateStatusBar();
        const companionResult = await writeAppleAnnotationCompanion(vault, this.readingStateStore, {
          annotationPath: file.path,
          annotationId: trackedAnnotationId,
          researchContent: companionContent,
          storedResearchPath: trackedEntry?.researchPath,
        });
        if (!companionResult.ok) throw new WebResearchError(companionResult.code, companionResult.message);
      } else {
        this.webResearchActivity = "writing";
        this.updateStatusBar();
        const result = await researchNote({ provider: new ExaResearchProvider(credential, requestUrlFetch), model, vault }, note, { text, title: file.basename, maxChars: MAX_RESEARCH_INPUT_CHARS });
        if (!result) throw new WebResearchError("NO_USABLE_SOURCES", "Web Research returned no usable sources.");
      }

      if (origin === "manual" && this.readingStateStore) {
        const statusResult = await completeAppleAnnotationResearchForNote(vault, this.readingStateStore, file.path);
        if (statusResult === "state-pending") this.webResearchLastError = "Research saved; annotation status will repair on next sync.";
      }
      this.webResearchActivity = "ready";
      if (reprocess && !(await this.runMindmap("reading", "note", file.path))) {
        this.webResearchLastError = "Research was saved; Mindmap processing is retryable.";
        new Notice(this.webResearchLastError, 8000);
      } else {
        if (origin === "manual") new Notice("Web research saved.", 5000);
      }
      return { ok: true };
    } catch (error) {
      this.webResearchActivity = "error";
      const researchError = error instanceof WebResearchError ? error : new WebResearchError("RESEARCH_FAILED", "Web Research failed without saving changes.");
      this.webResearchLastError = researchError.message;
      if (origin === "manual") new Notice(this.webResearchLastError, 8000);
      return { ok: false, code: researchError.code, message: researchError.message };
    } finally {
      this.updateStatusBar();
    }
  }

  private async getWebResearchPrerequisites(): Promise<{ credential: string; model: ReturnType<typeof createConfiguredLocalResearchModel> }> {
    const credential = await getExaCredential({ allowDevelopmentOverride: false });
    const config = JSON.parse(await fs.promises.readFile(this.getResolvedRuntime().configPath, "utf8")) as Record<string, unknown>;
    const provider = config.llm_provider === "ollama" ? "ollama" : "openai_compatible";
    const chatTemplateKwargs = config.llm_chat_template_kwargs && typeof config.llm_chat_template_kwargs === "object" && !Array.isArray(config.llm_chat_template_kwargs)
      ? config.llm_chat_template_kwargs as Record<string, unknown>
      : undefined;
    const model = createConfiguredLocalResearchModel({
      provider,
      baseUrl: coerceConfigString(config.llm_base_url, coerceConfigString(config.ollama_base_url, "")),
      model: coerceConfigString(config.llm_model, ""),
      ...(resolveLocalModelApiKey(config, process.env) ? { apiKey: resolveLocalModelApiKey(config, process.env) } : {}),
      ...(chatTemplateKwargs ? { chatTemplateKwargs } : {}),
      temperature: 0.2,
    }, requestUrlFetch);
    return { credential, model };
  }

  async runLaunchAgentCatchUp(): Promise<void> {
    const status = this.getLaunchAgentCatchUpStatus();
    if (!status.available) {
      new Notice(status.message, 8000);
      return;
    }
    await this.runMindmap("manual", "all");
  }

  async openMindmapView(): Promise<void> {
    this.app.workspace.detachLeavesOfType(MINDMAP_VIEW_TYPE);

    const leaf = await this.app.workspace.ensureSideLeaf(MINDMAP_VIEW_TYPE, "right", {
      active: true,
      split: false,
      reveal: true,
    });
    await leaf.setViewState({
      type: MINDMAP_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  async openMindmapLookup(): Promise<void> {
    this.focusLookupOnNextRender = true;
    await this.openMindmapView();
  }

  consumeLookupFocusRequest(): boolean {
    const requested = this.focusLookupOnNextRender;
    this.focusLookupOnNextRender = false;
    return requested;
  }

  getPinnedConnections(sourcePath: string): string[] {
    return [...(this.settings.pinnedConnections[sourcePath] ?? [])];
  }

  isConnectionPinned(sourcePath: string, targetPath: string): boolean {
    return this.getPinnedConnections(sourcePath).includes(targetPath);
  }

  async togglePinnedConnection(sourcePath: string, targetPath: string): Promise<boolean> {
    const current = this.getPinnedConnections(sourcePath);
    const existingIndex = current.indexOf(targetPath);
    const pinned = existingIndex < 0;
    if (pinned) {
      current.unshift(targetPath);
    } else {
      current.splice(existingIndex, 1);
    }

    this.settings.pinnedConnections = {
      ...this.settings.pinnedConnections,
      [sourcePath]: current,
    };
    if (current.length === 0) {
      delete this.settings.pinnedConnections[sourcePath];
    }
    await this.saveSettings();
    return pinned;
  }

  async syncMindmapLocalGraph(file: TFile | null): Promise<void> {
    if (file === null) {
      return;
    }
    if (this.mindmapLocalGraphPath === file.path && this.mindmapLocalGraphLeaf !== null) {
      return;
    }
    if (this.mindmapLocalGraphLeaf === null) {
      for (const leaf of this.app.workspace.getLeavesOfType("localgraph")) {
        if (this.isMindmapLocalGraphLeaf(leaf)) {
          this.mindmapLocalGraphLeaf = leaf;
          break;
        }
      }
    }

    const state = buildMindmapLocalGraphState(this.manifest.id, file.path);
    this.mindmapLocalGraphLeaf = await this.app.workspace.ensureSideLeaf("localgraph", "right", {
      active: false,
      split: true,
      reveal: true,
    });
    await this.mindmapLocalGraphLeaf.setViewState({
      type: "localgraph",
      state,
      active: false,
    });
    this.mindmapLocalGraphPath = file.path;
  }

  private isMindmapLocalGraphLeaf(leaf: WorkspaceLeaf): boolean {
    return isMindmapLocalGraphLeaf(leaf, this.mindmapLocalGraphLeaf, this.manifest.id);
  }

  getPendingSnapshot(): PendingSnapshot {
    return this.pendingScanService?.getSnapshot() ?? {
      available: false,
      reason: "Pending scan service not initialized yet.",
      current: { total: 0, items: [] },
      all: { total: 0, items: [] },
      metrics: {
        durationMs: 0,
        filesListed: 0,
        filesScanned: 0,
        filesUpdated: 0,
        totalTracked: 0,
        dirtyPaths: 0,
        stateReloaded: false,
        configReloaded: false,
      },
      lastUpdatedAt: null,
    };
  }

  getScopeSetupStatus(): ScopeSetupStatus {
    const runtime = this.getResolvedRuntime();
    return resolveScopeSetupStatus(runtime, runtime.valid && this.canManageConfig(runtime));
  }

  getVaultFolderOptions(): VaultFolderOption[] {
    const folderPaths = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path);
    return listVaultFolderOptions(folderPaths, this.app.vault.configDir);
  }

  saveScopeSetup(selection: ScopeSelection): void {
    const runtime = this.getResolvedRuntime();
    const status = this.getScopeSetupStatus();
    if (!runtime.valid || !status.canManage || !status.configPath) {
      throw new Error(status.guidance);
    }

    const configPath = writeScopeSetup(status, selection);
    this.appendLog(`[setup] Updated scope folders in ${configPath}`);
    this.pendingScanService?.requestRefresh("scope setup updated");
    this.updateStatusBar();
  }

  getLlmProviderConfigStatus(): LlmProviderConfigStatus {
    const runtime = this.getResolvedRuntime();
    return resolveLlmProviderConfigStatus(runtime, runtime.valid && this.canManageConfig(runtime));
  }

  saveLlmProviderConfig(providerConfig: LlmProviderConfig): void {
    const status = this.getLlmProviderConfigStatus();
    if (!status.canManage || !status.configPath) {
      throw new Error(status.guidance);
    }

    const configPath = writeLlmProviderConfig(status, providerConfig);
    this.appendLog(`[setup] Updated LLM provider config in ${configPath}`);
  }

  /** One compact, path-free readiness summary for the settings Overview row. */
  getOverviewState(): OverviewState {
    const runtime = this.getResolvedRuntime();
    const runtimeSetup = this.getRuntimeSetupState();
    const scope = this.getScopeSetupStatus();
    const provider = this.getLlmProviderConfigStatus();
    return buildOverviewState({
      runtimeValid: runtime.valid,
      runtimeSetup: runtimeSetup
        ? { phase: runtimeSetup.phase, message: runtimeSetup.message, canSetup: runtimeSetup.canSetup, canCancel: runtimeSetup.canCancel }
        : null,
      scopeCanManage: scope.canManage,
      providerCanManage: provider.canManage,
      preflightOk: this.diagnosticsState.result?.ok ?? null,
    });
  }

  /** One-line latest preflight result for the collapsed Troubleshooting disclosure's default view. */
  getDiagnosticsOneLine(): string {
    return buildDiagnosticsOneLine({
      inProgress: this.diagnosticsState.inProgress,
      lastRunAt: this.diagnosticsState.lastRunAt,
      result: this.diagnosticsState.result,
    });
  }

  /**
   * Builds a bounded, redacted technical report on demand and copies it to
   * the clipboard. Never called from a default render path -- only from an
   * explicit "Copy diagnostics" click.
   */
  async copyDiagnostics(): Promise<void> {
    const runtime = this.getResolvedRuntime();
    const provider = this.getLlmProviderConfigStatus();
    const report = buildDiagnosticsReport({
      generatedAt: new Date().toISOString(),
      runtime: {
        command: runtime.command.command,
        args: runtime.command.args,
        scriptPath: runtime.scriptPath,
        configPath: runtime.configPath,
        valid: runtime.valid,
        trustLevel: runtime.trust.level,
        trustInterpreter: runtime.trust.interpreter,
        trustScript: runtime.trust.script,
        trustConfig: runtime.trust.config,
        messages: runtime.messages.map((message) => ({ level: message.level, message: message.message })),
      },
      provider: {
        canManage: provider.canManage,
        provider: provider.provider,
        baseUrl: provider.baseUrl,
        model: provider.model,
        hasApiKey: Boolean(provider.apiKey),
        maxTokens: provider.maxTokens,
        enableThinking: provider.enableThinking,
      },
      preflight: {
        inProgress: this.diagnosticsState.inProgress,
        lastRunAt: this.diagnosticsState.lastRunAt,
        result: this.diagnosticsState.result,
      },
      scheduler: {
        mode: this.settings.schedulerMode,
        launchAgentHealth: this.schedulerState.launchAgentHealth,
        nextRunAt: this.schedulerState.nextRunAt,
        lastMessage: this.schedulerState.lastMessage,
      },
      recentLogLines: [...this.recentLog],
    });

    try {
      await navigator.clipboard.writeText(report);
      new Notice("Diagnostics copied to clipboard.", 5000);
    } catch {
      // Fixed copy only: a clipboard-permission error's message is
      // platform/browser text outside this plugin's control and must never
      // be forwarded verbatim into a user-facing Notice.
      new Notice("Could not copy diagnostics to the clipboard.", 8000);
    }
  }

  showStatusSummary(): void {
    const runtime = this.getResolvedRuntime();
    const state = buildMindmapStatusBarState(this, this.getStatusBarInternalState());
    new Notice(buildStatusSummary({
      ready: runtime.valid && state.scopeReady && state.preflightOk !== false,
      pendingAvailable: state.pendingAvailable,
      currentPending: state.currentPending,
      allPending: state.allPending,
      preflightInProgress: state.preflightInProgress,
      preflightOk: state.preflightOk,
      schedulerMode: state.schedulerMode,
      schedulerDetails: state.schedulerDetails,
    }), 8000);
  }

  buildRuntimeCommand(extraArgs: string[] = []): { command: string; args: string[]; cwd: string } {
    assertAllowedPluginArgs(extraArgs, this.app.vault.configDir);
    const runtime = this.getResolvedRuntime();
    return {
      command: runtime.command.command,
      args: [...runtime.command.args, ...extraArgs],
      cwd: runtime.command.cwd,
    };
  }

  async setSchedulerMode(mode: SchedulerMode): Promise<void> {
    this.settings.schedulerMode = mode;
    await this.saveSettings();
    const message = mode === "launchAgent"
      ? "Mindmap LaunchAgent scheduler enabled. Runs continue when Obsidian is closed."
      : mode === "interval"
        ? `Mindmap interval scheduler enabled. Next run ${formatTimestamp(this.schedulerState.nextRunAt)}.`
        : "Mindmap schedulers disabled. Manual runs remain available.";
    new Notice(message, 8000);
  }

  /**
   * Checkpoint 10B FORCE COMMANDS: maps `ProductionEngine.recheckReadiness()`'s
   * `PreflightReportV1` onto the existing `PreflightResult` UI contract --
   * a purely mechanical rename (`HealthStatus` "ok"/"degraded"/"unavailable"
   * collapses to the UI's "ok"/"error"; there is no live subprocess, so
   * `rawStdout`/`rawStderr` stay empty and `exitCode` is derived from
   * `summary.runtimeReady`), never a behavior change to the UI itself.
   */
  private static toPreflightResult(report: PreflightReportV1): PreflightResult {
    const ok = report.summary.runtimeReady;
    return {
      ok,
      summary: `TypeScript engine preflight: ${report.summary.overallStatus} (${report.summary.requiredOkCount}/${report.summary.requiredCount} required, ${report.summary.optionalOkCount}/${report.summary.optionalCount} optional ok).`,
      checks: report.checks.map((check) => ({
        code: check.code,
        label: check.code,
        status: check.status === "ok" ? "ok" : "error",
        message: check.message,
        guidance: check.guidance,
        context: check.context,
      })),
      rawStdout: "",
      rawStderr: "",
      exitCode: ok ? 0 : 1,
    };
  }

  /**
   * Checkpoint 10B FORCE COMMANDS: preflight is the TypeScript engine's own
   * `recheckReadiness()` whenever a `ProductionEngine` is composed for this
   * vault -- re-probes every capability AND resumes the ordinary job
   * pump/scheduler if a previously-degraded provider has recovered (see
   * that method's own doc comment) -- NEVER the Python `--preflight`
   * subprocess below, which stays reachable only as the non-desktop-adapter
   * fallback.
   */
  private async runProductionPreflight(trigger: "manual" | "startup", engine: ProductionEngine): Promise<PreflightResult> {
    this.diagnosticsState.inProgress = true;
    this.updateStatusBar();
    const report = await engine.recheckReadiness();
    const result = MindmapPlugin.toPreflightResult(report);
    this.diagnosticsState.inProgress = false;
    this.diagnosticsState.result = result;
    this.diagnosticsState.lastRunAt = Date.now();
    this.appendLog(`[preflight] ${result.summary}`);
    this.updateStatusBar();
    if (trigger === "manual" || !result.ok) {
      new Notice(formatPreflightNotice(result), 12000);
    }
    return result;
  }

  async runPreflight(trigger: "manual" | "startup"): Promise<PreflightResult> {
    if (this.productionEngine) {
      return await this.runProductionPreflight(trigger, this.productionEngine);
    }
    if (this.productionEngineFailed) {
      const summary = "The Mindmap TypeScript engine failed to start for this vault. Preflight is unavailable.";
      const result: PreflightResult = {
        ok: false,
        summary,
        checks: [
          {
            code: "PRODUCTION_ENGINE_FAILED",
            label: "Mindmap TypeScript engine",
            status: "error",
            message: summary,
            guidance: "Check the Mindmap log for the [production-engine] start() failure, then restart Obsidian.",
          },
        ],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      };
      this.diagnosticsState.result = result;
      this.diagnosticsState.lastRunAt = Date.now();
      this.appendLog(`[preflight] ${summary}`);
      if (trigger === "manual") {
        new Notice(summary, 10000);
      }
      this.updateStatusBar();
      return result;
    }
    if (this.isRuntimeSetupBlocking()) {
      // Never spawn the legacy pythonCommand (often a bare "python3" that
      // discovery already knows is missing/incompatible) while setup is
      // pending: return one fixed setup-required result instead.
      const runtimeMessage = this.runtimeCoordinator?.getState().message ?? "Checking for a compatible Mindmap runtime.";
      const summary = `Mindmap runtime setup is required before preflight can run. ${runtimeMessage}`;
      const result: PreflightResult = {
        ok: false,
        summary,
        checks: [
          {
            code: "RUNTIME_SETUP_REQUIRED",
            label: "Mindmap runtime",
            status: "error",
            message: summary,
            guidance: "Finish Mindmap runtime setup in Settings, then run preflight again.",
          },
        ],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      };
      this.diagnosticsState.result = result;
      this.diagnosticsState.lastRunAt = Date.now();
      this.appendLog(`[preflight] ${summary}`);
      if (trigger === "manual") {
        new Notice(summary, 10000);
      }
      this.updateStatusBar();
      return result;
    }

    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      const result: PreflightResult = {
        ok: false,
        summary: error?.message ?? "Mindmap runtime is not ready.",
        checks: [
          {
            code: "RUNTIME_PATH_INVALID",
            label: "Runtime paths",
            status: "error",
            message: error?.message ?? "Mindmap runtime is not ready.",
            guidance: "Fix the configured paths or reset them to the bundled defaults before running preflight.",
          },
        ],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      };
      this.diagnosticsState.result = result;
      this.diagnosticsState.lastRunAt = Date.now();
      this.appendLog(`[preflight] ${result.summary}`);
      if (trigger === "manual") {
        new Notice(formatPreflightNotice(result), 12000);
      }
      this.updateStatusBar();
      return result;
    }

    let command: { command: string; args: string[]; cwd: string };
    try {
      command = this.buildRuntimeCommand(["--preflight"]);
    } catch (error) {
      const result: PreflightResult = {
        ok: false,
        summary: error instanceof Error ? error.message : "Blocked unexpected preflight arguments.",
        checks: [
          {
            code: "PREFLIGHT_ARGUMENTS_BLOCKED",
            label: "Preflight execution",
            status: "error",
            message: error instanceof Error ? error.message : "Blocked unexpected preflight arguments.",
            guidance: "Use only plugin-managed Mindmap commands.",
          },
        ],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      };
      this.diagnosticsState.result = result;
      this.diagnosticsState.lastRunAt = Date.now();
      this.appendLog(`[preflight] ${result.summary}`);
      if (trigger === "manual") {
        new Notice(formatPreflightNotice(result), 12000);
      }
      this.updateStatusBar();
      return result;
    }

    this.diagnosticsState.inProgress = true;
    this.updateStatusBar();
    this.appendLog(`[preflight] Starting ${formatCommandPreview(runtime, ["--preflight"])}`);

    const result = await new Promise<PreflightResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: unknown) => {
        stdout += String(chunk);
      });

      child.stderr.on("data", (chunk: unknown) => {
        const text = String(chunk);
        stderr += text;
        for (const line of splitLogLines(text)) {
          this.appendLog(`[preflight][stderr] ${line}`);
        }
      });

      child.on("error", (error) => {
        resolve(buildSpawnFailureResult(error, command.command));
      });

      child.on("close", (code) => {
        resolve(parsePreflightOutput(stdout, stderr, code ?? 1));
      });
    });

    this.diagnosticsState.inProgress = false;
    this.diagnosticsState.lastRunAt = Date.now();
    this.diagnosticsState.result = result;
    this.appendLog(`[preflight] ${result.summary}`);
    this.updateStatusBar();

    if (trigger === "manual" || !result.ok) {
      new Notice(formatPreflightNotice(result), 12000);
    }

    return result;
  }

  private syncScheduler(): void {
    if (isSchedulerEnabled(this.settings.schedulerMode) && !this.isRuntimeSetupBlocking()) {
      this.startScheduler();
    } else if (isSchedulerEnabled(this.settings.schedulerMode)) {
      this.stopScheduler("Mindmap runtime setup is required before the interval scheduler can run.");
    } else {
      this.stopScheduler("Manual mode. Interval scheduler disabled.");
    }

    if (isLaunchAgentSchedulerEnabled(this.settings.schedulerMode) && this.productionEngine) {
      void this.reconcileLaunchAgents();
    } else if (this.launchAgentManagedThisSession) {
      void this.disableManagedLaunchAgents("Background wake scheduler disabled.");
    }
    void this.syncCoreSchedules();

    this.updateStatusBar();
  }

  /**
   * Checkpoint 10B LAUNCHAGENT: polls the TypeScript `BackgroundScheduler`'s
   * own owned-plist status -- NEVER a Python process's exit code/log files
   * (there is no such Python process anymore). `BackgroundReconcileStatus`
   * is mapped onto the existing coarse `LaunchAgentHealth` UI union so the
   * status-bar surface stays unchanged.
   */
  refreshLaunchAgentHealth(): Promise<void> {
    if (!isLaunchAgentSchedulerEnabled(this.settings.schedulerMode) || process.platform !== "darwin") {
      return Promise.resolve();
    }
    if (this.launchAgentHealthRefreshInFlight) {
      return this.launchAgentHealthRefreshInFlight;
    }
    const backgroundScheduler = this.productionEngine?.backgroundScheduler;
    if (!backgroundScheduler) {
      return Promise.resolve();
    }
    const refresh = backgroundScheduler.status()
      .then((status) => {
        this.schedulerState.launchAgentHealth = mapBackgroundReconcileStatusToHealth(status);
        this.schedulerState.launchAgentMessage = `Background wake scheduler: ${status}.`;
        this.updateStatusBar();
      })
      .catch((error: unknown) => {
        this.appendLog(`[background-scheduler] status() failed: ${error instanceof Error ? error.message : "unknown error"}`);
      })
      .finally(() => {
        this.launchAgentHealthRefreshInFlight = null;
      });
    this.launchAgentHealthRefreshInFlight = refresh;
    return refresh;
  }

  /**
   * Checkpoint 10B LAUNCHAGENT: reconciles the ONE accepted TS
   * `BackgroundScheduler` adapter -- a fixed `/usr/bin/open <vault-url>`
   * LaunchAgent that only ever OPENS/WAKES this vault at the configured
   * daily/weekly times; it never carries a job payload, note path, or
   * processing logic of its own (see `BackgroundScheduler`'s own doc
   * comment). Once Obsidian is open/foregrounded, `CoreScheduler`
   * (`syncCoreSchedules()` below) performs whatever TS work is actually
   * due. Python is never installed into, or executed by, any LaunchAgent
   * this method writes.
   */
  private async reconcileLaunchAgents(): Promise<void> {
    const syncId = ++this.launchAgentSyncId;
    if (process.platform !== "darwin") {
      this.schedulerState.launchAgentMessage = "Background wake scheduling is only available on macOS.";
      this.updateStatusBar();
      return;
    }
    const backgroundScheduler = this.productionEngine?.backgroundScheduler;
    if (!backgroundScheduler) {
      this.schedulerState.launchAgentMessage = "The Mindmap TypeScript engine is not available in this vault.";
      this.updateStatusBar();
      return;
    }

    try {
      const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const cadences: WakeCadence[] = [
        { hour: normalizeHour(this.settings.launchAgentDailyHour), minute: normalizeMinute(this.settings.launchAgentDailyMinute) },
      ];
      if (this.settings.launchAgentWeeklyEnabled) {
        cadences.push({ hour: normalizeHour(this.settings.launchAgentWeeklyHour), minute: normalizeMinute(this.settings.launchAgentWeeklyMinute), weekday: 0 });
      }
      const result = await backgroundScheduler.reconcile({
        consent: true,
        vaultName: this.app.vault.getName(),
        systemTimeZone,
        cadences: cadences.map((cadence) => toSystemLocalWakeCadence(cadence, systemTimeZone)),
      });
      if (syncId !== this.launchAgentSyncId) {
        return;
      }
      this.launchAgentManagedThisSession = result.status === "installed";
      this.schedulerState.launchAgentHealth = mapBackgroundReconcileStatusToHealth(result.status);
      this.schedulerState.launchAgentMessage = `Background wake scheduler: ${result.status}.`;
      this.schedulerState.lastMessage = "LaunchAgent mode enabled. macOS wakes/opens Obsidian at the scheduled times; the TypeScript engine performs due work once open.";
      this.appendLog(this.schedulerState.launchAgentMessage);
      await this.syncCoreSchedules();
      this.updateStatusBar();
    } catch (error) {
      if (syncId !== this.launchAgentSyncId) {
        return;
      }
      const message = error instanceof Error ? error.message : "Background wake scheduler reconciliation failed.";
      this.schedulerState.launchAgentHealth = "failing";
      this.schedulerState.launchAgentMessage = message;
      this.schedulerState.lastMessage = `Background wake scheduler error: ${message}`;
      this.appendLog(this.schedulerState.lastMessage);
      new Notice(this.schedulerState.lastMessage, 12000);
      this.updateStatusBar();
    }
  }

  private async disableManagedLaunchAgents(message: string): Promise<void> {
    ++this.launchAgentSyncId;
    const backgroundScheduler = this.productionEngine?.backgroundScheduler;
    if (backgroundScheduler) {
      try {
        await backgroundScheduler.remove();
      } catch (error) {
        this.appendLog(`[background-scheduler] remove() failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    this.launchAgentManagedThisSession = false;
    this.schedulerState.launchAgentPaths = [];
    this.schedulerState.launchAgentMessage = message;
    this.schedulerState.launchAgentHealth = null;
    this.schedulerState.launchAgentDetails = [];
    this.schedulerState.launchAgentLastSuccessfulRunAt = null;
    this.schedulerState.launchAgentLastExitCode = null;
    this.appendLog(message);
    this.updateStatusBar();
  }

  /**
   * Checkpoint 10B LAUNCHAGENT: seeds/updates `CoreScheduler`'s three
   * persisted schedules from current settings -- `"daily-maintenance"`
   * (-> `scope-refresh` over `PRODUCTION_SCOPE_ALL`) and `"weekly-refresh"`
   * (-> `rebuild-index`) mirror the retired Python LaunchAgent's own
   * daily/weekly jobs one-to-one; `"reading-sync"` keeps Reading
   * annotations flowing in while Obsidian is open. `enabled` on each
   * definition -- never whether it is configured at all -- is what
   * actually gates whether `CoreScheduler` ever submits a job for it, so
   * calling this whenever settings change is always safe and idempotent.
   * `CoreScheduler` itself only ever runs work while Obsidian is open (see
   * its own class doc); this method never touches `BackgroundScheduler`.
   */
  private async syncCoreSchedules(): Promise<void> {
    const engine = this.productionEngine;
    if (!engine) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const launchAgentModeActive = isLaunchAgentSchedulerEnabled(this.settings.schedulerMode);
    const definitions = [
      {
        schemaVersion: 1 as const,
        id: "daily-maintenance" as const,
        kind: "daily-maintenance" as const,
        enabled: launchAgentModeActive,
        timezone,
        cadence: { type: "daily" as const, hour: normalizeHour(this.settings.launchAgentDailyHour), minute: normalizeMinute(this.settings.launchAgentDailyMinute) },
        pipelineVersion: PRODUCTION_PIPELINE_VERSION,
        scopeId: PRODUCTION_SCOPE_ALL,
      },
      {
        schemaVersion: 1 as const,
        id: "weekly-refresh" as const,
        kind: "weekly-refresh" as const,
        enabled: launchAgentModeActive && this.settings.launchAgentWeeklyEnabled,
        timezone,
        cadence: { type: "weekly" as const, weekday: 0, hour: normalizeHour(this.settings.launchAgentWeeklyHour), minute: normalizeMinute(this.settings.launchAgentWeeklyMinute) },
        pipelineVersion: PRODUCTION_PIPELINE_VERSION,
      },
      {
        schemaVersion: 1 as const,
        id: "reading-sync" as const,
        kind: "reading-sync" as const,
        enabled: this.settings.readingMode === "reading" && this.settings.schedulerMode !== "manual",
        timezone,
        cadence: { type: "interval" as const, intervalMinutes: 60 },
        pipelineVersion: PRODUCTION_PIPELINE_VERSION,
        scopeId: PRODUCTION_SCOPE_READING,
      },
    ];
    for (const raw of definitions) {
      try {
        await engine.coreScheduler.configure(parseScheduleDefinitionV1(raw));
      } catch (error) {
        this.appendLog(`[core-scheduler] configure(${raw.id}) failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  private startScheduler(): void {
    this.clearSchedulerTimer();
    this.scheduleNextTick(Date.now());
    this.appendLog(`Internal scheduler enabled with a ${normalizeSchedulerInterval(this.settings.schedulerIntervalMinutes)} minute interval.`);
  }

  private stopScheduler(message: string): void {
    this.clearSchedulerTimer();
    this.schedulerState.nextRunAt = null;
    this.schedulerState.lastMessage = message;
    this.updateStatusBar();
  }

  private clearSchedulerTimer(): void {
    if (this.schedulerTimer) {
      window.clearTimeout(this.schedulerTimer as ReturnType<typeof window.setTimeout>);
      this.schedulerTimer = null;
    }
  }

  private scheduleNextTick(fromMs: number): void {
    const nextRunAt = computeNextRunAt(this.getSchedulerConfig(), fromMs);
    this.schedulerState.nextRunAt = nextRunAt;
    this.updateStatusBar();
    if (nextRunAt === null) {
      return;
    }

    const delayMs = Math.max(0, nextRunAt - fromMs);
    this.schedulerTimer = window.setTimeout(() => {
      void this.handleScheduledTick();
    }, delayMs);
  }

  private async handleScheduledTick(): Promise<void> {
    this.schedulerTimer = null;
    const action = getSchedulerAction(this.getSchedulerConfig(), this.currentProcess !== null);

    if (action === "skip-disabled") {
      this.schedulerState.lastMessage = "Scheduled tick ignored because scheduling is disabled.";
      this.updateStatusBar();
      return;
    }

    if (action === "skip-running") {
      const message = "Scheduled run skipped because another Mindmap run is already in progress.";
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      this.scheduleNextTick(Date.now());
      return;
    }

    await this.runMindmap("scheduled", "current");
    this.scheduleNextTick(Date.now());
  }

  private updateRunStatusFromLine(line: string): void {
    if (!this.currentProcess) {
      return;
    }

    let status: string | null = null;
    if (line.includes("[omlx] Started server for this run")) {
      status = "Mindmap: starting oMLX";
    } else if (line.includes("[omlx] Server ready")) {
      status = "Mindmap: oMLX ready";
    } else if (line.includes("[omlx] Server already running")) {
      status = "Mindmap: oMLX already running";
    } else if (line.includes("[omlx] Stopping server started by this run")) {
      status = "Mindmap: stopping oMLX";
    }

    if (status) {
      this.activeRunStatus = status;
      this.updateStatusBar();
    }
  }

  async runActiveNote(): Promise<void> {
    await this.refreshActiveNoteEligibility();
    if (!this.activeNoteEligibility.eligible || !this.activeNoteEligibility.path) {
      new Notice(this.activeNoteEligibility.reason, 8000);
      return;
    }
    await this.runMindmap("manual", "note", this.activeNoteEligibility.path);
  }

  async processPendingNote(notePath: string): Promise<void> {
    await this.runMindmap("manual", "note", notePath);
  }

  getActiveNoteEligibility(): ActiveNoteEligibility {
    return this.activeNoteEligibility;
  }

  async refreshActiveNoteEligibility(): Promise<void> {
    this.activeNoteEligibility = await resolveActiveNoteEligibility(this);
    this.updateStatusBar();
  }

  private createReadingModeController(): ReadingModeController {
    const state = this.readingStateStore;
    if (!state) {
      throw new Error("Reading state store is not initialized.");
    }
    return new ReadingModeController({
      initiallyEnabled: this.settings.readingMode === "reading",
      readPayload: () => this.readAppleBooksPayload(),
      readFingerprint: () => this.readAppleBooksFingerprint(),
      importPayload: async (payload) => {
        const result = await importAppleBooksAnnotations(payload, {
          vault: createObsidianVaultApi(this.app.vault),
          state,
        });
        return {
          imported: result.imported,
          failures: result.failures,
          lastSyncAt: result.state.lastSyncAt,
          initialImport: result.initialImport,
        };
      },
      waitForManualResearch: async () => {
        if (this.webResearchPromise) await this.webResearchPromise;
      },
      runAutomaticResearch: async (imported) => {
        if (this.settings.webResearchMode !== "automatic-reading" || this.settings.readingMode !== "reading" || !this.automaticResearchPolicyStore) return;
        if (this.isRuntimeSetupBlocking()) return;
        const now = new Date();
        try {
          await this.refreshAutomaticResearchPolicyStatus(now);
          const currentState = await state.load();
          const candidates = selectSyncResearchCandidates(imported, currentState.annotations);
          const policyResult = await runAutomaticResearch({
            store: this.automaticResearchPolicyStore,
            now,
            candidates,
            shouldContinue: () => this.readingModeController?.getMode() === "reading" && this.settings.webResearchMode === "automatic-reading" && !this.isRuntimeSetupBlocking(),
            attempt: async (item) => {
              const file = this.app.vault.getAbstractFileByPath(item.notePath);
              if (!(file instanceof TFile)) throw new WebResearchError("NOTE_MISSING", "Automatic research note is unavailable.");
              const text = prepareActiveNoteResearchInput(await this.app.vault.cachedRead(file), MAX_RESEARCH_INPUT_CHARS);
              if (!text) {
                return await persistAutomaticResearchOutcome({
                  outcome: { ok: false, code: "RESEARCH_INPUT_EMPTY", message: "Automatic research note is empty." },
                  updateStatus: async (status) => await updateAppleAnnotationResearchStatus(createObsidianVaultApi(this.app.vault), state, item.annotationId, status),
                });
              }
              const outcome = await this.researchFile(file, text, false, "automatic");
              return await persistAutomaticResearchOutcome({
                outcome,
                updateStatus: async (status) => await updateAppleAnnotationResearchStatus(createObsidianVaultApi(this.app.vault), state, item.annotationId, status),
              });
            },
          });
          if (policyResult.pauseReason) {
            this.webResearchLastError = policyResult.lastError ?? `Automatic research paused: ${policyResult.pauseReason}.`;
            this.webResearchActivity = "error";
          } else if (this.settings.webResearchMode === "automatic-reading") {
            this.webResearchLastError = null;
            this.webResearchActivity = "ready";
          }
        } finally {
          await this.refreshAutomaticResearchPolicyStatus(now);
          this.updateStatusBar();
        }
      },
      onAutomaticResearchError: (message) => {
        this.webResearchActivity = "error";
        this.webResearchLastError = message;
        this.updateStatusBar();
      },
      listPendingEligibleNotes: async () => {
        const current = await state.load();
        return Object.values(current.annotations)
          .filter((entry) => entry.researchStatus !== "too-short" && entry.processedAt === null)
          .map((entry) => entry.notePath)
          .sort();
      },
      countUnresearchable: async () => {
        const current = await state.load();
        return Object.values(current.annotations).filter((entry) => entry.researchStatus === "unresearchable").length;
      },
      processNote: async (notePath) => {
        return await this.runMindmap("reading", "note", notePath);
      },
      markProcessed: async (notePath) => {
        const { result: found } = await state.mutate((current) => {
          const entry = Object.values(current.annotations).find((value) => value.notePath === notePath);
          if (!entry) return false;
          entry.processedAt = new Date().toISOString();
          return true;
        });
        if (!found) {
          throw new Error(`Reading state entry not found for ${notePath}.`);
        }
      },
      confirmSetup: (preview) => this.confirmReadingSetup(preview),
      onModeChange: async (mode) => {
        const previous = this.settings.readingMode;
        this.settings.readingMode = mode;
        try {
          await this.saveSettings();
        } catch (error) {
          this.settings.readingMode = previous;
          throw error;
        }
      },
      onHealthChange: () => this.updateStatusBar(),
    });
  }

  private async confirmReadingSetup(preview: ReadingPreview): Promise<boolean> {
    return await confirmMindmapRun(this.app, {
      title: "Enable Reading Mode?",
      message: `Apple Books access is ready. Found ${preview.annotationCount} annotations; ${preview.eligibleCount} meet the eight-word processing threshold and ${preview.tooShortCount} will be imported as too-short. No annotations will be imported unless you confirm this sync.`,
      confirmText: "Enable and sync",
      confirmClass: "mod-cta",
    });
  }

  /**
   * The Apple Books reader is stdlib-only, so it only needs a real Python
   * executable — never the full chromadb/ruamel.yaml package set. Prefer
   * checkpoint-1's discovered interpreter (verified executable, supported
   * version) over the settings' raw pythonCommand default, since a blank
   * "python3" may not exist or may resolve to an incompatible interpreter
   * even while discovery already found a good one. An explicit custom
   * pythonCommand (coordinator phase "not-applicable") always wins, as does
   * any state before the coordinator has produced an interpreter at all.
   */
  private getAppleBooksInterpreterCommand(): string {
    const coordinatorState = this.runtimeCoordinator?.getState();
    if (coordinatorState && coordinatorState.phase !== "not-applicable" && coordinatorState.interpreterPath) {
      return coordinatorState.interpreterPath;
    }
    return this.getResolvedRuntime().command.command;
  }

  /**
   * Checkpoint 10B item 6: reads Apple Books annotations through the real
   * TypeScript `AppleBooksSqliteReader` this vault's `ProductionEngine`
   * already composes (fixed `/usr/bin/sqlite3`, no shell -- see
   * `sqliteProcess.ts`) -- never the Python `apple_books_reader.py`
   * subprocess. `AppleBooksReadResult` is deliberately shaped to match the
   * Python reader's own historical stdout payload byte-for-byte
   * (`{version, status, annotations, diagnostics, count, ...}`), so
   * `importAppleBooksAnnotations`'s existing `validateAppleBooksReaderPayload`
   * parsing needs no changes at all.
   */
  private async readAppleBooksPayload(): Promise<unknown> {
    if (!this.productionEngine) {
      throw new Error("Mindmap TypeScript engine is not available for Apple Books reading.");
    }
    return await this.productionEngine.appleBooksReader.readAnnotations();
  }

  private async readAppleBooksFingerprint(): Promise<string> {
    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      throw new Error("Mindmap runtime is not ready for Apple Books watching.");
    }
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(await fs.promises.readFile(runtime.configPath, "utf8")) as Record<string, unknown>;
    } catch {
      // The reader will provide the actionable config diagnostic during sync.
    }
    const candidates = await discoverAppleBooksDatabasePaths({
      config,
      homeDirectory: os.homedir(),
      fileSystem: { readdir: async (directory) => await fs.promises.readdir(directory) },
    });
    const fingerprints: string[] = [];
    for (const candidate of candidates) {
      for (const sidecar of [candidate, `${candidate}-wal`, `${candidate}-shm`]) {
        try {
          const stat = await fs.promises.stat(sidecar);
          fingerprints.push(`${sidecar}:${stat.size}:${stat.mtimeMs}`);
        } catch {
          fingerprints.push(`${sidecar}:missing`);
        }
      }
    }
    return fingerprints.join("|");
  }

  private async runReaderProcess(command: string, args: string[], cwd: string): Promise<unknown> {
    if (this.activeReaderChild) throw new Error("Apple Books reader is already running.");
    const started = startAppleBooksReaderProcess({
      spawn: () => spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }),
    });
    this.activeReaderChild = started.child as ChildProcess;
    try { return await started.promise; } finally {
      if (this.activeReaderChild === started.child) this.activeReaderChild = null;
    }
  }

  /**
   * Checkpoint 10B item 2: the actual TypeScript-engine run path for
   * `"current"`/`"all"`/`"note"` scopes. Standard Mode (this whole method's
   * OWN early guards below aside) always stays usable; index-dependent
   * work specifically is gated on migration being `"complete"` -- a
   * not-yet-migrated vault gets a plain guidance Notice pointing at the
   * status menu's Start/Retry action, never a silent no-op and never a
   * Python fallback.
   */
  private async runMindmapViaProductionEngine(trigger: RunTrigger, scope: RunScope, notePath?: string): Promise<boolean> {
    const engine = this.productionEngine;
    if (!engine) return false;
    if (["deriving", "searching", "writing"].includes(this.webResearchActivity)) {
      const message = "Web Research is using the local model. Mindmap run skipped.";
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 8000);
      this.updateStatusBar();
      return false;
    }
    if (!this.getScopeSetupStatus().complete) {
      const message = `Mindmap ${trigger} run skipped: ${this.getScopeSetupStatus().guidance}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }
    const migrationStatus = await engine.getMigrationStatus();
    if (migrationStatus.phase !== "complete") {
      const message = `Mindmap ${trigger} run skipped: the TypeScript engine's migration is not complete yet (${migrationStatus.phase}). Open the Mindmap status menu to Start/Retry migration.`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }
    try {
      if (scope === "note") {
        if (!notePath) throw new Error("An individual note path is required.");
        await engine.submitNoteForProcessing(notePath, trigger);
      } else if (scope === "rebuildAll") {
        await engine.submitRebuild(trigger);
      } else if (scope === "refreshAll" || scope === "metadataAll") {
        // Checkpoint 10B FORCE COMMANDS: refreshAll/metadataAll are behaviorally identical under
        // the TS pipeline -- discovery always returns every eligible "all"-scope note regardless of
        // its current sourceHash, and JobEngine.submit() only ever coalesces onto an existing
        // NON-terminal job for the same identity+sourceHash (see JobStore.appendOrCoalesce); a note
        // whose prior process-note job already reached a terminal status gets a brand-new job, never
        // silently skipped. There is no separate "metadata-only, no re-embed" pipeline mode to give
        // metadataAll a distinct meaning from refreshAll, so both route to the SAME explicit
        // force-scope operation: a full "all"-scope refresh.
        await engine.submitScopeRefresh(PRODUCTION_SCOPE_ALL, trigger);
      } else {
        await engine.submitScopeRefresh(scope === "current" ? PRODUCTION_SCOPE_CURRENT : PRODUCTION_SCOPE_ALL, trigger);
      }
      const message = `Mindmap ${trigger} ${scope === "note" ? `note ${notePath}` : `${scope} scope`} run submitted to the TypeScript engine.`;
      this.schedulerState.lastTrigger = trigger;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 8000);
      this.updateStatusBar();
      return true;
    } catch (error) {
      const message = `Mindmap ${trigger} run failed: ${error instanceof Error ? error.message : "unknown error"}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }
  }

  /**
   * Checkpoint 10B FORCE COMMANDS: every `RunScope` is routed through the
   * TypeScript `ProductionEngine` whenever one is available for this vault
   * -- NEVER the Python subprocess. `"current"`/`"all"`/`"note"` submit an
   * ordinary scope-refresh/note job; `"refreshAll"`/`"metadataAll"` submit
   * a force "all"-scope refresh (both route to the SAME operation -- see
   * `runMindmapViaProductionEngine`'s own doc comment on why they are
   * behaviorally identical under this pipeline); `"rebuildAll"` submits a
   * `"rebuild-index"` job.
   */
  async runMindmap(trigger: RunTrigger, scope: RunScope = "current", notePath?: string): Promise<boolean> {
    if (this.productionEngine) {
      return await this.runMindmapViaProductionEngine(trigger, scope, notePath);
    }
    if (this.productionEngineFailed) {
      const message = `Mindmap ${trigger} run skipped: the TypeScript engine failed to start for this vault.`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }
    if (this.isRuntimeSetupBlocking()) {
      const runtimeMessage = this.runtimeCoordinator?.getState().message ?? "Checking for a compatible Mindmap runtime.";
      const message = `Mindmap ${trigger} run skipped: runtime setup is required. ${runtimeMessage}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      if (trigger === "manual") {
        new Notice(message, 12000);
      }
      this.updateStatusBar();
      return false;
    }
    if (["deriving", "searching", "writing"].includes(this.webResearchActivity)) {
      const message = "Web Research is using the local model. Mindmap run skipped.";
      this.appendLog(message);
      if (trigger === "manual") new Notice(message, 8000);
      this.updateStatusBar();
      return false;
    }
    if (this.currentProcess) {
      const message = "Mindmap is already running. Skipping the new request.";
      this.appendLog(message);
      if (trigger === "manual") {
        new Notice(message, 8000);
      }
      return false;
    }

    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      const message = `Mindmap ${trigger} run skipped: ${error?.message ?? "runtime is not ready"}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }

    const scopeSetup = this.getScopeSetupStatus();
    if (!scopeSetup.complete) {
      const message = `Mindmap ${trigger} run skipped: ${scopeSetup.guidance}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }

    let command: { command: string; args: string[]; cwd: string };
    let profile: RunProfile;
    try {
      profile = getRunProfile(scope, notePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "An individual note path is required.";
      this.appendLog(message);
      new Notice(message, 8000);
      return false;
    }

    if (trigger === "manual" && profile.confirmation) {
      const confirmed = await confirmMindmapRun(this.app, profile.confirmation);
      if (!confirmed) {
        const message = `Mindmap ${profile.label} run cancelled.`;
        this.schedulerState.lastMessage = message;
        this.appendLog(message);
        this.updateStatusBar();
        return false;
      }
    }

    if (this.currentProcess) {
      const message = "Mindmap is already running. Skipping the new request.";
      this.appendLog(message);
      if (trigger === "manual") {
        new Notice(message, 8000);
      }
      this.updateStatusBar();
      return false;
    }

    try {
      command = this.buildRuntimeCommand(profile.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Blocked unexpected subprocess arguments.";
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return false;
    }

    const preview = formatCommandPreview(runtime, profile.args);
    this.appendLog(`Starting ${trigger} ${profile.label} run: ${preview}`);
    if (trigger === "manual") {
      new Notice(`Mindmap run started (${profile.label}). ${preview}`, 8000);
    }

    return await new Promise<boolean>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentProcess = child;
      this.activeRunStatus = `Mindmap: ${profile.label}`;
      this.schedulerState.lastTrigger = trigger;
      this.schedulerState.lastMessage = `Running ${profile.label} via ${trigger} trigger.`;
      this.updateStatusBar();

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      child.stdout.on("data", (chunk: unknown) => {
        for (const line of splitLogLines(String(chunk))) {
          stdoutLines.push(line);
          this.appendLog(`[stdout] ${line}`);
          this.updateRunStatusFromLine(line);
        }
      });

      child.stderr.on("data", (chunk: unknown) => {
        for (const line of splitLogLines(String(chunk))) {
          stderrLines.push(line);
          this.appendLog(`[stderr] ${line}`);
          this.updateRunStatusFromLine(line);
        }
      });

      child.on("error", (error) => {
        const message = `Mindmap ${trigger} ${profile.label} run failed to start: ${error.message}`;
        this.currentProcess = null;
        this.activeRunStatus = null;
        this.schedulerState.lastRunAt = Date.now();
        this.schedulerState.lastExitCode = -1;
        this.schedulerState.lastMessage = message;
        this.appendLog(message);
        if (trigger === "manual") {
          new Notice(message, 12000);
        }
        this.updateStatusBar();
        resolve(false);
      });

      child.on("close", (code) => {
        this.currentProcess = null;
        this.activeRunStatus = null;
        this.schedulerState.lastRunAt = Date.now();
        this.schedulerState.lastExitCode = code;
        const failureContext = stderrLines[stderrLines.length - 1] ?? stdoutLines[stdoutLines.length - 1];
        this.schedulerState.lastMessage = code === 0
          ? `Last ${trigger} ${profile.label} run finished successfully.`
          : `Last ${trigger} ${profile.label} run exited with code ${code}.${failureContext ? ` ${failureContext}` : ""}`;
        this.appendLog(this.schedulerState.lastMessage);
        if (code !== 0 || trigger === "manual") {
          new Notice(this.schedulerState.lastMessage, 10000);
        }
        this.pendingScanService?.requestRefresh("run completed");
        this.updateStatusBar();
        resolve(code === 0);
      });
    });
  }

  private appendLog(message: string): void {
    const timestamped = `[${new Date().toLocaleString()}] ${message}`;
    this.recentLog.push(timestamped);
    if (this.recentLog.length > LOG_LIMIT) {
      this.recentLog.shift();
    }
    console.debug(`[Mindmap] ${message}`);
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }

    const pendingSnapshot = this.getPendingSnapshot();
    this.schedulerState.pendingAllCount = pendingSnapshot.available ? pendingSnapshot.all.total : null;
    renderStatusBarElement(this.statusBarEl, buildMindmapStatusBarState(this, this.getStatusBarInternalState()));
  }

  private getRuntimeContext(): RuntimeContext {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      throw new Error("Mindmap requires the desktop filesystem adapter.");
    }

    const vaultRoot = this.app.vault.adapter.getBasePath();
    const configDir = this.app.vault.configDir;
    const pluginDirRelative = this.manifest.dir ?? path.posix.join(configDir, "plugins", this.manifest.id);

    return {
      vaultRoot,
      configDir,
      pluginDir: path.join(vaultRoot, pluginDirRelative),
    };
  }

  private async ensureBundledRuntime(): Promise<void> {
    const runtimeDir = getPluginRuntimeDir(this.getRuntimeContext());
    const result = await ensureBundledRuntimeAssets(
      runtimeDir,
      BUNDLED_RUNTIME_ASSETS,
      {
        existsSync: fs.existsSync,
        mkdir: async (targetPath, options) => {
          await fs.promises.mkdir(targetPath, options);
        },
        writeFile: (targetPath, content, encoding) => fs.promises.writeFile(targetPath, content, encoding),
      },
    );

    this.appendLog(`[runtime] ${result.message}`);
    if (!result.ok) {
      new Notice(result.message, 12000);
      return;
    }

    const configMigration = await migrateLegacyPluginVaultRoot(path.join(runtimeDir, "config.json"), this.app.vault.configDir, {
      existsSync: fs.existsSync,
      readFile: (targetPath, encoding) => fs.promises.readFile(targetPath, encoding),
      writeFile: (targetPath, content, encoding) => fs.promises.writeFile(targetPath, content, encoding),
    });
    if (configMigration.message) {
      this.appendLog(`[runtime] ${configMigration.message}`);
      new Notice(configMigration.message, 12000);
    }
  }

  private canManageConfig(runtime: ResolvedRuntime): boolean {
    const runtimeDir = getPluginRuntimeDir(this.getRuntimeContext());
    return path.normalize(runtime.configPath).startsWith(path.normalize(runtimeDir));
  }

  /**
   * Reads the SAME `config.json` the Python runtime reads (bounded,
   * fail-soft -- `null` on anything missing/oversized/malformed, mirroring
   * `devShadowIntegration.ts`'s own `readBoundedJsonConfig`, never a raw
   * parse error escaping to a caller).
   */
  private readBoundedRuntimeConfig(configPath: string): Record<string, unknown> | null {
    try {
      const stat = fs.statSync(configPath);
      if (stat.size > PRODUCTION_CONFIG_MAX_BYTES) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * Checkpoint 10B item 1: composes the real `ProductionEngineOptions` this
   * vault's `ProductionEngine` is constructed with -- real Obsidian
   * `Vault`/`Workspace`/`TFile`/`TFolder`, a `NodeOwnedFs` confined to
   * `<pluginDir>/data/production-engine`, this vault's current Ollama-only
   * embedding config and (Ollama-only, never `openai_compatible`) local
   * metadata config, explicit Apple Books config/home, and the bounded
   * readiness probes every capability above is checked against. Returns
   * `null` only when the desktop filesystem adapter itself is unavailable
   * (`getRuntimeContext()` throws) -- every other missing/invalid piece of
   * config degrades a single capability (embedding/metadata/Apple Books)
   * to `null`/an "unconfigured" probe rather than blocking construction:
   * Standard Mode must stay usable on a fresh install with no config.json
   * written yet.
   */
  private buildProductionEngineOptions(): ProductionEngineOptions | null {
    let context: RuntimeContext;
    try {
      context = this.getRuntimeContext();
    } catch {
      return null;
    }
    const runtime = this.getResolvedRuntime();
    const rawConfig = runtime.valid ? this.readBoundedRuntimeConfig(runtime.configPath) : null;
    const cfg = toProductionRuntimeConfig(rawConfig);
    const scope = runtime.valid ? this.readProductionScopeFolders(runtime.configPath) : { currentPaths: [], allPaths: [] };

    const embeddingProvider = cfg.embedProvider === "ollama" && cfg.embedBaseUrl && cfg.embedModel
      ? new OllamaEmbeddingProvider({ baseUrl: cfg.embedBaseUrl, model: cfg.embedModel }, { fetchImpl: requestUrlFetch, sleep: createWindowSleep() })
      : null;
    const embeddingModel = embeddingProvider ? (cfg.embedModel ?? null) : null;
    const embeddingDimension = embeddingModel ? resolveKnownEmbeddingDimension(embeddingModel, cfg.embedDimension) : undefined;

    // Item 7: STRICT Ollama-only metadata inference -- an `openai_compatible` `llm_provider`
    // (this vault's own current default, pointing at a local MLX server) is deliberately never
    // wired here, mirroring `devShadowIntegration.ts`'s identical Ollama-only contract. A vault
    // configured that way simply has no local metadata provider yet; `process-note` jobs stay
    // composed but their pump never starts until the user points `llm_provider` at `"ollama"`.
    const metadataProvider = cfg.llmProvider === "ollama" && cfg.llmBaseUrl
      ? createOllamaMetadataProvider({ baseUrl: cfg.llmBaseUrl }, { fetchImpl: requestUrlFetch })
      : null;
    const metadataPipelineConfig = metadataProvider && cfg.llmModel
      ? {
        model: cfg.llmModel,
        maxTokens: cfg.llmMaxTokens,
        tagLimit: cfg.tagLimit,
        conceptLimit: cfg.conceptLimit,
        conceptMaxWords: cfg.conceptMaxWords,
        conceptCaseMode: cfg.conceptCaseMode,
        controlledTags: [],
        allowFreeTags: cfg.allowFreeTags,
        tagMinLen: cfg.tagMinLen,
        tagMaxWords: cfg.tagMaxWords,
        tagAliases: {},
      }
      : null;

    const probes: ProductionEngineOptions["probes"] = {
      researchProvider: createResearchCredentialReadinessProbe(hasExaCredential),
    };
    if (embeddingProvider && embeddingModel) {
      probes.ollama = createOllamaEmbeddingReadinessProbe(embeddingProvider, { model: embeddingModel });
    }
    if (metadataProvider && cfg.llmModel) {
      probes.localMetadataProvider = createLocalMetadataReadinessProbe(metadataProvider, cfg.llmModel);
    }
    const appleBooksConfig = rawConfig ?? {};
    const appleBooksReaderForProbe = new AppleBooksSqliteReader({
      sqliteProcess: createNodeSqliteProcess(),
      fs: createNodeAppleBooksFsAdapter(),
      config: appleBooksConfig,
      homeDirectory: os.homedir(),
    });
    probes.appleBooksReading = createAppleBooksReadinessProbe(appleBooksReaderForProbe);

    const dataRoot = path.join(context.pluginDir, "data", "production-engine");

    return {
      dataRoot,
      backgroundScheduler: {
        platform: process.platform,
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
        userHomeDir: os.homedir(),
        installationId: this.getBackgroundSchedulerInstallationId(context),
        fs: createNodeBackgroundSchedulerFs(),
        process: createNodeBackgroundSchedulerProcessRunner(),
      },
      fs: new NodeOwnedFs(dataRoot),
      registrar: {
        registerInterval: (callback, intervalMs) => this.registerInterval(window.setInterval(callback, intervalMs)),
        cancelInterval: (handle) => window.clearInterval(handle as number),
      },
      vault: this.app.vault,
      workspace: this.app.workspace,
      vaultFileClasses: { TFile, TFolder },
      embeddingProvider,
      embeddingModel,
      embeddingDimension,
      chunkOptions: { targetTokens: cfg.chunkTargetTokens, overlapTokens: cfg.chunkOverlapTokens },
      relatedSelectionConfig: {
        relatedLimit: cfg.relatedLimit,
        overreachCount: cfg.relatedOverreach,
        creativeCount: cfg.relatedCreative,
        creativeMin: cfg.relatedCreativeMin,
        creativeMax: cfg.relatedCreativeMax,
        candidateLimit: cfg.relatedCandidateLimit,
        minScore: cfg.relatedMinScore,
      },
      metadataProvider,
      metadataPipelineConfig,
      scopeFolders: scope.allPaths,
      currentScopeFolders: scope.currentPaths,
      minimumWords: cfg.minimumWords,
      configDir: this.app.vault.configDir,
      runtimeFolder: context.pluginDir.startsWith(context.vaultRoot)
        ? path.posix.join(context.configDir, "plugins", this.manifest.id)
        : undefined,
      pipelineVersion: PRODUCTION_PIPELINE_VERSION,
      appleBooks: {
        config: appleBooksConfig,
        homeDirectory: os.homedir(),
        annotationDbPath: cfg.appleAnnotationDbPath,
        libraryDbPath: cfg.appleLibraryDbPath,
      },
      probes,
      onFault: (fault) => {
        this.appendLog(`[production-engine] ${fault.source} fault: ${fault.code}`);
      },
    };
  }

  /** Checkpoint 10B LAUNCHAGENT: a stable, bounded lowercase-alphanumeric token (`BackgroundScheduler`'s own `installationId` contract) derived from this vault's absolute root path -- stable across restarts/renames of the PLUGIN, but intentionally changes if the VAULT itself is moved/renamed (a moved vault is a genuinely different filesystem location for `/usr/bin/open` to target). Never a display name. */
  private getBackgroundSchedulerInstallationId(context: RuntimeContext): string {
    return createHash("sha256").update(context.vaultRoot).digest("hex").slice(0, 32);
  }

  private readProductionScopeFolders(configPath: string): ScopeSelection {
    try {
      return readScopeSelection(fs.readFileSync(configPath, "utf8"));
    } catch {
      return { currentPaths: [], allPaths: [] };
    }
  }

  /**
   * Checkpoint 10B item 1 / final cleanup: constructs and starts this
   * vault's ONE `ProductionEngine`, then disposes it immediately if
   * construction OR `start()` itself throws (never leaves a half-started
   * engine referenced by `this.productionEngine`). A `null` COMPOSITION
   * (`buildProductionEngineOptions()` returning `null` -- no desktop
   * filesystem adapter, construction never even attempted) leaves
   * `this.productionEngine` `null` with `productionEngineFailed` staying
   * `false` -- Standard Mode's existing Python fallback remains the
   * intentional behavior there. A construction/`start()` FAILURE instead
   * sets `productionEngineFailed = true`, which every command that would
   * otherwise silently fall back to Python checks first and fails closed
   * on -- a real engine bug must never be silently observed by the user
   * as "quietly running Python again."
   */
  private async startProductionEngine(): Promise<void> {
    const options = this.buildProductionEngineOptions();
    if (!options) return;
    try {
      const engine = new ProductionEngine(options);
      this.productionEngine = engine;
      await engine.start();
    } catch (error) {
      this.appendLog(`[production-engine] start() failed: ${error instanceof Error ? error.message : "unknown error"}`);
      await this.productionEngine?.dispose();
      this.productionEngine = null;
      this.productionEngineFailed = true;
      new Notice("The Mindmap TypeScript engine failed to start for this vault. Automated runs, preflight, and sidebar search are unavailable until this is resolved.", 12000);
    }
    await this.refreshCachedMigrationStatus();
  }

  /** Item 3: current migration status -- `null` when the production engine itself is unavailable (e.g. non-desktop filesystem adapter). Never throws. */
  async getProductionMigrationStatus(): Promise<MigrationStatusV1 | null> {
    if (!this.productionEngine) return null;
    return this.productionEngine.getMigrationStatus();
  }

  /**
   * Item 3: a SYNCHRONOUS snapshot of the last-known migration status, for
   * the status bar menu's own synchronous `buildMindmapStatusBarState`
   * (menu building cannot itself be async). Refreshed opportunistically --
   * right after `startProductionEngine()`, whenever the status menu opens,
   * and after every Start/Retry/Cancel action -- never guaranteed to be
   * the absolute latest tick, exactly like `getPendingSnapshot()`'s own
   * cached-and-refreshed pattern.
   */
  private cachedMigrationStatus: MigrationStatusV1 | null = null;

  getCachedProductionMigrationStatus(): MigrationStatusV1 | null {
    return this.cachedMigrationStatus;
  }

  async refreshCachedMigrationStatus(): Promise<void> {
    this.cachedMigrationStatus = await this.getProductionMigrationStatus();
  }

  /** Item 3: `true` once the production engine's ordinary JobEngine pump AND CoreScheduler have both actually started -- migration complete AND both Ollama readiness probes ok (see `ProductionEngine.tryStartOrdinaryWork`). */
  getProductionOrdinaryWorkStatus(): { pumpStarted: boolean; schedulerStarted: boolean } | null {
    if (!this.productionEngine) return null;
    return this.productionEngine.getOrdinaryWorkStatus();
  }

  /** Item 3: Start/Retry action for the migration status UI -- surfaces the engine's own closed `MIGRATION_NOT_STARTABLE` guard (engine not started, or the fresh embedding probe not ok) as a plain Notice rather than an unhandled rejection. */
  async startProductionMigration(): Promise<void> {
    if (!this.productionEngine) {
      new Notice("Mindmap TypeScript engine is not available in this vault.", 10000);
      return;
    }
    try {
      await this.productionEngine.startMigration();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Migration could not be started.", 10000);
    }
    await this.refreshCachedMigrationStatus();
    this.updateStatusBar();
  }

  /** Item 3: alias for `startProductionMigration()` -- valid only once the current status reports `canRetry` (phase `"failed"`); the migration UI itself only ever shows a Retry action in that state. */
  async retryProductionMigration(): Promise<void> {
    await this.startProductionMigration();
  }

  /** Item 3: Cancel action for the migration status UI. A no-op once activation has begun (`MigrationRunner.cancel()`'s own documented behavior) -- surfaced as informational, never as an error. */
  async cancelProductionMigration(): Promise<void> {
    if (!this.productionEngine) return;
    await this.productionEngine.cancelMigration();
    await this.refreshCachedMigrationStatus();
    this.updateStatusBar();
  }

  /** Item 2: re-probes provider readiness and resumes the ordinary pump/CoreScheduler once a previously-degraded provider recovers (or stops them once a previously-ok one degrades) -- see `ProductionEngine.recheckReadiness`. Safe to call at any time. */
  async recheckProductionReadiness(): Promise<PreflightReportV1 | null> {
    if (!this.productionEngine) return null;
    const report = await this.productionEngine.recheckReadiness();
    this.updateStatusBar();
    return report;
  }

  /**
   * Lazily composes the optional diagnostics overlay integration over a
   * real, plugin-owned data directory (`<pluginDir>/data/mindmap-engine`)
   * -- never the vault root, never any Python-managed path. Only ever
   * called from the dev-only diagnostics command's `callback`, itself only
   * registered behind `__MINDMAP_DEV_BUILD__`. The integration owns and
   * disposes its own engine; this method never touches engine internals
   * directly.
   */
  private getOrCreateDiagOverlay(): DevShadowIntegration {
    if (this.diagOverlay) return this.diagOverlay;
    this.diagOverlay = createDevShadowIntegration({
      pluginDir: this.getRuntimeContext().pluginDir,
      vault: this.app.vault,
      registerInterval: (callback, intervalMs) => this.registerInterval(window.setInterval(callback, intervalMs)),
      appendLog: (message) => this.appendLog(message),
      notice: (message, durationMs) => { new Notice(message, durationMs); },
      getResolvedRuntime: () => this.getResolvedRuntime(),
      canManageConfig: (runtime) => this.canManageConfig(runtime),
      fetchImpl: requestUrlFetch,
    });
    return this.diagOverlay;
  }

}

type ResearchFileResult =
  | { ok: true }
  | { ok: false; code: string; message: string };
