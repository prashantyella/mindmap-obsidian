import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";

import { FileSystemAdapter, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from "obsidian";

import { buildSpawnFailureResult, formatPreflightNotice, parsePreflightOutput, type PreflightResult } from "./diagnostics";
import { listVaultFolderOptions, type ScopeSelection, type VaultFolderOption } from "./onboarding";
import { formatCommandPreview, getPluginRuntimeDir, resolveRuntime, type ResolvedRuntime, type RuntimeContext } from "./pathResolver";
import { createPendingScanService, type PendingSnapshot } from "./pendingScan";
import { discoverAppleBooksDatabasePaths } from "./appleBooksDiscovery";
import { importAppleBooksAnnotations } from "./appleBooksImport";
import { createReadingStateStore, type ReadingStateStore } from "./readingState";
import { createObsidianVaultApi } from "./readingVault";
import { ReadingModeController, type ReadingHealth, type ReadingPreview } from "./readingMode";
import { registerMindmapCommands } from "./pluginCommands";
import {
  getLlmProviderConfigStatus as resolveLlmProviderConfigStatus,
  getScopeSetupStatus as resolveScopeSetupStatus,
  saveLlmProviderConfig as writeLlmProviderConfig,
  saveScopeSetup as writeScopeSetup,
  type LlmProviderConfig,
  type LlmProviderConfigStatus,
  type ScopeSetupStatus,
} from "./pluginConfig";
import {
  buildDiagnosticsSummary,
  buildPendingSummary,
  buildSchedulerSummary,
  buildScopeSetupSummary,
  type DiagnosticsSummaryState,
  type SchedulerSummaryState,
} from "./pluginSummaries";
import { assertAllowedPluginArgs } from "./runArguments";
import { getRunProfile, type RunProfile, type RunScope } from "./runProfiles";
import { NO_ACTIVE_NOTE, type ActiveNoteEligibility } from "./individualNote";
import { resolveActiveNoteEligibility } from "./individualNoteActions";
import { confirmMindmapRun } from "./runConfirmModal";
import { migrateLegacyPluginVaultRoot } from "./runtimeConfigMigration";
import { ensureBundledRuntimeAssets } from "./runtimeAssets";
import { MindmapSemanticEnvironment, type SemanticEnvironmentStatus } from "./semanticEnvironment";
import type { LiveRelatedResponse, LookupRelatedResponse } from "./semanticTypes";
import { buildMindmapLocalGraphState, isMindmapLocalGraphLeaf } from "./localGraph";
import {
  buildLaunchAgentPlist,
  DAILY_LAUNCH_AGENT_LABEL,
  formatClockTime,
  normalizeHour,
  normalizeMinute,
  shouldBootstrapLaunchAgent,
  WEEKLY_LAUNCH_AGENT_LABEL,
  type LaunchAgentSpec,
} from "./launchAgent";
import {
  buildLaunchAgentCatchUpStatus,
  buildPluginLaunchAgentSpecs,
  ensureLaunchAgentDirectories,
  getLaunchAgentPlistPath,
  getLaunchAgentsDirectory,
  isLaunchAgentLoaded,
  refreshLaunchAgentHealth,
} from "./launchAgentHealth";
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
import { BUNDLED_RUNTIME_ASSETS } from "virtual:runtime-assets";
import {
  configureStatusBarElement,
  renderStatusBarElement,
} from "./statusBarMenu";
import { buildMindmapStatusBarState, openMindmapStatusMenu, type StatusBarInternalState } from "./statusBarIntegration";
import { buildStatusSummary } from "./statusBarState";
import type { LaunchAgentDetail } from "./launchAgentHealth";
import { registerVaultRefreshEvents } from "./vaultRefreshEvents";

const LOG_LIMIT = 50;

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
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
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
  private pendingScanService: ReturnType<typeof createPendingScanService> | null = null;
  private readingModeController: ReadingModeController | null = null;
  private readingStateStore: ReadingStateStore | null = null;
  private semanticEnvironment: MindmapSemanticEnvironment | null = null;
  private mindmapLocalGraphLeaf: WorkspaceLeaf | null = null;
  private mindmapLocalGraphPath: string | null = null;
  private focusLookupOnNextRender = false;
  private diagnosticsState: DiagnosticsState = {
    inProgress: false,
    lastRunAt: null,
    result: null,
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBundledRuntime();

    this.statusBarEl = this.addStatusBarItem();
    configureStatusBarElement(this.statusBarEl, (event) => this.openStatusMenu(event));
    this.readingStateStore = createReadingStateStore(path.join(this.getRuntimeContext().pluginDir, "data", "reading-state.json"));
    this.readingModeController = this.createReadingModeController();
    this.registerView(MINDMAP_VIEW_TYPE, (leaf) => new MindmapWorkspaceView(leaf, this));
    this.registerHoverLinkSource(MINDMAP_VIEW_TYPE, {
      display: "Mindmap AI",
      defaultMod: false,
    });
    this.addRibbonIcon("orbit", "Open Mindmap", () => {
      void this.openMindmapView();
    });
    this.addSettingTab(new MindmapSettingTab(this.app, this));
    this.pendingScanService = createPendingScanService(
      this.app.vault,
      this.getRuntimeContext(),
      () => this.getResolvedRuntime(),
      (message) => this.appendLog(message),
      () => this.updateStatusBar(),
    );
    this.semanticEnvironment = new MindmapSemanticEnvironment(
      () => this.getResolvedRuntime(),
      (message) => this.appendLog(message),
      () => this.updateStatusBar(),
    );

    registerMindmapCommands(this);
    this.syncScheduler();
    registerVaultRefreshEvents(this.app.vault, (event) => this.registerEvent(event), (reason, paths) => {
      this.pendingScanService?.requestRefresh(reason, paths);
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { void this.refreshActiveNoteEligibility(); }));
    void this.pendingScanService.warm().then(() => this.updateStatusBar());
    void this.runPreflight("startup");
    if (this.settings.liveSemanticLookupEnabled) {
      void this.startSemanticEnvironment(false);
    }
    if (this.settings.readingMode === "reading") {
      void this.readingModeController.start();
    }
  }

  onunload(): void {
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.readingMode = this.settings.readingMode === "reading" ? "reading" : "standard";
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

  getSemanticStatus(): SemanticEnvironmentStatus {
    return this.semanticEnvironment?.getStatus() ?? {
      state: "off",
      message: "Semantic environment is off.",
      health: null,
    };
  }

  async startSemanticEnvironment(showNotice: boolean): Promise<void> {
    if (!this.semanticEnvironment) {
      return;
    }
    const status = await this.semanticEnvironment.start("current");
    if (showNotice) {
      new Notice(status.message, 8000);
    }
  }

  async queryLiveRelated(path: string): Promise<LiveRelatedResponse> {
    if (!this.settings.liveSemanticLookupEnabled) {
      throw new Error("Live semantic lookup is disabled.");
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

  getSchedulerSummary(): DocumentFragment {
    this.refreshLaunchAgentHealth();
    const config = this.getSchedulerConfig();
    return buildSchedulerSummary(
      config,
      this.schedulerState,
      this.currentProcess !== null,
      `LaunchAgent daily: ${formatClockTime({ hour: this.settings.launchAgentDailyHour, minute: this.settings.launchAgentDailyMinute })} Mon-Sat`,
      this.settings.launchAgentWeeklyEnabled
        ? `LaunchAgent weekly refresh: ${formatClockTime({ hour: this.settings.launchAgentWeeklyHour, minute: this.settings.launchAgentWeeklyMinute })} Sunday`
        : "LaunchAgent weekly refresh: disabled",
    );
  }

  getLaunchAgentCatchUpStatus(): { available: boolean; message: string } {
    return buildLaunchAgentCatchUpStatus(this.settings.schedulerMode, this.schedulerState.launchAgentHealth, this.getPendingSnapshot());
  }

  private openStatusMenu(event?: MouseEvent | KeyboardEvent): void {
    openMindmapStatusMenu(this, event);
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
      lastSyncAt: null,
      lastError: null,
    };
  }

  async toggleReadingMode(): Promise<void> {
    if (!this.readingModeController) {
      return;
    }
    if (this.settings.readingMode === "reading") {
      await this.readingModeController.disable();
      return;
    }
    await this.readingModeController.enable();
  }

  async syncReadingMode(): Promise<void> {
    await this.readingModeController?.syncNow();
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
    this.app.workspace.revealLeaf(leaf);
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

  getPendingSummary(): DocumentFragment {
    return buildPendingSummary(this.getPendingSnapshot());
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

  getScopeSetupSummary(): DocumentFragment {
    return buildScopeSetupSummary(this.getScopeSetupStatus());
  }

  getDiagnosticsSummary(): DocumentFragment {
    return buildDiagnosticsSummary(this.diagnosticsState, [...this.recentLog]);
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
    assertAllowedPluginArgs(extraArgs);
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

  async runPreflight(trigger: "manual" | "startup"): Promise<PreflightResult> {
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

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
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
    if (isSchedulerEnabled(this.settings.schedulerMode)) {
      this.startScheduler();
    } else {
      this.stopScheduler("Manual mode. Interval scheduler disabled.");
    }

    if (isLaunchAgentSchedulerEnabled(this.settings.schedulerMode)) {
      void this.reconcileLaunchAgents();
    } else if (this.launchAgentManagedThisSession) {
      void this.disableManagedLaunchAgents("LaunchAgent scheduler disabled.");
    }

    this.updateStatusBar();
  }

  private getLaunchAgentSpecs(runtime: ResolvedRuntime): LaunchAgentSpec[] {
    return buildPluginLaunchAgentSpecs({
      command: runtime.command,
      settings: this.settings,
      plistDirectory: getLaunchAgentsDirectory(os.homedir()),
      pathEnvironment: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      homeDirectory: os.homedir(),
    });
  }

  refreshLaunchAgentHealth(): Promise<void> {
    if (!isLaunchAgentSchedulerEnabled(this.settings.schedulerMode) || process.platform !== "darwin") {
      return Promise.resolve();
    }
    if (this.launchAgentHealthRefreshInFlight) {
      return this.launchAgentHealthRefreshInFlight;
    }

    const runtime = this.getResolvedRuntime();
    if (!runtime.valid || typeof process.getuid !== "function") {
      return Promise.resolve();
    }

    const specs = this.getLaunchAgentSpecs(runtime);
    const refresh = refreshLaunchAgentHealth(specs, process.getuid(), (summary) => {
      this.schedulerState.launchAgentHealth = summary.health;
      this.schedulerState.launchAgentLastSuccessfulRunAt = summary.lastSuccessfulRunAt;
      this.schedulerState.launchAgentLastExitCode = summary.lastExitCode;
      this.schedulerState.launchAgentDetails = summary.details;
      this.schedulerState.launchAgentMessage = summary.message;
      this.updateStatusBar();
    }).finally(() => {
      this.launchAgentHealthRefreshInFlight = null;
    });
    this.launchAgentHealthRefreshInFlight = refresh;
    return refresh;
  }

  private async reconcileLaunchAgents(): Promise<void> {
    const syncId = ++this.launchAgentSyncId;
    if (process.platform !== "darwin") {
      this.schedulerState.launchAgentMessage = "LaunchAgent scheduling is only available on macOS.";
      this.updateStatusBar();
      return;
    }

    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      this.schedulerState.launchAgentMessage = error?.message ?? "Runtime is not ready.";
      this.updateStatusBar();
      return;
    }

    const specs = this.getLaunchAgentSpecs(runtime);
    const activeLabels = new Set(specs.map((spec) => spec.label));

    try {
      await fs.promises.mkdir(getLaunchAgentsDirectory(os.homedir()), { recursive: true });
      await ensureLaunchAgentDirectories(specs, os.homedir());

      for (const spec of specs) {
        const changed = await this.writeLaunchAgentPlist(spec);
        if (shouldBootstrapLaunchAgent(changed, await isLaunchAgentLoaded(spec.label))) {
          await this.bootstrapLaunchAgent(spec);
        }
      }

      if (!activeLabels.has(WEEKLY_LAUNCH_AGENT_LABEL)) {
        await this.removeLaunchAgent(WEEKLY_LAUNCH_AGENT_LABEL);
      }

      if (syncId !== this.launchAgentSyncId) {
        return;
      }

      this.launchAgentManagedThisSession = true;
      this.schedulerState.launchAgentPaths = specs.map((spec) => spec.plistPath);
      this.schedulerState.launchAgentMessage = `Reconciled ${specs.length} plugin-managed LaunchAgent${specs.length === 1 ? "" : "s"}.`;
      this.schedulerState.lastMessage = "LaunchAgent mode enabled. Scheduled runs use the plugin runtime.";
      this.appendLog(this.schedulerState.launchAgentMessage);
      this.updateStatusBar();
      this.refreshLaunchAgentHealth();
    } catch (error) {
      if (syncId !== this.launchAgentSyncId) {
        return;
      }
      const message = error instanceof Error ? error.message : "LaunchAgent reconciliation failed.";
      this.schedulerState.launchAgentHealth = "failing";
      this.schedulerState.launchAgentDetails = specs.map((spec) => ({
        label: spec.label,
        health: "failing" as const,
        lastSuccessfulRunAt: null,
        lastExitCode: null,
      }));
      this.schedulerState.launchAgentMessage = message;
      this.schedulerState.lastMessage = `LaunchAgent scheduler error: ${message}`;
      this.appendLog(this.schedulerState.lastMessage);
      new Notice(this.schedulerState.lastMessage, 12000);
      this.updateStatusBar();
    }
  }

  private async writeLaunchAgentPlist(spec: LaunchAgentSpec): Promise<boolean> {
    const content = buildLaunchAgentPlist(spec);
    let existing: string | null;
    try {
      existing = await fs.promises.readFile(spec.plistPath, "utf8");
    } catch {
      existing = null;
    }

    if (existing !== content) {
      await fs.promises.writeFile(spec.plistPath, content, "utf8");
      this.appendLog(`[launchagent] Wrote ${spec.plistPath}`);
      return true;
    }
    return false;
  }

  private async bootstrapLaunchAgent(spec: LaunchAgentSpec): Promise<void> {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid === null) {
      throw new Error("Unable to determine user id for LaunchAgent bootstrap.");
    }

    const domain = `gui/${uid}`;
    await this.execLaunchctl(["bootout", domain, spec.plistPath], true);
    await this.execLaunchctl(["bootstrap", domain, spec.plistPath], false);
    this.appendLog(`[launchagent] Loaded ${spec.label}`);
  }

  private async removeLaunchAgent(label: string): Promise<void> {
    const plistPath = getLaunchAgentPlistPath(os.homedir(), label);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null) {
      await this.execLaunchctl(["bootout", `gui/${uid}`, plistPath], true);
    }
    try {
      await fs.promises.unlink(plistPath);
      this.appendLog(`[launchagent] Removed ${plistPath}`);
    } catch {
      // Missing plist is already disabled.
    }
  }

  private async disableManagedLaunchAgents(message: string): Promise<void> {
    ++this.launchAgentSyncId;
    await this.removeLaunchAgent(DAILY_LAUNCH_AGENT_LABEL);
    await this.removeLaunchAgent(WEEKLY_LAUNCH_AGENT_LABEL);
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

  private async execLaunchctl(args: string[], ignoreFailure: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile("/bin/launchctl", args, (error) => {
        if (error && !ignoreFailure) {
          reject(error);
          return;
        }
        resolve();
      });
    });
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
      clearTimeout(this.schedulerTimer);
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
    this.schedulerTimer = setTimeout(() => {
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
        };
      },
      listPendingEligibleNotes: async () => {
        const current = await state.load();
        return Object.values(current.annotations)
          .filter((entry) => entry.researchStatus !== "too-short" && entry.processedAt === null)
          .map((entry) => entry.notePath)
          .sort();
      },
      processNote: async (notePath) => {
        return await this.runMindmap("reading", "note", notePath);
      },
      markProcessed: async (notePath) => {
        const current = await state.load();
        const entry = Object.entries(current.annotations).find(([, value]) => value.notePath === notePath)?.[1];
        if (!entry) {
          throw new Error(`Reading state entry not found for ${notePath}.`);
        }
        entry.processedAt = new Date().toISOString();
        await state.save(current);
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

  private async readAppleBooksPayload(): Promise<unknown> {
    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      throw new Error("Mindmap runtime is not ready for Apple Books reading.");
    }
    const readerPath = path.join(getPluginRuntimeDir(this.getRuntimeContext()), "apple_books_reader.py");
    return await this.runReaderProcess(runtime.command.command, [readerPath, "--config", runtime.configPath], path.dirname(readerPath));
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
    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", () => {
        const lines = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        const line = lines[lines.length - 1];
        if (!line) {
          reject(new Error(stderr.trim() || "Apple Books reader did not produce structured output."));
          return;
        }
        try {
          resolve(JSON.parse(line) as unknown);
        } catch {
          reject(new Error("Apple Books reader output was not valid JSON."));
        }
      });
    });
  }

  async runMindmap(trigger: RunTrigger, scope: RunScope = "current", notePath?: string): Promise<boolean> {
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

      child.stdout.on("data", (chunk) => {
        for (const line of splitLogLines(chunk.toString())) {
          stdoutLines.push(line);
          this.appendLog(`[stdout] ${line}`);
          this.updateRunStatusFromLine(line);
        }
      });

      child.stderr.on("data", (chunk) => {
        for (const line of splitLogLines(chunk.toString())) {
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

}
