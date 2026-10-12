import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import { createErrorLiveState, createReadyLiveState, type SidebarLiveState } from "./workspaceViewState";
import { SidebarRefreshController } from "./sidebarRefreshController";
import type { LiveRelatedResponse } from "./semanticTypes";

/** Execute the real renderer without loading Obsidian or changing a vault. */
class Element {
  hidden = false;
  writes = 0;
  textContent = "";
  children: Element[] = [];
  ownerDocument = { activeElement: null, defaultView: null };
  contains(): boolean { return false; }
  matches(): boolean { return false; }
  empty(): void { this.writes++; this.children = []; }
  createDiv(): Element { this.writes++; const el = new Element(); this.children.push(el); return el; }
  createEl(_tag: string, options: { text: string }): Element {
    this.writes++; const el = new Element(); el.textContent = options.text; this.children.push(el); return el;
  }
  text(): string { return [this.textContent, ...this.children.map((child) => child.text())].join(" ").trim(); }
}

interface View {
  app: unknown;
  activePath: string;
  liveState: SidebarLiveState;
  refreshController: SidebarRefreshController;
  feedbackEl: Element;
  resultsEl: Element;
  heatmapRegionEl: Element;
  retainedListEl: Element;
  ensureShell(): Element;
  getRelatedCandidates(): never[];
  getDisplayCandidates(): never[];
  render(background?: boolean): void;
  refreshIndexQueries(): void;
  refreshActiveNoteQuery(): void;
}

function fixture(): { view: View; feedback: Element; resolve: (value: LiveRelatedResponse) => void; calls: () => number } {
  const filename = path.resolve("src/workspaceView.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const require = createRequire(filename);
  const exports: Record<string, unknown> = {};
  class ItemView {}
  const execute = vm.runInThisContext(`(function(require, exports) { ${output}\n})`) as (require: (id: string) => unknown, exports: Record<string, unknown>) => void;
  execute((id) => id === "obsidian" ? { ItemView } : require(id), exports);
  let resolve!: (value: LiveRelatedResponse) => void;
  let calls = 0;
  const plugin = { settings: { liveSemanticLookupEnabled: true }, queryLiveRelated: () => {
    calls++;
    return new Promise<LiveRelatedResponse>((finish) => { resolve = finish; });
  } };
  const Constructor = exports.MindmapWorkspaceView as new (leaf: unknown, plugin: unknown) => View;
  const view = new Constructor({}, plugin);
  const feedback = new Element();
  const content = new Element();
  view.app = { workspace: { getActiveFile: () => ({ path: "Draft.md" }) } };
  view.activePath = "Draft.md";
  view.resultsEl = content;
  view.feedbackEl = feedback;
  view.heatmapRegionEl = new Element();
  view.retainedListEl = new Element();
  view.ensureShell = () => content;
  view.getRelatedCandidates = () => [];
  view.getDisplayCandidates = () => [];
  return { view, feedback, resolve: (value) => resolve(value), calls: () => calls };
}

function result(indexed: boolean): LiveRelatedResponse {
  return { path: "Draft.md", hash: "h", indexed, stale: !indexed, index_result: null, related: [] };
}

void test("actual renderer performs no empty/loading flashes or DOM clears for an unindexed draft", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { value: Element, configurable: true });
  try {
    const { view, feedback, resolve, calls } = fixture();
    view.liveState = createReadyLiveState("Draft.md", result(false));
    view.render();
    const writes = feedback.writes;
    for (let i = 0; i < 5; i++) {
      view.refreshIndexQueries();
      assert.equal(feedback.text(), "");
      resolve(result(false));
      await Promise.resolve();
      assert.equal(feedback.text(), "");
      assert.equal(feedback.writes, writes);
    }
    assert.equal(calls(), 5);
    view.refreshController.close();
  } finally {
    if (previous) Object.defineProperty(globalThis, "HTMLElement", previous);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});

void test("actual renderer retains a confirmed empty heading during revalidation and does not render while typing", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { value: Element, configurable: true });
  try {
    const { view, feedback, resolve, calls } = fixture();
    view.liveState = createReadyLiveState("Draft.md", result(true));
    view.render();
    const original = feedback.text();
    const writes = feedback.writes;
    assert.match(original, /No mindmap connections/);
    view.refreshIndexQueries();
    assert.equal(feedback.text(), original);
    resolve(result(true));
    await Promise.resolve();
    assert.equal(feedback.writes, writes);
    view.refreshController.recordTyping();
    view.refreshActiveNoteQuery();
    view.render(true);
    assert.equal(calls(), 1);
    assert.equal(feedback.writes, writes);
    assert.equal(feedback.text(), original);
    view.refreshController.close();
    const retry = fixture();
    retry.view.liveState = createErrorLiveState("Draft.md", createReadyLiveState("Draft.md", result(true)), new Error("Provider unavailable"));
    retry.view.render();
    const errorText = retry.feedback.text();
    assert.match(errorText, /Connections unavailable/);
    retry.view.refreshIndexQueries();
    assert.equal(retry.feedback.text(), errorText, "background retries must not flash empty feedback before returning to an error");
    retry.resolve(result(true));
    await Promise.resolve();
    assert.match(retry.feedback.text(), /No mindmap connections/);
    retry.view.refreshController.close();
  } finally {
    if (previous) Object.defineProperty(globalThis, "HTMLElement", previous);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
