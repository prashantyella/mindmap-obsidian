import { FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";

import { formatCommandPreview, type ResolvedRuntime } from "./pathResolver";
import { getRunProfile } from "./runProfiles";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import { normalizeHour, normalizeMinute } from "./launchAgent";
import type MindmapPlugin from "./main";
import { DEFAULT_METADATA_MODEL, type LlmProviderConfig } from "./pluginConfig";
import { ScopeManager } from "./scopeManager";
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
  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderScopeSetupSettings();
    this.renderProviderSettings();
    this.renderSchedulerSettings();
    this.renderResearchSettings();
    this.renderDiagnosticsSettings();
    this.renderAdvancedRuntimeSettings();
    this.renderSummary(this.plugin.getResolvedRuntime());
  }

  private renderResearchSettings(): void {
    this.renderSection("Web Research", "Off, Manual, or Automatic for Reading. Automatic keeps manual research available.");
    const status = this.plugin.getWebResearchStatus();
    new Setting(this.containerEl)
      .setName("Manual research")
      .setDesc(status.mode === "automatic-reading" ? "Included with Automatic for Reading; selected text and active notes remain available on demand." : status.mode === "manual" ? "Enabled for selected text and bounded active-note excerpts." : "Off. Enable it for on-demand research only.")
      .addButton((button) => button
        .setButtonText(status.mode === "automatic-reading" ? "Included" : status.mode === "manual" ? "Disable" : "Enable")
        .setDisabled(status.mode === "automatic-reading" || ["deriving", "searching", "writing"].includes(status.activity))
        .onClick(async () => {
          await this.plugin.toggleWebResearchMode();
          this.display();
        }));
    new Setting(this.containerEl)
      .setName("Automatic for Reading")
      .setDesc(status.mode === "automatic-reading"
        ? `${status.automatic.attempted}/10 today · max 5/sync · ${this.plugin.getReadingHealth().unresearchableCount} unresearchable.${status.automatic.pauseReason === "daily-limit" ? " Daily limit reached; resumes after local midnight." : status.automatic.pauseReason ? ` Paused: ${status.automatic.pauseReason}.` : this.plugin.getReadingHealth().mode === "reading" ? " Active in Reading Mode." : " Waiting for Reading Mode."}`
        : "Requires Reading Mode and separate consent.")
      .addButton((button) => button
        .setButtonText(status.mode === "automatic-reading" ? "Pause" : "Enable")
        .setDisabled(["deriving", "searching", "writing"].includes(status.activity))
        .onClick(async () => {
          await this.plugin.toggleAutomaticReadingResearch();
          this.display();
        }));
    if (status.mode === "automatic-reading" && status.automatic.pauseReason && status.automatic.pauseReason !== "daily-limit") {
      new Setting(this.containerEl)
        .setName("Automatic research")
        .setDesc(status.automatic.lastError ?? status.lastError ?? `Paused: ${status.automatic.pauseReason}.`)
        .addButton((button) => button.setButtonText("Retry").onClick(async () => {
          await this.plugin.retryAutomaticResearch();
          this.display();
        }));
    }
  }

  private renderSection(title: string, description: string): void {
    new Setting(this.containerEl).setName(title).setHeading().setClass("mindmap-settings-heading");
    this.containerEl.createEl("p", { cls: "mindmap-settings-section-desc", text: description });
  }

  private renderDiagnosticsSettings(): void {
    this.renderSection("Diagnostics", "Check runtime readiness.");
    new Setting(this.containerEl)
      .setName("Preflight")
      .setDesc("Python, dependencies, model service, and required models.")
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

    this.renderSection("Scope", "Choose folders for current-note runs and full-vault runs.");

    new Setting(this.containerEl)
      .setName("Scope status")
      .setDesc(this.plugin.getScopeSetupSummary());

    if (!status.canManage) {
      return;
    }

    const scopeManager = this.containerEl.createDiv();
    new ScopeManager(this.plugin, scopeManager).render();

    new Setting(this.containerEl)
      .setName("Mindmap sidebar")
      .setDesc("Open the active note graph panel.")
      .addButton((button) =>
        button.setButtonText("Open Mindmap").setCta().onClick(() => {
          void this.plugin.openMindmapView();
        }),
      );
  }

  private renderProviderSettings(): void {
    this.renderSection("Provider", "Local model service for summaries, tags, concepts, and links.");

    const status = this.plugin.getLlmProviderConfigStatus();
    if (!status.canManage) {
      new Setting(this.containerEl)
        .setName("Provider config")
        .setDesc(status.guidance);
      return;
    }

    new Setting(this.containerEl)
      .setName("Provider")
      .setDesc(`Config: ${status.configPath ?? "Unavailable"}`)
      .addDropdown((dropdown) => {
        dropdown
          .addOption("ollama", "Ollama")
          .addOption("openai_compatible", "OpenAI compatible")
          .setValue(status.provider)
          .onChange((value) => {
            this.saveProviderConfig({
              provider: value === "openai_compatible" ? "openai_compatible" : "ollama",
            });
            this.display();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Use OMLX")
          .onClick(() => {
            this.saveProviderConfig({
              provider: "openai_compatible",
              baseUrl: "http://localhost:8000/v1",
              model: DEFAULT_METADATA_MODEL,
              maxTokens: 1024,
              enableThinking: false,
            });
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Base URL")
      .setDesc(status.provider === "openai_compatible" ? "Include the /v1 suffix." : "Ollama server URL.")
      .addText((text) => {
        text
          .setPlaceholder(status.provider === "openai_compatible" ? "http://localhost:8000/v1" : "http://localhost:11434")
          .setValue(status.baseUrl)
          .onChange((value) => {
            this.saveProviderConfig({ baseUrl: value });
          });
      });

    new Setting(this.containerEl)
      .setName("Model")
      .setDesc("Model used for metadata extraction.")
      .addText((text) => {
        text
          .setPlaceholder(status.provider === "openai_compatible" ? DEFAULT_METADATA_MODEL : "llama3.1:8b")
          .setValue(status.model)
          .onChange((value) => {
            this.saveProviderConfig({ model: value });
          });
      });

    new Setting(this.containerEl)
      .setName("Local API key")
      .setDesc("Stored in the local plugin runtime config.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Optional")
          .setValue(status.apiKey)
          .onChange((value) => {
            this.saveProviderConfig({ apiKey: value });
          });
      });

    new Setting(this.containerEl)
      .setName("Max output tokens")
      .setDesc("Caps only the metadata response, not the note text sent to the model.")
      .addText((text) => {
        text
          .setPlaceholder("1024")
          .setValue(String(status.maxTokens))
          .onChange((value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.saveProviderConfig({ maxTokens: Number.isFinite(parsed) ? parsed : 1024 });
          });
      });

    new Setting(this.containerEl)
      .setName("Model thinking")
      .setDesc("Disable for Qwen/OMLX JSON extraction.")
      .addToggle((toggle) => {
        toggle
          .setValue(status.enableThinking)
          .onChange((value) => {
            this.saveProviderConfig({ enableThinking: value });
            this.display();
          });
      });
  }

  private saveProviderConfig(patch: Partial<LlmProviderConfig>): void {
    const status = this.plugin.getLlmProviderConfigStatus();
    if (!status.canManage) {
      new Notice(status.guidance, 8000);
      return;
    }

    try {
      this.plugin.saveLlmProviderConfig({
        provider: status.provider,
        baseUrl: status.baseUrl,
        model: status.model,
        apiKey: status.apiKey,
        maxTokens: status.maxTokens,
        enableThinking: status.enableThinking,
        ...patch,
      });
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Mindmap provider config could not be saved.", 8000);
    }
  }

  private renderSchedulerSettings(): void {
    this.renderSection("Scheduler", "Manual, interval, or macOS LaunchAgent runs.");

    new Setting(this.containerEl)
      .setName("Mode")
      .setDesc("LaunchAgent continues when Obsidian is closed.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("interval", "Interval")
          .addOption("launchAgent", "LaunchAgent")
          .setValue(this.plugin.settings.schedulerMode)
          .onChange(async (value) => {
            this.plugin.settings.schedulerMode = value === "launchAgent"
              ? "launchAgent"
              : value === "interval"
                ? "interval"
                : "manual";
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

    new Setting(this.containerEl)
      .setName("Daily LaunchAgent time")
      .setDesc("Runs all-scope apply Monday through Saturday in LaunchAgent mode.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyHour))
          .setValue(String(this.plugin.settings.launchAgentDailyHour))
          .onChange(async (value) => {
            this.plugin.settings.launchAgentDailyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyMinute).padStart(2, "0"))
          .setValue(String(this.plugin.settings.launchAgentDailyMinute).padStart(2, "0"))
          .onChange(async (value) => {
            this.plugin.settings.launchAgentDailyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Weekly refresh LaunchAgent")
      .setDesc("Runs all-scope refresh and apply on Sunday in LaunchAgent mode.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.launchAgentWeeklyEnabled)
          .onChange(async (value) => {
            this.plugin.settings.launchAgentWeeklyEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Weekly LaunchAgent time")
      .setDesc("Used only when the weekly refresh LaunchAgent is enabled.")
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyHour))
          .setValue(String(this.plugin.settings.launchAgentWeeklyHour))
          .onChange(async (value) => {
            this.plugin.settings.launchAgentWeeklyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
      })
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyMinute).padStart(2, "0"))
          .setValue(String(this.plugin.settings.launchAgentWeeklyMinute).padStart(2, "0"))
          .onChange(async (value) => {
            this.plugin.settings.launchAgentWeeklyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
        });

    const catchUp = this.plugin.getLaunchAgentCatchUpStatus();
    if (catchUp.available) {
      new Setting(this.containerEl)
        .setName("Scheduled recovery")
        .setDesc(catchUp.message)
        .addButton((button) => {
          button
            .setButtonText("Catch up pending notes")
            .setCta()
            .onClick(async () => {
              await this.plugin.runLaunchAgentCatchUp();
              this.display();
            });
        });
    }
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

  private renderAdvancedRuntimeSettings(): void {
    this.renderSection("Advanced", "Runtime overrides. Leave these blank unless you need a custom local setup.");
    this.renderPathSetting("pythonCommand");
    this.renderPathSetting("scriptPath");
    this.renderPathSetting("configPath");
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

}
