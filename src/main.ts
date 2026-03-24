import fs from "node:fs";
import path from "node:path";

import { FileSystemAdapter, Notice, Plugin } from "obsidian";

import { formatCommandPreview, getPluginRuntimeDir, resolveRuntime, type ResolvedRuntime, type RuntimeContext } from "./pathResolver";
import { DEFAULT_SETTINGS, type MindmapSettings } from "./settings";
import { MindmapSettingTab } from "./settingsTab";

export default class MindmapPlugin extends Plugin {
  settings: MindmapSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBundledConfig();

    this.addSettingTab(new MindmapSettingTab(this.app, this));

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
  }

  onunload(): void {
    // No persistent resources in this phase.
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  getResolvedRuntime(): ResolvedRuntime {
    return resolveRuntime(this.settings, this.getRuntimeContext());
  }

  showRuntimeNotice(runtime: ResolvedRuntime): void {
    if (!runtime.valid) {
      const error = runtime.messages.find((message) => message.level === "error");
      new Notice(error?.message ?? "Mindmap runtime is not ready.", 12000);
      return;
    }

    new Notice(`Mindmap runtime ready. ${formatCommandPreview(runtime, ["--current"])}`, 12000);
  }

  buildRuntimeCommand(extraArgs: string[] = []): { command: string; args: string[]; cwd: string } {
    const runtime = this.getResolvedRuntime();
    return {
      command: runtime.command.command,
      args: [...runtime.command.args, ...extraArgs],
      cwd: runtime.command.cwd,
    };
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
