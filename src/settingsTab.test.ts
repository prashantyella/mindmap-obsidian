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
  assert.match(SOURCE, /Applying a different model automatically re-embeds notes/);
  assert.equal((SOURCE.match(/setButtonText\("Apply"\)/g) ?? []).length, 0, "dynamic Apply label is used exactly in the grouped action");
});

void test("Automation uses the approved labels and one HH:MM field per schedule", () => {
  assert.match(SOURCE, /While Obsidian is open/);
  assert.match(SOURCE, /Scheduled \(macOS\)/);
  assert.match(SOURCE, /macOS opens this vault at the scheduled time/);
  assert.match(SOURCE, /parseTimeOfDay\(value\)/);
});

void test("Automation exposes the real-time summaries toggle and a bounded connections count", () => {
  const automation = SOURCE.slice(SOURCE.indexOf("private renderAutomation("), SOURCE.indexOf("private renderIntegrations("));
  assert.match(automation, /setName\("Real-time summaries and tags"\)[\s\S]*setValue\(this\.plugin\.settings\.realtimeMetadataExtraction\)/);
  assert.match(automation, /setName\("Connections shown"\)[\s\S]*parsed < MIN_RELATED_LIMIT \|\| parsed > MAX_RELATED_LIMIT/);
  assert.match(automation, /this\.plugin\.settings\.relatedLimit = normalizeRelatedLimit\(parsed\)/);
});

void test("integrations use authoritative on/off toggles with a subordinate enabled research mode", () => {
  assert.match(SOURCE, /setName\("Apple Books import"\)[\s\S]*setValue\(reading\)/);
  assert.match(SOURCE, /setName\("Internet research"\)[\s\S]*setValue\(research\.mode !== "off"\)/);
  assert.match(SOURCE, /if \(research\.mode !== "off"\)[\s\S]*setName\("Research mode"\)[\s\S]*addOption\("manual", "Manual"\).*addOption\("automatic-reading", "Automatic for Apple Books"\)/s);
  assert.match(SOURCE, /value \? "manual" : "off"/, "enabling defaults safely to Manual and disabling persists Off");
  assert.match(SOURCE, /selectWebResearchMode/);
  assert.match(SOURCE, /Copy diagnostics/);
  assert.match(SOURCE, /Apple Books annotation database/);
});

void test("integration controls await transactional selectors and always redraw from authoritative settings", () => {
  const integrations = SOURCE.slice(SOURCE.indexOf("private renderIntegrations("), SOURCE.indexOf("private renderAdvanced("));
  assert.match(integrations, /await this\.plugin\.selectReadingMode\(value \? "reading" : "standard"\); this\.display\(\)/);
  assert.match(integrations, /await this\.plugin\.selectWebResearchMode\(value \? "manual" : "off"\);[\s\S]*this\.display\(\)/);
  assert.match(MAIN_SOURCE, /webResearchModeTransition\.change\(/,
    "all settings and menu mode changes must use the tested transactional coordinator");
  assert.match(MAIN_SOURCE, /if \(!confirmed\) return false/,
    "cancelled consent must leave the authoritative mode unchanged before Settings redraws");
  assert.match(MAIN_SOURCE, /toggleAutomaticReadingResearch\(\)[\s\S]*selectWebResearchMode\(automatic \? "manual" : "automatic-reading"\)/,
    "subordinate Automatic changes must share the master toggle's coordinator");
});

void test("retired runtime paths and Python setup never appear", () => {
  assert.doesNotMatch(SOURCE, /pythonCommand|scriptPath|configPath|startRuntimeSetup|cancelRuntimeSetup/);
});

void test("provider Apply refreshes readiness in place and engine replacement replaces stale diagnostics", () => {
  assert.match(SOURCE, /this\.renderReadiness\(\)/);
  assert.match(SOURCE, /Configuration saved, but Local AI is not ready/);
  assert.match(MAIN_SOURCE, /this\.diagnosticsState\.result = MindmapPlugin\.toPreflightResult\(report, this\.cachedMigrationStatus/);
});

void test("time and saved text failures restore the latest committed value, not the render-time value", () => {
  const timeBody = SOURCE.slice(SOURCE.indexOf("private renderTime("), SOURCE.indexOf("private renderIntegrations("));
  assert.match(timeBody, /committed\.set\(parsed\)/);
  assert.match(timeBody, /const previous = committed\.get\(\)/);
  const savedTextBody = SOURCE.slice(SOURCE.indexOf("private savedText("));
  assert.match(savedTextBody, /committed\.set\(next\.trim\(\)\)/);
  assert.match(savedTextBody, /update\(committed\.get\(\)\)/);
});

void test("replacement preparation failure explicitly leaves Mindmap unavailable", () => {
  assert.match(MAIN_SOURCE, /Mindmap is unavailable because the active job phase did not settle safely/);
  assert.match(MAIN_SOURCE, /The disposed engine was not restored/);
});
