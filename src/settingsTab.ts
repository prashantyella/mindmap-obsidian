import { Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";

import { bindCommitOnBlurOrEnter } from "./commitOnBlur";
import { MIN_SCHEDULER_INTERVAL_MINUTES } from "./scheduler";
import { buildScheduleVisibility, formatTimeOfDay, isSchedulerRecoveryActionable, parseTimeOfDay } from "./scheduleVisibility";
import type MindmapPlugin from "./main";
import { ScopeManager } from "./scopeManager";
import { DEFAULT_SETTINGS } from "./settings";
import { applyProviderDraft, CommittedValue, SettingsViewState, updateProviderApplyUi, type SettingsSection } from "./settingsViewState";

// The declarative settings-search API requires Obsidian 1.13.0; this plugin
// retains its 1.7.2 minimum and uses the supported native Setting API.
export class MindmapSettingTab extends PluginSettingTab {
  private readonly viewState: SettingsViewState;
  private providerApplyButtonEl: HTMLButtonElement | null = null;
  private providerStatusEl: HTMLElement | null = null;
  private readinessEl: HTMLElement | null = null;
  private unsubscribeDiagnostics: (() => void) | null = null;
  private diagnosticsSummaryEl: HTMLElement | null = null;
  private diagnosticsDescriptionEl: HTMLElement | null = null;

  constructor(app: MindmapPlugin["app"], private readonly plugin: MindmapPlugin) {
    super(app, plugin);
    this.viewState = new SettingsViewState(plugin.settings, plugin.getScopeSetupStatus().complete);
  }

  display(): void {
    this.unsubscribeDiagnostics?.();
    this.viewState.syncSavedSettings(this.plugin.settings);
    this.containerEl.empty();
    this.containerEl.addClass("mindmap-settings");
    this.readinessEl = this.containerEl.createDiv();
    this.renderReadiness();
    this.renderLocalAi();
    this.renderFolders();
    this.renderAutomation();
    this.renderIntegrations();
    this.renderAdvanced();
    this.unsubscribeDiagnostics = this.plugin.subscribeDiagnostics(() => {
      this.renderReadiness();
      this.diagnosticsSummaryEl?.setText(this.plugin.getDiagnosticsOneLine());
      this.diagnosticsDescriptionEl?.setText(this.plugin.getDiagnosticsOneLine());
    });
  }

  hide(): void { this.unsubscribeDiagnostics?.(); this.unsubscribeDiagnostics = null; }

  private createSection(key: SettingsSection, title: string, summary: string): HTMLElement {
    const details = this.containerEl.createEl("details", { cls: "mindmap-settings-section" });
    details.open = this.viewState.disclosures[key];
    const summaryEl = details.createEl("summary");
    const copy = summaryEl.createDiv({ cls: "mindmap-settings-section-copy" });
    copy.createEl("strong", { text: title });
    const description = copy.createSpan({ text: summary });
    if (key === "advanced") this.diagnosticsSummaryEl = description;
    const action = summaryEl.createSpan({ cls: "mindmap-settings-edit", text: details.open ? "Done" : "Edit" });
    details.addEventListener("toggle", () => {
      this.viewState.disclosures[key] = details.open;
      action.setText(details.open ? "Done" : "Edit");
    });
    return details.createDiv({ cls: "mindmap-settings-section-body" });
  }

  private renderReadiness(): void {
    if (!this.readinessEl) return;
    this.readinessEl.empty();
    const state = this.plugin.getOverviewState();
    const row = new Setting(this.readinessEl)
      .setName(state.checking ? "Checking setup" : state.ready ? "Mindmap is ready" : "Setup needs attention")
      .setDesc(state.message)
      .setClass(state.checking ? "mindmap-readiness" : `mindmap-readiness ${state.ready ? "mindmap-validation-ok" : "mindmap-validation-error"}`);
    if (state.actions.includes("runChecks")) row.addButton((button) => button.setButtonText("Check setup").onClick(async () => {
      await this.plugin.runPreflight("manual");
      this.display();
    }));
  }

  private renderLocalAi(): void {
    const draft = this.viewState.providerDraft;
    const sharedAddress = draft.embedBaseUrl === draft.llmBaseUrl;
    const body = this.createSection("localAi", "Local AI", `${draft.embedModel || "No embedding model"} · ${draft.llmModel || "No summaries model"}`);
    new Setting(body).setName("Ollama address").setDesc(sharedAddress
      ? "Used for embeddings, summaries, tags, and concepts."
      : "Embedding and summary addresses differ. They remain separate in Advanced unless you enter one address here.")
      .addText((text) => text.setPlaceholder(sharedAddress ? "http://localhost:11434" : "Enter one address to unify").setValue(sharedAddress ? draft.embedBaseUrl : "").onChange((value) => {
        if (!value.trim() && !sharedAddress) return;
        draft.embedBaseUrl = value;
        draft.llmBaseUrl = value;
        this.markProviderDirty();
      }));
    this.providerText(body, "Embedding model", "Creates the semantic index. Applying a different model automatically re-embeds notes before activating the new index.", draft.embedModel, "embeddinggemma-2:270m", (value) => { draft.embedModel = value; });
    this.providerText(body, "Summaries and tags model", "Creates local summaries, tags, and concepts.", draft.llmModel, "llama3.1:8b", (value) => { draft.llmModel = value; });

    const actions = new Setting(body).setName("Apply Local AI settings").setDesc(this.viewState.providerMessage || "Changes stay as a draft until applied.");
    this.providerStatusEl = actions.descEl;
    actions.addButton((button) => button.setButtonText("Test draft").onClick(async () => {
      try {
        this.viewState.providerMessage = await this.plugin.testLocalAiConfig({ ...this.viewState.providerDraft });
      } catch (error) {
        this.viewState.providerMessage = error instanceof Error ? error.message : "The displayed Local AI draft could not be tested.";
      }
      this.updateProviderApplyControls();
    }));
    actions.addButton((button) => {
      this.providerApplyButtonEl = button.buttonEl;
      button.setButtonText(this.viewState.providerStatus === "saving" ? "Applying…" : "Apply").setCta()
      .setDisabled(this.viewState.providerStatus === "saving" || !this.viewState.providerDirty)
      .onClick(async () => {
        const previousModel = this.plugin.settings.embedModel;
        const previousDimension = this.plugin.settings.embedDimension;
        const applying = applyProviderDraft(this.viewState, async (draft) => { await this.plugin.saveLocalAiConfig(draft); });
        this.updateProviderApplyControls();
        const applied = await applying;
        if (applied && !this.viewState.providerDirty) {
          const ready = this.plugin.getOverviewState().ready;
          const embeddingChanged = previousModel !== this.plugin.settings.embedModel || previousDimension !== this.plugin.settings.embedDimension;
          this.viewState.providerMessage = embeddingChanged
            ? "Local AI configuration saved. The new embedding index activates after re-embedding and verification finish. Check the status menu for progress or retry guidance."
            : !ready
            ? "Configuration saved, but Local AI is not ready. Test the draft or check setup for details."
            : "Local AI configuration saved and ready.";
          this.renderReadiness();
        }
        this.updateProviderApplyControls();
      });
    });
  }

  private providerText(container: HTMLElement, name: string, description: string, value: string, placeholder: string, update: (value: string) => void): void {
    new Setting(container).setName(name).setDesc(description).addText((text) => text.setPlaceholder(placeholder).setValue(value).onChange((next) => {
      update(next);
      this.markProviderDirty();
    }));
  }
  private markProviderDirty(): void {
    this.viewState.markProviderChanged();
    this.updateProviderApplyControls();
  }
  private updateProviderApplyControls(): void {
    if (this.providerApplyButtonEl && this.providerStatusEl) updateProviderApplyUi(this.viewState, this.providerApplyButtonEl, this.providerStatusEl);
  }

  private renderFolders(): void {
    const draft = this.viewState.scope.draft;
    const same = !this.viewState.scope.separateQuickRun;
    const summary = same ? `${draft.allPaths.length} included folder${draft.allPaths.length === 1 ? "" : "s"}` : `${draft.allPaths.length} included · ${draft.currentPaths.length} quick run`;
    const body = this.createSection("folders", "Included folders", summary);
    new ScopeManager(this.plugin, body, { compact: true, state: this.viewState.scope }).render();
  }

  private renderAutomation(): void {
    const mode = this.plugin.settings.schedulerMode;
    const label = mode === "manual" ? "Manual" : mode === "interval" ? "While Obsidian is open" : "Scheduled on macOS";
    const body = this.createSection("automation", "Automation", label);
    const visibility = buildScheduleVisibility(mode, this.plugin.settings.launchAgentWeeklyEnabled);
    new Setting(body).setName("Processing mode").setDesc(mode === "launchAgent"
      ? "macOS opens this vault at the scheduled time. Mindmap processes notes only after Obsidian is open."
      : "Choose when Mindmap checks for eligible work.")
      .addDropdown((dropdown) => dropdown.addOption("manual", "Manual").addOption("interval", "While Obsidian is open").addOption("launchAgent", "Scheduled (macOS)").setValue(mode).onChange(async (value) => {
        if (value === "launchAgent" && process.platform !== "darwin") {
          new Notice("Scheduled opening is available only on macOS.", 8000);
          dropdown.setValue(mode);
          return;
        }
        try {
          await this.plugin.setSchedulerMode(value === "interval" || value === "launchAgent" ? value : "manual");
          this.display();
        } catch (error) {
          dropdown.setValue(this.plugin.settings.schedulerMode);
          new Notice(error instanceof Error ? error.message : "Automation mode could not be saved.", 8000);
        }
      }));
    if (visibility.showInterval) {
      new Setting(body).setName("Check every").setDesc(`Minutes while Obsidian is open. Minimum ${MIN_SCHEDULER_INTERVAL_MINUTES}.`).addText((text) => {
        text.setValue(String(this.plugin.settings.schedulerIntervalMinutes));
        bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          if (!Number.isFinite(parsed) || parsed < MIN_SCHEDULER_INTERVAL_MINUTES) {
            new Notice(`Enter ${MIN_SCHEDULER_INTERVAL_MINUTES} minutes or more.`, 6000);
            return false;
          }
          const previous = this.plugin.settings.schedulerIntervalMinutes;
          this.plugin.settings.schedulerIntervalMinutes = parsed;
          try { await this.plugin.saveSettings(); return true; } catch (error) {
            this.plugin.settings.schedulerIntervalMinutes = previous;
            new Notice(error instanceof Error ? error.message : "The interval could not be saved.", 8000);
            return false;
          }
        });
      });
    }
    if (visibility.showDailyTime) this.renderTime(body, "Daily opening time", this.plugin.settings.launchAgentDailyHour, this.plugin.settings.launchAgentDailyMinute, (hour, minute) => {
      this.plugin.settings.launchAgentDailyHour = hour; this.plugin.settings.launchAgentDailyMinute = minute;
    });
    if (visibility.showWeeklyToggle) new Setting(body).setName("Weekly index refresh").setDesc("Also open Obsidian on Sunday for a full refresh.").addToggle((toggle) => toggle.setValue(this.plugin.settings.launchAgentWeeklyEnabled).onChange(async (value) => {
      const previous = this.plugin.settings.launchAgentWeeklyEnabled;
      this.plugin.settings.launchAgentWeeklyEnabled = value;
      try { await this.plugin.saveSettings(); this.display(); } catch (error) {
        this.plugin.settings.launchAgentWeeklyEnabled = previous;
        toggle.setValue(previous);
        new Notice(error instanceof Error ? error.message : "The weekly schedule could not be saved.", 8000);
      }
    }));
    if (visibility.showWeeklyTime) this.renderTime(body, "Sunday opening time", this.plugin.settings.launchAgentWeeklyHour, this.plugin.settings.launchAgentWeeklyMinute, (hour, minute) => {
      this.plugin.settings.launchAgentWeeklyHour = hour; this.plugin.settings.launchAgentWeeklyMinute = minute;
    });
    const health = this.plugin.getStatusBarInternalState().schedulerHealth;
    if (isSchedulerRecoveryActionable(mode, health)) {
      const catchUp = this.plugin.getLaunchAgentCatchUpStatus();
      const row = new Setting(body).setName("Schedule needs attention").setDesc(catchUp.message).setClass("mindmap-validation-error");
      if (catchUp.available) row.addButton((button) => button.setButtonText("Catch up pending notes").onClick(async () => { await this.plugin.runLaunchAgentCatchUp(); this.display(); }));
    }
  }

  private renderTime(container: HTMLElement, name: string, hour: number, minute: number, update: (hour: number, minute: number) => void): void {
    const committed = new CommittedValue({ hour, minute });
    const row = new Setting(container).setName(name).setDesc("Use 24-hour time (HH:MM).");
    row.addText((text) => {
      text.setPlaceholder("02:30").setValue(formatTimeOfDay(hour, minute));
      const error = row.descEl.createDiv({ cls: "mindmap-field-error", attr: { role: "alert" } });
      bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (value) => {
        const parsed = parseTimeOfDay(value);
        if (!parsed) {
          error.setText("Enter a valid 24-hour time, for example 02:30.");
          text.inputEl.setAttribute("aria-invalid", "true");
          return false;
        }
        error.empty();
        text.inputEl.removeAttribute("aria-invalid");
        update(parsed.hour, parsed.minute);
        try {
          await this.plugin.saveSettings();
          committed.set(parsed);
          text.setValue(formatTimeOfDay(parsed.hour, parsed.minute));
          return true;
        } catch (saveError) {
          const previous = committed.get();
          update(previous.hour, previous.minute);
          new Notice(saveError instanceof Error ? saveError.message : "The schedule time could not be saved.", 8000);
          return false;
        }
      });
    });
  }

  private renderIntegrations(): void {
    const research = this.plugin.getWebResearchStatus();
    const reading = this.plugin.settings.readingMode === "reading";
    const researchLabel = research.mode === "automatic-reading" ? "Automatic" : research.mode === "manual" ? "Manual" : "Off";
    const body = this.createSection("integrations", "Apple Books and web research", `${reading ? "Apple Books on" : "Apple Books off"} · Research ${researchLabel}`);
    new Setting(body).setName("Apple Books import").setDesc(reading ? "New annotations are imported and processed while Obsidian is open." : "Off. Enabling previews the first import and asks for confirmation.").addToggle((toggle) => toggle.setValue(reading).onChange(async (value) => {
      await this.plugin.selectReadingMode(value ? "reading" : "standard"); this.display();
    }));
    new Setting(body).setName("Internet research").setDesc(research.mode === "off" ? "Off. Enabling asks for consent and defaults to Manual." : "On. Exa receives only locally derived queries, never raw note text.").addToggle((toggle) => toggle.setValue(research.mode !== "off").onChange(async (value) => {
      await this.plugin.selectWebResearchMode(value ? "manual" : "off");
      this.display();
    }));
    if (research.mode !== "off") new Setting(body).setName("Research mode").setDesc("Manual works on selected text or the active note. Automatic is limited to eligible Apple Books annotations.").addDropdown((dropdown) => dropdown
      .addOption("manual", "Manual").addOption("automatic-reading", "Automatic for Apple Books").setValue(research.mode)
      .onChange(async (value) => {
        await this.plugin.selectWebResearchMode(value === "automatic-reading" ? value : "manual");
        this.display();
      }));
    if (research.mode === "automatic-reading") {
      new Setting(body).setName("Automatic usage").setDesc(`${research.automatic.attempted} of 10 attempts today. Maximum 5 per sync.${research.automatic.pauseReason ? ` Paused: ${research.automatic.pauseReason}.` : ""}`);
    }
    if (research.lastError || (research.automatic.pauseReason && research.automatic.pauseReason !== "daily-limit")) {
      new Setting(body).setName("Research needs attention").setDesc(research.automatic.lastError ?? research.lastError ?? "Automatic research is paused.").setClass("mindmap-validation-error")
        .addButton((button) => button.setButtonText("Retry").onClick(async () => { await this.plugin.retryAutomaticResearch(); this.display(); }));
    }
  }

  private renderAdvanced(): void {
    const draft = this.viewState.providerDraft;
    const body = this.createSection("advanced", "Advanced and troubleshooting", this.plugin.getDiagnosticsOneLine());
    this.providerText(body, "Embedding Ollama address", "Keep separate only when embeddings use another Ollama server.", draft.embedBaseUrl, DEFAULT_SETTINGS.embedBaseUrl, (value) => { draft.embedBaseUrl = value; });
    this.providerText(body, "Summaries Ollama address", "Keep separate only when summaries and tags use another Ollama server.", draft.llmBaseUrl, DEFAULT_SETTINGS.llmBaseUrl, (value) => { draft.llmBaseUrl = value; });
    this.providerNumber(body, "Embedding dimension", "0 uses the known-model default. Custom models may require an explicit value.", draft.embedDimension, 0, (value) => { draft.embedDimension = value; });
    this.providerNumber(body, "Maximum output tokens", "Caps metadata output, not note text sent to the local model.", draft.llmMaxTokens, DEFAULT_SETTINGS.llmMaxTokens, (value) => { draft.llmMaxTokens = value; });
    const diagnostics = new Setting(body).setName("Setup diagnostics").setDesc(this.plugin.getDiagnosticsOneLine());
    this.diagnosticsDescriptionEl = diagnostics.descEl;
    diagnostics.addButton((button) => button.setButtonText("Check setup").onClick(async () => { await this.plugin.runPreflight("manual"); this.display(); }));
    diagnostics.addButton((button) => button.setButtonText("Copy diagnostics").onClick(async () => { await this.plugin.copyDiagnostics(); }));
    this.savedText(body, "Apple Books annotation database", "Leave blank to discover automatically.", this.plugin.settings.appleAnnotationDbPath, (value) => { this.plugin.settings.appleAnnotationDbPath = value; });
    this.savedText(body, "Apple Books library database", "Leave blank to discover automatically.", this.plugin.settings.appleLibraryDbPath, (value) => { this.plugin.settings.appleLibraryDbPath = value; });
  }

  private providerNumber(container: HTMLElement, name: string, description: string, value: number, fallback: number, update: (value: number) => void): void {
    new Setting(container).setName(name).setDesc(description).addText((text) => text.setValue(String(value)).onChange((next) => {
      const parsed = Number.parseInt(next.trim(), 10);
      update(Number.isFinite(parsed) ? parsed : fallback);
      this.markProviderDirty();
    }));
  }
  private savedText(container: HTMLElement, name: string, description: string, value: string, update: (value: string) => void): void {
    const committed = new CommittedValue(value);
    new Setting(container).setName(name).setDesc(description).addText((text: TextComponent) => {
      text.setValue(value);
      bindCommitOnBlurOrEnter(text.inputEl, text.getValue(), async (next) => {
        update(next.trim());
        try {
          await this.plugin.saveSettings({ explicitEngineActivation: true });
          committed.set(next.trim());
          return true;
        } catch (error) {
          update(committed.get());
          new Notice(error instanceof Error ? error.message : `${name} could not be saved.`, 8000);
          return false;
        }
      });
    });
  }
}
