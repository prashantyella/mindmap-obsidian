import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { FileSystemAdapter, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";

import { formatPreflightNotice, type PreflightResult } from "./diagnostics";
import { listVaultFolderOptions, type ScopeSelection, type VaultFolderOption } from "./onboarding";
import { createProductionPendingScanService, ProductionPendingScanService } from "./engine/productionPendingScan";
import type { PendingSnapshot } from "./pendingScan";
import { discoverAppleBooksDatabasePaths } from "./appleBooksDiscovery";
import { classifyResearchTarget, completeAppleAnnotationResearchForNote, importAppleBooksAnnotations, updateAppleAnnotationResearchStatus, writeAppleAnnotationCompanion } from "./appleBooksImport";
import { clearTransientAutomaticPause, createAutomaticResearchPolicy, createAutomaticResearchPolicyStore, loadAutomaticResearchPolicySafely, localResearchDay, type AutomaticResearchPolicyState, type AutomaticResearchPolicyStore } from "./automaticResearchPolicy";
import { persistAutomaticResearchOutcome, runAutomaticResearch, selectSyncResearchCandidates } from "./automaticResearch";
import { ExaResearchProvider } from "./exaResearchProvider";
import { requestUrlFetch } from "./obsidianRequestUrlFetch";
import { getExaCredential, hasExaCredential } from "./keychainCredential";
import { createConfiguredLocalResearchModel } from "./localResearchModel";
import { isSafeManualResearchPath } from "./manualResearchGuard";
import { collectResearch, researchNote } from "./webResearch";
import { prepareActiveNoteResearchInput } from "./researchInput";
import { renderCompanionResearchContent } from "./researchWriter";
import { MAX_RESEARCH_INPUT_CHARS, WebResearchError } from "./webResearchTypes";
import { createReadingStateStore, type ReadingStateStore } from "./readingState";
import { createObsidianVaultApi } from "./readingVault";
import { ReadingModeController, type ReadingHealth, type ReadingMode, type ReadingPreview } from "./readingMode";
import { registerMindmapCommands } from "./pluginCommands";
import {
  getLlmProviderConfigStatus as resolveLlmProviderConfigStatus,
  getScopeSetupStatus as resolveScopeSetupStatus,
  saveLlmProviderConfig as writeLlmProviderConfig,
  saveScopeSetup as writeScopeSetup,
  type LlmProviderConfigStatus,
  type ScopeSetupStatus,
} from "./pluginConfig";
import type { DiagnosticsSummaryState, SchedulerSummaryState } from "./pluginSummaries";
import { buildOverviewState, type OverviewState } from "./settingsOverview";
import { buildDiagnosticsOneLine, buildDiagnosticsReport } from "./diagnosticsReport";
import { getRunProfile, type RunScope } from "./runProfiles";
import { NO_ACTIVE_NOTE, type ActiveNoteEligibility } from "./individualNote";
import { resolveActiveNoteEligibility } from "./individualNoteActions";
import { confirmMindmapRun } from "./runConfirmModal";
import type { LiveRelatedResponse, LiveRelatedResult, LookupRelatedResponse } from "./semanticTypes";
import { buildMindmapLocalGraphState, isMindmapLocalGraphLeaf } from "./localGraph";
import {
  retireLegacyPythonLaunchAgents,
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
import {
  configureStatusBarElement,
  renderStatusBarElement,
} from "./statusBarMenu";
import { buildMindmapStatusBarState, openMindmapStatusMenu, type StatusBarInternalState } from "./statusBarIntegration";
import { buildStatusSummary } from "./statusBarState";
import type { LaunchAgentDetail } from "./launchAgentHealth";
import { registerVaultRefreshEvents } from "./vaultRefreshEvents";
import { ProductionEngine, type ProductionEngineOptions, type ProductionRelatedResult, PRODUCTION_SCOPE_CURRENT, PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_READING } from "./engine/productionEngine";
import type { EngineActivitySnapshot } from "./jobs/jobActivity";
import { createNodeBackgroundSchedulerFs, createNodeBackgroundSchedulerProcessRunner, createNodeLegacyLaunchAgentCleanupFs } from "./scheduling/backgroundSchedulerNodeAdapters";
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

const LOG_LIMIT = 50;

/** Checkpoint 11: the vault/plugin path triple every path-resolution helper needs -- previously `pathResolver.ts`'s own type, now defined here directly since that module (Python interpreter/script/config resolution) no longer exists. */
interface RuntimeContext {
  vaultRoot: string;
  configDir: string;
  pluginDir: string;
}

/** Checkpoint 10B: the current TypeScript engine pipeline (chunking/embedding/metadata) version this vault's engine is composed under -- bumped only if this cutover's own pipeline shape changes, never tied to the retired Python pipeline's own versioning. */
const PRODUCTION_PIPELINE_VERSION = 1;

/**
 * Best-effort, explicitly-documented fallback for a handful of common
 * Ollama embedding models -- `MigrationRunner` requires an explicit,
 * bounded positive integer `dimension` before it will ever start a run
 * (see its own `beginFreshRun` guard). A vault running an unlisted custom
 * embedding model can still override it explicitly via the
 * `embedDimension` plugin setting; absent both, `embeddingDimension`
 * stays `undefined` and migration surfaces a closed
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
  private engineActivity: EngineActivitySnapshot | null = null;
  private unsubscribeActivity: (() => void) | null = null;
  private statusRenderTimer: number | null = null;
  private activeNoteEligibility: ActiveNoteEligibility = NO_ACTIVE_NOTE;
  private pendingScanService: ProductionPendingScanService | null = null;
  private readingModeController: ReadingModeController | null = null;
  private readingStateStore: ReadingStateStore | null = null;
  private automaticResearchPolicyStore: AutomaticResearchPolicyStore | null = null;
  private automaticResearchPolicyStatus: AutomaticResearchPolicyState = createAutomaticResearchPolicy(localResearchDay(new Date()));
  private webResearchActivity: "off" | "ready" | "deriving" | "searching" | "writing" | "error" = "off";
  private webResearchLastError: string | null = null;
  private webResearchPromise: Promise<ResearchFileResult> | null = null;
  private mindmapLocalGraphLeaf: WorkspaceLeaf | null = null;
  private mindmapLocalGraphPath: string | null = null;
  private focusLookupOnNextRender = false;
  private diagnosticsState: DiagnosticsState = {
    inProgress: false,
    lastRunAt: null,
    result: null,
  };

  /**
   * Checkpoint 11: the ONE production, write-capable TypeScript engine this
   * desktop-only plugin owns -- composed once in `onload()` with real
   * Obsidian `Vault`/`Workspace`/`TFile`/`TFolder`, a real `NodeOwnedFs`
   * confined to `<pluginDir>/data/production-engine`, and this vault's
   * current Ollama-only embedding/local-metadata config read entirely from
   * plugin settings (never a Python `config.json`). `ProductionEngine` is
   * mandatory: `null` only when the desktop filesystem adapter itself is
   * unavailable, or construction/`start()` failed (see
   * `productionEngineFailed`) -- there is no Python fallback for either
   * case anymore.
   */
  productionEngine: ProductionEngine | null = null;
  /**
   * `true` only when `startProductionEngine()` actually ATTEMPTED to
   * construct/start a `ProductionEngine` and that attempt threw -- distinct
   * from `productionEngine === null` on a genuinely non-desktop filesystem
   * adapter, where construction was never attempted at all. Every command
   * that depends on the engine fails closed with a static Notice/error
   * either way; this flag exists only to give the failure case a more
   * specific message pointing at the logged start() failure.
   */
  private productionEngineFailed = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.retireLegacyLaunchAgents();

    this.statusBarEl = this.addStatusBarItem();
    configureStatusBarElement(this.statusBarEl, (event) => this.openStatusMenu(event));
    this.register(() => {
      this.unsubscribeActivity?.();
      this.unsubscribeActivity = null;
      if (this.statusRenderTimer !== null) window.clearTimeout(this.statusRenderTimer);
      this.statusRenderTimer = null;
      this.statusBarEl = null;
    });
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
    registerMindmapCommands(this);
    this.syncScheduler();
    registerVaultRefreshEvents(this.app.vault, (event) => this.registerEvent(event), (reason, paths) => {
      this.pendingScanService?.requestRefresh(reason, paths);
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { void this.refreshActiveNoteEligibility(); }));
    await this.migrateLegacyConfigOnce();
    await this.startProductionEngine();
    void this.pendingScanService.warm().then(() => this.updateStatusBar());
    if (this.settings.readingMode === "reading") {
      void this.readingModeController.start();
    }
  }

  onunload(): void {
    void this.productionEngine?.dispose();
    this.productionEngine = null;
    this.pendingScanService?.dispose();
    void this.readingModeController?.dispose();
    this.stopScheduler("Plugin unloaded. Internal scheduler stopped.");
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

  /** One-time-by-absence retirement of content-owned 0.2.x Python LaunchAgents; foreign or ambiguous files are never touched. */
  private async retireLegacyLaunchAgents(): Promise<void> {
    if (process.platform !== "darwin" || typeof process.getuid !== "function") return;
    const context = this.getRuntimeContext();
    const results = await retireLegacyPythonLaunchAgents({
      fs: createNodeLegacyLaunchAgentCleanupFs(),
      runner: createNodeBackgroundSchedulerProcessRunner(),
      userHomeDir: os.homedir(),
      pluginDir: context.pluginDir,
      uid: process.getuid(),
      platform: process.platform,
    });
    for (const result of results) {
      if (result.status === "retired") this.appendLog(`[migration] Retired legacy LaunchAgent ${result.label}.`);
      if (result.status === "foreign" || result.status === "ambiguous") this.appendLog(`[migration] Legacy LaunchAgent ${result.label} was not changed (${result.status}).`);
    }
  }

  /** Checkpoint 11: there is no Python runtime to set up anymore -- always unblocked. Kept as a named check (rather than deleted outright) since several call sites still gate on it for readability/future use. */
  private isRuntimeSetupBlocking(): boolean {
    return false;
  }

  /** Checkpoint 11: the semantic environment command is now a pure TS-engine no-op -- there is no Python worker to start anymore. */
  async startSemanticEnvironment(showNotice: boolean): Promise<void> {
    if (showNotice) {
      new Notice(
        this.productionEngine
          ? "The Mindmap TypeScript engine already handles semantic search in this vault."
          : "The Mindmap TypeScript engine is not available for this vault. Semantic search is unavailable.",
        8000,
      );
    }
  }

  /** Checkpoint 10B SIDEBAR: maps `ProductionEngine.queryLiveRelated`/`queryLookupRelated`'s own wider `ProductionRelatedResult.kind` union onto the existing, unchanged `LiveRelatedResult` UI contract -- a purely mechanical rename, never a behavior change. */
  private static toLiveRelatedResults(related: readonly ProductionRelatedResult[]): LiveRelatedResult[] {
    return related.map((item) => ({ path: item.path, score: item.score, kind: item.kind }));
  }

  /** Checkpoint 11: the TypeScript `ProductionEngine` is the ONLY backend for live/lookup related queries -- there is no Python semantic worker fallback anymore. An unavailable engine fails closed with a thrown error, which the sidebar UI already renders as an error state. */
  async queryLiveRelated(path: string): Promise<LiveRelatedResponse> {
    if (!this.settings.liveSemanticLookupEnabled) {
      throw new Error("Live semantic lookup is disabled.");
    }
    if (!this.productionEngine) {
      throw new Error("The Mindmap TypeScript engine is not available for this vault.");
    }
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

  async queryLookupRelated(query: string, limit?: number): Promise<LookupRelatedResponse> {
    if (!this.settings.liveSemanticLookupEnabled) {
      throw new Error("Live semantic lookup is disabled.");
    }
    if (!this.productionEngine) {
      throw new Error("The Mindmap TypeScript engine is not available for this vault.");
    }
    const related = await this.productionEngine.queryLookupRelated(query, limit ?? this.settings.relatedLimit);
    return { query, related: MindmapPlugin.toLiveRelatedResults(related) };
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
      running: this.engineActivity?.state === "running",
      runStatus: this.engineActivity?.batch?.total === undefined
        ? this.engineActivity?.current?.phase ?? null
        : `${this.engineActivity.batch.processed}/${this.engineActivity.batch.total}`,
      activity: this.engineActivity,
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
    if ((this.engineActivity?.processNoteCount ?? 0) > 0) {
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
      const vault = createObsidianVaultApi(this.app.vault, TFile);
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

  /** Checkpoint 11: the local research model is the SAME Ollama-only provider setting the TypeScript engine's metadata inference uses (`this.settings.llmBaseUrl`/`llmModel`) -- no Python `config.json` is ever read here. */
  private async getWebResearchPrerequisites(): Promise<{ credential: string; model: ReturnType<typeof createConfiguredLocalResearchModel> }> {
    const credential = await getExaCredential({ allowDevelopmentOverride: false });
    const model = createConfiguredLocalResearchModel({
      provider: "ollama",
      baseUrl: this.settings.llmBaseUrl.trim(),
      model: this.settings.llmModel.trim(),
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
    return resolveScopeSetupStatus(this.settings);
  }

  getVaultFolderOptions(): VaultFolderOption[] {
    const folderPaths = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path);
    return listVaultFolderOptions(folderPaths, this.app.vault.configDir);
  }

  async saveScopeSetup(selection: ScopeSelection): Promise<void> {
    writeScopeSetup(this.settings, selection);
    await this.saveSettings();
    this.appendLog("[setup] Updated scope folders in plugin settings");
    this.pendingScanService?.requestRefresh("scope setup updated");
    await this.startProductionEngine();
    this.updateStatusBar();
  }

  getLlmProviderConfigStatus(): LlmProviderConfigStatus {
    return resolveLlmProviderConfigStatus(this.settings);
  }

  async saveLlmProviderConfig(patch: Partial<Pick<LlmProviderConfigStatus, "baseUrl" | "model" | "maxTokens">>): Promise<void> {
    writeLlmProviderConfig(this.settings, patch);
    await this.saveSettings();
    this.appendLog("[setup] Updated Ollama metadata provider config in plugin settings");
    await this.startProductionEngine();
  }

  /** One compact, path-free readiness summary for the settings Overview row. */
  getOverviewState(): OverviewState {
    const scope = this.getScopeSetupStatus();
    return buildOverviewState({
      productionEngineAvailable: this.productionEngine !== null,
      scopeComplete: scope.complete,
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
    const provider = this.getLlmProviderConfigStatus();
    const report = buildDiagnosticsReport({
      generatedAt: new Date().toISOString(),
      engine: { available: this.productionEngine !== null },
      provider: {
        embedBaseUrl: this.settings.embedBaseUrl,
        embedModel: this.settings.embedModel,
        llmBaseUrl: provider.baseUrl,
        llmModel: provider.model,
        llmMaxTokens: provider.maxTokens,
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
    const state = buildMindmapStatusBarState(this, this.getStatusBarInternalState());
    new Notice(buildStatusSummary({
      ready: this.productionEngine !== null && state.scopeReady && state.preflightOk !== false,
      pendingAvailable: state.pendingAvailable,
      currentPending: state.currentPending,
      allPending: state.allPending,
      preflightInProgress: state.preflightInProgress,
      preflightOk: state.preflightOk,
      schedulerMode: state.schedulerMode,
      schedulerDetails: state.schedulerDetails,
    }), 8000);
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

  /** Checkpoint 11: `ProductionEngine` is mandatory on this desktop-only plugin -- there is no Python subprocess fallback anymore. An unavailable engine (construction failure, or the desktop filesystem adapter itself missing) fails closed with one fixed result, never a spawn. */
  async runPreflight(trigger: "manual" | "startup"): Promise<PreflightResult> {
    if (this.productionEngine) {
      return await this.runProductionPreflight(trigger, this.productionEngine);
    }
    const summary = "The Mindmap TypeScript engine is not available for this vault. Preflight is unavailable.";
    const result: PreflightResult = {
      ok: false,
      summary,
      checks: [
        {
          code: "PRODUCTION_ENGINE_UNAVAILABLE",
          label: "Mindmap TypeScript engine",
          status: "error",
          message: summary,
          guidance: "Check the Mindmap log for a [production-engine] start() failure, then restart Obsidian.",
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
    const action = getSchedulerAction(this.getSchedulerConfig(), this.engineActivity?.bulkBlocked ?? false);

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
          vault: createObsidianVaultApi(this.app.vault, TFile),
          state,
          configDir: this.app.vault.configDir,
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
                  updateStatus: async (status) => await updateAppleAnnotationResearchStatus(createObsidianVaultApi(this.app.vault, TFile), state, item.annotationId, status),
                });
              }
              const outcome = await this.researchFile(file, text, false, "automatic");
              return await persistAutomaticResearchOutcome({
                outcome,
                updateStatus: async (status) => await updateAppleAnnotationResearchStatus(createObsidianVaultApi(this.app.vault, TFile), state, item.annotationId, status),
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
    const config: Record<string, unknown> = {
      apple_books: {
        annotation_database_path: this.settings.appleAnnotationDbPath,
        library_database_path: this.settings.appleLibraryDbPath,
      },
    };
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
    if (trigger === "manual" && (scope === "refreshAll" || scope === "metadataAll" || scope === "rebuildAll")) {
      const profile = getRunProfile(scope);
      if (profile.confirmation) {
        const confirmed = await confirmMindmapRun(this.app, profile.confirmation);
        if (!confirmed) {
          const message = `Mindmap ${profile.label} run cancelled.`;
          this.schedulerState.lastMessage = message;
          this.appendLog(message);
          this.updateStatusBar();
          return false;
        }
      }
    }
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
    const message = `Mindmap ${trigger} run skipped: the TypeScript engine is not available for this vault.`;
    this.schedulerState.lastMessage = message;
    this.appendLog(message);
    if (trigger === "manual") new Notice(message, 12000);
    this.updateStatusBar();
    return false;
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
    if (this.statusRenderTimer !== null) return;
    this.statusRenderTimer = window.setTimeout(() => {
      this.statusRenderTimer = null;
      if (this.statusBarEl) renderStatusBarElement(this.statusBarEl, buildMindmapStatusBarState(this, this.getStatusBarInternalState()));
    }, 250);
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

  /**
   * Checkpoint 11: a ONE-TIME, best-effort migration from a legacy Python
   * `config.json` (if this vault was previously running the retired
   * Python-powered plugin) into `this.settings` -- provider/model/base URL,
   * scope folders, and Apple Books database overrides only, exactly once.
   * Gated on `settings.legacyConfigMigrated`, which is set `true` whether a
   * legacy config was found or not, so this NEVER runs again and NEVER
   * reads a Python config file as part of ordinary operation afterward. A
   * fresh install (no legacy config present) is a normal, silent no-op.
   */
  private async migrateLegacyConfigOnce(): Promise<void> {
    if (this.settings.legacyConfigMigrated) return;
    try {
      const context = this.getRuntimeContext();
      const legacyConfigPath = path.join(context.pluginDir, "python", "config.json");
      const raw = await fs.promises.readFile(legacyConfigPath, "utf8").catch(() => null);
      if (raw !== null) {
        const config = JSON.parse(raw) as Record<string, unknown>;
        const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
        const currentPaths = Array.isArray(config.notes_paths_current) ? config.notes_paths_current.filter((v): v is string => typeof v === "string") : undefined;
        const allPaths = Array.isArray(config.notes_paths_all) ? config.notes_paths_all.filter((v): v is string => typeof v === "string") : undefined;

        this.settings.embedBaseUrl = str(config.embed_base_url) ?? str(config.ollama_base_url) ?? this.settings.embedBaseUrl;
        this.settings.embedModel = str(config.embed_model) ?? this.settings.embedModel;
        this.settings.llmBaseUrl = config.llm_provider === "ollama" ? (str(config.llm_base_url) ?? this.settings.llmBaseUrl) : this.settings.llmBaseUrl;
        this.settings.llmModel = config.llm_provider === "ollama" ? (str(config.llm_model) ?? this.settings.llmModel) : this.settings.llmModel;
        if (currentPaths && currentPaths.length > 0) this.settings.scopeCurrentPaths = currentPaths;
        if (allPaths && allPaths.length > 0) this.settings.scopeAllPaths = allPaths;
        const appleBooks = typeof config.apple_books === "object" && config.apple_books !== null && !Array.isArray(config.apple_books) ? config.apple_books as Record<string, unknown> : {};
        this.settings.appleAnnotationDbPath = str(appleBooks.annotation_database_path) ?? this.settings.appleAnnotationDbPath;
        this.settings.appleLibraryDbPath = str(appleBooks.library_database_path) ?? this.settings.appleLibraryDbPath;

        this.appendLog("[migration] Imported legacy config.json values into plugin settings (scope, provider, Apple Books overrides).");
      }
    } catch (error) {
      this.appendLog(`[migration] Legacy config.json migration skipped: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.settings.legacyConfigMigrated = true;
      await this.saveSettings();
    }
  }

  /**
   * Checkpoint 11: composes the real `ProductionEngineOptions` this vault's
   * `ProductionEngine` is constructed with -- real Obsidian
   * `Vault`/`Workspace`/`TFile`/`TFolder`, a `NodeOwnedFs` confined to
   * `<pluginDir>/data/production-engine`, this vault's current Ollama-only
   * embedding config and Ollama-only local metadata config, explicit Apple
   * Books config/home, and the bounded readiness probes every capability
   * above is checked against. Every field comes from `this.settings` (TS
   * plugin data) plus vault/plugin paths -- no Python `config.json` is ever
   * read here. Returns `null` only when the desktop filesystem adapter
   * itself is unavailable (`getRuntimeContext()` throws); every other
   * missing/blank setting degrades a single capability (embedding/metadata)
   * to `null`/an "unconfigured" probe rather than blocking construction, so
   * Standard Mode stays usable on a fresh install with no provider
   * configured yet.
   */
  private buildProductionEngineOptions(): ProductionEngineOptions | null {
    let context: RuntimeContext;
    try {
      context = this.getRuntimeContext();
    } catch {
      return null;
    }
    const settings = this.settings;

    const embeddingProvider = settings.embedBaseUrl.trim() && settings.embedModel.trim()
      ? new OllamaEmbeddingProvider({ baseUrl: settings.embedBaseUrl.trim(), model: settings.embedModel.trim() }, { fetchImpl: requestUrlFetch, sleep: createWindowSleep() })
      : null;
    const embeddingModel = embeddingProvider ? settings.embedModel.trim() : null;
    const embeddingDimension = embeddingModel ? resolveKnownEmbeddingDimension(embeddingModel, settings.embedDimension > 0 ? settings.embedDimension : undefined) : undefined;

    // Ollama-only local metadata inference -- see `MindmapSettings`'s own doc comment; there is no
    // remote/OpenAI-compatible provider option in the TypeScript engine.
    const metadataProvider = settings.llmBaseUrl.trim() && settings.llmModel.trim()
      ? createOllamaMetadataProvider({ baseUrl: settings.llmBaseUrl.trim() }, { fetchImpl: requestUrlFetch })
      : null;
    const metadataPipelineConfig = metadataProvider
      ? {
        model: settings.llmModel.trim(),
        maxTokens: settings.llmMaxTokens,
        tagLimit: settings.tagLimit,
        conceptLimit: settings.conceptLimit,
        conceptMaxWords: settings.conceptMaxWords,
        conceptCaseMode: settings.conceptCaseMode,
        controlledTags: [],
        allowFreeTags: settings.allowFreeTags,
        tagMinLen: settings.tagMinLen,
        tagMaxWords: settings.tagMaxWords,
        tagAliases: {},
      }
      : null;

    const probes: ProductionEngineOptions["probes"] = {
      researchProvider: createResearchCredentialReadinessProbe(hasExaCredential),
    };
    if (embeddingProvider && embeddingModel) {
      probes.ollama = createOllamaEmbeddingReadinessProbe(embeddingProvider, { model: embeddingModel });
    }
    if (metadataProvider && settings.llmModel.trim()) {
      probes.localMetadataProvider = createLocalMetadataReadinessProbe(metadataProvider, settings.llmModel.trim());
    }
    const appleBooksConfig: Record<string, unknown> = {
      apple_books: {
        annotation_database_path: settings.appleAnnotationDbPath,
        library_database_path: settings.appleLibraryDbPath,
      },
    };
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
      chunkOptions: { targetTokens: settings.chunkTargetTokens, overlapTokens: settings.chunkOverlapTokens },
      relatedSelectionConfig: {
        relatedLimit: settings.relatedLimit,
        overreachCount: settings.relatedOverreach,
        creativeCount: settings.relatedCreative,
        creativeMin: settings.relatedCreativeMin,
        creativeMax: settings.relatedCreativeMax,
        candidateLimit: settings.relatedCandidateLimit,
        minScore: settings.relatedMinScore,
      },
      metadataProvider,
      metadataPipelineConfig,
      scopeFolders: settings.scopeAllPaths,
      currentScopeFolders: settings.scopeCurrentPaths,
      minimumWords: settings.minimumWords,
      configDir: this.app.vault.configDir,
      runtimeFolder: context.pluginDir.startsWith(context.vaultRoot)
        ? path.posix.join(context.configDir, "plugins", this.manifest.id)
        : undefined,
      pipelineVersion: PRODUCTION_PIPELINE_VERSION,
      appleBooks: {
        config: appleBooksConfig,
        homeDirectory: os.homedir(),
        annotationDbPath: settings.appleAnnotationDbPath.trim() || undefined,
        libraryDbPath: settings.appleLibraryDbPath.trim() || undefined,
      },
      probes,
      onFault: (fault) => {
        this.appendLog(`[production-engine] ${fault.source} fault: ${fault.code}`);
      },
      onMigrationComplete: () => {
        void this.refreshCachedMigrationStatus();
        this.invalidateLiveMindmapViews();
      },
    };
  }

  /** Checkpoint 10B LAUNCHAGENT: a stable, bounded lowercase-alphanumeric token (`BackgroundScheduler`'s own `installationId` contract) derived from this vault's absolute root path -- stable across restarts/renames of the PLUGIN, but intentionally changes if the VAULT itself is moved/renamed (a moved vault is a genuinely different filesystem location for `/usr/bin/open` to target). Never a display name. */
  private getBackgroundSchedulerInstallationId(context: RuntimeContext): string {
    return createHash("sha256").update(context.vaultRoot).digest("hex").slice(0, 32);
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
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
    this.engineActivity = null;
    this.updateStatusBar();
    if (this.productionEngine) {
      await this.productionEngine.dispose();
      this.productionEngine = null;
    }
    this.productionEngineFailed = false;
    const options = this.buildProductionEngineOptions();
    if (!options) return;
    try {
      const engine = new ProductionEngine(options);
      this.productionEngine = engine;
      this.unsubscribeActivity = engine.subscribeActivity((snapshot) => {
        if (this.productionEngine !== engine) return;
        this.engineActivity = snapshot;
        this.updateStatusBar();
      });
      await engine.start();
    } catch (error) {
      this.appendLog(`[production-engine] start() failed: ${error instanceof Error ? error.message : "unknown error"}`);
      await this.productionEngine?.dispose();
      this.productionEngine = null;
      this.unsubscribeActivity?.();
      this.unsubscribeActivity = null;
      this.engineActivity = null;
      this.updateStatusBar();
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

  /** Checkpoint 10B SIDEBAR: called once per `ProductionEngine.onMigrationComplete` firing -- resets every open Mindmap sidebar's live-query cache so an `indexed: false` result cached while migration was still running gets re-queried, rather than staying cached forever (`MindmapWorkspaceView.ensureLiveQuery` otherwise never re-fetches for an unchanged active path). Bounded and one-shot per firing: this does not itself trigger a render loop, since `invalidateLiveQuery()` only resets to idle and renders once. */
  private invalidateLiveMindmapViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MINDMAP_VIEW_TYPE)) {
      if (leaf.view instanceof MindmapWorkspaceView) {
        leaf.view.invalidateLiveQuery();
      }
    }
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
}

type ResearchFileResult =
  | { ok: true }
  | { ok: false; code: string; message: string };
