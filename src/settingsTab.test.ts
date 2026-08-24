import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// settingsTab.ts imports the "obsidian" module, which in this repo is
// types-only (no runtime implementation), so it cannot be imported directly
// in a Node test. This file audits the source text instead: it verifies the
// linear section order, the absence of the raw status/path/log dump the
// design explicitly removes, and the subscription-cleanup contract, all of
// which are otherwise only visible by reading the actual plugin inside
// Obsidian.
const SOURCE = fs.readFileSync(path.join(__dirname, "settingsTab.ts"), "utf8");
// copyDiagnostics() itself lives on the plugin (main.ts), which also
// imports "obsidian" and cannot be imported directly here either.
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

function sectionIndex(name: string): number {
  const index = SOURCE.indexOf(`private ${name}(`);
  assert.ok(index >= 0, `expected a ${name} method in settingsTab.ts`);
  return index;
}

void test("the linear IA renders in the exact required order", () => {
  const order = [
    "renderOverview",
    "renderReadingAndResearch",
    "renderScope",
    "renderSchedule",
    "renderLocalAi",
    "renderTroubleshooting",
  ].map(sectionIndex);

  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] > order[i - 1], `expected ${order[i - 1]} to render before ${order[i]}`);
  }

  const displayBody = SOURCE.slice(SOURCE.indexOf("display(): void {"), SOURCE.indexOf("hide(): void {"));
  const callOrder = ["renderOverview", "renderReadingAndResearch", "renderScope", "renderSchedule", "renderLocalAi", "renderTroubleshooting"]
    .map((name) => displayBody.indexOf(`this.${name}()`));
  for (const index of callOrder) {
    assert.ok(index >= 0, "expected display() to call every section in order");
  }
  for (let i = 1; i < callOrder.length; i += 1) {
    assert.ok(callOrder[i] > callOrder[i - 1]);
  }
});

void test("no raw status/path/log dump is rendered by default: no unconditional trust/interpreter/command/log-line output", () => {
  // These are the exact fragments the pre-checkpoint-3 renderSummary() used
  // to always render (runtime.trust internals, the resolved Python command,
  // config/script paths, and a rendered "Recent diagnostics" log dump).
  // Copy diagnostics builds an equivalent report on demand (diagnosticsReport.ts),
  // but the default settings render path must never construct or display it.
  assert.doesNotMatch(SOURCE, /Trust: \$\{/);
  assert.doesNotMatch(SOURCE, /Interpreter: \$\{/);
  assert.doesNotMatch(SOURCE, /Script source: \$\{/);
  assert.doesNotMatch(SOURCE, /Config source: \$\{/);
  assert.doesNotMatch(SOURCE, /Recent diagnostics/);
  assert.doesNotMatch(SOURCE, /Run commands: current/);
  assert.doesNotMatch(SOURCE, /Vault root: \$\{/);
  assert.doesNotMatch(SOURCE, /getBasePath/);
  assert.equal(SOURCE.includes("renderSummary("), false, "the old full-detail renderSummary() dump must be removed entirely");
});

void test("Overview never interpolates a runtime command, script path, or config path into rendered text", () => {
  const overviewBody = SOURCE.slice(sectionIndex("renderOverview"), sectionIndex("renderReadingAndResearch"));
  assert.doesNotMatch(overviewBody, /scriptPath|configPath|command\.command|formatCommandPreview/);
});

void test("the Local AI provider config path is never rendered", () => {
  // The old surface rendered `Config: ${status.configPath ?? "Unavailable"}` directly in the Provider row's description.
  const localAiBody = SOURCE.slice(sectionIndex("renderLocalAi"), sectionIndex("saveProviderConfig"));
  assert.doesNotMatch(localAiBody, /status\.configPath/);
});

void test("Scope renders no separate status/guidance row outside ScopeManager (no duplicate summary)", () => {
  const scopeBody = SOURCE.slice(sectionIndex("renderScope"), sectionIndex("renderSchedule"));
  assert.equal((scopeBody.match(/new Setting\(/g) ?? []).length, 1, "expected exactly one fallback Setting row (the !canManage guidance), no duplicate status card");
  assert.doesNotMatch(scopeBody, /getScopeSetupSummary/);
});

void test("Local AI text fields commit via bindCommitOnBlurOrEnter rather than a plain per-keystroke onChange", () => {
  const localAiBody = SOURCE.slice(sectionIndex("renderLocalAi"), sectionIndex("saveProviderConfig"));
  const textFieldCount = (localAiBody.match(/\.addText\(/g) ?? []).length;
  const commitBindingCount = (localAiBody.match(/this\.bindProviderText\(/g) ?? []).length;
  assert.ok(textFieldCount >= 4, "expected Base URL, Model, API key, and Max output tokens as text fields");
  assert.equal(commitBindingCount, textFieldCount, "every Local AI text field must commit through the blur/Enter binder");
});

void test("Troubleshooting uses a native collapsed <details>/<summary> disclosure, not an always-open card", () => {
  const troubleshootingBody = SOURCE.slice(sectionIndex("renderTroubleshooting"), SOURCE.length);
  assert.match(troubleshootingBody, /createEl\("details"/);
  assert.match(troubleshootingBody, /createEl\("summary"/);
  assert.doesNotMatch(troubleshootingBody, /\.open\s*=\s*true/, "the disclosure must start collapsed");
});

void test("Troubleshooting offers Run preflight, a one-line result, Copy diagnostics, and the advanced runtime overrides", () => {
  const troubleshootingBody = SOURCE.slice(sectionIndex("renderTroubleshooting"), SOURCE.length);
  assert.match(troubleshootingBody, /Run preflight/);
  assert.match(troubleshootingBody, /getDiagnosticsOneLine/);
  assert.match(troubleshootingBody, /Copy diagnostics/);
  assert.match(troubleshootingBody, /copyDiagnostics/);
  assert.match(troubleshootingBody, /pythonCommand/);
  assert.match(troubleshootingBody, /scriptPath/);
  assert.match(troubleshootingBody, /configPath/);
});

void test("runtime setup progress/cancel/download actions live in Overview, and are not duplicated as buttons elsewhere", () => {
  const overviewBody = SOURCE.slice(sectionIndex("renderOverview"), sectionIndex("renderReadingAndResearch"));
  assert.match(overviewBody, /setupRuntime/);
  assert.match(overviewBody, /cancelSetup/);
  assert.match(overviewBody, /openPythonDownload/);
  assert.match(overviewBody, /openPythonRuntimeDownloadPage/);

  const restOfFile = SOURCE.slice(sectionIndex("renderReadingAndResearch"));
  assert.doesNotMatch(restOfFile, /startRuntimeSetup\(\)/);
  assert.doesNotMatch(restOfFile, /cancelRuntimeSetup\(\)/);
  assert.doesNotMatch(restOfFile, /openPythonRuntimeDownloadPage\(\)/);
});

void test("display() resubscribes to runtime-setup state and hide() cleans up the prior subscription (no leaked listener)", () => {
  const displayBody = SOURCE.slice(SOURCE.indexOf("display(): void {"), SOURCE.indexOf("hide(): void {"));
  const hideBody = SOURCE.slice(SOURCE.indexOf("hide(): void {"));
  assert.match(displayBody, /this\.unsubscribeRuntimeSetup\?\.\(\)/, "display() must unsubscribe any prior listener before resubscribing");
  assert.match(displayBody, /this\.unsubscribeRuntimeSetup = this\.plugin\.subscribeRuntimeSetupState/);
  assert.match(hideBody, /this\.unsubscribeRuntimeSetup\?\.\(\)/, "hide() must unsubscribe on teardown");
  assert.match(hideBody, /this\.unsubscribeRuntimeSetup = null/);
});

void test("copyDiagnostics() reports a clipboard failure with fixed copy, never the raw error message", () => {
  const startIndex = MAIN_SOURCE.indexOf("async copyDiagnostics(");
  assert.ok(startIndex >= 0, "expected copyDiagnostics() on the plugin");
  const nextMethodIndex = MAIN_SOURCE.indexOf("\n  }", MAIN_SOURCE.indexOf("showStatusSummary("));
  const body = MAIN_SOURCE.slice(startIndex, nextMethodIndex);

  assert.match(body, /catch\s*\{/, "the failure path must not bind the caught error to a variable it then forwards");
  assert.doesNotMatch(body, /error\.message/);
  assert.match(body, /new Notice\("Could not copy diagnostics to the clipboard\."/);
});
