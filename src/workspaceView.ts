import { ItemView, WorkspaceLeaf } from "obsidian";

import type MindmapPlugin from "./main";
import { ScopeManager } from "./scopeManager";

export const MINDMAP_VIEW_TYPE = "mindmap-ai-view";

function addFragmentSection(container: HTMLElement, title: string, fragment: DocumentFragment): void {
  const section = container.createDiv({ cls: "mindmap-view-section" });
  section.createEl("h3", { text: title });
  section.createDiv({ cls: "mindmap-view-fragment" }).appendChild(fragment);
}

function addMetric(container: HTMLElement, label: string, value: string): void {
  const metric = container.createDiv({ cls: "mindmap-view-metric" });
  metric.createEl("div", { cls: "mindmap-view-metric-value", text: value });
  metric.createEl("div", { cls: "mindmap-view-metric-label", text: label });
}

export class MindmapWorkspaceView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: MindmapPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return MINDMAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Mindmap AI";
  }

  getIcon(): string {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  render(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("mindmap-view");

    const shell = containerEl.createDiv({ cls: "mindmap-view-shell" });
    this.renderHeader(shell);
    this.renderOverview(shell);
    this.renderScope(shell);
    this.renderLogs(shell);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "mindmap-view-header" });
    const titleWrap = header.createDiv();
    titleWrap.createEl("h2", { text: "Mindmap AI" });
    titleWrap.createEl("p", {
      text: "Run local note analysis, monitor pending work, and manage scope.",
    });

    const actions = header.createDiv({ cls: "mindmap-view-actions" });
    this.createButton(actions, "Run current", () => {
      void this.plugin.runMindmap("manual", "current").then(() => this.render());
    });
    this.createButton(actions, "Run all", () => {
      void this.plugin.runMindmap("manual", "all").then(() => this.render());
    });
    this.createButton(actions, "Preflight", () => {
      void this.plugin.runPreflight("manual").then(() => this.render());
    });
    this.createButton(actions, "Refresh", () => this.render());
  }

  private renderOverview(container: HTMLElement): void {
    const pending = this.plugin.getPendingSnapshot();
    const setup = this.plugin.getScopeSetupStatus();
    const panel = container.createDiv({ cls: "mindmap-view-panel" });
    panel.createEl("h3", { text: "Status" });

    const metrics = panel.createDiv({ cls: "mindmap-view-metrics" });
    addMetric(metrics, "Current pending", pending.available ? String(pending.current.total) : "n/a");
    addMetric(metrics, "All pending", pending.available ? String(pending.all.total) : "n/a");
    addMetric(metrics, "Scope", setup.complete ? "Ready" : "Needs setup");
    addMetric(metrics, "Scheduler", this.plugin.settings.schedulerMode);

    addFragmentSection(panel, "Scheduler", this.plugin.getSchedulerSummary());
    addFragmentSection(panel, "Preflight", this.plugin.getDiagnosticsSummary());
  }

  private renderScope(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "mindmap-view-panel" });
    const heading = panel.createDiv({ cls: "mindmap-view-section-heading" });
    heading.createEl("h3", { text: "Scope manager" });
    heading.createEl("p", { text: "Choose the folders used by current and all-scope runs." });
    new ScopeManager(this.plugin, panel).render();
  }

  private renderLogs(container: HTMLElement): void {
    const panel = container.createDiv({ cls: "mindmap-view-panel" });
    panel.createEl("h3", { text: "Recent log" });
    const lines = this.plugin.getRecentLogLines().slice(-12);
    if (lines.length === 0) {
      panel.createEl("p", { cls: "mindmap-muted", text: "No log entries yet." });
      return;
    }
    const log = panel.createEl("pre", { cls: "mindmap-view-log" });
    log.textContent = lines.join("\n");
  }

  private createButton(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const button = container.createEl("button", {
      text: label,
      attr: { type: "button" },
    });
    button.addEventListener("click", onClick);
    return button;
  }
}
