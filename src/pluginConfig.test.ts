import test from "node:test";
import assert from "node:assert/strict";

import { getLlmProviderConfigStatus, getScopeSetupStatus, saveLlmProviderConfig, saveScopeSetup } from "./pluginConfig";
import { DEFAULT_SETTINGS, type MindmapSettings } from "./settings";

function freshSettings(): MindmapSettings {
  return { ...DEFAULT_SETTINGS, pinnedConnections: {}, scopeCurrentPaths: [], scopeAllPaths: [] };
}

void test("getLlmProviderConfigStatus reads baseUrl/model/maxTokens straight from settings", () => {
  const settings = freshSettings();
  settings.llmBaseUrl = "http://localhost:11434";
  settings.llmModel = "llama3.1:8b";
  settings.llmMaxTokens = 512;

  const status = getLlmProviderConfigStatus(settings);
  assert.equal(status.baseUrl, "http://localhost:11434");
  assert.equal(status.model, "llama3.1:8b");
  assert.equal(status.maxTokens, 512);
});

void test("saveLlmProviderConfig trims baseUrl/model and only updates maxTokens when finite/positive", () => {
  const settings = freshSettings();
  saveLlmProviderConfig(settings, { baseUrl: "  http://localhost:11434  ", model: "  llama3.1:8b  ", maxTokens: 2048 });
  assert.equal(settings.llmBaseUrl, "http://localhost:11434");
  assert.equal(settings.llmModel, "llama3.1:8b");
  assert.equal(settings.llmMaxTokens, 2048);

  saveLlmProviderConfig(settings, { maxTokens: -1 });
  assert.equal(settings.llmMaxTokens, 2048, "an invalid maxTokens must never overwrite the last good value");
});

void test("getScopeSetupStatus/saveScopeSetup round-trip through settings, normalizing and validating", () => {
  const settings = freshSettings();
  assert.equal(getScopeSetupStatus(settings).complete, false);

  saveScopeSetup(settings, { currentPaths: ["Projects", "Journal"], allPaths: [".", "Projects"] });
  const status = getScopeSetupStatus(settings);
  assert.equal(status.complete, true);
  assert.deepEqual(status.currentPaths, ["Journal", "Projects"]);
  assert.deepEqual(status.allPaths, [".", "Projects"]);

  assert.throws(() => saveScopeSetup(settings, { currentPaths: [], allPaths: ["Projects"] }));
});
