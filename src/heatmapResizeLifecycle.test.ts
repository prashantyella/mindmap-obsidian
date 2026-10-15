import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";

type FrameCallback = (time: number) => void;

class FakeResizeObserver {
  disconnected = false;
  observed: unknown = null;
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: unknown): void { this.observed = target; }
  disconnect(): void { this.disconnected = true; }
  emit(target: unknown, width: number): void {
    this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

class FakeWindow {
  readonly observers: FakeResizeObserver[] = [];
  readonly frames = new Map<number, FrameCallback>();
  readonly cancelled: number[] = [];
  private nextFrame = 1;
  readonly ResizeObserver: typeof ResizeObserver;
  constructor() {
    const observers = this.observers;
    this.ResizeObserver = class extends FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        observers.push(this);
      }
    } as unknown as typeof ResizeObserver;
  }
  requestAnimationFrame(callback: FrameCallback): number {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }
  cancelAnimationFrame(id: number): void { this.cancelled.push(id); }
}

interface ResizeTestView {
  heatmapEl: unknown;
  heatmapSvgEl: unknown;
  heatmapCandidates: Map<string, unknown>;
  renderHeatmap(container: unknown, candidates: unknown[]): void;
  ensureHeatmapResize(svg: unknown): void;
  onClose(): Promise<void>;
}

function createView(): ResizeTestView {
  const filename = path.resolve("src/workspaceView.ts");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const require = createRequire(filename);
  const exports: Record<string, unknown> = {};
  class ItemView {}
  const execute = vm.runInThisContext(`(function(require, exports) { ${output}\n})`) as (
    requireFunction: (id: string) => unknown,
    exportsObject: Record<string, unknown>,
  ) => void;
  execute((id) => id === "obsidian"
    ? { ItemView, Keymap: { isModEvent: () => false }, setIcon: () => undefined }
    : require(id), exports);
  const Constructor = exports.MindmapWorkspaceView as new (leaf: unknown, plugin: unknown) => ResizeTestView;
  return new Constructor({}, {});
}

function fakeSvg(ownerWindow: FakeWindow, width = 200): unknown {
  return {
    ownerDocument: { defaultView: ownerWindow },
    getBoundingClientRect: () => ({ width }),
  };
}

void test("queued graph resize is cancelled on its original window and ignored after close", async () => {
  const view = createView();
  const ownerWindow = new FakeWindow();
  const svg = fakeSvg(ownerWindow);
  let layouts = 0;
  view.heatmapEl = {};
  view.heatmapSvgEl = svg;
  view.heatmapCandidates.set("Related.md", {});
  view.renderHeatmap = () => { layouts += 1; };

  view.ensureHeatmapResize(svg);
  const observer = ownerWindow.observers[0]!;
  observer.emit(svg, 240);
  const [frameId, callback] = [...ownerWindow.frames.entries()][0]!;
  await view.onClose();

  assert.equal(observer.disconnected, true);
  assert.deepEqual(ownerWindow.cancelled, [frameId]);
  callback(0); // A browser should not run a cancelled callback; stale delivery is still harmless.
  observer.emit(svg, 300);
  assert.equal(layouts, 0);
});

void test("moving the graph to another owner window cancels old work and rebinds there", () => {
  const view = createView();
  const firstWindow = new FakeWindow();
  const firstSvg = fakeSvg(firstWindow);
  view.heatmapEl = {};
  view.heatmapSvgEl = firstSvg;
  view.heatmapCandidates.set("Related.md", {});
  view.renderHeatmap = () => undefined;

  view.ensureHeatmapResize(firstSvg);
  const firstObserver = firstWindow.observers[0]!;
  firstObserver.emit(firstSvg, 240);
  const [firstFrameId, staleCallback] = [...firstWindow.frames.entries()][0]!;

  const secondWindow = new FakeWindow();
  const secondSvg = fakeSvg(secondWindow);
  view.heatmapSvgEl = secondSvg;
  view.ensureHeatmapResize(secondSvg);

  assert.equal(firstObserver.disconnected, true);
  assert.deepEqual(firstWindow.cancelled, [firstFrameId]);
  assert.equal(secondWindow.observers.length, 1);
  assert.equal(secondWindow.observers[0]!.observed, secondSvg);
  staleCallback(0);
  assert.equal(secondWindow.observers[0]!.disconnected, false);
});
