import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// scopeManager.ts imports the "obsidian" module, which in this repo is
// types-only (no runtime implementation), so it cannot be imported directly
// in a Node test -- this audits the source text instead, the same approach
// used for settingsTab.ts.
const SOURCE = fs.readFileSync(path.join(__dirname, "scopeManager.ts"), "utf8");

void test("healthy (complete) scope guidance is never rendered: renderSummary only renders guidance when the draft is incomplete", () => {
  const renderCall = SOURCE.match(/this\.renderSummary\(([^)]*)\);/);
  assert.ok(renderCall, "expected a this.renderSummary(...) call in render()");
  assert.match(renderCall![1], /draftComplete \? null : status\.guidance/);

  const renderSummaryBody = SOURCE.slice(SOURCE.indexOf("private renderSummary("));
  assert.match(renderSummaryBody, /if \(guidance\)/, "guidance div must be conditionally rendered");
});

void test("scope completeness for the guidance decision is computed from the live draft, not just the last-saved status", () => {
  assert.match(SOURCE, /isScopeSetupComplete\(this\.draft\)/);
});

void test("Current/All chips render exactly once via renderScopeSummary, and exactly one Save action exists", () => {
  const renderSummaryBody = SOURCE.slice(SOURCE.indexOf("private renderSummary("), SOURCE.indexOf("private renderScopeSummary("));
  const chipCalls = renderSummaryBody.match(/this\.renderScopeSummary\(/g) ?? [];
  assert.equal(chipCalls.length, 2, "expected exactly one Current and one All renderScopeSummary call");

  const saveButtonCalls = SOURCE.match(/createButton\(toolbar, "Save"/g) ?? [];
  assert.equal(saveButtonCalls.length, 1, "expected exactly one Save action");
});

void test("no unconditional 'Scope folders are configured' style sentence is ever created directly in ScopeManager", () => {
  assert.doesNotMatch(SOURCE, /createDiv\(\{\s*cls:\s*"mindmap-scope-guidance",\s*text:\s*"[^"]*configured/i);
});
