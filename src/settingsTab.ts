import { FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";

import type { ScopeSelection } from "./onboarding";
import { formatCommandPreview, type ResolvedRuntime } from "./pathResolver";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
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
  private onboardingDraft: ScopeSelection | null = null;

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
    containerEl.createEl("p", {
      text: "Trust warning: this plugin executes a local Python interpreter and reads local files. PATH commands and bundled runtime files are the safest options. Custom executable, script, or config paths should be reviewed before you run them.",
    });

    this.renderPathSetting("pythonCommand");
    this.renderPathSetting("scriptPath");
    this.renderPathSetting("configPath");
    this.renderFirstRunSetup();
    this.renderSchedulerSettings();

    new Setting(containerEl)
      .setName("Run preflight diagnostics")
      .setDesc("Validate Python execution, dependencies, Ollama reachability, and required models using the script's --preflight mode.")
      .addButton((button) =>
        button.setButtonText("Run preflight").onClick(() => {
          void this.plugin.runPreflight("manual").then(() => {
            this.display();
          });
        }),
      );

    this.renderSummary(this.plugin.getResolvedRuntime());
  }

  private renderFirstRunSetup(): void {
    const status = this.plugin.getScopeSetupStatus();
    const options = this.plugin.getVaultFolderOptions();
    const draft = this.getOnboardingDraft(status);

    this.containerEl.createEl("h3", { text: "First-run setup" });
    this.containerEl.createEl("p", {
      text: "Choose which vault folders Mindmap should use for the current scope and for all-scope runs. This updates the plugin-managed config file only and preserves unrelated config keys.",
    });

    new Setting(this.containerEl)
      .setName("Setup status")
      .setDesc(this.plugin.getScopeSetupSummary());

    if (!status.canManage) {
      return;
    }

    this.containerEl.createEl("h4", { text: "Current scope folders" });
    for (const option of options) {
      new Setting(this.containerEl)
        .setName(option.label)
        .setDesc("Included when the plugin runs with --current.")
        .addToggle((toggle) => {
          toggle
            .setValue(draft.currentPaths.includes(option.value))
            .onChange((value) => {
              this.toggleDraftValue("currentPaths", option.value, value);
            });
        });
    }

    this.containerEl.createEl("h4", { text: "All-scope folders" });
    for (const option of options) {
      new Setting(this.containerEl)
        .setName(option.label)
        .setDesc("Included when the plugin runs with --all.")
        .addToggle((toggle) => {
          toggle
            .setValue(draft.allPaths.includes(option.value))
            .onChange((value) => {
              this.toggleDraftValue("allPaths", option.value, value);
            });
        });
    }

    new Setting(this.containerEl)
      .setName("Save setup")
      .setDesc("Write the selected folders into the bundled config.json.")
      .addButton((button) =>
        button.setButtonText("Save scope folders").setCta().onClick(() => {
          void this.plugin.saveScopeSetup(this.getOnboardingDraft(status)).then(async () => {
            this.onboardingDraft = null;
            await this.plugin.runPreflight("manual");
            new Notice("Mindmap scope setup saved.");
            this.display();
          }).catch((error) => {
            new Notice(error instanceof Error ? error.message : "Failed to save Mindmap scope setup.", 12000);
          });
        }),
      )
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset draft to the saved config")
          .onClick(() => {
            this.onboardingDraft = {
              currentPaths: [...status.currentPaths],
              allPaths: [...status.allPaths],
            };
            this.display();
          });
      });
  }

  private renderSchedulerSettings(): void {
    this.containerEl.createEl("h3", { text: "Scheduling" });
    this.containerEl.createEl("p", {
      text: "The built-in scheduler uses an internal plugin timer and works the same way on macOS, Windows, and Linux. OS-native schedulers remain optional external alternatives.",
    });

    new Setting(this.containerEl)
      .setName("Scheduler mode")
      .setDesc("Manual keeps runs on demand only. Interval runs the same Python command path on a repeating timer.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual only")
          .addOption("interval", "Internal interval scheduler")
          .setValue(this.plugin.settings.schedulerMode)
          .onChange(async (value) => {
            this.plugin.settings.schedulerMode = value === "interval" ? "interval" : "manual";
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default")
          .onClick(async () => {
            this.plugin.settings.schedulerMode = DEFAULT_SETTINGS.schedulerMode;
            await this.plugin.saveSettings();
            new Notice("Scheduler mode reset to default.");
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Run interval")
      .setDesc(`Minimum ${MIN_SCHEDULER_INTERVAL_MINUTES} minutes. Only used when the internal interval scheduler is enabled.`)
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.schedulerIntervalMinutes))
          .setValue(String(this.plugin.settings.schedulerIntervalMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.schedulerIntervalMinutes = Number.isFinite(parsed)
              ? parsed
              : DEFAULT_SETTINGS.schedulerIntervalMinutes;
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset to default")
          .onClick(async () => {
            this.plugin.settings.schedulerIntervalMinutes = DEFAULT_SETTINGS.schedulerIntervalMinutes;
            await this.plugin.saveSettings();
            new Notice("Scheduler interval reset to default.");
            this.display();
          });
      });
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
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Trust: ${runtime.trust.level}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Interpreter trust: ${runtime.trust.interpreter}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Script trust: ${runtime.trust.script}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Config trust: ${runtime.trust.config}`);

    for (const message of runtime.messages) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`[${message.level}] ${message.message}`);
    }

    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`Vault root: ${this.app.vault.adapter.getBasePath()}`);
    }

    summary.setDesc(fragment);

    new Setting(this.containerEl)
      .setName("Scheduler status")
      .setDesc(this.plugin.getSchedulerSummary());

    new Setting(this.containerEl)
      .setName("Pending scan")
      .setDesc(this.plugin.getPendingSummary());

    new Setting(this.containerEl)
      .setName("Diagnostics")
      .setDesc(this.plugin.getDiagnosticsSummary());
  }

  private getOnboardingDraft(status = this.plugin.getScopeSetupStatus()): ScopeSelection {
    if (!this.onboardingDraft) {
      this.onboardingDraft = {
        currentPaths: [...status.currentPaths],
        allPaths: [...status.allPaths],
      };
    }
    return this.onboardingDraft;
  }

  private toggleDraftValue(field: keyof ScopeSelection, value: string, enabled: boolean): void {
    const draft = this.getOnboardingDraft();
    const nextValues = enabled
      ? [...draft[field], value]
      : draft[field].filter((entry) => entry !== value);
    this.onboardingDraft = {
      ...draft,
      [field]: nextValues,
    };
  }
}
