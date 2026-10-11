import { ItemView, Keymap, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import type MindmapPlugin from "./main";
import type { LiveRelatedResult } from "./semanticTypes";
import {
  createErrorLiveState,
  createIdleLiveState,
  createLoadingLiveState,
  createReadyLiveState,
  getDisplayLiveRelated,
  getIndexRefreshTargets,
  NO_MINDMAP_CONNECTIONS_MESSAGE,
  NO_MINDMAP_CONNECTIONS_TITLE,
  shouldApplyLiveResponse,
  shouldSkipLiveQuery,
  type SidebarLiveState,
  normalizeMindmapViewState,
  rememberExpandedPath,
  type MindmapViewState,
} from "./workspaceViewState";
import { SidebarRefreshController } from "./sidebarRefreshController";
import { reconcileKeyedOrder } from "./keyedReconciler";

export const MINDMAP_VIEW_TYPE = "mindmap-ai-view";

type Frontmatter = Record<string, unknown>;

type HeatmapKey = "concepts" | "tags" | "links" | "time" | "source";

interface HeatmapCell {
  key: HeatmapKey;
  label: string;
  level: number;
  detail: string;
}

interface RelatedCandidate {
  file: TFile | null;
  path: string;
  title: string;
  folderPath: string;
  summary: string | null;
  heatmap: HeatmapCell[];
  liveScore?: number;
  liveKind?: string;
  source?: "saved" | "live" | "lookup" | "pinned";
  pinned?: boolean;
}

interface LookupState {
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  related: LiveRelatedResult[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRelatedItem(value: unknown): string | null {
  const text = coerceText(value);
  if (text !== null) {
    return text;
  }

  if (!isRecord(value)) {
    return null;
  }

  return coerceText(value.path) ?? coerceText(value.note) ?? coerceText(value.link);
}

function normalizeRelatedList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeRelatedItem(item))
      .filter((item): item is string => item !== null);
  }

  const item = normalizeRelatedItem(value);
  return item === null ? [] : [item];
}

function normalizeTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => coerceText(item))
      .filter((item): item is string => item !== null);
  }

  const text = coerceText(value);
  return text === null ? [] : [text];
}

function cleanRelatedPath(path: string): string {
  const wikiMatch = path.match(/^\[\[([^|\]#]+)(?:#[^|\]]+)?(?:\|[^\]]+)?\]\]$/);
  return (wikiMatch?.[1] ?? path).trim();
}

function comparablePath(path: string): string {
  return cleanRelatedPath(path).replace(/\.md$/i, "").toLowerCase();
}

function titleFromPath(path: string): string {
  const withoutExtension = path.replace(/\.md$/i, "");
  const parts = withoutExtension.split("/");
  return parts[parts.length - 1] ?? withoutExtension;
}

function parentFolderFromPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.join("/");
}

function topFolderFromPath(path: string): string {
  return path.split("/").find((part) => part.length > 0) ?? "Vault root";
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right.map((item) => item.toLowerCase()));
  return left.filter((item) => rightSet.has(item.toLowerCase())).length;
}

function overlapLevel(count: number): number {
  if (count >= 3) {
    return 4;
  }
  if (count === 2) {
    return 3;
  }
  if (count === 1) {
    return 2;
  }
  return 0;
}

function parseDailyTimestamp(path: string): number | null {
  const match = path.match(/Daily Notes\/(\d{4})\/[^/]+\/(\d{2}) ([A-Za-z]{3}) '\d{2}/);
  if (match === null) {
    return null;
  }

  const [, yearText, dayText, monthText] = match;
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(monthText);
  if (monthIndex < 0) {
    return null;
  }

  return Date.UTC(Number(yearText), monthIndex, Number(dayText));
}

function timeLevel(activePath: string, candidatePath: string): number {
  const activeTime = parseDailyTimestamp(activePath);
  const candidateTime = parseDailyTimestamp(candidatePath);
  if (activeTime === null || candidateTime === null) {
    return 0;
  }

  const days = Math.abs(activeTime - candidateTime) / 86_400_000;
  if (days <= 7) {
    return 4;
  }
  if (days <= 31) {
    return 3;
  }
  if (days <= 366) {
    return 2;
  }
  return 1;
}

function sourceLevel(activePath: string, candidatePath: string): number {
  if (parentFolderFromPath(activePath) === parentFolderFromPath(candidatePath)) {
    return 4;
  }
  if (topFolderFromPath(activePath) === topFolderFromPath(candidatePath)) {
    return 3;
  }
  return 1;
}

function formatScoreDetail(candidate: RelatedCandidate): string | null {
  if (typeof candidate.liveScore !== "number") {
    if (candidate.pinned) {
      return "Pinned connection.";
    }
    return null;
  }
  const percent = Math.round(candidate.liveScore * 100);
  if (candidate.source === "lookup") {
    return `Lookup match (${percent}%).`;
  }
  const kind = candidate.liveKind ?? "semantic";
  return `${candidate.source === "live" ? "Live" : "Saved"} ${kind} match (${percent}%).`;
}

function renderLoadingSpinner(container: HTMLElement): void {
  const spinner = container.createDiv({
    cls: "mindmap-loading-spinner",
    attr: {
      role: "status",
      "aria-label": "Loading",
    },
  });
  spinner.createSpan({ cls: "mindmap-loading-spinner-icon" });
}

export class MindmapWorkspaceView extends ItemView {
  private activePath: string | null = null;
  private expandedPath: string | null | undefined = undefined;
  private liveRequestId = 0;
  private lookupRequestId = 0;
  private pinRevealPath: string | null = null;
  private composingLookup = false;
  private shellEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private feedbackEl: HTMLElement | null = null;
  private heatmapRegionEl: HTMLElement | null = null;
  private lookupInputEl: HTMLInputElement | null = null;
  private lookupErrorEl: HTMLElement | null = null;
  private liveRegionEl: HTMLElement | null = null;
  private retainedListEl: HTMLElement | null = null;
  private readonly renderedCandidates = new Map<string, RelatedCandidate>();
  private viewState: MindmapViewState = { heatmapOpen: false, expandedByNote: {} };
  private readonly refreshController = new SidebarRefreshController({
    runLookup: () => this.runLookupQuery(),
    refreshNote: () => this.refreshActiveNoteQuery(),
    refreshIndex: () => this.refreshIndexQueries(),
  });
  private lookupState: LookupState = {
    query: "",
    status: "idle",
    related: [],
    error: null,
  };
  private liveState: SidebarLiveState = {
    path: "",
    status: "idle",
    response: null,
    error: null,
  };

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
    return "Mindmap";
  }

  getIcon(): string {
    return "orbit";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path !== this.activePath) return;
      this.refreshController.scheduleNoteRefresh();
    }));
    const subscribeIndexChanges = (this.plugin as unknown as {
      subscribeIndexChanges?: (listener: (change: { revision: number; paths?: readonly string[] }) => void) => () => void;
    }).subscribeIndexChanges;
    if (subscribeIndexChanges) {
      this.register(subscribeIndexChanges.call(this.plugin, () => this.refreshController.scheduleIndexRefresh()));
    }
    this.render();
  }

  getState(): MindmapViewState {
    return normalizeMindmapViewState(this.viewState);
  }

  async setState(state: unknown): Promise<void> {
    this.viewState = normalizeMindmapViewState(state);
    this.render();
  }

  /**
   * Checkpoint 10B SIDEBAR: one-shot cache reset for the active note's live
   * query, called by main.ts exactly once when migration transitions to
   * `"complete"` -- a query issued while migration was still running can
   * have cached an `indexed: false` "ready" result that `ensureLiveQuery`
   * would otherwise never re-fetch for this path. Mirrors the existing
   * `metadataCache "changed"` handler above (reset to idle, keep the prior
   * response for display continuity, then render once) rather than making
   * every render re-check staleness, which would re-trigger a query on
   * every subsequent render for a note that is still legitimately
   * unindexed (out of scope, still queued, etc.) -- an unbounded
   * query/render loop.
   */
  invalidateLiveQuery(): void {
    if (this.liveState.path === "") {
      return;
    }
    this.liveState = createIdleLiveState(this.liveState.path, this.liveState.response);
    this.render();
  }

  async onClose(): Promise<void> {
    this.liveRequestId += 1;
    this.lookupRequestId += 1;
    this.refreshController.close();
  }

  render(): void {
    const content = this.ensureShell();
    const focusedElement = content.ownerDocument.activeElement instanceof HTMLElement && content.contains(content.ownerDocument.activeElement)
      ? content.ownerDocument.activeElement
      : null;
    const focusedPath = focusedElement
      ? focusedElement.closest<HTMLElement>("[data-path]")?.dataset.path ?? null
      : null;
    this.feedbackEl?.empty();
    this.heatmapRegionEl?.empty();
    this.updateLookupShell();

    const activeFile = this.app.workspace.getActiveFile();
    const shell = this.feedbackEl ?? content;

    if (activeFile === null) {
      this.activePath = null;
      this.refreshController.invalidateNoteRequest();
      this.expandedPath = undefined;
      if (this.retainedListEl) this.retainedListEl.hidden = true;
      if (this.hasLookupQuery()) {
        const candidates = this.getLookupCandidates(null);
        if (this.isLoadingVisible()) {
          this.renderInlineLoadingIndicator(shell);
        }
        if (candidates.length === 0) {
          this.renderLookupResults(shell, null);
          this.restoreFocusedRow(focusedPath, focusedElement);
          return;
        }
        const list = this.ensureResultList(shell);
        const ordered = this.stabilizeCandidates(candidates, list);
        for (const candidate of ordered) {
          this.renderCandidate(list, candidate, false);
        }
        this.removeUnusedRows(list, new Set(candidates.map((candidate) => candidate.path)));
        this.reconcileRowOrder(list, ordered.map((candidate) => candidate.path));
      } else {
        this.renderEmpty(shell, "No active note", "Open a note to see its mindmap links.");
      }
      this.restoreFocusedRow(focusedPath, focusedElement);
      return;
    }

    if (this.activePath !== activeFile.path) {
      this.activePath = activeFile.path;
      this.refreshController.invalidateNoteRequest();
      this.expandedPath = this.viewState.expandedByNote[activeFile.path];
      this.pinRevealPath = null;
      this.liveState = createIdleLiveState(activeFile.path);
    }

    this.ensureLiveQuery(activeFile);

    const persistedCandidates = this.getRelatedCandidates(activeFile);
    const candidates = this.hasLookupQuery()
      ? this.getLookupCandidates(activeFile)
      : this.getDisplayCandidates(activeFile, persistedCandidates);
    if (!this.hasLookupQuery()) this.renderLiveStatus(shell, activeFile.path, persistedCandidates.length > 0);
    if (candidates.length > 0 && this.expandedPath === undefined) {
      this.expandedPath = candidates[0].path;
    }

    if (candidates.length === 0) {
      if (this.retainedListEl) this.retainedListEl.hidden = true;
      if (this.isLoadingVisible()) {
        this.renderInlineLoadingIndicator(shell);
      }
      if (this.hasLookupQuery()) {
        this.renderLookupResults(shell, activeFile);
      } else if (this.liveState.status === "loading") {
        this.renderEmpty(shell, "Updating connections", "Existing connections will remain available while this finishes.");
      } else if (this.liveState.status === "error") {
        this.renderEmpty(shell, "Connections unavailable", "Saved connections remain in the note. Check Local AI, then try again.");
      } else if (this.liveState.response && (!this.liveState.response.indexed || this.liveState.response.stale)) {
        this.renderEmpty(shell, "Connections need an update", "Update this note when you are ready.");
      } else {
        this.renderEmpty(shell, NO_MINDMAP_CONNECTIONS_TITLE, NO_MINDMAP_CONNECTIONS_MESSAGE);
      }
      this.restoreFocusedRow(focusedPath, focusedElement);
      return;
    }

    if (this.isLoadingVisible()) {
      this.renderInlineLoadingIndicator(shell);
    }

    if (!this.hasLookupQuery()) {
      this.renderHeatmapDisclosure(this.heatmapRegionEl ?? shell, candidates);
    }

    const list = this.ensureResultList(shell);
    const ordered = this.stabilizeCandidates(candidates, list);
    for (const candidate of ordered) {
      this.renderCandidate(list, candidate, candidate.path === this.expandedPath);
    }
    this.removeUnusedRows(list, new Set(candidates.map((candidate) => candidate.path)));
    this.reconcileRowOrder(list, ordered.map((candidate) => candidate.path));

    this.restoreFocusedRow(focusedPath, focusedElement);
  }

  private ensureShell(): HTMLElement {
    if (this.resultsEl) return this.resultsEl;
    this.containerEl.empty();
    this.containerEl.addClass("mindmap-view");
    this.shellEl = this.containerEl.createDiv({ cls: "mindmap-sidebar" });
    const search = this.shellEl.createDiv({ cls: "mindmap-lookup" });
    const input = search.createEl("input", {
      cls: "mindmap-lookup-input",
      attr: {
        type: "search",
        placeholder: "Ask across notes",
        "aria-label": "Search connections",
      },
    });
    input.value = this.lookupState.query;
    const searchButton = search.createEl("button", {
      cls: "mindmap-lookup-button",
      attr: {
        type: "button",
        "aria-label": "Search",
      },
    });
    setIcon(searchButton, "search");
    const clearButton = search.createEl("button", {
      cls: "mindmap-lookup-button",
      attr: {
        type: "button",
        "aria-label": "Clear search",
      },
    });
    setIcon(clearButton, "x");

    this.lookupErrorEl = search.createDiv({ cls: "mindmap-lookup-error" });
    this.lookupErrorEl.hidden = true;
    this.liveRegionEl = this.shellEl.createDiv({ cls: "mindmap-sr-only", attr: { "aria-live": "polite", "aria-atomic": "true" } });
    this.resultsEl = this.shellEl.createDiv({ cls: "mindmap-sidebar-content" });
    this.feedbackEl = this.resultsEl.createDiv({ cls: "mindmap-sidebar-feedback" });
    this.heatmapRegionEl = this.resultsEl.createDiv({ cls: "mindmap-sidebar-heatmap-region" });
    this.retainedListEl = this.resultsEl.createDiv({ cls: "mindmap-sidebar-list" });
    this.lookupInputEl = input;

    input.addEventListener("input", () => {
      this.lookupRequestId += 1;
      this.refreshController.invalidateLookup();
      const hasQuery = input.value.trim().length > 0;
      this.lookupState = {
        ...this.lookupState,
        query: input.value,
        status: hasQuery ? "loading" : "idle",
        related: hasQuery ? this.lookupState.related : [],
        error: null,
      };
      if (!hasQuery) {
        this.render();
        return;
      }
      this.render();
      if (!this.composingLookup) this.refreshController.scheduleLookup();
    });
    input.addEventListener("compositionstart", () => { this.composingLookup = true; this.refreshController.invalidateLookup(); });
    input.addEventListener("compositionend", () => { this.composingLookup = false; if (input.value.trim()) this.refreshController.scheduleLookup(); });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      if (this.composingLookup) return;
      this.refreshController.invalidateLookup();
      this.runLookupQuery();
    });
    searchButton.addEventListener("click", () => {
      this.refreshController.invalidateLookup();
      this.runLookupQuery();
    });
    clearButton.addEventListener("click", () => {
      this.lookupRequestId += 1;
      this.refreshController.invalidateLookup();
      this.lookupState = {
        query: "",
        status: "idle",
        related: [],
        error: null,
      };
      this.render();
    });
    if (this.plugin.consumeLookupFocusRequest()) window.requestAnimationFrame(() => input.focus());
    return this.resultsEl;
  }

  private updateLookupShell(): void {
    if (this.lookupInputEl && this.lookupInputEl.value !== this.lookupState.query) this.lookupInputEl.value = this.lookupState.query;
    if (this.lookupErrorEl) {
      this.lookupErrorEl.textContent = this.lookupState.error ?? "";
      this.lookupErrorEl.hidden = this.lookupState.status !== "error";
    }
  }

  private renderLookupResults(container: HTMLElement, activeFile: TFile | null): void {
    if (this.lookupState.status === "loading") {
      this.renderEmpty(container, "Searching notes", "Finding semantic matches.");
      return;
    }
    if (this.lookupState.status === "error") {
      this.renderEmpty(container, "Lookup unavailable", this.lookupState.error ?? "Mindmap lookup could not run.");
      return;
    }
    if (activeFile === null) {
      this.renderEmpty(container, "No active note", "Lookup works without an active note, but pins need a source note.");
      return;
    }
    this.renderEmpty(container, "No lookup matches", "Try a more specific question.");
  }

  private hasLookupQuery(): boolean {
    return this.lookupState.query.trim().length > 0;
  }

  private isLoadingVisible(): boolean {
    return this.hasLookupQuery() ? this.lookupState.status === "loading" : this.liveState.status === "loading";
  }

  private runLookupQuery(): void {
    const query = this.lookupState.query.trim();
    if (!query) {
      return;
    }
    const requestId = ++this.lookupRequestId;
    const generation = this.refreshController.invalidateLookup();
    this.lookupState = {
      query,
      status: "loading",
      related: this.lookupState.related,
      error: null,
    };
    this.render();

    void this.plugin.queryLookupRelated(query)
      .then((response) => {
        if (requestId !== this.lookupRequestId || !this.refreshController.isCurrentLookup(generation) || response.query !== this.lookupState.query.trim()) {
          return;
        }
        this.lookupState = {
          query: response.query,
          status: "ready",
          related: response.related,
          error: null,
        };
        if (this.liveRegionEl) this.liveRegionEl.textContent = `${response.related.length} connection${response.related.length === 1 ? "" : "s"} found.`;
        this.render();
      })
      .catch((error) => {
        if (requestId !== this.lookupRequestId || !this.refreshController.isCurrentLookup(generation)) {
          return;
        }
        this.lookupState = {
          query,
          status: "error",
          related: this.lookupState.related,
          error: error instanceof Error ? error.message : String(error),
        };
        this.render();
      });
  }

  private ensureLiveQuery(activeFile: TFile): void {
    if (!this.plugin.settings.liveSemanticLookupEnabled) {
      return;
    }
    if (shouldSkipLiveQuery(this.liveState, activeFile.path)) {
      return;
    }

    const requestId = ++this.liveRequestId;
    const generation = this.refreshController.invalidateNoteRequest();
    this.liveState = createLoadingLiveState(activeFile.path, this.liveState);

    const query = this.plugin.queryLiveRelated as (path: string, ensureIndex?: boolean) => Promise<import("./semanticTypes").LiveRelatedResponse>;
    void query.call(this.plugin, activeFile.path, false)
      .then((response) => {
        if (!this.refreshController.isCurrentNote(generation) || !shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createReadyLiveState(activeFile.path, response);
        this.render();
      })
      .catch((error) => {
        if (!this.refreshController.isCurrentNote(generation) || !shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createErrorLiveState(activeFile.path, this.liveState, error);
        this.render();
      });
  }

  private refreshActiveNoteQuery(): void {
    if (!this.activePath) return;
    this.liveRequestId += 1;
    this.liveState = createIdleLiveState(this.activePath, this.liveState.response);
    this.render();
  }

  private refreshIndexQueries(): void {
    const targets = getIndexRefreshTargets(this.activePath, this.lookupState.query);
    if (targets.live && this.activePath) {
      this.liveRequestId += 1;
      this.liveState = createIdleLiveState(this.activePath, this.liveState.response);
    }
    if (targets.lookup) {
      this.lookupRequestId += 1;
      this.runLookupQuery();
      return;
    }
    this.render();
  }

  private renderInlineLoadingIndicator(container: HTMLElement): void {
    const indicator = container.createDiv({ cls: "mindmap-inline-loading" });
    renderLoadingSpinner(indicator);
  }

  private renderLiveStatus(container: HTMLElement, activePath: string, hasPersisted: boolean): void {
    if (this.liveState.path !== activePath) return;
    if (this.liveState.status === "error") {
      const status = container.createDiv({ cls: "mindmap-sidebar-status is-error", attr: { role: "status" } });
      status.createSpan({ text: hasPersisted ? "Live refresh failed. Showing saved connections." : "Live connections are unavailable." });
      return;
    }
    const response = this.liveState.response;
    if (!response || (response.indexed && !response.stale)) return;
    const eligibility = this.plugin.getActiveNoteEligibility();
    const eligible = eligibility.path === activePath && eligibility.eligible;
    const status = container.createDiv({ cls: "mindmap-sidebar-status", attr: { role: "status" } });
    status.createSpan({ text: eligible ? "This note's connections are out of date." : eligibility.reason });
    const button = status.createEl("button", {
      cls: "mod-cta mindmap-update-connections",
      text: "Update connections",
      attr: { type: "button", ...(eligible ? {} : { disabled: "true" }) },
    });
    button.addEventListener("click", () => {
      button.disabled = true;
      button.textContent = "Updating…";
      void this.plugin.runActiveNote().finally(() => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.textContent = "Update connections";
      });
    });
  }

  private renderHeatmapDisclosure(container: HTMLElement, candidates: RelatedCandidate[]): void {
    const disclosure = container.createEl("details", { cls: "mindmap-heatmap-disclosure" });
    disclosure.open = this.viewState.heatmapOpen;
    disclosure.createEl("summary", { text: "Connection signals" });
    disclosure.addEventListener("toggle", () => { this.viewState = { ...this.viewState, heatmapOpen: disclosure.open }; });
    this.renderHeatmap(disclosure, candidates);
  }

  private renderHeatmap(container: HTMLElement, candidates: RelatedCandidate[]): void {
    const heatmap = container.createDiv({ cls: "mindmap-heatmap" });
    const svg = heatmap.createSvg("svg", {
      cls: "mindmap-heatmap-chart",
      attr: { viewBox: "0 0 320 300", role: "img", "aria-label": "Mindmap relevance signals for related notes" },
    });
    const tooltip = heatmap.createDiv({ cls: "mindmap-heatmap-tooltip" });

    const chart = {
      left: 10,
      right: 10,
      top: 14,
      bottom: 22,
      width: 320,
      height: 300,
      maxLevel: 4,
    };
    const plotWidth = chart.width - chart.left - chart.right;
    const plotHeight = chart.height - chart.top - chart.bottom;
    const xFor = (index: number): number => chart.left + (candidates.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (candidates.length - 1));
    const yFor = (level: number): number => chart.top + plotHeight - (plotHeight * level) / chart.maxLevel;
    const hideTooltip = (): void => {
      tooltip.removeClass("is-visible");
    };
    const showTooltip = (candidate: RelatedCandidate, clientX: number, clientY: number): void => {
      tooltip.empty();
      tooltip.createDiv({ cls: "mindmap-heatmap-tooltip-title", text: candidate.title });
      const metrics = tooltip.createDiv({ cls: "mindmap-heatmap-tooltip-metrics" });
      for (const metric of candidate.heatmap) {
        const row = metrics.createDiv({ cls: "mindmap-heatmap-tooltip-row" });
        row.createSpan({ cls: `mindmap-heatmap-tooltip-key is-${metric.key}`, text: metric.label });
        row.createSpan({ cls: "mindmap-heatmap-tooltip-detail", text: `${metric.detail} (${metric.level}/4)` });
      }

      const bounds = heatmap.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - bounds.left + 12, 12), bounds.width - 208);
      const y = Math.min(Math.max(clientY - bounds.top + 12, 12), bounds.height - 148);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
      tooltip.addClass("is-visible");
    };
    const bindTooltip = (element: SVGElement, candidate: RelatedCandidate): void => {
      element.addEventListener("mouseenter", (event) => {
        showTooltip(candidate, event.clientX, event.clientY);
      });
      element.addEventListener("mousemove", (event) => {
        showTooltip(candidate, event.clientX, event.clientY);
      });
      element.addEventListener("mouseleave", hideTooltip);
      element.addEventListener("focus", () => {
        const bounds = element.getBoundingClientRect();
        showTooltip(candidate, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      });
      element.addEventListener("blur", hideTooltip);
    };

    for (let level = 0; level <= chart.maxLevel; level += 1) {
      svg.createSvg("line", {
        cls: "mindmap-heatmap-grid",
        attr: {
          x1: String(chart.left),
          x2: String(chart.width - chart.right),
          y1: String(yFor(level)),
          y2: String(yFor(level)),
        },
      });
    }

    for (const [index, candidate] of candidates.entries()) {
      const x = xFor(index);
      const marker = svg.createSvg("rect", {
        cls: "mindmap-heatmap-hit",
        attr: {
          x: String(x - plotWidth / Math.max(candidates.length - 1, 1) / 2),
          y: String(chart.top),
          width: String(plotWidth / Math.max(candidates.length - 1, 1)),
          height: String(plotHeight),
          tabindex: "0",
          role: "button",
          "aria-label": `Select ${candidate.title}`,
        },
      });
      if (candidate.path === this.expandedPath) {
        marker.addClass("is-selected");
      }
      marker.addEventListener("click", () => {
        this.expandedPath = candidate.path;
        this.render();
      });
      marker.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.expandedPath = candidate.path;
          this.render();
        }
      });
      bindTooltip(marker, candidate);
    }

    const metrics = candidates[0]?.heatmap ?? [];
    for (const metric of metrics) {
      const points = candidates.map((candidate, index) => {
        const cell = candidate.heatmap.find((candidateMetric) => candidateMetric.key === metric.key);
        return `${xFor(index)},${yFor(cell?.level ?? 0)}`;
      });
      const line = svg.createSvg("polyline", {
        cls: "mindmap-heatmap-line",
        attr: { points: points.join(" ") },
      });
      line.addClass(`is-${metric.key}`);
    }

    for (const [index, candidate] of candidates.entries()) {
      const x = xFor(index);
      for (const metric of candidate.heatmap) {
        const point = svg.createSvg("circle", {
          cls: "mindmap-heatmap-point",
          attr: {
            cx: String(x),
            cy: String(yFor(metric.level)),
            r: candidate.path === this.expandedPath ? "2.6" : "2",
          },
        });
        point.addClass(`is-${metric.key}`);
        if (candidate.path === this.expandedPath) {
          point.addClass("is-selected");
        }
        point.addEventListener("click", () => {
          this.expandedPath = candidate.path;
          this.render();
        });
        bindTooltip(point, candidate);
      }
    }
  }

  private ensureResultList(container: HTMLElement): HTMLElement {
    const list = this.retainedListEl ?? container.createDiv({ cls: "mindmap-sidebar-list" });
    list.hidden = false;
    this.retainedListEl = list;
    return list;
  }

  private stabilizeCandidates(candidates: RelatedCandidate[], list: HTMLElement): RelatedCandidate[] {
    const active = list.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !list.contains(active)) return candidates;
    const order = new Map(Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-path]")).map((row, index) => [row.dataset.path!, index]));
    return [...candidates].sort((left, right) => {
      const leftIndex = order.get(left.path);
      const rightIndex = order.get(right.path);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });
  }

  private removeUnusedRows(list: HTMLElement, paths: ReadonlySet<string>): void {
    for (const row of Array.from(list.querySelectorAll<HTMLElement>(":scope > [data-path]"))) {
      if (!row.dataset.path || !paths.has(row.dataset.path)) {
        this.renderedCandidates.delete(row.dataset.path ?? "");
        row.remove();
      }
    }
  }

  private reconcileRowOrder(list: HTMLElement, desiredPaths: readonly string[]): void {
    reconcileKeyedOrder(desiredPaths, {
      first: () => list.firstElementChild as HTMLElement | null,
      next: (node) => node.nextElementSibling as HTMLElement | null,
      find: (path) => {
        const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(path) : path.replace(/["\\]/g, "\\$&");
        return list.querySelector<HTMLElement>(`:scope > [data-path="${escaped}"]`);
      },
      insertBefore: (node, before) => { list.insertBefore(node, before); },
    });
  }

  private renderCandidate(container: HTMLElement, candidate: RelatedCandidate, expanded: boolean): void {
    this.renderedCandidates.set(candidate.path, candidate);
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(candidate.path) : candidate.path.replace(/["\\]/g, "\\$&");
    let row = container.querySelector<HTMLElement>(`:scope > [data-path="${escaped}"]`);
    if (!row) {
      row = container.createDiv({ cls: "mindmap-sidebar-card", attr: { role: "button", tabindex: "0", "data-path": candidate.path } });
      const pin = row.createEl("button", { cls: "mindmap-sidebar-pin", attr: { type: "button", tabindex: "0" } });
      setIcon(pin, "pin");
      const body = row.createDiv({ cls: "mindmap-sidebar-card-body" });
      const top = body.createDiv({ cls: "mindmap-sidebar-card-top" });
      const titleWrap = top.createDiv({ cls: "mindmap-sidebar-title-wrap" });
      titleWrap.createEl("a", { cls: "mindmap-sidebar-title internal-link" });
      top.createDiv({ cls: "mindmap-sidebar-meta" });

      const toggle = (): void => {
        const path = row!.dataset.path!;
        this.expandedPath = this.expandedPath === path ? null : path;
        if (this.activePath) this.viewState = rememberExpandedPath(this.viewState, this.activePath, this.expandedPath);
        this.pinRevealPath = null;
        this.render();
      };
      row.addEventListener("click", (event) => { if (!(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) toggle(); });
      row.addEventListener("contextmenu", (event) => { event.preventDefault(); this.pinRevealPath = this.pinRevealPath === row!.dataset.path ? null : row!.dataset.path!; this.render(); });
      row.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          this.pinRevealPath = this.pinRevealPath === row!.dataset.path ? null : row!.dataset.path!;
          this.render();
        } else if ((event.key === "Enter" || event.key === " ") && event.target === row) {
          event.preventDefault();
          toggle();
        }
      });
      pin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = this.renderedCandidates.get(row!.dataset.path!);
        const active = this.app.workspace.getActiveFile();
        if (!current || !active) return;
        void this.plugin.togglePinnedConnection(active.path, current.path).then(() => this.render());
      });
      const link = titleWrap.querySelector<HTMLAnchorElement>("a")!;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = this.renderedCandidates.get(row!.dataset.path!);
        if (current?.file) void this.app.workspace.openLinkText(current.file.path, this.activePath ?? current.file.path, Keymap.isModEvent(event));
      });
      link.addEventListener("mouseover", (event) => {
        const current = this.renderedCandidates.get(row!.dataset.path!);
        if (!current?.file) return;
        this.app.workspace.trigger("hover-link", { event, source: MINDMAP_VIEW_TYPE, hoverParent: this.leaf, targetEl: link, linktext: current.file.path, sourcePath: this.activePath ?? current.file.path });
      });
    }

    row.toggleClass("is-expanded", expanded);
    row.toggleClass("is-pin-revealed", this.pinRevealPath === candidate.path);
    row.setAttribute("aria-expanded", String(expanded));
    const pin = row.querySelector<HTMLButtonElement>(".mindmap-sidebar-pin")!;
    pin.toggleClass("is-pinned", Boolean(candidate.pinned));
    pin.setAttribute("aria-label", candidate.pinned ? `Unpin ${candidate.title}` : `Pin ${candidate.title}`);
    const link = row.querySelector<HTMLAnchorElement>(".mindmap-sidebar-title")!;
    link.textContent = candidate.title;
    link.toggleClass("is-disabled", candidate.file === null);
    if (candidate.file) {
      link.href = candidate.file.path;
      link.dataset.href = candidate.file.path;
      link.removeAttribute("aria-disabled");
    } else {
      link.removeAttribute("href");
      delete link.dataset.href;
      link.setAttribute("aria-disabled", "true");
    }
    const meta = row.querySelector<HTMLElement>(".mindmap-sidebar-meta")!;
    const score = this.formatScore(candidate) ?? (candidate.pinned ? "Pinned" : "");
    let scoreEl = meta.querySelector<HTMLElement>(".mindmap-sidebar-score");
    if (score && !scoreEl) scoreEl = meta.createSpan({ cls: "mindmap-sidebar-score" });
    if (scoreEl) { scoreEl.textContent = score; scoreEl.hidden = !score; if (score) scoreEl.setAttribute("aria-label", `${score} similarity`); }
    const body = row.querySelector<HTMLElement>(".mindmap-sidebar-card-body")!;
    let detail = body.querySelector<HTMLElement>(".mindmap-sidebar-detail");
    if (expanded) {
      if (!detail) { detail = body.createDiv({ cls: "mindmap-sidebar-detail" }); detail.createDiv({ cls: "mindmap-sidebar-summary" }); }
      detail.querySelector<HTMLElement>(".mindmap-sidebar-summary")!.textContent = candidate.summary ?? formatScoreDetail(candidate) ?? "No summary available yet.";
    } else {
      detail?.remove();
    }
  }

  private formatScore(candidate: RelatedCandidate): string | null {
    if (typeof candidate.liveScore !== "number") {
      return null;
    }
    const percent = Math.max(0, Math.min(100, Math.round(candidate.liveScore * 100)));
    return `${percent}%`;
  }

  private renderEmpty(container: HTMLElement, title: string, message: string): void {
    const empty = container.createDiv({ cls: "mindmap-sidebar-empty" });
    empty.createEl("h2", { text: title });
    empty.createEl("p", { text: message });
  }

  private restoreFocusedRow(path: string | null, previousElement?: HTMLElement | null): void {
    if (previousElement?.isConnected) {
      if (previousElement.ownerDocument.activeElement !== previousElement) previousElement.focus({ preventScroll: true });
      return;
    }
    if (!path || !this.resultsEl) return;
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(path) : path.replace(/["\\]/g, "\\$&");
    const row = this.resultsEl.querySelector<HTMLElement>(`[data-path="${escaped}"]`);
    row?.focus({ preventScroll: true });
  }

  private getDisplayCandidates(activeFile: TFile, persistedCandidates: RelatedCandidate[]): RelatedCandidate[] {
    if (!this.plugin.settings.liveSemanticLookupEnabled) {
      return this.applyPinnedCandidates(activeFile, persistedCandidates);
    }
    const liveRelated = getDisplayLiveRelated(activeFile.path, this.liveState);
    if (liveRelated.length > 0) {
      return this.applyPinnedCandidates(activeFile, this.getLiveCandidates(activeFile, liveRelated, "live"));
    }
    return this.applyPinnedCandidates(activeFile, persistedCandidates);
  }

  private getLookupCandidates(activeFile: TFile | null): RelatedCandidate[] {
    if (this.lookupState.related.length === 0) {
      return activeFile === null ? [] : this.applyPinnedCandidates(activeFile, []);
    }
    const lookupCandidates = this.getLiveCandidates(activeFile, this.lookupState.related, "lookup");
    return activeFile === null ? lookupCandidates : this.applyPinnedCandidates(activeFile, lookupCandidates);
  }

  private getLiveCandidates(activeFile: TFile | null, related: LiveRelatedResult[], source: "live" | "lookup"): RelatedCandidate[] {
    const activeFrontmatter = activeFile === null ? {} : this.getFrontmatter(activeFile);
    const activeConcepts = activeFile === null ? [] : normalizeTextList(activeFrontmatter.concepts);
    const activeTags = activeFile === null ? [] : normalizeTextList(activeFrontmatter.tags);

    return related.map((item) => {
      const file = this.resolveRelatedFile(item.path, activeFile?.path ?? "");
      const frontmatter = file === null ? {} : this.getFrontmatter(file);
      const resolvedPath = file?.path ?? item.path;

      return {
        file,
        path: resolvedPath,
        title: item.title ?? file?.basename ?? titleFromPath(item.path),
        folderPath: parentFolderFromPath(resolvedPath) || "Vault root",
        summary: coerceText(frontmatter.summary),
        heatmap: activeFile === null ? [] : this.getHeatmapCells(activeFile.path, activeConcepts, activeTags, resolvedPath, frontmatter),
        liveScore: item.score,
        liveKind: item.kind,
        source,
      };
    });
  }

  private getRelatedCandidates(activeFile: TFile): RelatedCandidate[] {
    const activeFrontmatter = this.getFrontmatter(activeFile);
    const related = normalizeRelatedList(activeFrontmatter.related).map(cleanRelatedPath);
    const activeConcepts = normalizeTextList(activeFrontmatter.concepts);
    const activeTags = normalizeTextList(activeFrontmatter.tags);

    return related.map((path) => {
      const file = this.resolveRelatedFile(path, activeFile.path);
      const frontmatter = file === null ? {} : this.getFrontmatter(file);
      const resolvedPath = file?.path ?? path;

      return {
        file,
        path: resolvedPath,
        title: file?.basename ?? titleFromPath(path),
        folderPath: parentFolderFromPath(resolvedPath) || "Vault root",
        summary: coerceText(frontmatter.summary),
        heatmap: this.getHeatmapCells(activeFile.path, activeConcepts, activeTags, resolvedPath, frontmatter),
        source: "saved",
      };
    });
  }

  private applyPinnedCandidates(activeFile: TFile, candidates: RelatedCandidate[]): RelatedCandidate[] {
    const pinnedPaths = this.plugin.getPinnedConnections(activeFile.path);
    const byPath = new Map<string, RelatedCandidate>();
    for (const candidate of candidates) {
      byPath.set(candidate.path, {
        ...candidate,
        pinned: this.plugin.isConnectionPinned(activeFile.path, candidate.path),
      });
    }

    const pinnedCandidates = pinnedPaths.map((path) => {
      const existing = byPath.get(path);
      if (existing !== undefined) {
        byPath.delete(path);
        return {
          ...existing,
          pinned: true,
        };
      }
      return this.getPinnedCandidate(activeFile, path);
    });

    return [
      ...pinnedCandidates,
      ...Array.from(byPath.values()),
    ];
  }

  private getPinnedCandidate(activeFile: TFile, path: string): RelatedCandidate {
    const file = this.resolveRelatedFile(path, activeFile.path);
    const frontmatter = file === null ? {} : this.getFrontmatter(file);
    const resolvedPath = file?.path ?? path;
    const activeFrontmatter = this.getFrontmatter(activeFile);
    const activeConcepts = normalizeTextList(activeFrontmatter.concepts);
    const activeTags = normalizeTextList(activeFrontmatter.tags);

    return {
      file,
      path: resolvedPath,
      title: file?.basename ?? titleFromPath(path),
      folderPath: parentFolderFromPath(resolvedPath) || "Vault root",
      summary: coerceText(frontmatter.summary),
      heatmap: this.getHeatmapCells(activeFile.path, activeConcepts, activeTags, resolvedPath, frontmatter),
      source: "pinned",
      pinned: true,
    };
  }

  private getHeatmapCells(
    activePath: string,
    activeConcepts: string[],
    activeTags: string[],
    candidatePath: string,
    candidateFrontmatter: Frontmatter,
  ): HeatmapCell[] {
    const candidateConcepts = normalizeTextList(candidateFrontmatter.concepts);
    const candidateTags = normalizeTextList(candidateFrontmatter.tags);
    const conceptOverlap = overlapCount(activeConcepts, candidateConcepts);
    const tagOverlap = overlapCount(activeTags, candidateTags);
    const reciprocal = normalizeRelatedList(candidateFrontmatter.related)
      .map(comparablePath)
      .includes(comparablePath(activePath));
    const metadataLinks = this.app.metadataCache.resolvedLinks[candidatePath] ?? {};
    const metadataBacklink = Object.keys(metadataLinks).some((path) => comparablePath(path) === comparablePath(activePath));
    const linkLevel = reciprocal ? 4 : metadataBacklink ? 3 : 2;
    const temporalLevel = timeLevel(activePath, candidatePath);
    const folderLevel = sourceLevel(activePath, candidatePath);

    return [
      {
        key: "concepts",
        label: "C",
        level: overlapLevel(conceptOverlap),
        detail: conceptOverlap === 1 ? "1 shared concept" : `${conceptOverlap} shared concepts`,
      },
      {
        key: "tags",
        label: "T",
        level: overlapLevel(tagOverlap),
        detail: tagOverlap === 1 ? "1 shared tag" : `${tagOverlap} shared tags`,
      },
      {
        key: "links",
        label: "L",
        level: linkLevel,
        detail: reciprocal ? "Related in both directions" : metadataBacklink ? "Candidate links back to this note" : "Listed as related",
      },
      {
        key: "time",
        label: "D",
        level: temporalLevel,
        detail: temporalLevel > 0 ? "Daily-note date proximity" : "No daily-note date match",
      },
      {
        key: "source",
        label: "F",
        level: folderLevel,
        detail: folderLevel >= 4 ? "Same parent folder" : folderLevel >= 3 ? "Same top-level folder" : "Different source folder",
      },
    ];
  }

  private getFrontmatter(file: TFile): Frontmatter {
    return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  }

  private resolveRelatedFile(path: string, sourcePath: string): TFile | null {
    const candidates = path.endsWith(".md") ? [path] : [path, `${path}.md`];

    for (const candidate of candidates) {
      const direct = this.app.vault.getAbstractFileByPath(candidate);
      if (direct instanceof TFile) {
        return direct;
      }

      const linkPath = candidate.replace(/\.md$/i, "");
      const linked = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
      if (linked !== null) {
        return linked;
      }
    }

    return null;
  }
}
