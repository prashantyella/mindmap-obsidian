import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SOURCE = fs.readFileSync(path.join(__dirname, "settingsTab.ts"), "utf8");
const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");

void test("settings render readiness and the five approved sections in order", () => {
  const display = SOURCE.slice(SOURCE.indexOf("display(): void"), SOURCE.indexOf("private createSection"));
  const names = ["renderReadiness", "renderLocalAi", "renderFolders", "renderAutomation", "renderIntegrations", "renderAdvanced"];
  let previous = -1;
  for (const name of names) {
    const index = display.indexOf(`this.${name}()`);
    assert.ok(index > previous, `${name} should render in the approved order`);
    previous = index;
  }
});

void test("configured sections use native persistent disclosures with compact Edit affordances", () => {
  assert.match(SOURCE, /createEl\("details"/);
  assert.match(SOURCE, /this\.viewState\.disclosures\[key\]/);
  assert.match(SOURCE, /details\.open \? "Done" : "Edit"/);
});

void test("Local AI is a draft group with one awaited Apply path", () => {
  assert.match(SOURCE, /Changes stay as a draft until applied/);
  assert.match(SOURCE, /await this\.plugin\.saveLocalAiConfig\(draft\)/);
  assert.match(SOURCE, /Changing it requires an explicit reindex/);
  assert.equal((SOURCE.match(/setButtonText\("Apply"\)/g) ?? []).length, 0, "dynamic Apply label is used exactly in the grouped action");
});

void test("Automation uses the approved labels and one HH:MM field per schedule", () => {
  assert.match(SOURCE, /While Obsidian is open/);
  assert.match(SOURCE, /Scheduled \(macOS\)/);
  assert.match(SOURCE, /macOS opens this vault at the scheduled time/);
  assert.match(SOURCE, /parseTimeOfDay\(value\)/);
});

void test("research is one Off, Manual, Automatic selector and diagnostics stay in Advanced", () => {
  assert.match(SOURCE, /addOption\("off", "Off"\).*addOption\("manual", "Manual"\).*addOption\("automatic-reading", "Automatic for Apple Books"\)/s);
  assert.match(SOURCE, /selectWebResearchMode/);
  assert.match(SOURCE, /Copy diagnostics/);
  assert.match(SOURCE, /Apple Books annotation database/);
});

void test("retired runtime paths and Python setup never appear", () => {
  assert.doesNotMatch(SOURCE, /pythonCommand|scriptPath|configPath|startRuntimeSetup|cancelRuntimeSetup/);
});

void test("provider Apply refreshes readiness in place and engine replacement replaces stale diagnostics", () => {
  assert.match(SOURCE, /this\.renderReadiness\(\)/);
  assert.match(SOURCE, /Configuration saved, but Local AI is not ready/);
  assert.match(MAIN_SOURCE, /this\.diagnosticsState\.result = MindmapPlugin\.toPreflightResult\(report\)/);
});
