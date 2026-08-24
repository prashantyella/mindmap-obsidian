import { Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";

import { bindCommitOnBlurOrEnter } from "./commitOnBlur";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import { buildScheduleVisibility, isSchedulerRecoveryActionable } from "./scheduleVisibility";
import { normalizeHour, normalizeMinute } from "./launchAgent";
import type MindmapPlugin from "./main";
import type { LlmProviderConfigStatus } from "./pluginConfig";
import { ScopeManager } from "./scopeManager";
import { DEFAULT_SETTINGS } from "./settings";

// Intentionally not implementing getSettingDefinitions() (the declarative
// settings-search API): adopting it would raise minAppVersion from 1.7.2 to
// 1.13.0, which is a bigger compatibility trade-off than this release makes.
// This is the one accepted obsidianmd/settings-tab/prefer-setting-definitions
// warning in the official lint gate.
export class MindmapSettingTab extends PluginSettingTab {
  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderOverview();
    this.renderReadingAndResearch();
    this.renderScope();
    this.renderSchedule();
    this.renderLocalAi();
    this.renderTroubleshooting();
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
        .setButtonText("Open mindmap")
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
  }

  // ---------------------------------------------------------------------
  // Reading and Research
  // ---------------------------------------------------------------------

  private renderReadingAndResearch(): void {
    this.renderSection("Reading and Research", "Reading Mode watches Apple Books and imports new annotations. Manual and Automatic research add context from the web.");

    const readingMode = this.plugin.settings.readingMode;
    new Setting(this.containerEl)
      .setName("Reading mode")
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
      .setName("Automatic for reading")
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
      .setDesc("Launchagent continues when Obsidian is closed.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("interval", "Interval")
          .addOption("launchAgent", "Launchagent")
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
            text.setValue(String(this.plugin.settings.schedulerIntervalMinutes));
          });
        });
    }

    if (visibility.showDailyTime) {
      new Setting(this.containerEl)
        .setName("Daily launchagent time")
        .setDesc("Runs all-scope apply monday through saturday.")
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyHour)).setValue(String(this.plugin.settings.launchAgentDailyHour));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentDailyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            text.setValue(String(this.plugin.settings.launchAgentDailyHour));
          });
        })
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentDailyMinute).padStart(2, "0")).setValue(String(this.plugin.settings.launchAgentDailyMinute).padStart(2, "0"));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentDailyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            text.setValue(String(this.plugin.settings.launchAgentDailyMinute).padStart(2, "0"));
          });
        });
    }

    if (visibility.showWeeklyToggle) {
      new Setting(this.containerEl)
        .setName("Weekly refresh launchagent")
        .setDesc("Runs all-scope refresh and apply on sunday.")
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
        .setName("Weekly launchagent time")
        .setDesc("Used only while the weekly refresh is enabled.")
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyHour)).setValue(String(this.plugin.settings.launchAgentWeeklyHour));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentWeeklyHour = normalizeHour(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            text.setValue(String(this.plugin.settings.launchAgentWeeklyHour));
          });
        })
        .addText((text) => {
          text.setPlaceholder(String(DEFAULT_SETTINGS.launchAgentWeeklyMinute).padStart(2, "0")).setValue(String(this.plugin.settings.launchAgentWeeklyMinute).padStart(2, "0"));
          bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
            this.plugin.settings.launchAgentWeeklyMinute = normalizeMinute(Number.parseInt(value.trim(), 10));
            await this.plugin.saveSettings();
            text.setValue(String(this.plugin.settings.launchAgentWeeklyMinute).padStart(2, "0"));
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
  // Local AI: Ollama-only (embedding + metadata). Text fields commit on
  // blur/Enter, not per keystroke.
  // ---------------------------------------------------------------------

  private bindProviderText(text: TextComponent, commit: (value: string) => boolean): void {
    bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), commit);
  }

  private renderLocalAi(): void {
    this.renderSection("Local AI", "Ollama-hosted models for embeddings, and for summaries, tags, concepts, and links.");

    new Setting(this.containerEl)
      .setName("Embedding base URL")
      .setDesc("Ollama server URL used for the vector index.")
      .addText((text) => {
        text.setPlaceholder("http://localhost:11434").setValue(this.plugin.settings.embedBaseUrl);
        this.bindProviderText(text, (value) => {
          this.plugin.settings.embedBaseUrl = value.trim();
          void this.plugin.saveSettings();
          return true;
        });
      });

    new Setting(this.containerEl)
      .setName("Embedding model")
      .setDesc("Ollama embedding model, e.g. mxbai-embed-large.")
      .addText((text) => {
        text.setPlaceholder("mxbai-embed-large").setValue(this.plugin.settings.embedModel);
        this.bindProviderText(text, (value) => {
          this.plugin.settings.embedModel = value.trim();
          void this.plugin.saveSettings();
          return true;
        });
      });

    const status = this.plugin.getLlmProviderConfigStatus();

    new Setting(this.containerEl)
      .setName("Metadata base URL")
      .setDesc("Ollama server URL used for metadata extraction.")
      .addText((text) => {
        text.setPlaceholder("http://localhost:11434").setValue(status.baseUrl);
        this.bindProviderText(text, (value) => this.saveProviderConfig({ baseUrl: value }));
      });

    new Setting(this.containerEl)
      .setName("Metadata model")
      .setDesc("Model used for metadata extraction, e.g. llama3.1:8b.")
      .addText((text) => {
        text.setPlaceholder("llama3.1:8b").setValue(status.model);
        this.bindProviderText(text, (value) => this.saveProviderConfig({ model: value }));
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
  }

  /**
   * Returns whether the save actually succeeded so the blur/Enter commit
   * binder (commitOnBlur.ts) knows not to advance its last-committed value
   * on failure -- otherwise a failed save would look "committed" and the
   * user could never retry it by re-blurring the same text.
   */
  private saveProviderConfig(patch: Partial<Pick<LlmProviderConfigStatus, "baseUrl" | "model" | "maxTokens">>): boolean {
    try {
      void this.plugin.saveLlmProviderConfig(patch);
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

    this.renderSection("Advanced", "Apple Books database overrides -- leave blank to auto-discover.", details);
    new Setting(details)
      .setName("Apple Books annotation database path")
      .setDesc("Leave blank to auto-discover.")
      .addText((text) => {
        text.setPlaceholder("auto-discover").setValue(this.plugin.settings.appleAnnotationDbPath);
        bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
          this.plugin.settings.appleAnnotationDbPath = value.trim();
          await this.plugin.saveSettings();
          return true;
        });
      });
    new Setting(details)
      .setName("Apple Books library database path")
      .setDesc("Leave blank to auto-discover.")
      .addText((text) => {
        text.setPlaceholder("auto-discover").setValue(this.plugin.settings.appleLibraryDbPath);
        bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
          this.plugin.settings.appleLibraryDbPath = value.trim();
          await this.plugin.saveSettings();
          return true;
        });
      });
  }
}
