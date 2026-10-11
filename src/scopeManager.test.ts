import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.join(__dirname, "scopeManager.ts"), "utf8");

void test("ScopeManager accepts stable external editor state and preserves distinct saved lists", () => {
  assert.match(SOURCE, /state\?: ScopeEditorState/);
  assert.match(SOURCE, /separateQuickRun: !samePaths/);
  assert.match(SOURCE, /draft: cloneSelection\(status\)/);
});

void test("search stays mounted while only the folder tree rerenders", () => {
  const inputHandler = SOURCE.slice(SOURCE.indexOf('search.addEventListener("input"'), SOURCE.indexOf("const actions"));
  assert.match(inputHandler, /this\.renderTree\(\)/);
  assert.doesNotMatch(inputHandler, /this\.render\(\)/);
});

void test("bulk actions are disclosed and save, reset, and clear stay local", () => {
  assert.match(SOURCE, /createEl\("details", \{ cls: "mindmap-folder-actions" \}\)/);
  assert.match(SOURCE, /"Clear"/);
  assert.match(SOURCE, /"Reset"/);
  assert.match(SOURCE, /"Save folders"/);
});

void test("failed Save retains the draft for retry", () => {
  const save = SOURCE.slice(SOURCE.indexOf("private async save"), SOURCE.indexOf("private renderSummary"));
  assert.match(save, /catch \(error\)/);
  assert.doesNotMatch(save.slice(save.indexOf("catch")), /this\.state\.draft\s*=/);
});
