import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

type Handler = (event: FakeEvent) => void;

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  constructor(readonly target: FakeElement, readonly altKey = false) {}
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class FakeElement {
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  textContent = "";
  hidden = false;
  focused = false;
  private readonly classes = new Set<string>();
  private readonly handlers = new Map<string, Handler[]>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tag = "div", options?: { cls?: string; attr?: Record<string, string>; text?: string }) {
    for (const token of options?.cls?.split(" ") ?? []) this.classes.add(token);
    for (const [key, value] of Object.entries(options?.attr ?? {})) this.setAttribute(key, value);
    this.textContent = options?.text ?? "";
  }

  createDiv(options?: { cls?: string; attr?: Record<string, string>; text?: string }): FakeElement {
    const child = new FakeElement("div", options); this.children.push(child); return child;
  }
  createSpan(options?: { cls?: string; attr?: Record<string, string>; text?: string }): FakeElement {
    const child = new FakeElement("span", options); this.children.push(child); return child;
  }
  createEl(tag: string, options?: { cls?: string; attr?: Record<string, string>; text?: string }): FakeElement {
    const child = new FakeElement(tag, options); this.children.push(child); return child;
  }
  querySelector<T extends FakeElement>(selector: string): T | null {
    const classMatch = /^\.([\w-]+)$/.exec(selector);
    const tagMatch = /^[a-z]+$/.test(selector) ? selector : null;
    const pathMatch = /\[data-path="(.*)"\]/.exec(selector);
    const matches = (node: FakeElement): boolean => classMatch ? node.classes.has(classMatch[1]) : pathMatch ? node.dataset.path === pathMatch[1] : tagMatch ? node.tag === tagMatch : false;
    const visit = (nodes: FakeElement[]): FakeElement | null => {
      for (const node of nodes) { if (matches(node)) return node; const nested = visit(node.children); if (nested) return nested; }
      return null;
    };
    return visit(this.children) as T | null;
  }
  addEventListener(type: string, handler: Handler): void {
    this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]);
  }
  emit(type: string, event: FakeEvent): void { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  toggleClass(name: string, active: boolean): void { if (active) this.classes.add(name); else this.classes.delete(name); }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "data-path") this.dataset.path = value;
  }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  empty(): void { this.children = []; }
  remove(): void {}
  focus(): void { this.focused = true; }
}

interface TestCandidate {
  file: null;
  path: string;
  title: string;
  folderPath: string;
  summary: string;
  heatmap: [];
}

interface TestView {
  app: unknown;
  activePath: string;
  resultsEl: FakeElement;
  render(): void;
  renderCandidate(container: FakeElement, candidate: TestCandidate, expanded: boolean): void;
  selectCandidateFromGraph(path: string): void;
  getState(): { collapsedByNote: Record<string, string[]> };
}

function createView(): { view: TestView; container: FakeElement; opens: () => number } {
  const filename = path.resolve("src/workspaceView.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const require = createRequire(filename);
  const exports: Record<string, unknown> = {};
  class ItemView {}
  const execute = vm.runInThisContext(`(function(require, exports) { ${output}\n})`) as (require: (id: string) => unknown, exports: Record<string, unknown>) => void;
  execute((id) => id === "obsidian" ? { ItemView, Keymap: { isModEvent: () => false }, setIcon: () => undefined } : require(id), exports);
  let openCount = 0;
  const Constructor = exports.MindmapWorkspaceView as new (leaf: unknown, plugin: unknown) => TestView;
  const view = new Constructor({}, { togglePinnedConnection: async () => undefined });
  view.app = { workspace: { getActiveFile: () => ({ path: "Active.md" }), openLinkText: () => { openCount++; }, trigger: () => undefined } };
  view.activePath = "Active.md";
  view.render = () => undefined;
  return { view, container: new FakeElement(), opens: () => openCount };
}

function candidate(pathValue: string): TestCandidate {
  return { file: null, path: pathValue, title: pathValue, folderPath: "", summary: `Summary for ${pathValue}`, heatmap: [] };
}

void test("rendered disclosure buttons default open, toggle independently, and stop card/link actions", () => {
  const globals = ["HTMLElement", "HTMLButtonElement", "HTMLAnchorElement"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  for (const name of globals) Object.defineProperty(globalThis, name, { value: FakeElement, configurable: true });
  try {
    const { view, container, opens } = createView();
    view.renderCandidate(container, candidate("One.md"), true);
    view.renderCandidate(container, candidate("Two.md"), true);
    const one = container.querySelector<FakeElement>('[data-path="One.md"]')!;
    const two = container.querySelector<FakeElement>('[data-path="Two.md"]')!;
    assert.ok(one.querySelector(".mindmap-sidebar-detail"));
    assert.ok(two.querySelector(".mindmap-sidebar-detail"));

    const button = one.querySelector<FakeElement>(".mindmap-sidebar-collapse")!;
    assert.equal(button.tag, "button");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const click = new FakeEvent(button);
    button.emit("click", click);
    assert.equal(click.defaultPrevented, true);
    assert.equal(click.propagationStopped, true);
    assert.equal(opens(), 0);
    assert.deepEqual(view.getState().collapsedByNote["Active.md"], ["One.md"]);
  } finally {
    globals.forEach((name, index) => previous[index] ? Object.defineProperty(globalThis, name, previous[index]!) : Reflect.deleteProperty(globalThis, name));
  }
});

void test("graph selection focuses the matching retained result without changing disclosure state", () => {
  const { view, container } = createView();
  const row = container.createDiv({ attr: { "data-path": "Two.md" } });
  view.resultsEl = container;
  view.selectCandidateFromGraph("Two.md");
  assert.equal(row.focused, true);
  assert.deepEqual(view.getState().collapsedByNote, {});
});

void test("Alt-clicking a rendered disclosure button collapses then expands all cards", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { value: FakeElement, configurable: true });
  try {
    const { view, container } = createView();
    view.renderCandidate(container, candidate("One.md"), true);
    view.renderCandidate(container, candidate("Two.md"), true);
    const button = container.querySelector<FakeElement>('[data-path="One.md"]')!.querySelector<FakeElement>(".mindmap-sidebar-collapse")!;
    button.emit("click", new FakeEvent(button, true));
    assert.deepEqual(view.getState().collapsedByNote["Active.md"], ["One.md", "Two.md"]);
    button.emit("click", new FakeEvent(button, true));
    assert.deepEqual(view.getState().collapsedByNote["Active.md"], []);
  } finally {
    if (previous) Object.defineProperty(globalThis, "HTMLElement", previous);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});

void test("connection graph is rendered directly without a disclosure title", () => {
  const source = fs.readFileSync("src/workspaceView.ts", "utf8");
  assert.doesNotMatch(source, /createEl\("details"|createEl\("summary"|Connection graph/);
  assert.match(source, /this\.renderHeatmap\(this\.heatmapRegionEl \?\? shell, candidates\)/);
});
