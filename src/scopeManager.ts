import { Notice } from "obsidian";

import type MindmapPlugin from "./main";
import { isScopeSetupComplete, type ScopeSelection, type VaultFolderOption } from "./onboarding";
import type { ScopeEditorState } from "./settingsViewState";

interface FolderNode { value: string; label: string; children: FolderNode[] }
interface ScopeManagerOptions { compact?: boolean; state?: ScopeEditorState }

function cloneSelection(selection: ScopeSelection): ScopeSelection {
  return { currentPaths: [...selection.currentPaths], allPaths: [...selection.allPaths] };
}
function normalizeDraft(draft: ScopeSelection): ScopeSelection {
  return { currentPaths: [...new Set(draft.currentPaths)].sort(), allPaths: [...new Set(draft.allPaths)].sort() };
}
function setMembership(values: string[], value: string, enabled: boolean): string[] {
  if (enabled) return values.includes(value) ? values : [...values, value].sort();
  return values.filter((entry) => entry !== value);
}
function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function buildFolderTree(options: VaultFolderOption[]): FolderNode[] {
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  for (const option of options.filter((entry) => entry.value !== ".")) {
    let parentPath = "";
    let siblings = roots;
    for (const segment of option.value.split("/")) {
      const value = parentPath ? `${parentPath}/${segment}` : segment;
      let node = byPath.get(value);
      if (!node) {
        node = { value, label: segment, children: [] };
        byPath.set(value, node);
        siblings.push(node);
        siblings.sort((left, right) => left.label.localeCompare(right.label));
      }
      parentPath = value;
      siblings = node.children;
    }
  }
  return roots;
}
function nodeMatches(node: FolderNode, query: string): boolean {
  const lower = query.toLowerCase();
  return !lower || node.value.toLowerCase().includes(lower) || node.children.some((child) => nodeMatches(child, query));
}

export class ScopeManager {
  private readonly state: ScopeEditorState;
  private summaryEl: HTMLElement | null = null;
  private treeEl: HTMLElement | null = null;

  constructor(private readonly plugin: MindmapPlugin, private readonly containerEl: HTMLElement, private readonly options: ScopeManagerOptions = {}) {
    const status = this.plugin.getScopeSetupStatus();
    this.state = options.state ?? {
      draft: cloneSelection(status), query: "", expanded: new Set<string>(),
      separateQuickRun: !samePaths(status.currentPaths, status.allPaths), dirty: false,
    };
  }

  render(): void {
    this.containerEl.empty();
    this.containerEl.addClass("mindmap-scope-manager");
    if (this.options.compact) this.containerEl.addClass("is-compact");
    this.summaryEl = this.containerEl.createDiv({ cls: "mindmap-scope-summary" });
    this.renderSummary();

    const separate = this.containerEl.createEl("label", { cls: "mindmap-scope-separate" });
    const separateInput = separate.createEl("input", { attr: { type: "checkbox" } });
    separateInput.checked = this.state.separateQuickRun;
    separate.appendText(" Separate quick-run folders");
    separate.createSpan({ cls: "mindmap-muted", text: "Use a different folder list for current-note and quick runs." });
    separateInput.addEventListener("change", () => {
      this.state.separateQuickRun = separateInput.checked;
      if (!separateInput.checked) this.state.draft.currentPaths = [...this.state.draft.allPaths];
      this.state.dirty = true;
      this.renderSummary();
      this.renderTree();
    });

    const toolbar = this.containerEl.createDiv({ cls: "mindmap-scope-toolbar" });
    const search = toolbar.createEl("input", { cls: "mindmap-scope-search", attr: { type: "search", placeholder: "Search folders", value: this.state.query, "aria-label": "Search folders" } });
    search.addEventListener("input", () => { this.state.query = search.value; this.renderTree(); });

    const actions = toolbar.createEl("details", { cls: "mindmap-folder-actions" });
    actions.createEl("summary", { text: "Folder actions" });
    const actionButtons = actions.createDiv({ cls: "mindmap-folder-actions-menu" });
    this.createButton(actionButtons, "Select top-level", () => {
      const topLevel = this.plugin.getVaultFolderOptions().map((option) => option.value).filter((value) => value !== "." && !value.includes("/"));
      this.state.draft.allPaths = [...topLevel];
      if (!this.state.separateQuickRun) this.state.draft.currentPaths = [...topLevel];
      this.state.dirty = true;
      this.renderSummary(); this.renderTree();
    });
    this.createButton(actionButtons, "Clear", () => {
      this.state.draft = { currentPaths: [], allPaths: [] };
      this.state.dirty = true;
      this.renderSummary(); this.renderTree();
    });
    this.createButton(toolbar, "Reset", () => {
      const status = this.plugin.getScopeSetupStatus();
      this.state.draft = cloneSelection(status);
      this.state.separateQuickRun = !samePaths(status.currentPaths, status.allPaths);
      separateInput.checked = this.state.separateQuickRun;
      this.state.dirty = false;
      this.renderSummary(); this.renderTree();
    });
    this.createButton(toolbar, "Save folders", () => { void this.save(); }, true);
    this.treeEl = this.containerEl.createDiv({ cls: "mindmap-folder-tree" });
    this.renderTree();
  }

  private async save(): Promise<void> {
    try {
      const draft = normalizeDraft(this.state.draft);
      await this.plugin.saveScopeSetup(draft);
      this.state.draft = cloneSelection(draft);
      this.state.dirty = false;
      new Notice("Included folders saved.");
      this.renderSummary();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Included folders could not be saved.", 12000);
    }
  }

  private renderSummary(): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    if (!isScopeSetupComplete(this.state.draft)) this.summaryEl.createDiv({ cls: "mindmap-scope-guidance", text: "Select at least one included folder." });
    this.renderPaths(this.summaryEl, "Included folders", this.state.draft.allPaths);
    if (this.state.separateQuickRun) this.renderPaths(this.summaryEl, "Quick-run folders", this.state.draft.currentPaths);
  }
  private renderPaths(container: HTMLElement, label: string, paths: string[]): void {
    const row = container.createDiv({ cls: "mindmap-scope-summary-row" });
    row.createSpan({ cls: "mindmap-scope-summary-label", text: label });
    row.createSpan({ text: paths.length ? paths.map((path) => path === "." ? "Vault root" : path).join(", ") : "None selected" });
  }

  private renderTree(): void {
    if (!this.treeEl) return;
    this.treeEl.empty();
    const options = this.plugin.getVaultFolderOptions();
    const header = this.treeEl.createDiv({ cls: `mindmap-folder-tree-header${this.state.separateQuickRun ? " is-separated" : ""}` });
    header.createSpan({ text: "Folder" });
    if (this.state.separateQuickRun) header.createSpan({ text: "Quick run" });
    header.createSpan({ text: "Included" });
    if (options.some((option) => option.value === ".") && (!this.state.query || "vault root".includes(this.state.query.toLowerCase()))) {
      this.renderFolderRow({ value: ".", label: "Vault root", children: [] }, 0);
    }
    for (const node of buildFolderTree(options)) this.renderFolderNode(node, 0);
  }
  private renderFolderNode(node: FolderNode, depth: number): void {
    if (!nodeMatches(node, this.state.query)) return;
    this.renderFolderRow(node, depth);
    if (!(this.state.expanded.has(node.value) || Boolean(this.state.query))) return;
    for (const child of node.children) this.renderFolderNode(child, depth + 1);
  }
  private renderFolderRow(node: FolderNode, depth: number): void {
    if (!this.treeEl) return;
    const row = this.treeEl.createDiv({ cls: `mindmap-folder-row${this.state.separateQuickRun ? " is-separated" : ""}` });
    row.style.setProperty("--mindmap-folder-depth", String(depth));
    const label = row.createDiv({ cls: "mindmap-folder-label" });
    if (node.children.length) {
      const expanded = this.state.expanded.has(node.value) || Boolean(this.state.query);
      const toggle = label.createEl("button", { cls: "mindmap-folder-expand", text: expanded ? "▾" : "▸", attr: { type: "button", "aria-label": `Toggle ${node.value}` } });
      toggle.addEventListener("click", () => {
        if (this.state.expanded.has(node.value)) this.state.expanded.delete(node.value); else this.state.expanded.add(node.value);
        this.renderTree();
      });
    } else label.createSpan({ cls: "mindmap-folder-spacer" });
    label.createSpan({ text: node.label });
    if (this.state.separateQuickRun) this.renderCheckbox(row, "currentPaths", node.value, "Quick run");
    this.renderCheckbox(row, "allPaths", node.value, "Included");
  }
  private renderCheckbox(container: HTMLElement, field: keyof ScopeSelection, value: string, label: string): void {
    const wrap = container.createDiv({ cls: "mindmap-folder-checkbox" });
    const checkbox = wrap.createEl("input", { attr: { type: "checkbox", "aria-label": `${label}: ${value}` } });
    checkbox.checked = this.state.draft[field].includes(value);
    checkbox.addEventListener("change", () => {
      this.state.draft[field] = setMembership(this.state.draft[field], value, checkbox.checked);
      if (field === "allPaths" && !this.state.separateQuickRun) this.state.draft.currentPaths = [...this.state.draft.allPaths];
      this.state.dirty = true;
      this.renderSummary();
    });
  }
  private createButton(container: HTMLElement, label: string, onClick: () => void, cta = false): HTMLButtonElement {
    const button = container.createEl("button", { cls: cta ? "mod-cta" : "", text: label, attr: { type: "button" } });
    button.addEventListener("click", onClick);
    return button;
  }
}
