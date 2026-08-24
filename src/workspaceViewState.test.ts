import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type { LiveRelatedResponse } from "./semanticTypes";
import {
  createErrorLiveState,
  createIdleLiveState,
  createLoadingLiveState,
  createReadyLiveState,
  getDisplayLiveRelated,
  NO_MINDMAP_CONNECTIONS_MESSAGE,
  shouldApplyLiveResponse,
  shouldSkipLiveQuery,
  type SidebarLiveState,
} from "./workspaceViewState";

function createLiveResponse(pathValue: string, relatedPath = "Related.md", indexed = true): LiveRelatedResponse {
  return {
    path: pathValue,
    hash: "hash",
    indexed,
    stale: false,
    index_result: null,
    related: indexed
      ? [
          {
            path: relatedPath,
            score: 0.91,
            kind: "core",
            title: "Related",
          },
        ]
      : [],
  };
}

/**
 * Mirrors `MindmapWorkspaceView.ensureLiveQuery`'s own call/skip logic
 * (`shouldSkipLiveQuery`, then `createLoadingLiveState`, then the resolved
 * `query` result folded in via `createReadyLiveState`) without needing an
 * actual ItemView -- lets tests below simulate many `render()` calls and
 * count how often `query` actually runs.
 */
function simulateEnsureLiveQuery(liveState: SidebarLiveState, path: string, query: () => LiveRelatedResponse): SidebarLiveState {
  if (shouldSkipLiveQuery(liveState, path)) {
    return liveState;
  }
  return createReadyLiveState(path, query());
}

void test("loading preserves current visible candidates for the active note", () => {
  const response = createLiveResponse("Active.md");
  const ready = createReadyLiveState("Active.md", response);
  const loading = createLoadingLiveState("Active.md", ready);

  assert.equal(loading.status, "loading");
  assert.equal(loading.response, response);
  assert.deepEqual(getDisplayLiveRelated("Active.md", loading), response.related);
});

void test("loading clears stale candidates when the active note changes", () => {
  const response = createLiveResponse("Previous.md");
  const previousReady = createReadyLiveState("Previous.md", response);
  const nextLoading = createLoadingLiveState("Next.md", previousReady);

  assert.equal(nextLoading.status, "loading");
  assert.equal(nextLoading.response, null);
  assert.deepEqual(getDisplayLiveRelated("Next.md", nextLoading), []);
});

void test("empty sidebar copy stays stable while no live candidates exist", () => {
  const idle = createIdleLiveState("Empty.md");
  const loading = createLoadingLiveState("Empty.md", idle);

  assert.equal(NO_MINDMAP_CONNECTIONS_MESSAGE, "No mindmap connections exist for this note.");
  assert.deepEqual(getDisplayLiveRelated("Empty.md", loading), []);
});

void test("errors preserve the last visible candidates for the active note", () => {
  const response = createLiveResponse("Active.md");
  const loading = createLoadingLiveState("Active.md", createReadyLiveState("Active.md", response));
  const errored = createErrorLiveState("Active.md", loading, new Error("worker unavailable"));

  assert.equal(errored.status, "error");
  assert.equal(errored.response, response);
  assert.equal(errored.error, "worker unavailable");
  assert.deepEqual(getDisplayLiveRelated("Active.md", errored), response.related);
});

void test("stale live responses cannot replace the active note", () => {
  assert.equal(shouldApplyLiveResponse(2, 2, "Active.md", "Active.md"), true);
  assert.equal(shouldApplyLiveResponse(1, 2, "Active.md", "Active.md"), false);
  assert.equal(shouldApplyLiveResponse(2, 2, "Other.md", "Active.md"), false);
  assert.equal(shouldApplyLiveResponse(2, 2, null, "Active.md"), false);
});

void test("shouldSkipLiveQuery does not treat an indexed:false ready response as stale on its own -- no per-render re-query loop", () => {
  let queryCount = 0;
  const query = () => {
    queryCount += 1;
    return createLiveResponse("Active.md", "Related.md", false);
  };

  let state = createIdleLiveState("Active.md");
  // First render issues the query.
  state = simulateEnsureLiveQuery(state, "Active.md", query);
  assert.equal(queryCount, 1);
  assert.equal(state.status, "ready");
  assert.equal(state.response?.indexed, false);

  // Many further renders for the SAME path (e.g. the note is still queued
  // for indexing, or migration is still running) must not re-issue the
  // query just because the cached response says indexed:false -- that
  // would cascade into an unbounded query -> render -> query loop.
  for (let i = 0; i < 50; i += 1) {
    state = simulateEnsureLiveQuery(state, "Active.md", query);
  }
  assert.equal(queryCount, 1, "shouldSkipLiveQuery must keep skipping across repeated renders for an unchanged path");
});

void test("invalidateLiveQuery's reset-to-idle allows exactly one more query, not a loop", () => {
  let queryCount = 0;
  const query = () => {
    queryCount += 1;
    return createLiveResponse("Active.md", "Related.md", false);
  };

  let state = createIdleLiveState("Active.md");
  state = simulateEnsureLiveQuery(state, "Active.md", query);
  assert.equal(queryCount, 1);

  // Repeated renders before invalidation: still just the one query.
  for (let i = 0; i < 10; i += 1) state = simulateEnsureLiveQuery(state, "Active.md", query);
  assert.equal(queryCount, 1);

  // MindmapWorkspaceView.invalidateLiveQuery()'s own reset (mirrors the
  // "metadataCache changed" handler): createIdleLiveState keeps the prior
  // response for display continuity, but flips status back to "idle" so
  // exactly one more query is allowed.
  state = createIdleLiveState(state.path, state.response);
  state = simulateEnsureLiveQuery(state, "Active.md", query);
  assert.equal(queryCount, 2, "invalidation must allow exactly one re-query");

  // And it must not cascade: further renders after the second query
  // resolves must not trigger a third, fourth, ... query.
  for (let i = 0; i < 50; i += 1) state = simulateEnsureLiveQuery(state, "Active.md", query);
  assert.equal(queryCount, 2, "a single invalidation must never cascade into repeated queries");
});

void test("workspace view does not define a dedicated loading screen", () => {
  const sourceRoot = process.cwd();
  const workspaceViewSource = fs.readFileSync(path.join(sourceRoot, "src", "workspaceView.ts"), "utf8");
  const stylesSource = fs.readFileSync(path.join(sourceRoot, "styles.css"), "utf8");

  assert.equal(workspaceViewSource.includes("renderLoadingState"), false);
  assert.equal(workspaceViewSource.includes("Live links unavailable"), false);
  assert.equal(stylesSource.includes("mindmap-loading-state"), false);
});

void test("heatmap SVG classes are added as individual DOM tokens", () => {
  const sourceRoot = process.cwd();
  const workspaceViewSource = fs.readFileSync(path.join(sourceRoot, "src", "workspaceView.ts"), "utf8");

  assert.match(workspaceViewSource, /cls: "mindmap-heatmap-hit"/);
  assert.match(workspaceViewSource, /marker\.addClass\("is-selected"\)/);
  assert.match(workspaceViewSource, /cls: "mindmap-heatmap-line"/);
  assert.match(workspaceViewSource, /line\.addClass\(`is-\$\{metric\.key\}`\)/);
  assert.match(workspaceViewSource, /cls: "mindmap-heatmap-point"/);
  assert.match(workspaceViewSource, /point\.addClass\(`is-\$\{metric\.key\}`\)/);
  assert.doesNotMatch(workspaceViewSource, /cls: `mindmap-heatmap-(?:hit|line|point)[^`]*\s+is-/);
});

void test("open mindmap command docks into the existing right sidebar tab group", () => {
  const sourceRoot = process.cwd();
  const mainSource = fs.readFileSync(path.join(sourceRoot, "src", "main.ts"), "utf8");
  const methodStart = mainSource.indexOf("  async openMindmapView(): Promise<void> {");
  const methodEnd = mainSource.indexOf("  async syncMindmapLocalGraph", methodStart);

  assert.notEqual(methodStart, -1);
  assert.notEqual(methodEnd, -1);

  const methodSource = mainSource.slice(methodStart, methodEnd);
  assert.equal(methodSource.includes("detachLeavesOfType(MINDMAP_VIEW_TYPE)"), true);
  assert.equal(methodSource.includes("split: true"), false);
  assert.equal(methodSource.includes("split: false"), true);
  // openMindmapLookup awaits openMindmapView() expecting the leaf to be
  // fully revealed on completion; voiding revealLeaf here would silently
  // break that completion guarantee for every caller.
  assert.equal(methodSource.includes("await this.app.workspace.revealLeaf(leaf)"), true);
  assert.equal(methodSource.includes("void this.app.workspace.revealLeaf(leaf)"), false);
});

void test("workspace view exposes lookup, pin, and score affordances", () => {
  const sourceRoot = process.cwd();
  const workspaceViewSource = fs.readFileSync(path.join(sourceRoot, "src", "workspaceView.ts"), "utf8");
  const mainSource = fs.readFileSync(path.join(sourceRoot, "src", "main.ts"), "utf8");
  const commandSource = fs.readFileSync(path.join(sourceRoot, "src", "pluginCommands.ts"), "utf8");

  assert.equal(workspaceViewSource.includes("mindmap-lookup-input"), true);
  assert.equal(workspaceViewSource.includes("queryLookupRelated"), true);
  assert.equal(workspaceViewSource.includes("captureLookupInputState"), true);
  assert.equal(workspaceViewSource.includes("requestAnimationFrame"), true);
  assert.equal(workspaceViewSource.includes("togglePinnedConnection"), true);
  assert.equal(workspaceViewSource.includes("contextmenu"), true);
  assert.equal(workspaceViewSource.includes("ContextMenu"), true);
  assert.equal(workspaceViewSource.includes("event.shiftKey"), true);
  assert.equal(workspaceViewSource.includes("is-pin-revealed"), true);
  assert.equal(workspaceViewSource.includes("animatePinReveal"), true);
  assert.equal(workspaceViewSource.includes("mindmap-sidebar-score"), true);
  assert.equal(mainSource.includes("pinnedConnections"), true);
  assert.equal(commandSource.includes("mindmap-open-lookup"), true);
});

void test("migration completion invalidates the live-query cache exactly once per open Mindmap view, via the same skip guard tested above (never an inline per-render staleness check)", () => {
  const sourceRoot = process.cwd();
  const workspaceViewSource = fs.readFileSync(path.join(sourceRoot, "src", "workspaceView.ts"), "utf8");
  const mainSource = fs.readFileSync(path.join(sourceRoot, "src", "main.ts"), "utf8");
  const engineSource = fs.readFileSync(path.join(sourceRoot, "src", "engine", "productionEngine.ts"), "utf8");

  // ensureLiveQuery's skip guard must stay the single shared helper --
  // never re-inlined as (or replaced with) a per-render "is this response
  // still fresh" check, which is exactly the pattern the tests above prove
  // cascades into an unbounded query loop for an indexed:false response.
  assert.match(workspaceViewSource, /shouldSkipLiveQuery\(this\.liveState, activeFile\.path\)/);
  assert.doesNotMatch(workspaceViewSource, /response\??\.indexed\s*===\s*false/);

  // The one-shot invalidation entry point: resets to idle (keeping the
  // prior response for display continuity) and renders once, mirroring
  // the existing metadataCache "changed" handler.
  assert.match(workspaceViewSource, /invalidateLiveQuery\(\)\s*:\s*void\s*\{/);
  const invalidateBody = workspaceViewSource.slice(workspaceViewSource.indexOf("invalidateLiveQuery(): void {"));
  assert.match(invalidateBody, /createIdleLiveState\(this\.liveState\.path, this\.liveState\.response\)/);
  assert.match(invalidateBody, /this\.render\(\);/);

  // Wired from ProductionEngine's migration-complete signal, applied to
  // every open Mindmap leaf, not just the currently active one.
  assert.match(engineSource, /onMigrationComplete\?\.\(\)/);
  assert.match(mainSource, /onMigrationComplete:\s*\(\)\s*=>\s*\{/);
  assert.match(mainSource, /getLeavesOfType\(MINDMAP_VIEW_TYPE\)/);
  assert.match(mainSource, /leaf\.view\.invalidateLiveQuery\(\)/);
});
