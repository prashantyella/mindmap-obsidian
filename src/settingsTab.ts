import { FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";

import { formatCommandPreview, type ResolvedRuntime } from "./pathResolver";
import { getRunProfile } from "./runProfiles";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import { normalizeHour, normalizeMinute } from "./launchAgent";
import type MindmapPlugin from "./main";
import type { LlmProviderConfig } from "./main";
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
    this.renderProviderSettings();
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

    this.renderSection("Scope setup", "Review configured folders here. Use the Mindmap tab for full scope management.");

    new Setting(this.containerEl)
      .setName("Scope status")
      .setDesc(this.plugin.getScopeSetupSummary());

    if (!status.canManage) {
      return;
    }

    new Setting(this.containerEl)
      .setName("Manage scope")
      .setDesc("Open the dedicated Mindmap tab to search folders, select current/all scope, and save setup.")
      .addButton((button) =>
        button.setButtonText("Open Mindmap").setCta().onClick(() => {
          void this.plugin.openMindmapView();
        }),
      );
  }

  private renderProviderSettings(): void {
    this.renderSection("LLM provider", "Configure the local model service used for summary, tag, and concept extraction.");

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
              model: "Qwen3.5-9B-MLX-4bit",
              maxTokens: 1024,
              enableThinking: false,
            });
            this.display();
          });
      });

    new Setting(this.containerEl)
      .setName("Base URL")
      .setDesc("OpenAI-compatible providers should include the /v1 suffix.")
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
          .setPlaceholder(status.provider === "openai_compatible" ? "Qwen3.5-9B-MLX-4bit" : "llama3.1:8b")
          .setValue(status.model)
          .onChange((value) => {
            this.saveProviderConfig({ model: value });
          });
      });

    new Setting(this.containerEl)
      .setName("Local API key")
      .setDesc("Stored in the plugin runtime config for local OpenAI-compatible servers.")
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
    this.renderSection("Scheduler", "Use manual runs, in-app interval scheduling, or plugin-managed macOS LaunchAgents.");

    new Setting(this.containerEl)
      .setName("Mode")
      .setDesc("Manual runs on demand. Interval runs while Obsidian is open. LaunchAgent runs continue when Obsidian is closed.")
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

}
