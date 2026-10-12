import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SidebarRefreshController, type SidebarRefreshTimers } from "./sidebarRefreshController";
import { createIdleLiveState, createLoadingLiveState, createReadyLiveState, getDisplayLiveRelated, getLiveFeedback } from "./workspaceViewState";
import type { LiveRelatedResponse } from "./semanticTypes";
import { RetainedSvgNodes } from "./retainedSvgNodes";

class Timers implements SidebarRefreshTimers {
  now = 0;
  next = 0;
  tasks = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): number {
    const id = ++this.next;
    this.tasks.set(id, { at: this.now + ms, callback });
    return id;
  }
  clearTimeout(id: unknown): void { this.tasks.delete(id as number); }
  advance(ms: number): void {
    const until = this.now + ms;
    while (true) {
      const due = [...this.tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].callback();
    }
    this.now = until;
  }
}

void test("typing coalesces background and metadata changes into one update after two seconds idle", () => {
  const timers = new Timers();
  const calls: string[] = [];
  const c = new SidebarRefreshController({ runLookup() {}, refreshNote() { calls.push("note"); }, refreshIndex() { calls.push("index"); }, typingEnded() { calls.push("idle"); } }, timers);
  for (let i = 0; i < 10; i++) {
    c.recordTyping(); c.scheduleIndexRefresh(); c.scheduleNoteRefresh(); timers.advance(500);
  }
  assert.deepEqual(calls, []);
  assert.equal(c.isTyping(), true);
  timers.advance(1_499);
  assert.deepEqual(calls, []);
  timers.advance(1);
  assert.deepEqual(calls, ["index", "idle"]);
  assert.equal(c.isTyping(), false);
  c.close();
});

void test("continuous commits refresh at a bounded cadence instead of starving", () => {
  const timers = new Timers();
  let calls = 0;
  const c = new SidebarRefreshController({ runLookup() {}, refreshNote() {}, refreshIndex() { calls++; } }, timers);
  for (let i = 0; i < 10; i++) { c.scheduleIndexRefresh(); timers.advance(500); }
  assert.equal(calls, 5);
  c.close();
});

void test("note switches reject stale typing timers; closing cancels all delayed work", () => {
  const timers = new Timers();
  let calls = 0;
  const c = new SidebarRefreshController({ runLookup() {}, refreshNote() { calls++; }, refreshIndex() { calls++; }, typingEnded() { calls++; } }, timers);
  c.recordTyping();
  const stale = timers.tasks.values().next().value!.callback;
  c.scheduleIndexRefresh(); c.resetTyping(); c.invalidateNoteRequest();
  stale(); timers.advance(3_000);
  assert.equal(calls, 0);
  c.recordTyping(); c.close(); timers.advance(3_000);
  assert.equal(calls, 0);
  assert.equal(timers.tasks.size, 0);
});

function response(indexed: boolean, related: LiveRelatedResponse["related"] = []): LiveRelatedResponse {
  return { path: "Draft.md", hash: "h", indexed, stale: !indexed, index_result: null, related };
}

void test("unindexed drafts never flip empty/loading headings during background commits", () => {
  let state = createReadyLiveState("Draft.md", response(false));
  const feedback: string[] = [getLiveFeedback(state, true)];
  for (let i = 0; i < 10; i++) {
    state = createLoadingLiveState("Draft.md", createIdleLiveState("Draft.md", state.response, state.displayResponse));
    feedback.push(getLiveFeedback(state, true));
    state = createReadyLiveState("Draft.md", response(false), state);
    feedback.push(getLiveFeedback(state, true));
  }
  assert.deepEqual([...new Set(feedback)], ["none"]);
});

void test("confirmed empty results remain stable throughout silent refreshes", () => {
  const ready = createReadyLiveState("Draft.md", response(true));
  const loading = createLoadingLiveState("Draft.md", ready);
  assert.equal(getLiveFeedback(ready, true), "empty");
  assert.equal(getLiveFeedback(loading, true), "empty");
  assert.equal(getLiveFeedback(createReadyLiveState("Draft.md", response(false), loading), true), "empty");
});

void test("pending indexing retains accepted links without leaking them into another note", () => {
  const links: LiveRelatedResponse["related"] = [{ path: "Related.md", score: 0.9, kind: "core" }];
  const ready = createReadyLiveState("Draft.md", response(true, links));
  const pending = createReadyLiveState("Draft.md", response(false), ready);
  assert.deepEqual(getDisplayLiveRelated("Draft.md", pending), links);
  assert.deepEqual(getDisplayLiveRelated("Next.md", pending), []);
});

class Node {
  attrs = new Map<string, string>();
  writes = 0;
  removed = false;
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); this.writes++; }
  remove(): void { this.removed = true; }
}

void test("graph updates preserve node identity and perform zero writes/moves for unchanged data", () => {
  const graph = new RetainedSvgNodes<Node>();
  const children: Node[] = [];
  let creates = 0;
  let moves = 0;
  const host = {
    first: () => children[0] ?? null,
    next: (node: Node) => children[children.indexOf(node) + 1] ?? null,
    find: () => null,
    insertBefore: (node: Node, before: Node | null) => {
      moves++; children.splice(children.indexOf(node), 1);
      children.splice(before ? children.indexOf(before) : children.length, 0, node);
    },
  };
  const create = (): Node => { creates++; const node = new Node(); children.push(node); return node; };
  graph.begin(); const first = graph.get("point:a", create, { cx: "10", cy: "20" }); graph.finish(host);
  graph.begin(); const next = graph.get("point:a", create, { cx: "10", cy: "20" }); graph.finish(host);
  assert.equal(first.created, true); assert.equal(next.created, false);
  assert.equal(first.node, next.node); assert.equal(creates, 1);
  assert.equal(next.node.writes, 2); assert.equal(moves, 0);
  graph.begin(); graph.get("point:a", create, { cx: "10", cy: "30" }); graph.finish(host);
  assert.equal(next.node.writes, 3);
  graph.begin(); graph.finish(host);
  assert.equal(next.node.removed, true);
});

void test("renderer keeps background feedback silent, clears busy announcements and retains its graph shell", () => {
  const source = fs.readFileSync("src/workspaceView.ts", "utf8");
  assert.doesNotMatch(source, /heatmapRegionEl\?\.empty\(\)/);
  assert.doesNotMatch(source, /renderEmpty\(shell, "Updating connections"/);
  assert.match(source, /this\.liveRegionEl\.textContent = ""/);
  assert.match(source, /this\.refreshController\.recordTyping\(\)/);
  assert.match(source, /this\.heatmapSvgEl \?\?/);
});
