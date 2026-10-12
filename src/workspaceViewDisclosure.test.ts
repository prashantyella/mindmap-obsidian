import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

type Handler = (event: FakeEvent) => void;
type Options = { cls?: string; attr?: Record<string, string>; text?: string };

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  constructor(readonly target: FakeElement, readonly altKey = false) {}
  preventDefault(): void { this.defaultPrevented = true; }
  stopPropagation(): void { this.propagationStopped = true; }
}

class FakeDocument { activeElement: FakeElement | null = null; defaultView = null; }

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  dataset: Record<string, string> = {};
  textContent = "";
  hidden = false;
  focused = false;
  readonly ownerDocument: FakeDocument;
  private readonly classes = new Set<string>();
  private readonly handlers = new Map<string, Handler[]>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tag = "div", options?: Options, document = new FakeDocument()) {
    this.ownerDocument = document;
    for (const token of options?.cls?.split(" ") ?? []) this.classes.add(token);
    for (const [key, value] of Object.entries(options?.attr ?? {})) this.setAttribute(key, value);
    this.textContent = options?.text ?? "";
  }
  private attach<T extends FakeElement>(child: T): T { child.parent = this; this.children.push(child); return child; }
  createDiv(options?: Options): FakeElement { return this.attach(new FakeElement("div", options, this.ownerDocument)); }
  createSpan(options?: Options): FakeElement { return this.attach(new FakeElement("span", options, this.ownerDocument)); }
  createEl(tag: string, options?: Options): FakeElement {
    if (tag === "button") return this.attach(new FakeButton(options, this.ownerDocument));
    if (tag === "a") return this.attach(new FakeAnchor(options, this.ownerDocument));
    return this.attach(new FakeElement(tag, options, this.ownerDocument));
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
  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    return selector === ":scope > [data-path]" ? this.children.filter((child) => child.dataset.path) as T[] : [];
  }
  addEventListener(type: string, handler: Handler): void { this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]); }
  emit(type: string, event: FakeEvent): void { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  toggleClass(name: string, active: boolean): void { if (active) this.classes.add(name); else this.classes.delete(name); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === "data-path") this.dataset.path = value; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  empty(): void { for (const child of this.children) child.parent = null; this.children = []; }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  contains(element: FakeElement): boolean { return element === this || this.children.some((child) => child.contains(element)); }
  matches(): boolean { return false; }
  closest<T extends FakeElement>(selector: string): T | null { return selector === "[data-path]" && this.dataset.path ? this as unknown as T : this.parent?.closest<T>(selector) ?? null; }
  focus(): void { this.focused = true; this.ownerDocument.activeElement = this; }
  get isConnected(): boolean { return this.parent !== null; }
}

class FakeButton extends FakeElement { constructor(options?: Options, document?: FakeDocument) { super("button", options, document); } }
class FakeAnchor extends FakeElement { href = ""; constructor(options?: Options, document?: FakeDocument) { super("a", options, document); } }

interface TestCandidate {
  file: { path: string };
  path: string;
  title: string;
  folderPath: string;
  summary: string;
  heatmap: [];
  liveScore?: number;
  pinned?: boolean;
}

interface TestView {
  app: unknown;
  activePath: string | null;
  feedbackEl: FakeElement;
  resultsEl: FakeElement;
  heatmapRegionEl: FakeElement;
  retainedListEl: FakeElement;
  loadingController: null;
  ensureShell(): FakeElement;
  ensureLiveQuery(): void;
  getRelatedCandidates(): TestCandidate[];
  getDisplayCandidates(): TestCandidate[];
  renderLiveStatus(): void;
  renderHeatmap(): void;
  stabilizeCandidates(candidates: TestCandidate[]): TestCandidate[];
  reconcileRowOrder(): void;
  render(background?: boolean): void;
  selectCandidateFromGraph(path: string): void;
  getState(): { collapsedByNote: Record<string, string[]> };
}

function candidate(pathValue: string): TestCandidate {
  return { file: { path: pathValue }, path: pathValue, title: pathValue, folderPath: "", summary: `Summary for ${pathValue}`, heatmap: [], liveScore: pathValue === "One.md" ? 1 : undefined, pinned: pathValue === "One.md" };
}

function createView(): { view: TestView; list: FakeElement; setActive: (path: string | null) => void; opens: () => number; pins: () => number } {
  const filename = path.resolve("src/workspaceView.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const require = createRequire(filename);
  const exports: Record<string, unknown> = {};
  class ItemView {}
  const execute = vm.runInThisContext(`(function(require, exports) { ${output}\n})`) as (require: (id: string) => unknown, exports: Record<string, unknown>) => void;
  execute((id) => id === "obsidian" ? { ItemView, Keymap: { isModEvent: () => false }, setIcon: () => undefined } : require(id), exports);
  let activePath: string | null = "Active.md";
  let openCount = 0;
  let pinCount = 0;
  const candidates = [candidate("One.md"), candidate("Two.md")];
  const Constructor = exports.MindmapWorkspaceView as new (leaf: unknown, plugin: unknown) => TestView;
  const view = new Constructor({}, { settings: { liveSemanticLookupEnabled: false }, togglePinnedConnection: async () => { pinCount++; } });
  const content = new FakeElement();
  const feedback = content.createDiv();
  const heatmap = content.createDiv();
  const list = content.createDiv();
  view.app = { workspace: {
    getActiveFile: () => activePath === null ? null : { path: activePath },
    openLinkText: () => { openCount++; },
    trigger: () => undefined,
  } };
  view.activePath = null;
  view.feedbackEl = feedback;
  view.resultsEl = content;
  view.heatmapRegionEl = heatmap;
  view.retainedListEl = list;
  view.loadingController = null;
  view.ensureShell = () => content;
  view.ensureLiveQuery = () => undefined;
  view.getRelatedCandidates = () => candidates;
  view.getDisplayCandidates = () => candidates;
  view.renderLiveStatus = () => undefined;
  view.renderHeatmap = () => undefined;
  view.stabilizeCandidates = (items) => items;
  view.reconcileRowOrder = () => undefined;
  return { view, list, setActive: (next) => { activePath = next; }, opens: () => openCount, pins: () => pinCount };
}

function bubbleClick(control: FakeElement, row: FakeElement, altKey = false): FakeEvent {
  const event = new FakeEvent(control, altKey);
  control.emit("click", event);
  if (!event.propagationStopped) row.emit("click", event);
  return event;
}

function detail(row: FakeElement): FakeElement | null { return row.querySelector(".mindmap-sidebar-detail"); }

void test("actual render keeps independent disclosures, controls, and per-note choices stable", async () => {
  const globals = { HTMLElement: FakeElement, HTMLButtonElement: FakeButton, HTMLAnchorElement: FakeAnchor } as const;
  const previous = Object.entries(globals).map(([name]) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true });
  try {
    const { view, list, setActive, opens, pins } = createView();
    view.render();
    const one = list.querySelector<FakeElement>('[data-path="One.md"]')!;
    const two = list.querySelector<FakeElement>('[data-path="Two.md"]')!;
    const oneButton = one.querySelector<FakeButton>(".mindmap-sidebar-collapse")!;
    assert.ok(detail(one));
    assert.ok(detail(two));
    assert.equal(one.getAttribute("role"), "group");
    assert.equal(oneButton.tag, "button");
    assert.equal(oneButton.getAttribute("type"), "button");
    assert.equal(oneButton.getAttribute("aria-expanded"), "true");
    const meta = one.querySelector<FakeElement>(".mindmap-sidebar-meta")!;
    assert.deepEqual(meta.children.map((child) => child.tag), ["button", "span", "button"]);
    assert.equal(meta.querySelector<FakeElement>(".mindmap-sidebar-score")!.textContent, "100%");

    const collapseClick = bubbleClick(oneButton, one);
    assert.equal(collapseClick.defaultPrevented, true);
    assert.equal(collapseClick.propagationStopped, true);
    assert.equal(detail(one), null);
    assert.ok(detail(two));
    assert.equal(list.querySelector('[data-path="One.md"]'), one);
    assert.equal(one.querySelector(".mindmap-sidebar-collapse"), oneButton);
    view.render(true);
    assert.equal(detail(one), null);
    assert.ok(detail(two));

    const title = one.querySelector<FakeAnchor>(".mindmap-sidebar-title")!;
    bubbleClick(title, one);
    assert.equal(opens(), 1);
    assert.equal(detail(one), null);
    const pin = one.querySelector<FakeButton>(".mindmap-sidebar-pin")!;
    bubbleClick(pin, one);
    await Promise.resolve();
    assert.equal(pins(), 1);
    assert.equal(detail(one), null);

    setActive("Other.md");
    view.render();
    assert.ok(detail(one));
    assert.ok(detail(two));
    bubbleClick(oneButton, one, true);
    assert.equal(detail(one), null);
    assert.equal(detail(two), null);
    bubbleClick(oneButton, one, true);
    assert.ok(detail(one));
    assert.ok(detail(two));

    setActive("Active.md");
    view.render();
    assert.equal(detail(one), null);
    assert.ok(detail(two));
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

void test("graph selection focuses the matching retained result without changing disclosure state", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "HTMLElement", { value: FakeElement, configurable: true });
  try {
    const { view, list } = createView();
    view.render();
    const row = list.querySelector<FakeElement>('[data-path="Two.md"]')!;
    view.selectCandidateFromGraph("Two.md");
    assert.equal(row.focused, true);
    assert.deepEqual(view.getState().collapsedByNote, {});
  } finally {
    if (previous) Object.defineProperty(globalThis, "HTMLElement", previous);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});

void test("connection graph is rendered directly without a disclosure title", () => {
  const source = fs.readFileSync("src/workspaceView.ts", "utf8");
  const styles = fs.readFileSync("styles.css", "utf8");
  assert.doesNotMatch(source, /createEl\("details"|createEl\("summary"|Connection graph/);
  assert.match(source, /this\.renderHeatmap\(this\.heatmapRegionEl \?\? shell, candidates\)/);
  const pinRule = styles.slice(styles.lastIndexOf(".mindmap-sidebar-pin {"), styles.indexOf("}", styles.lastIndexOf(".mindmap-sidebar-pin {")) + 1);
  assert.doesNotMatch(pinRule, /position:\s*absolute|right:/);
});
