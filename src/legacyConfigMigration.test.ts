import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Checkpoint 11: source audits for migrateLegacyConfigOnce() in main.ts.
// main.ts imports the "obsidian" module (types-only), so it cannot be
// imported directly into a node:test run; these tests read the real
// shipped source text instead, following the project's existing
// source-audit convention (see finalAuditSourceBundle.test.ts).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const mainSource = readSource("src/main.ts");
const methodMatch = mainSource.match(/private async migrateLegacyConfigOnce\(\): Promise<void> \{[\s\S]*?\n {2}\}/);
assert.ok(methodMatch, "migrateLegacyConfigOnce method not found in main.ts");
const method = methodMatch![0];

void test("fresh install: migration is gated on legacyConfigMigrated and is a no-op guard at the top of the method", () => {
  assert.match(method, /if \(this\.settings\.legacyConfigMigrated\) return;/, "a vault that already ran migration (including a brand-new vault after its first load) must short-circuit immediately");
});

void test("fresh install: the flag is set unconditionally in a finally block, so a vault with no legacy config.json still stops re-checking on every future load", () => {
  const financallyBlock = method.slice(method.indexOf("} finally {"));
  assert.match(financallyBlock, /this\.settings\.legacyConfigMigrated = true;/);
  assert.match(financallyBlock, /await this\.saveSettings\(\);/);
});

void test("legacy-settings-migration: reads the legacy config from <pluginDir>/python/config.json, never from a path outside the plugin directory", () => {
  assert.match(method, /path\.join\(context\.pluginDir, "python", "config\.json"\)/);
});

void test("legacy-settings-migration: a missing legacy config.json is treated as absent (readFile failure caught to null), not as an error", () => {
  assert.match(method, /readFile\(legacyConfigPath, "utf8"\)\.catch\(\(\) => null\)/);
  assert.match(method, /if \(raw !== null\) \{/);
});

void test("legacy-settings-migration: imports Ollama base URL/model, scope folders, and Apple Books database overrides only", () => {
  assert.match(method, /this\.settings\.embedBaseUrl = /);
  assert.match(method, /this\.settings\.embedModel = /);
  assert.match(method, /this\.settings\.llmBaseUrl = /);
  assert.match(method, /this\.settings\.llmModel = /);
  assert.match(method, /this\.settings\.scopeCurrentPaths = currentPaths;/);
  assert.match(method, /this\.settings\.scopeAllPaths = allPaths;/);
  assert.match(method, /this\.settings\.appleAnnotationDbPath = /);
  assert.match(method, /this\.settings\.appleLibraryDbPath = /);
});

void test("legacy-settings-migration: llm base URL/model are only imported when the legacy provider was ollama, never copied blindly from another provider", () => {
  assert.match(method, /config\.llm_provider === "ollama" \? \(str\(config\.llm_base_url\) \?\? this\.settings\.llmBaseUrl\) : this\.settings\.llmBaseUrl/);
  assert.match(method, /config\.llm_provider === "ollama" \? \(str\(config\.llm_model\) \?\? this\.settings\.llmModel\) : this\.settings\.llmModel/);
});

void test("legacy-settings-migration: never copies an API key value into settings or logs -- only base URL/model/scope/Apple Books path fields are read from the legacy config", () => {
  assert.doesNotMatch(method, /api_key|apiKey|API_KEY/);
});

void test("legacy-settings-migration: a parse/read failure is caught and logged, and still falls through to setting the migrated flag (fail-open, not fail-closed, for this one-time best-effort step)", () => {
  assert.match(method, /catch \(error\) \{/);
  assert.match(method, /\[migration\] Legacy config\.json migration skipped:/);
});

void test("onload() runs the legacy migration before starting the production engine, so imported settings are honored on the very first engine start", () => {
  const onloadIndex = mainSource.indexOf("async onload()");
  assert.ok(onloadIndex >= 0, "onload() not found");
  const migrateIndex = mainSource.indexOf("await this.migrateLegacyConfigOnce();", onloadIndex);
  const startEngineIndex = mainSource.indexOf("await this.startProductionEngine();", onloadIndex);
  assert.ok(migrateIndex > onloadIndex, "migrateLegacyConfigOnce must be called from onload()");
  assert.ok(startEngineIndex > migrateIndex, "startProductionEngine must run after migrateLegacyConfigOnce");
});
