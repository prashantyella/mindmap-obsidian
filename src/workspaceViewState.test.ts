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
} from "./workspaceViewState";

function createLiveResponse(pathValue: string, relatedPath = "Related.md"): LiveRelatedResponse {
  return {
    path: pathValue,
    hash: "hash",
    indexed: true,
    stale: false,
    index_result: null,
    related: [
      {
        path: relatedPath,
        score: 0.91,
        kind: "core",
        title: "Related",
      },
    ],
  };
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

void test("workspace view does not define a dedicated loading screen", () => {
  const sourceRoot = process.cwd();
  const workspaceViewSource = fs.readFileSync(path.join(sourceRoot, "src", "workspaceView.ts"), "utf8");
  const stylesSource = fs.readFileSync(path.join(sourceRoot, "styles.css"), "utf8");

  assert.equal(workspaceViewSource.includes("renderLoadingState"), false);
  assert.equal(workspaceViewSource.includes("Live links unavailable"), false);
  assert.equal(stylesSource.includes("mindmap-loading-state"), false);
});
