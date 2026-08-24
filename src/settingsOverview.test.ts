import test from "node:test";
import assert from "node:assert/strict";

import { buildOverviewState, type OverviewInput } from "./settingsOverview";

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    productionEngineAvailable: true,
    scopeComplete: true,
    preflightOk: true,
    ...overrides,
  };
}

void test("ready when the engine is available, scope is complete, and preflight already succeeded", () => {
  const state = buildOverviewState(input());
  assert.equal(state.ready, true);
  assert.equal(state.message, "Ready.");
  assert.deepEqual(state.actions, ["openMindmap"]);
});

void test("readiness is truthful: preflight must have actually succeeded, not merely be unknown", () => {
  const neverRun = buildOverviewState(input({ preflightOk: null }));
  assert.equal(neverRun.ready, false);
  assert.equal(neverRun.message, "Run checks to finish setup.");
  assert.deepEqual(neverRun.actions, ["openMindmap", "runChecks"]);

  const failed = buildOverviewState(input({ preflightOk: false }));
  assert.equal(failed.ready, false);
  assert.equal(failed.message, "Preflight checks failed. Run checks to see details.");
  assert.deepEqual(failed.actions, ["openMindmap", "runChecks"]);

  const confirmed = buildOverviewState(input({ preflightOk: true }));
  assert.equal(confirmed.ready, true);
  assert.deepEqual(confirmed.actions, ["openMindmap"]);
});

void test("engine availability wins over scope, and scope wins over the preflight-null/false messages", () => {
  const engineWins = buildOverviewState(input({ productionEngineAvailable: false, preflightOk: false }));
  assert.equal(engineWins.message, "The Mindmap TypeScript engine is not available. Open Troubleshooting for details.");

  const scopeWins = buildOverviewState(input({ scopeComplete: false, preflightOk: null }));
  assert.equal(scopeWins.message, "Scope setup needs attention. Open the Scope section to fix it.");
});

void test("an unavailable engine shows a fixed message and offers Run checks", () => {
  const state = buildOverviewState(input({ productionEngineAvailable: false }));
  assert.equal(state.ready, false);
  assert.equal(state.message, "The Mindmap TypeScript engine is not available. Open Troubleshooting for details.");
  assert.deepEqual(state.actions, ["openMindmap", "runChecks"]);
});

void test("an incomplete scope shows a fixed redirect message with no extra action", () => {
  const state = buildOverviewState(input({ scopeComplete: false }));
  assert.equal(state.ready, false);
  assert.equal(state.message, "Scope setup needs attention. Open the Scope section to fix it.");
  assert.deepEqual(state.actions, ["openMindmap"]);
});

void test("precedence: engine availability beats scope completeness", () => {
  const engineWins = buildOverviewState(input({ productionEngineAvailable: false, scopeComplete: false }));
  assert.equal(engineWins.message, "The Mindmap TypeScript engine is not available. Open Troubleshooting for details.");
});
