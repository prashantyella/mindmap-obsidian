import { Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";

import { bindCommitOnBlurOrEnter } from "./commitOnBlur";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import { buildScheduleVisibility, isSchedulerRecoveryActionable } from "./scheduleVisibility";
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
  private unsubscribeRuntimeSetup: (() => void) | null = null;

  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.unsubscribeRuntimeSetup?.();
    this.unsubscribeRuntimeSetup = this.plugin.subscribeRuntimeSetupState(() => this.display());

    const { containerEl } = this;
    containerEl.empty();

    this.renderOverview();
    this.renderReadingAndResearch();
    this.renderScope();
    this.renderSchedule();
    this.renderLocalAi();
    this.renderTroubleshooting();
  }

  hide(): void {
    this.unsubscribeRuntimeSetup?.();
    this.unsubscribeRuntimeSetup = null;
    super.hide();
  }

  private renderSection(title: string, description: string, containerEl: HTMLElement = this.containerEl): void {
    new Setting(containerEl).setName(title).setHeading().setClass("mindmap-settings-heading");
    if (description) {
      containerEl.createEl("p", { cls: "mindmap-settings-section-desc", text: description });
    }
  }

  // ---------------------------------------------------------------------
  // Overview: one compact, path-free product-state row.
  // ---------------------------------------------------------------------

  private renderOverview(): void {
    this.renderSection("Overview", "");
    const state = this.plugin.getOverviewState();

    const setting = new Setting(this.containerEl)
      .setName(state.ready ? "Ready" : "Setup required")
      .setDesc(state.message)
      .setClass(state.ready ? "mindmap-validation-ok" : "mindmap-validation-error");

    if (state.actions.includes("openMindmap")) {
      setting.addButton((button) => button
        .setButtonText("Open Mindmap")
        .setCta()
        .onClick(() => { void this.plugin.openMindmapView(); }));
    }
    if (state.actions.includes("runChecks")) {
      setting.addButton((button) => button
        .setButtonText("Run checks")
        .onClick(() => {
          void this.plugin.runPreflight("manual").then(() => this.display());
        }));
    }
    if (state.actions.includes("setupRuntime")) {
      setting.addButton((button) => button
        .setCta()
        .setButtonText("Set up runtime")
        .onClick(async () => {
          await this.plugin.startRuntimeSetup();
          this.display();
        }));
    }
    if (state.actions.includes("cancelSetup")) {
      setting.addButton((button) => button
        .setButtonText("Cancel setup")
        .onClick(() => {
          this.plugin.cancelRuntimeSetup();
          this.display();
        }));
    }
    if (state.actions.includes("openPythonDownload")) {
      setting.addButton((button) => button
        .setButtonText("Open Python download page")
        .onClick(() => {
          this.plugin.openPythonRuntimeDownloadPage();
        }));
    }
  }

  // ---------------------------------------------------------------------
  // Reading and Research
  // ---------------------------------------------------------------------

  private renderReadingAndResearch(): void {
    this.renderSection("Reading and Research", "Reading Mode watches Apple Books and imports new annotations. Manual and Automatic research add context from the web.");

    const readingMode = this.plugin.settings.readingMode;
    new Setting(this.containerEl)
      .setName("Reading Mode")
      .setDesc(readingMode === "reading"
        ? "Importing new Apple Books annotations and processing them automatically."
        : "Off. Turning this on previews what would import, then asks you to confirm before the first sync.")
      .addToggle((toggle) => toggle
        .setValue(readingMode === "reading")
        .onChange(async (value) => {
          await this.plugin.selectReadingMode(value ? "reading" : "standard");
          this.display();
        }));

    const status = this.plugin.getWebResearchStatus();
    new Setting(this.containerEl)
      .setName("Manual research")
      .setDesc(status.mode === "automatic-reading"
        ? "Included with Automatic for Reading; selected text and active notes remain available on demand."
        : status.mode === "manual"
          ? "Enabled for selected text and bounded active-note excerpts."
          : "Off. Enable it for on-demand research only.")
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
        ? `${status.automatic.attempted}/10 today · max 5/sync.${status.automatic.pauseReason === "daily-limit" ? " Daily limit reached; resumes after local midnight." : status.automatic.pauseReason ? ` Paused: ${status.automatic.pauseReason}.` : ""}`
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
        .setName("Automatic research paused")
        .setDesc(status.automatic.lastError ?? status.lastError ?? `Paused: ${status.automatic.pauseReason}.`)
        .addButton((button) => button.setButtonText("Retry").onClick(async () => {
          await this.plugin.retryAutomaticResearch();
          this.display();
        }));
    }
  }

  // ---------------------------------------------------------------------
  // Scope: ScopeManager owns the single chips/tree/Save surface.
  // ---------------------------------------------------------------------

  private renderScope(): void {
    this.renderSection("Scope", "Choose folders for current-note runs and full-vault runs.");
    const status = this.plugin.getScopeSetupStatus();

    if (!status.canManage) {
      new Setting(this.containerEl).setName("Scope").setDesc(status.guidance);
      return;
    }

    const scopeManager = this.containerEl.createDiv();
    new ScopeManager(this.plugin, scopeManager).render();
  }

  // ---------------------------------------------------------------------
  // Schedule: mode selector always; every other control conditional on mode.
  // ---------------------------------------------------------------------

  private renderSchedule(): void {
    this.renderSection("Schedule", "Manual, interval, or macOS LaunchAgent runs.");
    void this.plugin.refreshLaunchAgentHealth();

    const mode = this.plugin.settings.schedulerMode;
    const visibility = buildScheduleVisibility(mode, this.plugin.settings.launchAgentWeeklyEnabled);

    new Setting(this.containerEl)
      .setName("Mode")
      .setDesc("LaunchAgent continues when Obsidian is closed.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("interval", "Interval")
          .addOption("launchAgent", "LaunchAgent")
          .setValue(mode)
          .onChange(async (value) => {
            this.plugin.settings.schedulerMode = value === "launchAgent"
              ? "launchAgent"
              : value === "interval"
                ? "interval"
                : "manual";
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (visibility.showInterval) {
      new Setting(this.containerEl)
        .setName("Interval (minutes)")
        .setDesc(`Minimum ${MIN_SCHEDULER_INTERVAL_MINUTES}.`)
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.schedulerIntervalMinutes)).setValue(String(this.plugin.settings.schedulerIntervalMinutes));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.schedulerIntervalMinutes = Number.isFinite(parsed) ? parsed : DEFAULT_SETTINGS.schedulerIntervalMinutes;
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    if (visibility.showDailyTime) {
      new Setting(this.containerEl)
        .setName("Daily LaunchAgent time")
        .setDesc("Runs all-scope apply Monday through Saturday.")
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyHour)).setValue(String(this.plugin.settings.launchAgentDailyHour));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentDailyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
        })
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyMinute).padStart(2, "0")).setValue(String(this.plugin.settings.launchAgentDailyMinute).padStart(2, "0"));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentDailyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    if (visibility.showWeeklyToggle) {
      new Setting(this.containerEl)
        .setName("Weekly refresh LaunchAgent")
        .setDesc("Runs all-scope refresh and apply on Sunday.")
        .addToggle((toggle) => {
          toggle.setValue(this.plugin.settings.launchAgentWeeklyEnabled).onChange(async (value) => {
            this.plugin.settings.launchAgentWeeklyEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    if (visibility.showWeeklyTime) {
      new Setting(this.containerEl)
        .setName("Weekly LaunchAgent time")
        .setDesc("Used only while the weekly refresh is enabled.")
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyHour)).setValue(String(this.plugin.settings.launchAgentWeeklyHour));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentWeeklyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
        })
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyMinute).padStart(2, "0")).setValue(String(this.plugin.settings.launchAgentWeeklyMinute).padStart(2, "0"));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentWeeklyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            this.display();
          });
        });
    }

    const schedulerHealth = this.plugin.getStatusBarInternalState().schedulerHealth;
    if (isSchedulerRecoveryActionable(mode, schedulerHealth)) {
      const catchUp = this.plugin.getLaunchAgentCatchUpStatus();
      const setting = new Setting(this.containerEl)
        .setName("Scheduler needs attention")
        .setDesc(catchUp.message)
        .setClass("mindmap-validation-error");
      if (catchUp.available) {
        setting.addButton((button) => button
          .setButtonText("Catch up pending notes")
          .setCta()
          .onClick(async () => {
            await this.plugin.runLaunchAgentCatchUp();
            this.display();
          }));
      }
    }
  }

  // ---------------------------------------------------------------------
  // Local AI: text fields commit on blur/Enter, not per keystroke.
  // ---------------------------------------------------------------------

  private bindProviderText(text: TextComponent, commit: (value: string) => boolean): void {
    bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), commit);
  }

  private renderLocalAi(): void {
    this.renderSection("Local AI", "Local model service for summaries, tags, concepts, and links.");

    const status = this.plugin.getLlmProviderConfigStatus();
    if (!status.canManage) {
      new Setting(this.containerEl).setName("Local AI").setDesc(status.guidance);
      return;
    }

    new Setting(this.containerEl)
      .setName("Provider")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("ollama", "Ollama")
          .addOption("openai_compatible", "OpenAI compatible")
          .setValue(status.provider)
          .onChange((value) => {
            this.saveProviderConfig({ provider: value === "openai_compatible" ? "openai_compatible" : "ollama" });
            this.display();
          });
      })
      .addButton((button) => {
        button.setButtonText("Use OMLX").onClick(() => {
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
        text.setPlaceholder(status.provider === "openai_compatible" ? "http://localhost:8000/v1" : "http://localhost:11434").setValue(status.baseUrl);
        this.bindProviderText(text, (value) => this.saveProviderConfig({ baseUrl: value }));
      });

    new Setting(this.containerEl)
      .setName("Model")
      .setDesc("Model used for metadata extraction.")
      .addText((text) => {
        text.setPlaceholder(status.provider === "openai_compatible" ? DEFAULT_METADATA_MODEL : "llama3.1:8b").setValue(status.model);
        this.bindProviderText(text, (value) => this.saveProviderConfig({ model: value }));
      });

    new Setting(this.containerEl)
      .setName("Local API key")
      .setDesc("Stored in the local plugin runtime config.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("Optional").setValue(status.apiKey);
        this.bindProviderText(text, (value) => this.saveProviderConfig({ apiKey: value }));
      });

    new Setting(this.containerEl)
      .setName("Max output tokens")
      .setDesc("Caps only the metadata response, not the note text sent to the model.")
      .addText((text) => {
        text.setPlaceholder("1024").setValue(String(status.maxTokens));
        this.bindProviderText(text, (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          return this.saveProviderConfig({ maxTokens: Number.isFinite(parsed) ? parsed : 1024 });
        });
      });

    new Setting(this.containerEl)
      .setName("Model thinking")
      .setDesc("Disable for Qwen/OMLX JSON extraction.")
      .addToggle((toggle) => {
        toggle.setValue(status.enableThinking).onChange((value) => {
          this.saveProviderConfig({ enableThinking: value });
          this.display();
        });
      });
  }

  /**
   * Returns whether the save actually succeeded so the blur/Enter commit
   * binder (commitOnBlur.ts) knows not to advance its last-committed value
   * on failure -- otherwise a failed save would look "committed" and the
   * user could never retry it by re-blurring the same text.
   */
  private saveProviderConfig(patch: Partial<LlmProviderConfig>): boolean {
    const status = this.plugin.getLlmProviderConfigStatus();
    if (!status.canManage) {
      new Notice(status.guidance, 8000);
      return false;
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
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Mindmap provider config could not be saved.", 8000);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Troubleshooting: native collapsed <details>/<summary>.
  // ---------------------------------------------------------------------

  private renderTroubleshooting(): void {
    const details = this.containerEl.createEl("details", { cls: "mindmap-troubleshooting" });
    details.createEl("summary", { text: "Troubleshooting" });

    const preflightSetting = new Setting(details)
      .setName("Preflight")
      .setDesc(this.plugin.getDiagnosticsOneLine())
      .addButton((button) => button.setButtonText("Run preflight").onClick(() => {
        void this.plugin.runPreflight("manual").then(() => this.display());
      }));
    preflightSetting.addButton((button) => button.setButtonText("Copy diagnostics").onClick(() => {
      void this.plugin.copyDiagnostics();
    }));

    this.renderRuntimeSetupDetail(details);
    this.renderSection("Advanced runtime overrides", "Leave these blank unless you need a custom local setup.", details);
    this.renderPathSetting("pythonCommand", details);
    this.renderPathSetting("scriptPath", details);
    this.renderPathSetting("configPath", details);
  }

  /** Runtime setup progress/cancel surfaces primarily in Overview; this keeps the raw phase/message visible for troubleshooting without duplicating the primary actions. */
  private renderRuntimeSetupDetail(containerEl: HTMLElement): void {
    const state = this.plugin.getRuntimeSetupState();
    if (!state || state.phase === "not-applicable") {
      return;
    }
    new Setting(containerEl)
      .setName("Runtime setup phase")
      .setDesc(`${state.phase}: ${state.message}`)
      .setClass(state.phase === "ready" ? "mindmap-validation-ok" : state.phase === "failed" || state.phase === "unavailable" ? "mindmap-validation-error" : "");
  }

  private renderPathSetting(field: RuntimeField, containerEl: HTMLElement): void {
    const metadata = FIELD_META[field];
    const runtimePath = getPluginRuntimeRelativePath(this.app.vault.configDir);
    const placeholder = field === "pythonCommand"
      ? DEFAULT_SETTINGS.pythonCommand
      : field === "scriptPath"
        ? `${runtimePath}/mindmap.py`
        : `${runtimePath}/config.json`;

    new Setting(containerEl)
      .setName(metadata.name)
      .setDesc(metadata.description)
      .addText((text) => {
        text.setPlaceholder(placeholder).setValue(this.plugin.settings[field]);
        bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
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
}
