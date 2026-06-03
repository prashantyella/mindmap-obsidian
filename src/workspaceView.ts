import { ItemView, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { animate } from "motion";

import type MindmapPlugin from "./main";
import type { LiveRelatedResult } from "./semanticTypes";
import {
  createErrorLiveState,
  createIdleLiveState,
  createLoadingLiveState,
  createReadyLiveState,
  getDisplayLiveRelated,
  NO_MINDMAP_CONNECTIONS_MESSAGE,
  NO_MINDMAP_CONNECTIONS_TITLE,
  shouldApplyLiveResponse,
  type SidebarLiveState,
} from "./workspaceViewState";

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
  private renderedExpandedPath: string | null | undefined = undefined;
  private renderedPinRevealPath: string | null = null;
  private liveRequestId = 0;
  private lookupRequestId = 0;
  private lookupTimer: number | null = null;
  private pinRevealPath: string | null = null;
  private lookupShouldRefocus = false;
  private lookupSelectionStart: number | null = null;
  private lookupSelectionEnd: number | null = null;
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
      if (file.path === this.activePath) {
        this.liveState = createIdleLiveState(file.path, this.liveState.response);
      }
      this.render();
    }));
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.lookupTimer !== null) {
      window.clearTimeout(this.lookupTimer);
      this.lookupTimer = null;
    }
  }

  render(): void {
    const { containerEl } = this;
    const previousCardPositions = this.captureCardPositions(containerEl);
    const previousExpandedPath = this.renderedExpandedPath;
    const previousPinRevealPath = this.renderedPinRevealPath;
    containerEl.empty();
    containerEl.addClass("mindmap-view");

    const activeFile = this.app.workspace.getActiveFile();
    const shell = containerEl.createDiv({ cls: "mindmap-sidebar" });
    this.renderLookupSearch(shell);

    if (activeFile === null) {
      this.activePath = null;
      this.expandedPath = undefined;
      this.renderedExpandedPath = undefined;
      this.renderedPinRevealPath = null;
      if (this.hasLookupQuery()) {
        const candidates = this.getLookupCandidates(null);
        if (this.isLoadingVisible()) {
          this.renderInlineLoadingIndicator(shell);
        }
        if (candidates.length === 0) {
          this.renderLookupResults(shell, null);
          return;
        }
        const list = shell.createDiv({ cls: "mindmap-sidebar-list" });
        for (const candidate of candidates) {
          this.renderCandidate(list, candidate, false);
        }
      } else {
        this.renderEmpty(shell, "No active note", "Open a note to see its mindmap links.");
      }
      return;
    }

    if (this.activePath !== activeFile.path) {
      this.activePath = activeFile.path;
      this.expandedPath = undefined;
      this.renderedExpandedPath = undefined;
      this.pinRevealPath = null;
      this.renderedPinRevealPath = null;
      this.liveState = createIdleLiveState(activeFile.path);
    }

    this.ensureLiveQuery(activeFile);

    const persistedCandidates = this.getRelatedCandidates(activeFile);
    const candidates = this.hasLookupQuery()
      ? this.getLookupCandidates(activeFile)
      : this.getDisplayCandidates(activeFile, persistedCandidates);
    if (candidates.length > 0 && this.expandedPath === undefined) {
      this.expandedPath = candidates[0].path;
    }

    if (candidates.length === 0) {
      if (this.isLoadingVisible()) {
        this.renderInlineLoadingIndicator(shell);
      }
      this.renderedExpandedPath = this.expandedPath;
      this.renderedPinRevealPath = null;
      if (this.hasLookupQuery()) {
        this.renderLookupResults(shell, activeFile);
      } else {
        this.renderEmpty(shell, NO_MINDMAP_CONNECTIONS_TITLE, NO_MINDMAP_CONNECTIONS_MESSAGE);
      }
      return;
    }

    if (this.isLoadingVisible()) {
      this.renderInlineLoadingIndicator(shell);
    }

    if (!this.hasLookupQuery()) {
      this.renderHeatmap(shell, candidates);
    }

    const list = shell.createDiv({ cls: "mindmap-sidebar-list" });
    for (const candidate of candidates) {
      this.renderCandidate(list, candidate, candidate.path === this.expandedPath);
    }

    this.animateSidebar(shell, previousCardPositions, previousExpandedPath, this.expandedPath);
    this.animatePinReveal(shell, previousPinRevealPath, this.pinRevealPath);
    this.renderedExpandedPath = this.expandedPath;
    this.renderedPinRevealPath = this.pinRevealPath;
  }

  private renderLookupSearch(container: HTMLElement): void {
    const search = container.createDiv({ cls: "mindmap-lookup" });
    const input = search.createEl("input", {
      cls: "mindmap-lookup-input",
      attr: {
        type: "search",
        placeholder: "Ask across notes",
        "aria-label": "Search Mindmap connections",
        value: this.lookupState.query,
      },
    });
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

    input.addEventListener("input", () => {
      this.captureLookupInputState(input);
      this.lookupState = {
        ...this.lookupState,
        query: input.value,
        status: input.value.trim() ? this.lookupState.status : "idle",
        related: input.value.trim() ? this.lookupState.related : [],
        error: null,
      };
      this.lookupShouldRefocus = true;
      if (!input.value.trim()) {
        this.lookupRequestId += 1;
        this.cancelLookupTimer();
        this.render();
        return;
      }
      this.scheduleLookupQuery();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      this.captureLookupInputState(input);
      this.cancelLookupTimer();
      this.runLookupQuery();
    });
    searchButton.addEventListener("click", () => {
      this.cancelLookupTimer();
      this.captureLookupInputState(input);
      this.lookupShouldRefocus = true;
      this.runLookupQuery();
    });
    clearButton.addEventListener("click", () => {
      this.lookupRequestId += 1;
      this.cancelLookupTimer();
      this.lookupState = {
        query: "",
        status: "idle",
        related: [],
        error: null,
      };
      this.lookupShouldRefocus = true;
      this.render();
    });

    if (this.lookupState.status === "error" && this.lookupState.error !== null) {
      search.createDiv({ cls: "mindmap-lookup-error", text: this.lookupState.error });
    }

    if (this.lookupShouldRefocus || this.plugin.consumeLookupFocusRequest()) {
      this.lookupShouldRefocus = false;
      window.requestAnimationFrame(() => {
        input.focus();
        const start = this.lookupSelectionStart ?? input.value.length;
        const end = this.lookupSelectionEnd ?? start;
        input.setSelectionRange(Math.min(start, input.value.length), Math.min(end, input.value.length));
      });
    }
  }

  private captureLookupInputState(input: HTMLInputElement): void {
    this.lookupSelectionStart = input.selectionStart;
    this.lookupSelectionEnd = input.selectionEnd;
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

  private scheduleLookupQuery(): void {
    this.cancelLookupTimer();
    this.lookupTimer = window.setTimeout(() => {
      this.lookupTimer = null;
      this.runLookupQuery();
    }, 350);
  }

  private cancelLookupTimer(): void {
    if (this.lookupTimer === null) {
      return;
    }
    window.clearTimeout(this.lookupTimer);
    this.lookupTimer = null;
  }

  private runLookupQuery(): void {
    const query = this.lookupState.query.trim();
    if (!query) {
      return;
    }
    const requestId = ++this.lookupRequestId;
    this.lookupState = {
      query,
      status: "loading",
      related: this.lookupState.related,
      error: null,
    };
    this.lookupShouldRefocus = true;

    void this.plugin.queryLookupRelated(query)
      .then((response) => {
        if (requestId !== this.lookupRequestId || response.query !== this.lookupState.query.trim()) {
          return;
        }
        this.lookupState = {
          query: response.query,
          status: "ready",
          related: response.related,
          error: null,
        };
        this.lookupShouldRefocus = true;
        this.render();
      })
      .catch((error) => {
        if (requestId !== this.lookupRequestId) {
          return;
        }
        this.lookupState = {
          query,
          status: "error",
          related: [],
          error: error instanceof Error ? error.message : String(error),
        };
        this.lookupShouldRefocus = true;
        this.render();
      });
  }

  private ensureLiveQuery(activeFile: TFile): void {
    if (!this.plugin.settings.liveSemanticLookupEnabled) {
      return;
    }
    if (this.liveState.path === activeFile.path && this.liveState.status !== "idle") {
      return;
    }

    const requestId = ++this.liveRequestId;
    this.liveState = createLoadingLiveState(activeFile.path, this.liveState);

    void this.plugin.queryLiveRelated(activeFile.path)
      .then((response) => {
        if (!shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createReadyLiveState(activeFile.path, response);
        this.render();
      })
      .catch((error) => {
        if (!shouldApplyLiveResponse(requestId, this.liveRequestId, this.activePath, activeFile.path)) {
          return;
        }
        this.liveState = createErrorLiveState(activeFile.path, this.liveState, error);
        this.render();
      });
  }

  private renderInlineLoadingIndicator(container: HTMLElement): void {
    const indicator = container.createDiv({ cls: "mindmap-inline-loading" });
    renderLoadingSpinner(indicator);
  }

  private renderHeatmap(container: HTMLElement, candidates: RelatedCandidate[]): void {
    const heatmap = container.createDiv({ cls: "mindmap-heatmap" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "mindmap-heatmap-chart");
    svg.setAttribute("viewBox", "0 0 320 300");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Mindmap relevance signals for related notes");
    heatmap.appendChild(svg);
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
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "mindmap-heatmap-grid");
      line.setAttribute("x1", String(chart.left));
      line.setAttribute("x2", String(chart.width - chart.right));
      line.setAttribute("y1", String(yFor(level)));
      line.setAttribute("y2", String(yFor(level)));
      svg.appendChild(line);
    }

    for (const [index, candidate] of candidates.entries()) {
      const x = xFor(index);
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      marker.setAttribute("class", `mindmap-heatmap-hit${candidate.path === this.expandedPath ? " is-selected" : ""}`);
      marker.setAttribute("x", String(x - plotWidth / Math.max(candidates.length - 1, 1) / 2));
      marker.setAttribute("y", String(chart.top));
      marker.setAttribute("width", String(plotWidth / Math.max(candidates.length - 1, 1)));
      marker.setAttribute("height", String(plotHeight));
      marker.setAttribute("tabindex", "0");
      marker.setAttribute("role", "button");
      marker.setAttribute("aria-label", `Select ${candidate.title}`);
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
      svg.appendChild(marker);
    }

    const metrics = candidates[0]?.heatmap ?? [];
    for (const metric of metrics) {
      const points = candidates.map((candidate, index) => {
        const cell = candidate.heatmap.find((candidateMetric) => candidateMetric.key === metric.key);
        return `${xFor(index)},${yFor(cell?.level ?? 0)}`;
      });
      const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      path.setAttribute("class", `mindmap-heatmap-line is-${metric.key}`);
      path.setAttribute("points", points.join(" "));
      svg.appendChild(path);
    }

    for (const [index, candidate] of candidates.entries()) {
      const x = xFor(index);
      for (const metric of candidate.heatmap) {
        const point = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        point.setAttribute("class", `mindmap-heatmap-point is-${metric.key}${candidate.path === this.expandedPath ? " is-selected" : ""}`);
        point.setAttribute("cx", String(x));
        point.setAttribute("cy", String(yFor(metric.level)));
        point.setAttribute("r", candidate.path === this.expandedPath ? "2.6" : "2");
        point.addEventListener("click", () => {
          this.expandedPath = candidate.path;
          this.render();
        });
        bindTooltip(point, candidate);
        svg.appendChild(point);
      }
    }
  }

  private renderCandidate(container: HTMLElement, candidate: RelatedCandidate, expanded: boolean): void {
    const activeFile = this.app.workspace.getActiveFile();
    const pinRevealed = activeFile !== null && this.pinRevealPath === candidate.path;
    const row = container.createDiv({
      cls: `mindmap-sidebar-card${expanded ? " is-expanded" : ""}${pinRevealed ? " is-pin-revealed" : ""}`,
      attr: {
        role: "button",
        tabindex: "0",
        "aria-expanded": String(expanded),
        "data-path": candidate.path,
      },
    });

    row.addEventListener("click", () => {
      this.expandedPath = expanded ? null : candidate.path;
      this.pinRevealPath = null;
      this.render();
    });
    row.addEventListener("contextmenu", (event) => {
      if (activeFile === null) {
        return;
      }
      event.preventDefault();
      this.pinRevealPath = pinRevealed ? null : candidate.path;
      this.render();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      this.expandedPath = expanded ? null : candidate.path;
      this.pinRevealPath = null;
      this.render();
    });

    if (activeFile !== null) {
      this.renderPinAction(row, activeFile, candidate, pinRevealed);
    }

    const body = row.createDiv({ cls: "mindmap-sidebar-card-body" });
    const top = body.createDiv({ cls: "mindmap-sidebar-card-top" });
    const titleWrap = top.createDiv({ cls: "mindmap-sidebar-title-wrap" });
    this.renderCandidateLink(titleWrap, candidate, "mindmap-sidebar-title");
    this.renderCandidateMeta(top, candidate);

    if (!expanded) {
      return;
    }

    const detail = body.createDiv({ cls: "mindmap-sidebar-detail" });
    detail.createDiv({
      cls: "mindmap-sidebar-summary",
      text: candidate.summary ?? formatScoreDetail(candidate) ?? "No summary available yet.",
    });
  }

  private renderPinAction(container: HTMLElement, activeFile: TFile, candidate: RelatedCandidate, revealed: boolean): void {
    const button = container.createEl("button", {
      cls: `mindmap-sidebar-pin${candidate.pinned ? " is-pinned" : ""}`,
      attr: {
        type: "button",
        "aria-label": candidate.pinned ? `Unpin ${candidate.title}` : `Pin ${candidate.title}`,
        tabindex: revealed ? "0" : "-1",
      },
    });
    setIcon(button, "pin");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.plugin.togglePinnedConnection(activeFile.path, candidate.path).then(() => {
        this.pinRevealPath = null;
        this.render();
      });
    });
  }

  private renderCandidateMeta(container: HTMLElement, candidate: RelatedCandidate): void {
    const meta = container.createDiv({ cls: "mindmap-sidebar-meta" });
    const score = this.formatScore(candidate);
    if (score !== null) {
      meta.createSpan({
        cls: "mindmap-sidebar-score",
        text: score,
        attr: {
          "aria-label": `${score} semantic score`,
        },
      });
    } else if (candidate.pinned) {
      meta.createSpan({ cls: "mindmap-sidebar-score", text: "Pinned" });
    }
  }

  private formatScore(candidate: RelatedCandidate): string | null {
    if (typeof candidate.liveScore !== "number") {
      return null;
    }
    const percent = Math.max(0, Math.min(100, Math.round(candidate.liveScore * 100)));
    return `${percent}`;
  }

  private renderEmpty(container: HTMLElement, title: string, message: string): void {
    const empty = container.createDiv({ cls: "mindmap-sidebar-empty" });
    empty.createEl("h2", { text: title });
    empty.createEl("p", { text: message });
  }

  private renderCandidateLink(container: HTMLElement, candidate: RelatedCandidate, className: string): void {
    const file = candidate.file;
    if (file === null) {
      container.createSpan({ cls: className, text: candidate.title });
      return;
    }

    const link = container.createEl("a", {
      cls: `${className} internal-link`,
      text: candidate.title,
      attr: {
        href: file.path,
        "data-href": file.path,
      },
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
    });
    link.addEventListener("mouseover", (event) => {
      this.app.workspace.trigger("hover-link", {
        event,
        source: MINDMAP_VIEW_TYPE,
        hoverParent: this.leaf,
        targetEl: link,
        linktext: file.path,
        sourcePath: this.app.workspace.getActiveFile()?.path ?? file.path,
      });
    });
  }

  private animateSidebar(
    container: HTMLElement,
    previousCardPositions: Map<string, DOMRect>,
    previousExpandedPath: string | null | undefined,
    nextExpandedPath: string | null | undefined,
  ): void {
    const expansionChanged = previousExpandedPath !== nextExpandedPath;
    const rows = Array.from(container.querySelectorAll(".mindmap-sidebar-card"));
    if (rows.length > 0) {
      rows.forEach((row, index) => {
        if (!(row instanceof HTMLElement)) {
          return;
        }
        const path = row.dataset.path;
        const previous = path ? previousCardPositions.get(path) : undefined;
        const current = row.getBoundingClientRect();
        if (previous === undefined) {
          animate(row, { opacity: [0.82, 1], y: [8, 0] }, { duration: 0.2, delay: index * 0.018, ease: "easeOut" });
          return;
        }
        if (expansionChanged && path === nextExpandedPath) {
          return;
        }

        const fromY = previous.top - current.top;
        if (Math.abs(fromY) > 0.5) {
          animate(row, { y: [fromY, 0] }, { duration: 0.24, ease: "easeOut" });
        }
      });
    }

    if (expansionChanged && nextExpandedPath !== null && nextExpandedPath !== undefined) {
      const expandedRow = rows.find((row): row is HTMLElement => row instanceof HTMLElement && row.dataset.path === nextExpandedPath);
      const detail = expandedRow?.querySelector(".mindmap-sidebar-detail");
      if (detail instanceof HTMLElement) {
        animate(detail, { opacity: [0, 1], y: [-4, 0] }, { duration: 0.16, ease: "easeOut" });
      }
    }
  }

  private animatePinReveal(container: HTMLElement, previousPath: string | null, nextPath: string | null): void {
    if (previousPath === nextPath) {
      return;
    }

    if (previousPath !== null) {
      const row = this.findCandidateRow(container, previousPath);
      const body = row?.querySelector(".mindmap-sidebar-card-body");
      const pin = row?.querySelector(".mindmap-sidebar-pin");
      if (body instanceof HTMLElement) {
        animate(body, { x: [32, 0] }, { duration: 0.16, ease: [0.25, 1, 0.5, 1] });
      }
      if (pin instanceof HTMLElement) {
        animate(pin, { opacity: [1, 0], x: [0, -4] }, { duration: 0.12, ease: [0.25, 1, 0.5, 1] });
      }
    }

    if (nextPath !== null) {
      const row = this.findCandidateRow(container, nextPath);
      const body = row?.querySelector(".mindmap-sidebar-card-body");
      const pin = row?.querySelector(".mindmap-sidebar-pin");
      if (body instanceof HTMLElement) {
        animate(body, { x: [0, 32] }, { duration: 0.16, ease: [0.25, 1, 0.5, 1] });
      }
      if (pin instanceof HTMLElement) {
        animate(pin, { opacity: [0, 1], x: [-4, 0] }, { duration: 0.14, ease: [0.25, 1, 0.5, 1] });
      }
    }
  }

  private findCandidateRow(container: HTMLElement, path: string): HTMLElement | null {
    return Array.from(container.querySelectorAll(".mindmap-sidebar-card"))
      .find((row): row is HTMLElement => row instanceof HTMLElement && row.dataset.path === path) ?? null;
  }

  private captureCardPositions(container: HTMLElement): Map<string, DOMRect> {
    const positions = new Map<string, DOMRect>();
    for (const row of Array.from(container.querySelectorAll(".mindmap-sidebar-card"))) {
      if (!(row instanceof HTMLElement) || !row.dataset.path) {
        continue;
      }
      positions.set(row.dataset.path, row.getBoundingClientRect());
    }
    return positions;
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
    return this.app.metadataCache.getFileCache(file)?.frontmatter as Frontmatter | undefined ?? {};
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
