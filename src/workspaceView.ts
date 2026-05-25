import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { animate } from "motion";

import type MindmapPlugin from "./main";
import type { LiveRelatedResponse, LiveRelatedResult } from "./semanticTypes";

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
}

interface LiveState {
  path: string;
  status: "idle" | "loading" | "ready" | "error";
  response: LiveRelatedResponse | null;
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

function formatLiveDetail(candidate: RelatedCandidate): string | null {
  if (typeof candidate.liveScore !== "number") {
    return null;
  }
  const percent = Math.round(candidate.liveScore * 100);
  const kind = candidate.liveKind ?? "semantic";
  return `Live ${kind} match (${percent}%).`;
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
  private liveState: LiveState = {
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
        this.liveState = {
          path: file.path,
          status: "idle",
          response: this.liveState.response,
          error: null,
        };
      }
      this.render();
    }));
    this.render();
  }

  render(): void {
    const { containerEl } = this;
    const previousCardPositions = this.captureCardPositions(containerEl);
    containerEl.empty();
    containerEl.addClass("mindmap-view");

    const activeFile = this.app.workspace.getActiveFile();
    const shell = containerEl.createDiv({ cls: "mindmap-sidebar" });

    if (activeFile === null) {
      this.activePath = null;
      this.expandedPath = undefined;
      this.renderEmpty(shell, "No active note", "Open a note to see its mindmap links.");
      return;
    }

    if (this.activePath !== activeFile.path) {
      this.activePath = activeFile.path;
      this.expandedPath = undefined;
      this.liveState = {
        path: activeFile.path,
        status: "idle",
        response: null,
        error: null,
      };
    }

    this.ensureLiveQuery(activeFile);

    const persistedCandidates = this.getRelatedCandidates(activeFile);
    const candidates = this.getDisplayCandidates(activeFile, persistedCandidates);
    if (candidates.length > 0 && this.expandedPath === undefined) {
      this.expandedPath = candidates[0].path;
    }

    if (candidates.length === 0) {
      if (this.liveState.status === "loading") {
        this.renderInlineLoadingIndicator(shell);
      }
      this.renderEmpty(shell, "No mindmap connections", "No mindmap connections exist for this note.");
      return;
    }

    if (this.liveState.status === "loading") {
      this.renderInlineLoadingIndicator(shell);
    }

    this.renderHeatmap(shell, candidates);

    const list = shell.createDiv({ cls: "mindmap-sidebar-list" });
    for (const candidate of candidates) {
      this.renderCandidate(list, candidate, candidate.path === this.expandedPath);
    }

    this.animateSidebar(shell, previousCardPositions);
  }

  private ensureLiveQuery(activeFile: TFile): void {
    if (!this.plugin.settings.liveSemanticLookupEnabled) {
      return;
    }
    if (this.liveState.path === activeFile.path && this.liveState.status !== "idle") {
      return;
    }

    const requestId = ++this.liveRequestId;
    const previousResponse = this.liveState.path === activeFile.path ? this.liveState.response : null;
    this.liveState = {
      path: activeFile.path,
      status: "loading",
      response: previousResponse,
      error: null,
    };

    void this.plugin.queryLiveRelated(activeFile.path)
      .then((response) => {
        if (requestId !== this.liveRequestId || this.activePath !== activeFile.path) {
          return;
        }
        this.liveState = {
          path: activeFile.path,
          status: "ready",
          response,
          error: null,
        };
        this.render();
      })
      .catch((error) => {
        if (requestId !== this.liveRequestId || this.activePath !== activeFile.path) {
          return;
        }
        this.liveState = {
          path: activeFile.path,
          status: "error",
          response: this.liveState.path === activeFile.path ? this.liveState.response : null,
          error: error instanceof Error ? error.message : String(error),
        };
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
    const row = container.createDiv({
      cls: `mindmap-sidebar-card${expanded ? " is-expanded" : ""}`,
      attr: {
        role: "button",
        tabindex: "0",
        "aria-expanded": String(expanded),
        "data-path": candidate.path,
      },
    });

    row.addEventListener("click", () => {
      this.expandedPath = expanded ? null : candidate.path;
      this.render();
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      this.expandedPath = expanded ? null : candidate.path;
      this.render();
    });

    this.renderCandidateLink(row, candidate, "mindmap-sidebar-title");

    if (!expanded) {
      return;
    }

    const detail = row.createDiv({ cls: "mindmap-sidebar-detail" });
    detail.createDiv({
      cls: "mindmap-sidebar-summary",
      text: candidate.summary ?? formatLiveDetail(candidate) ?? "No summary available yet.",
    });
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

  private animateSidebar(container: HTMLElement, previousCardPositions: Map<string, DOMRect>): void {
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

        const fromY = previous.top - current.top;
        if (Math.abs(fromY) > 0.5) {
          animate(row, { y: [fromY, 0] }, { duration: 0.24, ease: "easeOut" });
        }
      });
    }
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
    const liveRelated = this.liveState.path === activeFile.path
      ? this.liveState.response?.related ?? []
      : [];
    if (liveRelated.length > 0) {
      return this.getLiveCandidates(activeFile, liveRelated);
    }
    return persistedCandidates;
  }

  private getLiveCandidates(activeFile: TFile, related: LiveRelatedResult[]): RelatedCandidate[] {
    const activeFrontmatter = this.getFrontmatter(activeFile);
    const activeConcepts = normalizeTextList(activeFrontmatter.concepts);
    const activeTags = normalizeTextList(activeFrontmatter.tags);

    return related.map((item) => {
      const file = this.resolveRelatedFile(item.path, activeFile.path);
      const frontmatter = file === null ? {} : this.getFrontmatter(file);
      const resolvedPath = file?.path ?? item.path;

      return {
        file,
        path: resolvedPath,
        title: item.title ?? file?.basename ?? titleFromPath(item.path),
        folderPath: parentFolderFromPath(resolvedPath) || "Vault root",
        summary: coerceText(frontmatter.summary),
        heatmap: this.getHeatmapCells(activeFile.path, activeConcepts, activeTags, resolvedPath, frontmatter),
        liveScore: item.score,
        liveKind: item.kind,
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
      };
    });
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
