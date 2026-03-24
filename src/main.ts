import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { FileSystemAdapter, Notice, Plugin } from "obsidian";

import { formatCommandPreview, getPluginRuntimeDir, resolveRuntime, type ResolvedRuntime, type RuntimeContext } from "./pathResolver";
import { assertAllowedPluginArgs } from "./runArguments";
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

const DEFAULT_RUN_ARGS = ["--current", "--apply"];
const LOG_LIMIT = 50;

type RunTrigger = "manual" | "scheduled";

interface SchedulerState {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastTrigger: RunTrigger | null;
  lastExitCode: number | null;
  lastMessage: string;
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
    lastMessage: "Manual run only.",
  };
  private readonly recentLog: string[] = [];
  private statusBarEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBundledConfig();

    this.statusBarEl = this.addStatusBarItem();
    this.addSettingTab(new MindmapSettingTab(this.app, this));

    this.addCommand({
      id: "mindmap-run-now",
      name: "Run Mindmap now",
      callback: () => {
        void this.runMindmap("manual");
      },
    });

    this.addCommand({
      id: "mindmap-enable-scheduler",
      name: "Enable Mindmap scheduler",
      callback: () => {
        void this.setSchedulerMode("interval");
      },
    });

    this.addCommand({
      id: "mindmap-disable-scheduler",
      name: "Disable Mindmap scheduler",
      callback: () => {
        void this.setSchedulerMode("manual");
      },
    });

    this.addCommand({
      id: "mindmap-open-status",
      name: "Open Mindmap status",
      callback: () => {
        this.showRuntimeNotice(this.getResolvedRuntime());
      },
    });

    this.addCommand({
      id: "mindmap-validate-runtime",
      name: "Validate Mindmap runtime",
      callback: () => {
        this.showRuntimeNotice(this.getResolvedRuntime());
      },
    });

    this.syncScheduler();
  }

  onunload(): void {
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

  showRuntimeNotice(runtime: ResolvedRuntime): void {
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      new Notice(error?.message ?? "Mindmap runtime is not ready.", 12000);
      return;
    }

    const scheduleLabel = isSchedulerEnabled(this.settings.schedulerMode)
      ? `Scheduler on. Next run ${formatTimestamp(this.schedulerState.nextRunAt)}.`
      : "Scheduler off. Manual runs stay available on all desktop platforms.";

    new Notice(
      `Mindmap runtime ${runtime.trust.level}. ${formatCommandPreview(runtime, DEFAULT_RUN_ARGS)}. ${scheduleLabel}`,
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
      ? `Mindmap scheduler enabled. Next run ${formatTimestamp(this.schedulerState.nextRunAt)}.`
      : "Mindmap scheduler disabled. Manual runs remain available.";
    new Notice(message, 8000);
  }

  private syncScheduler(): void {
    if (isSchedulerEnabled(this.settings.schedulerMode)) {
      this.startScheduler();
    } else {
      this.stopScheduler("Manual mode. Internal scheduler disabled.");
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

    await this.runMindmap("scheduled");
    this.scheduleNextTick(Date.now());
  }

  private async runMindmap(trigger: RunTrigger): Promise<void> {
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

    let command: { command: string; args: string[]; cwd: string };
    try {
      command = this.buildRuntimeCommand(DEFAULT_RUN_ARGS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Blocked unexpected subprocess arguments.";
      this.schedulerState.lastMessage = message;
      this.appendLog(message);
      new Notice(message, 12000);
      this.updateStatusBar();
      return;
    }

    const preview = formatCommandPreview(runtime, DEFAULT_RUN_ARGS);
    this.appendLog(`Starting ${trigger} run: ${preview}`);
    if (trigger === "manual") {
      new Notice(`Mindmap run started. ${preview}`, 8000);
    }

    await new Promise<void>((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentProcess = child;
      this.schedulerState.lastTrigger = trigger;
      this.schedulerState.lastMessage = `Running via ${trigger} trigger.`;
      this.updateStatusBar();

      child.stdout.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
          this.appendLog(`[stdout] ${line}`);
        }
      });

      child.stderr.on("data", (chunk) => {
        const line = chunk.toString().trim();
        if (line) {
          this.appendLog(`[stderr] ${line}`);
        }
      });

      child.on("error", (error) => {
        const message = `Mindmap ${trigger} run failed to start: ${error.message}`;
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
        this.schedulerState.lastMessage = code === 0
          ? `Last ${trigger} run finished successfully.`
          : `Last ${trigger} run exited with code ${code}.`;
        this.appendLog(this.schedulerState.lastMessage);
        if (code !== 0 || trigger === "manual") {
          new Notice(this.schedulerState.lastMessage, 10000);
        }
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
    console.info(`[Mindmap] ${message}`);
  }

  private updateStatusBar(): void {
    if (!this.statusBarEl) {
      return;
    }

    if (this.currentProcess) {
      this.statusBarEl.setText("Mindmap: running");
      return;
    }

    if (isSchedulerEnabled(this.settings.schedulerMode)) {
      this.statusBarEl.setText(`Mindmap: next ${formatTimestamp(this.schedulerState.nextRunAt)}`);
      return;
    }

    this.statusBarEl.setText("Mindmap: manual");
  }

  private getRuntimeContext(): RuntimeContext {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      throw new Error("Mindmap requires the desktop filesystem adapter.");
    }

    const vaultRoot = this.app.vault.adapter.getBasePath();
    const pluginDirRelative = this.manifest.dir ?? path.posix.join(".obsidian", "plugins", this.manifest.id);

    return {
      vaultRoot,
      pluginDir: path.join(vaultRoot, pluginDirRelative),
    };
  }

  private async ensureBundledConfig(): Promise<void> {
    const runtimeDir = getPluginRuntimeDir(this.getRuntimeContext());
    const templatePath = path.join(runtimeDir, "config.template.json");
    const configPath = path.join(runtimeDir, "config.json");

    if (!fs.existsSync(templatePath) || fs.existsSync(configPath)) {
      return;
    }

    await fs.promises.mkdir(runtimeDir, { recursive: true });
    await fs.promises.copyFile(templatePath, configPath);
  }
}
