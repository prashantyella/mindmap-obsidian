import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { clampHeatmapTooltip, createHeatmapGeometry, HEATMAP_HEIGHT } from "./heatmapGeometry";
import { RetainedSvgNodes } from "./retainedSvgNodes";

void test("heatmap geometry fills each measured width without stretching its coordinate system", () => {
  for (const width of [96, 240, 417.5, 720]) {
    const chart = createHeatmapGeometry(width, 4);
    assert.equal(chart.width, width);
    assert.equal(chart.height, HEATMAP_HEIGHT);
    assert.equal(chart.xFor(0), chart.left);
    assert.equal(chart.xFor(3), width - chart.right);
    assert.equal(chart.yFor(4), chart.top);
    assert.equal(chart.yFor(0), HEATMAP_HEIGHT - chart.bottom);

    const hits = [0, 1, 2, 3].map((index) => chart.hitBounds(index));
    assert.equal(hits[0]?.x, chart.left);
    const lastHit = hits[hits.length - 1]!;
    assert.equal(lastHit.x + lastHit.width, width - chart.right);
    for (let index = 1; index < hits.length; index += 1) {
      assert.equal(hits[index - 1]!.x + hits[index - 1]!.width, hits[index]!.x);
    }
  }
});

class FakeSvgNode {
  readonly attributes = new Map<string, string>();
  removed = false;
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  remove(): void { this.removed = true; }
}

void test("resizing updates retained marker geometry without replacing marker nodes", () => {
  const retained = new RetainedSvgNodes<FakeSvgNode>();
  const children: FakeSvgNode[] = [];
  const host = {
    first: () => children[0] ?? null,
    next: (node: FakeSvgNode) => children[children.indexOf(node) + 1] ?? null,
    find: () => null,
    insertBefore: (node: FakeSvgNode, before: FakeSvgNode | null) => {
      children.splice(children.indexOf(node), 1);
      children.splice(before ? children.indexOf(before) : children.length, 0, node);
    },
  };
  const renderAt = (width: number): FakeSvgNode => {
    const chart = createHeatmapGeometry(width, 3);
    retained.begin();
    const result = retained.get("point:middle:links", () => {
      const node = new FakeSvgNode();
      children.push(node);
      return node;
    }, { cx: String(chart.xFor(1)), cy: String(chart.yFor(2)), r: "2" });
    retained.finish(host);
    return result.node;
  };

  const narrow = renderAt(180);
  assert.equal(narrow.getAttribute("cx"), "90");
  const wide = renderAt(540);
  assert.equal(wide, narrow);
  assert.equal(wide.getAttribute("cx"), "270");
  assert.equal(wide.getAttribute("r"), "2");
});

void test("workspace resize path is isolated from full renders and disconnects its observer", () => {
  const source = fs.readFileSync("src/workspaceView.ts", "utf8");
  const resizeStart = source.indexOf("  private ensureHeatmapResize");
  const resizeEnd = source.indexOf("  private selectCandidateFromGraph", resizeStart);
  const resizeSource = source.slice(resizeStart, resizeEnd);
  assert.match(resizeSource, /this\.renderHeatmap\(/);
  assert.doesNotMatch(resizeSource, /this\.render\(/);
  assert.doesNotMatch(resizeSource, /queryLiveRelated|queryLookupRelated/);
  assert.match(resizeSource, /\.disconnect\(\)/);
  assert.match(source, /this\.disconnectHeatmapResize\(\);/);
});

void test("heatmap geometry remains finite for hidden and extremely narrow containers", () => {
  for (const width of [0, -20, Number.NaN, 2]) {
    const chart = createHeatmapGeometry(width, 1);
    for (const value of [chart.width, chart.plotWidth, chart.xFor(0), chart.hitBounds(0).x, chart.hitBounds(0).width]) {
      assert.equal(Number.isFinite(value), true);
      assert.equal(value >= 0, true);
    }
  }
});

void test("heatmap marker positions change with width while circular radii remain CSS-pixel values", () => {
  const narrow = createHeatmapGeometry(180, 3);
  const wide = createHeatmapGeometry(540, 3);
  assert.notEqual(narrow.xFor(1), wide.xFor(1));
  assert.equal(narrow.height, wide.height);
  // The renderer uses this 1:1 pixel viewBox, so its fixed r=2/r=2.6 circles stay circular.
  assert.equal(`${narrow.width} ${narrow.height}`, "180 180");
  assert.equal(`${wide.width} ${wide.height}`, "540 180");
});

void test("tooltip position stays inside narrow graph containers", () => {
  assert.deepEqual(
    clampHeatmapTooltip({ x: 90, y: 170 }, { width: 100, height: 180 }, { width: 76, height: 140 }),
    { x: 12, y: 28 },
  );
});
