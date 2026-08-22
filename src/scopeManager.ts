import { Notice } from "obsidian";

import type MindmapPlugin from "./main";
import { isScopeSetupComplete, type ScopeSelection, type VaultFolderOption } from "./onboarding";

interface FolderNode {
  value: string;
  label: string;
  children: FolderNode[];
}

interface ScopeManagerOptions {
  compact?: boolean;
}

function cloneSelection(selection: ScopeSelection): ScopeSelection {
  return {
    currentPaths: [...selection.currentPaths],
    allPaths: [...selection.allPaths],
  };
}

function normalizeDraft(draft: ScopeSelection): ScopeSelection {
  return {
    currentPaths: [...new Set(draft.currentPaths)].sort(),
    allPaths: [...new Set(draft.allPaths)].sort(),
  };
}

function setMembership(values: string[], value: string, enabled: boolean): string[] {
  if (enabled) {
    return values.includes(value) ? values : [...values, value].sort();
  }
  return values.filter((entry) => entry !== value);
}

function buildFolderTree(options: VaultFolderOption[]): FolderNode[] {
  const nodeByPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  for (const option of options.filter((entry) => entry.value !== ".")) {
    const segments = option.value.split("/");
    let parentPath = "";
    let siblings = roots;

    for (const segment of segments) {
      const currentPath = parentPath ? `${parentPath}/${segment}` : segment;
      let node = nodeByPath.get(currentPath);
      if (!node) {
        node = {
          value: currentPath,
          label: segment,
          children: [],
        };
        nodeByPath.set(currentPath, node);
        siblings.push(node);
        siblings.sort((left, right) => left.label.localeCompare(right.label));
      }
      parentPath = currentPath;
      siblings = node.children;
    }
  }

  return roots;
}

function nodeMatches(node: FolderNode, query: string): boolean {
  if (!query) {
    return true;
  }
  const lower = query.toLowerCase();
  return node.value.toLowerCase().includes(lower) || node.children.some((child) => nodeMatches(child, query));
}

function createChip(container: HTMLElement, path: string, onRemove?: () => void): void {
  const chip = container.createSpan({
    cls: "mindmap-scope-chip",
    text: path === "." ? "Vault root" : path,
  });
  if (!onRemove) {
    return;
  }
  chip.addClass("is-removable");
  const remove = chip.createEl("button", {
    cls: "mindmap-scope-chip-remove",
    text: "×",
    attr: {
      type: "button",
      "aria-label": `Remove ${path === "." ? "Vault root" : path}`,
    },
  });
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    onRemove();
  });
}

export class ScopeManager {
  private draft: ScopeSelection;
  private query = "";
  private expanded = new Set<string>();

  constructor(
    private readonly plugin: MindmapPlugin,
    private readonly containerEl: HTMLElement,
    private readonly options: ScopeManagerOptions = {},
  ) {
    const status = this.plugin.getScopeSetupStatus();
    this.draft = cloneSelection({
      currentPaths: status.currentPaths,
      allPaths: status.allPaths,
    });
  }

  render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("mindmap-scope-manager");
    if (this.options.compact) {
      this.containerEl.addClass("is-compact");
    }

    const status = this.plugin.getScopeSetupStatus();
    if (!status.canManage) {
      this.containerEl.createEl("p", {
        cls: "mindmap-muted",
        text: status.guidance,
      });
      return;
    }

    const draftComplete = isScopeSetupComplete(this.draft);
    this.renderSummary(draftComplete ? null : status.guidance);
    this.renderToolbar();
    this.renderTree();
  }

  /**
   * Guidance is only ever an actionable nudge ("select at least one folder
   * for current and all scopes"). Once the (unsaved-safe) draft selection
   * is complete there is nothing to act on, so no "Scope folders are
   * configured." sentence is rendered at all -- the chips themselves
   * already show what's configured. Using the live draft (rather than the
   * last-saved status) keeps this reactive while the user is still editing,
   * before they click Save.
   */
  private renderSummary(guidance: string | null): void {
    const summary = this.containerEl.createDiv({ cls: "mindmap-scope-summary-grid" });
    this.renderScopeSummary(summary, "Current", "currentPaths", this.draft.currentPaths);
    this.renderScopeSummary(summary, "All", "allPaths", this.draft.allPaths);
    if (guidance) {
      this.containerEl.createDiv({ cls: "mindmap-scope-guidance", text: guidance });
    }
  }

  private renderScopeSummary(container: HTMLElement, label: string, field: keyof ScopeSelection, paths: string[]): void {
    const section = container.createDiv({ cls: "mindmap-scope-summary" });
    section.createDiv({ cls: "mindmap-scope-summary-label", text: label });
    const chips = section.createDiv({ cls: "mindmap-scope-chip-row" });
    if (paths.length === 0) {
      chips.createSpan({ cls: "mindmap-muted", text: "None" });
      return;
    }
    for (const path of paths) {
      createChip(chips, path, () => {
        this.draft = {
          ...this.draft,
          [field]: setMembership(this.draft[field], path, false),
        };
        this.render();
      });
    }
  }

  private renderToolbar(): void {
    const toolbar = this.containerEl.createDiv({ cls: "mindmap-scope-toolbar" });
    const search = toolbar.createEl("input", {
      cls: "mindmap-scope-search",
      attr: {
        type: "search",
        placeholder: "Search folders",
        value: this.query,
      },
    });
    search.addEventListener("input", () => {
      const selectionStart = search.selectionStart;
      const selectionEnd = search.selectionEnd;
      this.query = search.value.trim();
      this.render();
      const nextSearch = this.containerEl.querySelector<HTMLInputElement>(".mindmap-scope-search");
      if (nextSearch === null) {
        return;
      }
      nextSearch.focus();
      if (selectionStart !== null && selectionEnd !== null) {
        nextSearch.setSelectionRange(selectionStart, selectionEnd);
      }
    });

    this.createButton(toolbar, "Top-level", () => {
      const topLevel = this.plugin.getVaultFolderOptions()
        .map((option) => option.value)
        .filter((value) => value !== "." && !value.includes("/"));
      this.draft = {
        currentPaths: [...topLevel],
        allPaths: [...topLevel],
      };
      this.render();
    });

    this.createButton(toolbar, "Clear", () => {
      this.draft = { currentPaths: [], allPaths: [] };
      this.render();
    });

    this.createButton(toolbar, "Reset", () => {
      const status = this.plugin.getScopeSetupStatus();
      this.draft = cloneSelection({
        currentPaths: status.currentPaths,
        allPaths: status.allPaths,
      });
      this.render();
    });

    this.createButton(toolbar, "Save", () => {
      try {
        this.plugin.saveScopeSetup(normalizeDraft(this.draft));
        new Notice("Mindmap scope saved.");
        this.render();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "Failed to save scope.", 12000);
      }
    }, true);
  }

  private renderTree(): void {
    const options = this.plugin.getVaultFolderOptions();
    const rootOption = options.find((option) => option.value === ".");
    const tree = buildFolderTree(options);
    const list = this.containerEl.createDiv({ cls: "mindmap-folder-tree" });

    const header = list.createDiv({ cls: "mindmap-folder-tree-header" });
    header.createSpan({ text: "Folder" });
    header.createSpan({ text: "Current" });
    header.createSpan({ text: "All" });

    if (rootOption && (!this.query || "vault root".includes(this.query.toLowerCase()))) {
      this.renderFolderRow(list, {
        value: ".",
        label: "Vault root",
        children: [],
      }, 0);
    }

    for (const node of tree) {
      this.renderFolderNode(list, node, 0);
    }
  }

  private renderFolderNode(container: HTMLElement, node: FolderNode, depth: number): void {
    if (!nodeMatches(node, this.query)) {
      return;
    }

    this.renderFolderRow(container, node, depth);

    const expanded = this.expanded.has(node.value) || Boolean(this.query);
    if (!expanded) {
      return;
    }

    for (const child of node.children) {
      this.renderFolderNode(container, child, depth + 1);
    }
  }

  private renderFolderRow(container: HTMLElement, node: FolderNode, depth: number): void {
    const row = container.createDiv({ cls: "mindmap-folder-row" });
    row.style.setProperty("--mindmap-folder-depth", String(depth));

    const label = row.createDiv({ cls: "mindmap-folder-label" });
    if (node.children.length > 0) {
      const toggle = label.createEl("button", {
        cls: "mindmap-folder-expand",
        text: this.expanded.has(node.value) || this.query ? "▾" : "▸",
        attr: { type: "button", "aria-label": `Toggle ${node.value}` },
      });
      toggle.addEventListener("click", () => {
        if (this.expanded.has(node.value)) {
          this.expanded.delete(node.value);
        } else {
          this.expanded.add(node.value);
        }
        this.render();
      });
    } else {
      label.createSpan({ cls: "mindmap-folder-spacer" });
    }

    label.createSpan({ text: node.label });
    if (node.value !== "." && node.value.includes("/")) {
      label.createSpan({ cls: "mindmap-folder-path", text: node.value });
    }

    this.renderCheckbox(row, "currentPaths", node.value);
    this.renderCheckbox(row, "allPaths", node.value);
  }

  private renderCheckbox(container: HTMLElement, field: keyof ScopeSelection, value: string): void {
    const wrap = container.createDiv({ cls: "mindmap-folder-checkbox" });
    const checkbox = wrap.createEl("input", {
      attr: {
        type: "checkbox",
        "aria-label": `${field === "currentPaths" ? "Current" : "All"} scope ${value}`,
      },
    });
    checkbox.checked = this.draft[field].includes(value);
    checkbox.addEventListener("change", () => {
      this.draft = {
        ...this.draft,
        [field]: setMembership(this.draft[field], value, checkbox.checked),
      };
      this.render();
    });
  }

  private createButton(container: HTMLElement, label: string, onClick: () => void, cta = false): HTMLButtonElement {
    const button = container.createEl("button", {
      cls: cta ? "mod-cta" : "",
      text: label,
      attr: { type: "button" },
    });
    button.addEventListener("click", onClick);
    return button;
  }
}
