import { ItemView, Keymap, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import type MindmapPlugin from "./main";
import type { LiveRelatedResult } from "./semanticTypes";
import {
  createErrorLiveState,
  createIdleLiveState,
  createLoadingLiveState,
  createReadyLiveState,
  getDisplayLiveRelated,
  getLiveFeedback,
  getIndexRefreshTargets,
  NO_MINDMAP_CONNECTIONS_MESSAGE,
  NO_MINDMAP_CONNECTIONS_TITLE,
  shouldApplyLiveResponse,
  shouldSkipLiveQuery,
  type SidebarLiveState,
  normalizeMindmapViewState,
  rememberCollapsedPaths,
  toggleCollapsedPaths,
  type MindmapViewState,
} from "./workspaceViewState";
import { SidebarRefreshController } from "./sidebarRefreshController";
import { SidebarLoadingController } from "./sidebarLoadingController";
import { reconcileKeyedOrder } from "./keyedReconciler";
import { RetainedSvgNodes } from "./retainedSvgNodes";
import { clampHeatmapTooltip, createHeatmapGeometry } from "./heatmapGeometry";

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

export class MindmapWorkspaceView extends ItemView {
  private activePath: string | null = null;
  private selectedPath: string | null | undefined = undefined;
  private collapsedPaths = new Set<string>();
  private liveRequestId = 0;
  private lookupRequestId = 0;
  private lookupLoadingRequestId = 0;
  private loadingController: SidebarLoadingController | null = null;
  private pinRevealPath: string | null = null;
  private composingLookup = false;
  private lookupForeground = false;
  private pendingVisualRefresh = false;
  private feedbackKey: string | null = null;
  private heatmapEl: HTMLElement | null = null;
  private heatmapSvgEl: SVGSVGElement | null = null;
  private heatmapTooltipEl: HTMLElement | null = null;
  private heatmapResizeObserver: ResizeObserver | null = null;
  private heatmapResizeFrame: number | null = null;
  private heatmapResizeWindow: Window | null = null;
  private heatmapClosed = false;
  private heatmapWidth: number | null = null;
  private readonly heatmapNodes = new RetainedSvgNodes<SVGElement>();
  private readonly heatmapCandidates = new Map<string, RelatedCandidate>();
  private shellEl: HTMLElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private feedbackEl: HTMLElement | null = null;
  private heatmapRegionEl: HTMLElement | null = null;
  private lookupInputEl: HTMLInputElement | null = null;
  private lookupErrorEl: HTMLElement | null = null;
  private liveRegionEl: HTMLElement | null = null;
  private retainedListEl: HTMLElement | null = null;
  private readonly renderedCandidates = new Map<string, RelatedCandidate>();
  private viewState: MindmapViewState = { collapsedByNote: {} };
  private readonly refreshController = new SidebarRefreshController({
    runLookup: () => this.runLookupQuery(),
    refreshNote: () => this.refreshActiveNoteQuery(),
    refreshIndex: () => this.refreshIndexQueries(),
    typingEnded: () => { if (this.pendingVisualRefresh) this.render(true); },
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
    this.heatmapClosed = false;
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (file.path !== this.activePath) return;
      this.refreshController.scheduleNoteRefresh();
    }));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file?.path !== this.activePath) return;
      this.refreshController.recordTyping();
      this.liveRequestId += 1;
      this.refreshController.invalidateNoteRequest();
      this.liveState = createIdleLiveState(this.activePath, this.liveState.response, this.liveState.displayResponse, this.liveState.error);
    }));
    this.register(this.plugin.subscribeIndexChanges(() => this.refreshController.scheduleIndexRefresh()));
    this.render();
  }

  getState(): MindmapViewState {
    return normalizeMindmapViewState(this.viewState);
  }

  async setState(state: unknown): Promise<void> {
    this.viewState = normalizeMindmapViewState(state);
    if (this.activePath) this.collapsedPaths = new Set(this.viewState.collapsedByNote[this.activePath] ?? []);
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
    this.refreshController.scheduleNoteRefresh();
  }

  async onClose(): Promise<void> {
    this.heatmapClosed = true;
    this.liveRequestId += 1;
    this.lookupRequestId += 1;
    this.refreshController.close();
    this.loadingController?.close();
    this.disconnectHeatmapResize();
  }

  render(background = false): void {
    const content = this.ensureShell();
    const activeFile = this.app.workspace.getActiveFile();
    const activeElement = content.ownerDocument.activeElement;
    if (background && activeFile?.path === this.activePath && (
      this.refreshController.isTyping()
      || (activeElement !== null && content.contains(activeElement))
      || this.heatmapRegionEl?.matches(":hover")
    )) {
      this.pendingVisualRefresh = true;
      return;
    }
    this.pendingVisualRefresh = false;
    const focusedElement = content.ownerDocument.activeElement instanceof HTMLElement && content.contains(content.ownerDocument.activeElement)
      ? content.ownerDocument.activeElement
      : null;
    const focusedPath = focusedElement
      ? focusedElement.closest<HTMLElement>("[data-path]")?.dataset.path ?? null
      : null;
    this.updateLookupShell();

    const shell = this.feedbackEl ?? content;

    if (activeFile === null) {
      if (this.activePath !== null) {
        this.selectedPath = undefined;
        this.collapsedPaths = new Set();
      }
      if (this.heatmapRegionEl) this.heatmapRegionEl.hidden = true;
      this.refreshController.resetTyping();
      this.activePath = null;
      this.loadingController?.update(this.getLoadingRequest());
      this.refreshController.invalidateNoteRequest();
      if (this.retainedListEl) this.retainedListEl.hidden = true;
      if (this.hasLookupQuery()) {
        const candidates = this.getLookupCandidates(null);
        if (candidates.length === 0) {
          this.renderLookupResults(shell, null);
          this.restoreFocusedRow(focusedPath, focusedElement);
          return;
        }
        const list = this.ensureResultList(shell);
        const ordered = this.stabilizeCandidates(candidates, list);
        for (const candidate of ordered) {
          this.renderCandidate(list, candidate, !this.collapsedPaths.has(candidate.path));
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
      this.refreshController.resetTyping();
      this.activePath = activeFile.path;
      this.refreshController.invalidateNoteRequest();
      this.selectedPath = undefined;
      this.collapsedPaths = new Set(this.viewState.collapsedByNote[activeFile.path] ?? []);
      this.pinRevealPath = null;
      this.liveState = createIdleLiveState(activeFile.path);
    }

    this.ensureLiveQuery(activeFile);
    this.loadingController?.update(this.getLoadingRequest());

    const persistedCandidates = this.getRelatedCandidates(activeFile);
    const candidates = this.hasLookupQuery()
      ? this.getLookupCandidates(activeFile)
      : this.getDisplayCandidates(activeFile, persistedCandidates);
    if (candidates.length > 0 && this.selectedPath === undefined) {
      this.selectedPath = candidates[0].path;
    }

    if (candidates.length === 0) {
      if (this.heatmapRegionEl) this.heatmapRegionEl.hidden = true;
      if (this.retainedListEl) this.retainedListEl.hidden = true;
      if (this.hasLookupQuery()) {
        this.renderLookupResults(shell, activeFile);
      } else if (getLiveFeedback(this.liveState, this.plugin.settings.liveSemanticLookupEnabled) === "error") {
        this.renderEmpty(shell, "Connections unavailable", "Saved connections remain in the note. Check Local AI, then try again.");
      } else if (getLiveFeedback(this.liveState, this.plugin.settings.liveSemanticLookupEnabled) === "empty") {
        this.renderEmpty(shell, NO_MINDMAP_CONNECTIONS_TITLE, NO_MINDMAP_CONNECTIONS_MESSAGE);
      } else {
        this.resetFeedback("none");
      }
      this.restoreFocusedRow(focusedPath, focusedElement);
      return;
    }

    if (!this.hasLookupQuery()) this.renderLiveStatus(shell, activeFile.path, persistedCandidates.length > 0);
    else this.resetFeedback("none");
    if (!this.hasLookupQuery()) {
      if (this.heatmapRegionEl) this.heatmapRegionEl.hidden = false;
      this.renderHeatmap(this.heatmapRegionEl ?? shell, candidates);
    } else if (this.heatmapRegionEl) {
      this.heatmapRegionEl.hidden = true;
    }

    const list = this.ensureResultList(shell);
    const ordered = this.stabilizeCandidates(candidates, list);
    for (const candidate of ordered) {
      this.renderCandidate(list, candidate, !this.collapsedPaths.has(candidate.path));
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
    const searchIcon = searchButton.createSpan({ cls: "mindmap-lookup-search-icon", attr: { "aria-hidden": "true" } });
    setIcon(searchIcon, "search");
    const loadingIcon = searchButton.createSpan({ cls: "mindmap-status-swirling mindmap-lookup-loading", attr: { "aria-hidden": "true" } });
    loadingIcon.hidden = true;
    const ownerWindow = input.ownerDocument.defaultView ?? window;
    this.loadingController = new SidebarLoadingController((visible) => {
      loadingIcon.hidden = !visible;
      searchIcon.hidden = visible;
      searchButton.setAttribute("aria-busy", String(visible));
      if (visible && this.liveRegionEl) {
        this.liveRegionEl.textContent = this.hasLookupQuery() ? "Searching connections." : "Updating connections.";
      } else if (!visible && this.liveRegionEl && ["Searching connections.", "Updating connections."].includes(this.liveRegionEl.textContent ?? "")) {
        this.liveRegionEl.textContent = "";
      }
    }, {
      setTimeout: (callback, delayMs) => ownerWindow.setTimeout(callback, delayMs),
      clearTimeout: (handle) => ownerWindow.clearTimeout(handle as number),
    });
    this.register(() => this.loadingController?.close());
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
    let interactionTimer: number | null = null;
    const endInteraction = (): void => {
      if (interactionTimer !== null) ownerWindow.clearTimeout(interactionTimer);
      interactionTimer = ownerWindow.setTimeout(() => {
        interactionTimer = null;
        if (this.pendingVisualRefresh) this.render(true);
      }, 0);
    };
    this.registerDomEvent(this.resultsEl, "focusout", endInteraction);
    this.registerDomEvent(this.heatmapRegionEl, "mouseleave", endInteraction);
    this.register(() => { if (interactionTimer !== null) ownerWindow.clearTimeout(interactionTimer); });

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
    if (this.lookupState.status === "loading" && this.lookupForeground) {
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

  private getLoadingRequest(): string | null {
    if (this.hasLookupQuery()) {
      return this.lookupForeground && !this.composingLookup && this.lookupState.status === "loading" && this.lookupLoadingRequestId === this.lookupRequestId
        ? `lookup:${this.lookupRequestId}`
        : null;
    }
    return null;
  }

  private runLookupQuery(background = false): void {
    const query = this.lookupState.query.trim();
    if (!query) {
      return;
    }
    const requestId = ++this.lookupRequestId;
    this.lookupForeground = !background;
    this.lookupLoadingRequestId = requestId;
    const generation = this.refreshController.invalidateLookup();
    this.lookupState = {
      query,
      status: "loading",
      related: this.lookupState.related,
      error: null,
    };
    this.render(background);

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
        if (this.lookupForeground && this.liveRegionEl) this.liveRegionEl.textContent = `${response.related.length} connection${response.related.length === 1 ? "" : "s"} found.`;
        this.render(background);
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
        this.render(background);
      });
  }

  private ensureLiveQuery(activeFile: TFile): void {
    if (this.refreshController.isTyping()) return;
    if (!this.plugin.settings.liveSemanticLookupEnabled) {
      return;
    }
    if (shouldSkipLiveQuery(this.liveState, activeFile.path)) {
      return;
    }

    const requestId = ++this.liveRequestId;
    const generation = this.refreshController.invalidateNoteRequest();
    this.liveState = createLoadingLiveState(activeFile.path, this.liveState);

    void this.plugin.queryLiveRelated(activeFile.path)
      .then((response) => {
        if (!this.refreshController.isCurrentNote(generation) || !shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createReadyLiveState(activeFile.path, response, this.liveState);
        this.render(true);
      })
      .catch((error) => {
        if (!this.refreshController.isCurrentNote(generation) || !shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createErrorLiveState(activeFile.path, this.liveState, error);
        this.render(true);
      });
  }

  private refreshActiveNoteQuery(): void {
    if (!this.activePath) return;
    this.liveRequestId += 1;
    this.liveState = createIdleLiveState(this.activePath, this.liveState.response, this.liveState.displayResponse, this.liveState.error);
    this.render(true);
  }

  private refreshIndexQueries(): void {
    const targets = getIndexRefreshTargets(this.activePath, this.lookupState.query);
    if ((targets.live && this.liveState.status === "loading") || (targets.lookup && this.lookupState.status === "loading")) {
      this.refreshController.scheduleIndexRefresh();
      return;
    }
    if (targets.live && this.activePath) {
      this.liveRequestId += 1;
      this.liveState = createIdleLiveState(this.activePath, this.liveState.response, this.liveState.displayResponse, this.liveState.error);
    }
    if (targets.lookup) {
      this.lookupRequestId += 1;
      this.runLookupQuery(true);
      return;
    }
    this.render(true);
  }

  private renderLiveStatus(container: HTMLElement, activePath: string, hasPersisted: boolean): void {
    if (this.liveState.path !== activePath) return;
    if (this.liveState.error !== null) {
      if (!this.resetFeedback(`error:${activePath}:${hasPersisted}`)) return;
      const status = container.createDiv({ cls: "mindmap-sidebar-status is-error", attr: { role: "status" } });
      status.createSpan({ text: hasPersisted ? "Live refresh failed. Showing saved connections." : "Live connections are unavailable." });
      return;
    }
    this.resetFeedback("none");
  }

  private renderHeatmap(container: HTMLElement, candidates: RelatedCandidate[]): void {
    const heatmap = this.heatmapEl ?? container.createDiv({ cls: "mindmap-heatmap" });
    this.heatmapEl = heatmap;
    const svg = this.heatmapSvgEl ?? heatmap.createSvg("svg", {
      cls: "mindmap-heatmap-chart",
      attr: { role: "img", "aria-label": "Mindmap connection graph for related notes" },
    });
    this.heatmapSvgEl = svg;
    this.ensureHeatmapResize(svg);
    const tooltip = this.heatmapTooltipEl ?? heatmap.createDiv({ cls: "mindmap-heatmap-tooltip" });
    this.heatmapTooltipEl = tooltip;
    this.heatmapCandidates.clear();
    for (const candidate of candidates) this.heatmapCandidates.set(candidate.path, candidate);
    this.heatmapNodes.begin();

    const measuredWidth = svg.getBoundingClientRect().width;
    if (measuredWidth > 0) this.heatmapWidth = measuredWidth;
    const chart = createHeatmapGeometry(this.heatmapWidth ?? 320, candidates.length);
    svg.setAttribute("viewBox", `0 0 ${chart.width} ${chart.height}`);
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

      tooltip.addClass("is-visible");
      const bounds = heatmap.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();
      const position = clampHeatmapTooltip(
        { x: clientX - bounds.left, y: clientY - bounds.top },
        { width: bounds.width, height: bounds.height },
        { width: tooltipBounds.width, height: tooltipBounds.height },
      );
      tooltip.style.left = `${position.x}px`;
      tooltip.style.top = `${position.y}px`;
    };
    const bindTooltip = (element: SVGElement, candidatePath: string): void => {
      const show = (x: number, y: number): void => {
        const candidate = this.heatmapCandidates.get(candidatePath);
        if (candidate) showTooltip(candidate, x, y);
      };
      element.addEventListener("mouseenter", (event) => {
        show(event.clientX, event.clientY);
      });
      element.addEventListener("mousemove", (event) => {
        show(event.clientX, event.clientY);
      });
      element.addEventListener("mouseleave", hideTooltip);
      element.addEventListener("focus", () => {
        const bounds = element.getBoundingClientRect();
        show(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      });
      element.addEventListener("blur", hideTooltip);
    };

    for (let level = 0; level <= 4; level += 1) {
      this.heatmapNodes.get(`grid:${level}`, () => svg.createSvg("line", {
        cls: "mindmap-heatmap-grid",
      }), {
        x1: String(chart.left),
        x2: String(chart.width - chart.right),
        y1: String(chart.yFor(level)),
        y2: String(chart.yFor(level)),
      });
    }

    for (const [index, candidate] of candidates.entries()) {
      const hit = chart.hitBounds(index);
      const markerResult = this.heatmapNodes.get(`hit:${candidate.path}`, () => svg.createSvg("rect", {
        cls: "mindmap-heatmap-hit",
      }), {
        x: String(hit.x),
        y: String(chart.top),
        width: String(hit.width),
        height: String(chart.plotHeight),
        tabindex: "0",
        role: "button",
        "aria-label": `Select ${candidate.title}`,
      });
      const marker = markerResult.node;
      marker.toggleClass("is-selected", candidate.path === this.selectedPath);
      if (markerResult.created) {
        marker.addEventListener("click", () => {
          this.selectCandidateFromGraph(candidate.path);
        });
        marker.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.selectCandidateFromGraph(candidate.path);
          }
        });
        bindTooltip(marker, candidate.path);
      }
    }

    const metrics = candidates[0]?.heatmap ?? [];
    for (const metric of metrics) {
      const points = candidates.map((candidate, index) => {
        const cell = candidate.heatmap.find((candidateMetric) => candidateMetric.key === metric.key);
        return `${chart.xFor(index)},${chart.yFor(cell?.level ?? 0)}`;
      });
      const { node: line } = this.heatmapNodes.get(`line:${metric.key}`, () => svg.createSvg("polyline", {
        cls: "mindmap-heatmap-line",
      }), { points: points.join(" ") });
      line.addClass(`is-${metric.key}`);
    }

    for (const [index, candidate] of candidates.entries()) {
      const x = chart.xFor(index);
      for (const metric of candidate.heatmap) {
        const pointResult = this.heatmapNodes.get(`point:${candidate.path}:${metric.key}`, () => svg.createSvg("circle", {
          cls: "mindmap-heatmap-point",
        }), {
          cx: String(x),
          cy: String(chart.yFor(metric.level)),
          r: candidate.path === this.selectedPath ? "2.6" : "2",
        });
        const point = pointResult.node;
        point.addClass(`is-${metric.key}`);
        point.toggleClass("is-selected", candidate.path === this.selectedPath);
        if (pointResult.created) {
          point.addEventListener("click", () => {
            this.selectCandidateFromGraph(candidate.path);
          });
          bindTooltip(point, candidate.path);
        }
      }
    }
    this.heatmapNodes.finish({
      first: () => svg.firstElementChild as SVGElement | null,
      next: (node) => node.nextElementSibling as SVGElement | null,
      find: () => null,
      insertBefore: (node, before) => { svg.insertBefore(node, before); },
    });
  }

  private ensureHeatmapResize(svg: SVGSVGElement): void {
    const ownerWindow = svg.ownerDocument.defaultView ?? window;
    if (this.heatmapClosed) return;
    if (this.heatmapResizeObserver !== null && this.heatmapResizeWindow === ownerWindow) return;
    if (this.heatmapResizeObserver !== null || this.heatmapResizeFrame !== null) this.disconnectHeatmapResize();
    if (typeof ownerWindow.ResizeObserver !== "function") return;
    this.heatmapResizeWindow = ownerWindow;
    const observer = new ownerWindow.ResizeObserver((entries) => {
      if (this.heatmapClosed || this.heatmapResizeObserver !== observer || this.heatmapResizeWindow !== ownerWindow) return;
      const width = entries.find((entry) => entry.target === svg)?.contentRect.width ?? svg.getBoundingClientRect().width;
      if (!(width > 0) || width === this.heatmapWidth) return;
      this.heatmapWidth = width;
      if (this.heatmapResizeFrame !== null) return;
      const frame = ownerWindow.requestAnimationFrame(() => {
        if (this.heatmapResizeFrame !== frame) return;
        this.heatmapResizeFrame = null;
        const heatmap = this.heatmapEl;
        if (this.heatmapClosed || this.heatmapResizeObserver !== observer || this.heatmapResizeWindow !== ownerWindow
          || this.heatmapSvgEl !== svg || heatmap === null || this.heatmapCandidates.size === 0) return;
        this.renderHeatmap(heatmap, [...this.heatmapCandidates.values()]);
      });
      this.heatmapResizeFrame = frame;
    });
    this.heatmapResizeObserver = observer;
    observer.observe(svg);
  }

  private disconnectHeatmapResize(): void {
    this.heatmapResizeObserver?.disconnect();
    this.heatmapResizeObserver = null;
    if (this.heatmapResizeFrame !== null) {
      this.heatmapResizeWindow?.cancelAnimationFrame(this.heatmapResizeFrame);
      this.heatmapResizeFrame = null;
    }
    this.heatmapResizeWindow = null;
  }

  private selectCandidateFromGraph(path: string): void {
    this.selectedPath = path;
    this.render();
    const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(path) : path.replace(/["\\]/g, "\\$&");
    this.resultsEl?.querySelector<HTMLElement>(`[data-path="${escaped}"]`)?.focus({ preventScroll: true });
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
      row = container.createDiv({ cls: "mindmap-sidebar-card", attr: { role: "group", tabindex: "0", "data-path": candidate.path } });
      const body = row.createDiv({ cls: "mindmap-sidebar-card-body" });
      const top = body.createDiv({ cls: "mindmap-sidebar-card-top" });
      const titleWrap = top.createDiv({ cls: "mindmap-sidebar-title-wrap" });
      titleWrap.createEl("a", { cls: "mindmap-sidebar-title internal-link" });
      const meta = top.createDiv({ cls: "mindmap-sidebar-meta" });
      const pin = meta.createEl("button", { cls: "mindmap-sidebar-pin", attr: { type: "button", tabindex: "0" } });
      setIcon(pin, "pin");
      meta.createSpan({ cls: "mindmap-sidebar-score" });
      const collapse = meta.createEl("button", { cls: "mindmap-sidebar-collapse", attr: { type: "button" } });

      const select = (): void => {
        const path = row!.dataset.path!;
        this.selectedPath = path;
        this.pinRevealPath = null;
        this.render();
      };
      row.addEventListener("click", (event) => { if (!(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) select(); });
      row.addEventListener("contextmenu", (event) => { event.preventDefault(); this.pinRevealPath = this.pinRevealPath === row!.dataset.path ? null : row!.dataset.path!; this.render(); });
      row.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          this.pinRevealPath = this.pinRevealPath === row!.dataset.path ? null : row!.dataset.path!;
          this.render();
        } else if ((event.key === "Enter" || event.key === " ") && event.target === row) {
          event.preventDefault();
          select();
        }
      });
      collapse.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const path = row!.dataset.path!;
        const displayedPaths = Array.from(container.querySelectorAll<HTMLElement>(":scope > [data-path]"))
          .filter((candidateRow) => !candidateRow.hidden && Boolean(candidateRow.dataset.path))
          .map((candidateRow) => candidateRow.dataset.path!);
        this.collapsedPaths = toggleCollapsedPaths(this.collapsedPaths, path, displayedPaths, event.altKey);
        if (this.activePath) this.viewState = rememberCollapsedPaths(this.viewState, this.activePath, this.collapsedPaths);
        this.render();
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

    row.toggleClass("is-selected", candidate.path === this.selectedPath);
    row.toggleClass("is-expanded", expanded);
    row.toggleClass("is-pin-revealed", this.pinRevealPath === candidate.path);
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
    const collapse = row.querySelector<HTMLButtonElement>(".mindmap-sidebar-collapse")!;
    collapse.empty();
    setIcon(collapse, expanded ? "chevron-up" : "chevron-down");
    collapse.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${candidate.title}`);
    collapse.setAttribute("aria-expanded", String(expanded));
    const body = row.querySelector<HTMLElement>(".mindmap-sidebar-card-body")!;
    let detail = body.querySelector<HTMLElement>(".mindmap-sidebar-detail");
    if (expanded) {
      if (!detail) { detail = body.createDiv({ cls: "mindmap-sidebar-detail" }); detail.createDiv({ cls: "mindmap-sidebar-summary" }); }
      detail.querySelector<HTMLElement>(".mindmap-sidebar-summary")!.textContent = candidate.summary ?? "";
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

  private resetFeedback(key: string): boolean {
    if (this.feedbackKey === key) return false;
    this.feedbackKey = key;
    this.feedbackEl?.empty();
    return true;
  }

  private renderEmpty(container: HTMLElement, title: string, message: string): void {
    if (container === this.feedbackEl && !this.resetFeedback(`empty:${title}:${message}`)) return;
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
