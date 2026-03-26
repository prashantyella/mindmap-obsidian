import { FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";

import type { ScopeSelection } from "./onboarding";
import { formatCommandPreview, type ResolvedRuntime } from "./pathResolver";
import { getRunProfile } from "./runProfiles";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import type MindmapPlugin from "./main";
import { DEFAULT_SETTINGS, type RuntimeField } from "./settings";

const FIELD_META: Record<RuntimeField, { name: string; description: string }> = {
  pythonCommand: {
    name: "Python command",
    description: "Use a PATH command (for example python3) or a vault-relative executable path.",
  },
  scriptPath: {
    name: "Script path",
    description: "Leave blank to use the bundled script, or enter a vault-relative path.",
  },
  configPath: {
    name: "Config path",
    description: "Leave blank to use the bundled config, or enter a vault-relative path.",
  },
};

function thisPluginId(): string {
  return "mindmap-ai";
}

function getPluginRuntimeRelativePath(configDir: string): string {
  return `${configDir}/plugins/${thisPluginId()}/python`;
}

export class MindmapSettingTab extends PluginSettingTab {
  private onboardingDraft: ScopeSelection | null = null;

  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderSection(
      "Runtime",
      "Use bundled defaults unless you need vault-relative overrides.",
    );
    containerEl.createEl("p", {
      text: "This plugin runs a local runtime process and reads local files. Review custom executable, script, and config paths before running.",
    });

    this.renderPathSetting("pythonCommand");
    this.renderPathSetting("scriptPath");
    this.renderPathSetting("configPath");
    this.renderScopeSetupSettings();
    this.renderSchedulerSettings();
    this.renderDiagnosticsSettings();
    this.renderSummary(this.plugin.getResolvedRuntime());
  }

  private renderSection(title: string, description: string): void {
    new Setting(this.containerEl).setName(title).setHeading();
    this.containerEl.createEl("p", { text: description });
  }

  private renderDiagnosticsSettings(): void {
    this.renderSection("Diagnostics", "Run preflight checks and review runtime status.");
    new Setting(this.containerEl)
      .setName("Preflight checks")
      .setDesc(
        "Checks the local runtime, dependencies, model service, and required models.",
      )
      .addButton((button) =>
        button.setButtonText("Run checks").onClick(() => {
          void this.plugin.runPreflight("manual").then(() => {
            this.display();
          });
        }),
      );
  }

  private renderScopeSetupSettings(): void {
    const status = this.plugin.getScopeSetupStatus();
    const options = this.plugin.getVaultFolderOptions();
    const draft = this.getOnboardingDraft(status);

    this.renderSection("Scope setup", "Choose folders used for current-scope and all-scope runs.");

    new Setting(this.containerEl)
      .setName("Scope status")
      .setDesc(this.plugin.getScopeSetupSummary());

    if (!status.canManage) {
      return;
    }

    new Setting(this.containerEl).setName("Current scope (--current)").setHeading();
    for (const option of options) {
      new Setting(this.containerEl)
        .setName(option.label)
        .setDesc("Used by run mindmap (current scope).")
        .addToggle((toggle) => {
          toggle
            .setValue(draft.currentPaths.includes(option.value))
            .onChange((value) => {
              this.toggleDraftValue("currentPaths", option.value, value);
            });
        });
    }

    new Setting(this.containerEl).setName("All scope (--all)").setHeading();
    for (const option of options) {
      new Setting(this.containerEl)
        .setName(option.label)
        .setDesc("Used by run mindmap (all scopes).")
        .addToggle((toggle) => {
          toggle
            .setValue(draft.allPaths.includes(option.value))
            .onChange((value) => {
              this.toggleDraftValue("allPaths", option.value, value);
            });
        });
    }

    new Setting(this.containerEl)
      .setName("Save scope setup")
      .setDesc("Save selected folders to the bundled config file.")
      .addButton((button) =>
        button.setButtonText("Save setup").setCta().onClick(async () => {
          try {
            this.plugin.saveScopeSetup(this.getOnboardingDraft(status));
            this.onboardingDraft = null;
            await this.plugin.runPreflight("manual");
            new Notice("Scope setup saved.");
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "Failed to save scope setup.", 12000);
          }
        }),
      )
      .addExtraButton((button) => {
        button
          .setIcon("reset")
          .setTooltip("Reset unsaved changes")
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
    this.renderSection("Scheduler", "Use manual runs or enable interval scheduling for current-scope runs.");

    new Setting(this.containerEl)
      .setName("Mode")
      .setDesc("Manual runs on demand. Interval runs on a repeating timer.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("interval", "Interval")
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
            new Notice("Scheduler mode reset.");
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Interval (minutes)")
      .setDesc(`Minimum ${MIN_SCHEDULER_INTERVAL_MINUTES}. Used only in interval mode.`)
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
            new Notice("Scheduler interval reset.");
            this.display();
          });
      });
  }

  private renderPathSetting(field: RuntimeField): void {
    const metadata = FIELD_META[field];
    const runtimePath = getPluginRuntimeRelativePath(this.app.vault.configDir);
    const placeholder = field === "pythonCommand"
      ? DEFAULT_SETTINGS.pythonCommand
      : field === "scriptPath"
        ? `${runtimePath}/mindmap.py`
        : `${runtimePath}/config.json`;

    new Setting(this.containerEl)
      .setName(metadata.name)
      .setDesc(metadata.description)
      .addText((text) => {
        text
          .setPlaceholder(placeholder)
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
    new Setting(this.containerEl).setName("Status").setHeading();
    const summary = new Setting(this.containerEl).setName("Runtime status");
    summary.setClass(runtime.valid ? "mindmap-validation-ok" : "mindmap-validation-error");

    const fragment = document.createDocumentFragment();
    const currentPreview = formatCommandPreview(runtime, getRunProfile("current").args);
    const allPreview = formatCommandPreview(runtime, getRunProfile("all").args);
    fragment.appendText(`Status: ${runtime.valid ? "Ready" : "Not ready"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Run commands: current ${currentPreview}; all ${allPreview}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Python: ${runtime.command.command}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Script: ${runtime.scriptPath}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Config: ${runtime.configPath}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Trust: ${runtime.trust.level}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Interpreter: ${runtime.trust.interpreter}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Script source: ${runtime.trust.script}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Config source: ${runtime.trust.config}`);

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
      .setName("Scheduler")
      .setDesc(this.plugin.getSchedulerSummary());

    new Setting(this.containerEl)
      .setName("Pending notes")
      .setDesc(this.plugin.getPendingSummary());

    new Setting(this.containerEl)
      .setName("Preflight")
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
