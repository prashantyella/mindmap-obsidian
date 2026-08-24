import test from "node:test";
import assert from "node:assert/strict";

import { buildOverviewState, type OverviewInput } from "./settingsOverview";

function input(overrides: Partial<OverviewInput> = {}): OverviewInput {
  return {
    runtimeValid: true,
    runtimeSetup: null,
    scopeCanManage: true,
    providerCanManage: true,
    preflightOk: true,
    ...overrides,
  };
}

void test("ready when runtime, scope, and provider are all usable and preflight already succeeded", () => {
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

void test("preflight precedence: runtime/scope/provider all win over the preflight-null/false messages", () => {
  const runtimeWins = buildOverviewState(input({ runtimeValid: false, preflightOk: false }));
  assert.equal(runtimeWins.message, "Mindmap runtime needs attention. Open Troubleshooting for details.");

  const scopeWins = buildOverviewState(input({ scopeCanManage: false, preflightOk: null }));
  assert.equal(scopeWins.message, "Scope setup needs attention. Open the Scope section to fix it.");

  const providerWins = buildOverviewState(input({ providerCanManage: false, preflightOk: false }));
  assert.equal(providerWins.message, "Local AI provider setup needs attention. Open the Local AI section to fix it.");
});

void test("runtime setup in progress wins over every other condition and never renders a path", () => {
  const state = buildOverviewState(input({
    runtimeValid: false,
    scopeCanManage: false,
    providerCanManage: false,
    runtimeSetup: { phase: "setup-required", message: "A compatible Python was found, but Mindmap's packages are not installed yet.", canSetup: true, canCancel: false },
  }));
  assert.equal(state.ready, false);
  assert.equal(state.message, "A compatible Python was found, but Mindmap's packages are not installed yet.");
  assert.deepEqual(state.actions, ["openMindmap", "setupRuntime"]);
  assert.doesNotMatch(state.message, /\/|\\|Users|vault/i);
});

void test("runtime setup offers cancel independently of setup, and both can appear together", () => {
  const cancelOnly = buildOverviewState(input({ runtimeSetup: { phase: "confirming", message: "Waiting for confirmation.", canSetup: false, canCancel: true } }));
  assert.deepEqual(cancelOnly.actions, ["openMindmap", "cancelSetup"]);

  const both = buildOverviewState(input({ runtimeSetup: { phase: "failed", message: "Setup failed.", canSetup: true, canCancel: true } }));
  assert.deepEqual(both.actions, ["openMindmap", "setupRuntime", "cancelSetup"]);
});

void test("runtime setup 'unavailable' always offers the Python download page, since canSetup/canCancel are both false there", () => {
  const state = buildOverviewState(input({
    runtimeValid: false,
    runtimeSetup: { phase: "unavailable", message: "No compatible Python 3.11-3.13 was found.", canSetup: false, canCancel: false },
  }));
  assert.equal(state.ready, false);
  assert.deepEqual(state.actions, ["openMindmap", "openPythonDownload"]);
  assert.doesNotMatch(state.message, /\/|\\|Users|vault/i);
});

void test("the user is never stranded: every non-ready state offers at least one action beyond Open Mindmap alone, except the plain scope/provider redirects which point at another settings section", () => {
  const unavailable = buildOverviewState(input({ runtimeSetup: { phase: "unavailable", message: "n/a", canSetup: false, canCancel: false } }));
  assert.ok(unavailable.actions.length > 1);

  const setupRequired = buildOverviewState(input({ runtimeSetup: { phase: "setup-required", message: "n/a", canSetup: true, canCancel: false } }));
  assert.ok(setupRequired.actions.length > 1);

  const invalidRuntime = buildOverviewState(input({ runtimeValid: false }));
  assert.ok(invalidRuntime.actions.length > 1);

  const preflightUnknown = buildOverviewState(input({ preflightOk: null }));
  assert.ok(preflightUnknown.actions.length > 1);

  const preflightFailed = buildOverviewState(input({ preflightOk: false }));
  assert.ok(preflightFailed.actions.length > 1);
});

void test("runtime setup phases 'not-applicable' and 'ready' are healthy and fall through to other checks", () => {
  const notApplicable = buildOverviewState(input({ runtimeSetup: { phase: "not-applicable", message: "n/a", canSetup: false, canCancel: false } }));
  assert.equal(notApplicable.ready, true);

  const ready = buildOverviewState(input({ runtimeSetup: { phase: "ready", message: "Mindmap runtime is ready.", canSetup: false, canCancel: false } }));
  assert.equal(ready.ready, true);
});

void test("an invalid runtime shows a fixed, path-free message and offers Run checks, never the raw validation error", () => {
  const state = buildOverviewState(input({ runtimeValid: false }));
  assert.equal(state.ready, false);
  assert.equal(state.message, "Mindmap runtime needs attention. Open Troubleshooting for details.");
  assert.deepEqual(state.actions, ["openMindmap", "runChecks"]);
});

void test("unmanageable scope or provider config shows a fixed redirect message with no extra action", () => {
  const scope = buildOverviewState(input({ scopeCanManage: false }));
  assert.equal(scope.ready, false);
  assert.equal(scope.message, "Scope setup needs attention. Open the Scope section to fix it.");
  assert.deepEqual(scope.actions, ["openMindmap"]);

  const provider = buildOverviewState(input({ providerCanManage: false }));
  assert.equal(provider.ready, false);
  assert.equal(provider.message, "Local AI provider setup needs attention. Open the Local AI section to fix it.");
  assert.deepEqual(provider.actions, ["openMindmap"]);
});

void test("precedence: runtime validity beats scope/provider, scope beats provider", () => {
  const runtimeWins = buildOverviewState(input({ runtimeValid: false, scopeCanManage: false, providerCanManage: false }));
  assert.equal(runtimeWins.message, "Mindmap runtime needs attention. Open Troubleshooting for details.");

  const scopeWins = buildOverviewState(input({ scopeCanManage: false, providerCanManage: false }));
  assert.equal(scopeWins.message, "Scope setup needs attention. Open the Scope section to fix it.");
});
