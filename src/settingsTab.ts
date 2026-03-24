import { FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";

import { formatCommandPreview, type ResolvedRuntime } from "./pathResolver";
import type MindmapPlugin from "./main";
import { DEFAULT_SETTINGS, type RuntimeField } from "./settings";

const FIELD_META: Record<RuntimeField, { name: string; description: string; placeholder: string }> = {
  pythonCommand: {
    name: "Python command",
    description: "Use a PATH command like python3, or a vault-relative executable path such as .venv/bin/python.",
    placeholder: DEFAULT_SETTINGS.pythonCommand,
  },
  scriptPath: {
    name: "Mindmap script path",
    description: "Leave blank to use the bundled runtime, or enter a vault-relative file path.",
    placeholder: `.obsidian/plugins/${thisPluginId()}/python/mindmap.py`,
  },
  configPath: {
    name: "Mindmap config path",
    description: "Leave blank to use the bundled config, or enter a vault-relative file path inside the vault.",
    placeholder: `.obsidian/plugins/${thisPluginId()}/python/config.json`,
  },
};

function thisPluginId(): string {
  return "mindmap-obsidian";
}

export class MindmapSettingTab extends PluginSettingTab {
  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Mindmap Runtime" });
    containerEl.createEl("p", {
      text: "Portable defaults use the plugin runtime inside .obsidian/plugins. Override with vault-relative paths only when you need a custom script or config.",
    });

    this.renderPathSetting("pythonCommand");
    this.renderPathSetting("scriptPath");
    this.renderPathSetting("configPath");

    new Setting(containerEl)
      .setName("Validate runtime")
      .setDesc("Run the same path resolution and validation logic used before command execution.")
      .addButton((button) =>
        button.setButtonText("Check now").onClick(() => {
          const runtime = this.plugin.getResolvedRuntime();
          this.plugin.showRuntimeNotice(runtime);
          this.display();
        }),
      );

    this.renderSummary(this.plugin.getResolvedRuntime());
  }

  private renderPathSetting(field: RuntimeField): void {
    const metadata = FIELD_META[field];

    new Setting(this.containerEl)
      .setName(metadata.name)
      .setDesc(metadata.description)
      .addText((text) => {
        text
          .setPlaceholder(metadata.placeholder)
          .setValue(this.plugin.settings[field])
          .onChange(async (value) => {
            this.plugin.settings[field] = value.trim();
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default")
          .onClick(async () => {
            this.plugin.settings[field] = DEFAULT_SETTINGS[field];
            await this.plugin.saveSettings();
            new Notice(`${metadata.name} reset to default.`);
            this.display();
          });
      });
  }

  private renderSummary(runtime: ResolvedRuntime): void {
    const summary = new Setting(this.containerEl).setName("Resolved runtime");
    summary.setClass(runtime.valid ? "mindmap-validation-ok" : "mindmap-validation-error");

    const fragment = document.createDocumentFragment();
    fragment.appendText(`Status: ${runtime.valid ? "Ready" : "Not ready"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Python: ${runtime.command.command}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Script: ${runtime.scriptPath}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Config: ${runtime.configPath}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Command: ${formatCommandPreview(runtime, ["--current"])}`);

    for (const message of runtime.messages) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`[${message.level}] ${message.message}`);
    }

    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`Vault root: ${this.app.vault.adapter.getBasePath()}`);
    }

    summary.setDesc(fragment);
  }
}
