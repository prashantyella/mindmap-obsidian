import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { FileSystemAdapter, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";

import { buildSpawnFailureResult, formatPreflightNotice, parsePreflightOutput, type PreflightResult } from "./diagnostics";
import { isScopeSetupComplete, listVaultFolderOptions, readScopeSelection, updateScopeSelection, type ScopeSelection, type VaultFolderOption } from "./onboarding";
import { formatCommandPreview, getPluginRuntimeDir, resolveRuntime, type ResolvedRuntime, type RuntimeContext } from "./pathResolver";
import { createPendingScanService, type PendingSnapshot } from "./pendingScan";
import { assertAllowedPluginArgs } from "./runArguments";
import { getRunProfile, type RunScope } from "./runProfiles";
import { migrateLegacyPluginVaultRoot } from "./runtimeConfigMigration";
import { ensureBundledRuntimeAssets } from "./runtimeAssets";
import {
  buildSchedulerStatus,
  computeNextRunAt,
  formatTimestamp,
  getSchedulerAction,
  isSchedulerEnabled,
  normalizeSchedulerInterval,
  type SchedulerConfig,
} from "./scheduler";
import { DEFAULT_SETTINGS, type MindmapSettings, type SchedulerMode } from "./settings";
import { MindmapSettingTab } from "./settingsTab";
import { BUNDLED_RUNTIME_ASSETS } from "virtual:runtime-assets";

const LOG_LIMIT = 50;

type RunTrigger = "manual" | "scheduled";

interface SchedulerState {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastTrigger: RunTrigger | null;
  lastExitCode: number | null;
  lastMessage: string;
}

interface DiagnosticsState {
  inProgress: boolean;
  lastRunAt: number | null;
  result: PreflightResult | null;
}

export interface ScopeSetupStatus {
  complete: boolean;
  canManage: boolean;
  configPath: string | null;
  currentPaths: string[];
  allPaths: string[];
  guidance: string;
}

export default class MindmapPlugin extends Plugin {
  settings: MindmapSettings = DEFAULT_SETTINGS;

  private currentProcess: ChildProcessWithoutNullStreams | null = null;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private schedulerState: SchedulerState = {
    nextRunAt: null,
    lastRunAt: null,
    lastTrigger: null,
    lastExitCode: null,
    lastMessage: "Manual mode.",
  };
  private readonly recentLog: string[] = [];
  private statusBarEl: HTMLElement | null = null;
  private pendingScanService: ReturnType<typeof createPendingScanService> | null = null;
  private diagnosticsState: DiagnosticsState = {
    inProgress: false,
    lastRunAt: null,
    result: null,
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBundledRuntime();

    this.statusBarEl = this.addStatusBarItem();
    this.addSettingTab(new MindmapSettingTab(this.app, this));
    this.pendingScanService = createPendingScanService(
      this.app.vault,
      this.getRuntimeContext(),
      () => this.getResolvedRuntime(),
      (message) => this.appendLog(message),
      () => this.updateStatusBar(),
    );

    this.addCommand({
      id: "mindmap-run-now",
      name: "Run mindmap (current scope)",
      callback: () => {
        void this.runMindmap("manual", "current");
      },
    });

    this.addCommand({
      id: "mindmap-run-all",
      name: "Run mindmap (all scopes)",
      callback: () => {
        void this.runMindmap("manual", "all");
      },
    });

    this.addCommand({
      id: "mindmap-enable-scheduler",
      name: "Enable mindmap interval scheduler",
      callback: () => {
        void this.setSchedulerMode("interval");
      },
    });

    this.addCommand({
      id: "mindmap-disable-scheduler",
      name: "Disable mindmap interval scheduler",
      callback: () => {
        void this.setSchedulerMode("manual");
      },
    });

    this.addCommand({
      id: "mindmap-open-status",
      name: "Show mindmap status",
      callback: () => {
        this.showRuntimeNotice(this.getResolvedRuntime());
      },
    });

    this.addCommand({
      id: "mindmap-validate-runtime",
      name: "Run mindmap preflight checks",
      callback: () => {
        void this.runPreflight("manual");
      },
    });

    this.syncScheduler();
    this.registerVaultRefreshEvents();
    void this.pendingScanService.warm().then(() => this.updateStatusBar());
    void this.runPreflight("startup");
  }

  onunload(): void {
    this.pendingScanService?.dispose();
    this.stopScheduler("Plugin unloaded. Internal scheduler stopped.");
    if (this.currentProcess) {
      this.appendLog("Stopping active Mindmap run because the plugin is unloading.");
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.schedulerIntervalMinutes = normalizeSchedulerInterval(this.settings.schedulerIntervalMinutes);
  }

  async saveSettings(): Promise<void> {
    this.settings.schedulerIntervalMinutes = normalizeSchedulerInterval(this.settings.schedulerIntervalMinutes);
    await this.saveData(this.settings);
    this.syncScheduler();
    this.pendingScanService?.requestRefresh("settings updated");
  }

  getResolvedRuntime(): ResolvedRuntime {
    return resolveRuntime(this.settings, this.getRuntimeContext());
  }

  getSchedulerConfig(): SchedulerConfig {
    return {
      mode: this.settings.schedulerMode,
      intervalMinutes: this.settings.schedulerIntervalMinutes,
    };
  }

  getSchedulerSummary(): DocumentFragment {
    const config = this.getSchedulerConfig();
    const status = buildSchedulerStatus(config, this.schedulerState.nextRunAt);
    const fragment = document.createDocumentFragment();
    fragment.appendText(`Mode: ${config.mode}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Internal scheduler enabled: ${status.enabled ? "Yes" : "No"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Interval: ${status.intervalMinutes} minutes`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Next run: ${formatTimestamp(status.nextRunAt)}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Last result: ${this.schedulerState.lastMessage}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Active run: ${this.currentProcess ? "Yes" : "No"}`);
    if (this.schedulerState.lastRunAt !== null) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`Last run at: ${formatTimestamp(this.schedulerState.lastRunAt)}`);
    }
    return fragment;
  }

  getRecentLogLines(): string[] {
    return [...this.recentLog];
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
    const snapshot = this.getPendingSnapshot();
    const fragment = document.createDocumentFragment();
    if (!snapshot.available) {
      fragment.appendText(`Pending scan unavailable: ${snapshot.reason}`);
      return fragment;
    }

    fragment.appendText(`Current scope: ${snapshot.current.total} pending`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`All scopes: ${snapshot.all.total} pending`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Top current items: ${snapshot.current.items.join(", ") || "None"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Top all items: ${snapshot.all.items.join(", ") || "None"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(
      `Last scan: ${snapshot.metrics.durationMs}ms, listed ${snapshot.metrics.filesListed}, rescanned ${snapshot.metrics.filesScanned}, updated ${snapshot.metrics.filesUpdated}`,
    );
    return fragment;
  }

  getScopeSetupStatus(): ScopeSetupStatus {
    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      return {
        complete: false,
        canManage: false,
        configPath: null,
        currentPaths: [],
        allPaths: [],
        guidance: error?.message ?? "Mindmap runtime is not ready.",
      };
    }

    if (!this.canManageConfig(runtime)) {
      return {
        complete: false,
        canManage: false,
        configPath: runtime.configPath,
        currentPaths: [],
        allPaths: [],
        guidance: "Scope setup controls only the bundled plugin config. Reset config path to default or update your custom config manually.",
      };
    }

    try {
      const rawConfig = fs.readFileSync(runtime.configPath, "utf8");
      const selection = readScopeSelection(rawConfig);
      return {
        complete: isScopeSetupComplete(selection),
        canManage: true,
        configPath: runtime.configPath,
        currentPaths: selection.currentPaths,
        allPaths: selection.allPaths,
        guidance: isScopeSetupComplete(selection)
          ? "Scope folders are configured."
          : "Select at least one folder for current and all scopes, then save setup.",
      };
    } catch (error) {
      return {
        complete: false,
        canManage: true,
        configPath: runtime.configPath,
        currentPaths: [],
        allPaths: [],
        guidance: error instanceof Error
          ? `Mindmap config could not be read: ${error.message}`
          : "Mindmap config could not be read.",
      };
    }
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

    const updated = updateScopeSelection(fs.readFileSync(status.configPath, "utf8"), selection);
    fs.writeFileSync(status.configPath, updated, "utf8");
    this.appendLog(`[setup] Updated scope folders in ${status.configPath}`);
    this.pendingScanService?.requestRefresh("scope setup updated");
    this.updateStatusBar();
  }

  getScopeSetupSummary(): DocumentFragment {
    const status = this.getScopeSetupStatus();
    const fragment = document.createDocumentFragment();
    fragment.appendText(`Configured: ${status.complete ? "Yes" : "No"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Config: ${status.configPath ?? "Unavailable"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Current scope: ${status.currentPaths.join(", ") || "None"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`All scopes: ${status.allPaths.join(", ") || "None"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(status.guidance);
    return fragment;
  }

  getDiagnosticsSummary(): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const { result, inProgress, lastRunAt } = this.diagnosticsState;

    fragment.appendText(`Preflight running: ${inProgress ? "Yes" : "No"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Last preflight: ${formatTimestamp(lastRunAt)}`);

    if (!result) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText("No preflight result recorded yet.");
    } else {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`Status: ${result.ok ? "Ready" : "Not ready"}`);
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`Summary: ${result.summary}`);
      for (const check of result.checks) {
        fragment.appendChild(document.createElement("br"));
        fragment.appendText(`[${check.status}] ${check.label}: ${check.message}`);
        if (check.guidance) {
          fragment.appendChild(document.createElement("br"));
          fragment.appendText(`Guidance: ${check.guidance}`);
        }
      }
    }

    const recent = this.getRecentLogLines().slice(-6);
    if (recent.length > 0) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText("Recent diagnostics:");
      for (const line of recent) {
        fragment.appendChild(document.createElement("br"));
        fragment.appendText(line);
      }
    }

    return fragment;
  }

  showRuntimeNotice(runtime: ResolvedRuntime): void {
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      new Notice(error?.message ?? "Mindmap runtime is not ready.", 12000);
      return;
    }

    const scheduleLabel = isSchedulerEnabled(this.settings.schedulerMode)
      ? `Scheduler: interval (next ${formatTimestamp(this.schedulerState.nextRunAt)}).`
      : "Scheduler: manual.";
    const pending = this.getPendingSnapshot();
    const pendingLabel = pending.available
      ? `Pending current/all: ${pending.current.total}/${pending.all.total}.`
      : `Pending unavailable: ${pending.reason}.`;
    const preflightLabel = this.diagnosticsState.result
      ? `Preflight: ${this.diagnosticsState.result.ok ? "ready" : "failed"} (${this.diagnosticsState.result.summary}).`
      : "Preflight: not run yet.";
    const setup = this.getScopeSetupStatus();
    const setupLabel = setup.complete
      ? `Scope setup: ready (${setup.currentPaths.length}/${setup.allPaths.length}).`
      : `Scope setup: required. ${setup.guidance}`;
    const currentPreview = formatCommandPreview(runtime, getRunProfile("current").args);
    const allPreview = formatCommandPreview(runtime, getRunProfile("all").args);

    new Notice(
      `Runtime trust: ${runtime.trust.level}. Runs: current ${currentPreview}; all ${allPreview}. ${scheduleLabel} ${pendingLabel} ${preflightLabel} ${setupLabel}`,
      12000,
    );
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
    const message = mode === "interval"
      ? `Mindmap interval scheduler enabled. Next run ${formatTimestamp(this.schedulerState.nextRunAt)}.`
      : "Mindmap interval scheduler disabled. Manual runs remain available.";
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
        for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
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
    this.updateStatusBar();
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

  private async runMindmap(trigger: RunTrigger, scope: RunScope = "current"): Promise<void> {
    if (this.currentProcess) {
      const message = "Mindmap is already running. Skipping the new request.";
      this.appendLog(message);
      if (trigger === "manual") {
        new Notice(message, 8000);
      }
      return;
    }

    const runtime = this.getResolvedRuntime();
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      const message = `Mindmap ${trigger} run skipped: ${error?.message ?? "runtime is not ready"}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return;
    }

    const scopeSetup = this.getScopeSetupStatus();
    if (!scopeSetup.complete) {
      const message = `Mindmap ${trigger} run skipped: ${scopeSetup.guidance}`;
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return;
    }

    let command: { command: string; args: string[]; cwd: string };
    const profile = getRunProfile(scope);
    try {
      command = this.buildRuntimeCommand(profile.args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Blocked unexpected subprocess arguments.";
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return;
    }

    const preview = formatCommandPreview(runtime, profile.args);
    this.appendLog(`Starting ${trigger} ${profile.label} run: ${preview}`);
    if (trigger === "manual") {
      new Notice(`Mindmap run started (${profile.label}). ${preview}`, 8000);
    }

    await new Promise<void>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentProcess = child;
      this.schedulerState.lastTrigger = trigger;
      this.schedulerState.lastMessage = `Running ${profile.label} via ${trigger} trigger.`;
      this.updateStatusBar();

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      child.stdout.on("data", (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
          stdoutLines.push(line);
          this.appendLog(`[stdout] ${line}`);
        }
      });

      child.stderr.on("data", (chunk) => {
        for (const line of chunk.toString().split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
          stderrLines.push(line);
          this.appendLog(`[stderr] ${line}`);
        }
      });

      child.on("error", (error) => {
        const message = `Mindmap ${trigger} ${profile.label} run failed to start: ${error.message}`;
        this.currentProcess = null;
        this.schedulerState.lastRunAt = Date.now();
        this.schedulerState.lastExitCode = -1;
        this.schedulerState.lastMessage = message;
        this.appendLog(message);
        new Notice(message, 12000);
        this.updateStatusBar();
        resolve();
      });

      child.on("close", (code) => {
        this.currentProcess = null;
        this.schedulerState.lastRunAt = Date.now();
        this.schedulerState.lastExitCode = code;
        const failureContext = stderrLines.at(-1) ?? stdoutLines.at(-1);
        this.schedulerState.lastMessage = code === 0
          ? `Last ${trigger} ${profile.label} run finished successfully.`
          : `Last ${trigger} ${profile.label} run exited with code ${code}.${failureContext ? ` ${failureContext}` : ""}`;
        this.appendLog(this.schedulerState.lastMessage);
        if (code !== 0 || trigger === "manual") {
          new Notice(this.schedulerState.lastMessage, 10000);
        }
        this.pendingScanService?.requestRefresh("run completed");
        this.updateStatusBar();
        resolve();
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

    if (this.currentProcess) {
      this.statusBarEl.setText("Mindmap: running");
      return;
    }

    if (this.diagnosticsState.inProgress) {
      this.statusBarEl.setText("Mindmap: preflight");
      return;
    }

    if (this.diagnosticsState.result && !this.diagnosticsState.result.ok) {
      this.statusBarEl.setText("Mindmap: preflight failed");
      return;
    }

    if (!this.getScopeSetupStatus().complete) {
      this.statusBarEl.setText("Mindmap: scope setup required");
      return;
    }

    if (isSchedulerEnabled(this.settings.schedulerMode)) {
      const pending = this.getPendingSnapshot();
      const pendingLabel = pending.available ? `${pending.current.total} pending` : "pending n/a";
      this.statusBarEl.setText(`Mindmap: ${pendingLabel} • next ${formatTimestamp(this.schedulerState.nextRunAt)}`);
      return;
    }

    const pending = this.getPendingSnapshot();
    this.statusBarEl.setText(pending.available ? `Mindmap: ${pending.current.total} pending` : "Mindmap: manual");
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
        mkdir: (targetPath, options) => fs.promises.mkdir(targetPath, options),
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

  private registerVaultRefreshEvents(): void {
    const markDirty = (file: TAbstractFile | null, oldPath?: string) => {
      const relpaths: string[] = [];
      if (oldPath && oldPath.endsWith(".md")) {
        relpaths.push(oldPath);
      }
      if (file instanceof TFile && file.extension === "md") {
        relpaths.push(file.path);
      }
      if (relpaths.length > 0) {
        this.pendingScanService?.requestRefresh("vault file changed", relpaths);
      }
    };

    this.registerEvent(this.app.vault.on("create", (file) => markDirty(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => markDirty(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => markDirty(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => markDirty(file, oldPath)));
  }
}
