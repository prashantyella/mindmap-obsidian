import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_METADATA_MODEL,
  getLlmProviderConfigStatus,
  saveLlmProviderConfig,
  type LlmProviderConfigStatus,
} from "./pluginConfig";

void test("provider fallback uses the approved Qwen metadata model", () => {
  const status = getLlmProviderConfigStatus({
    valid: false,
    messages: [],
  } as never, false);

  assert.equal(DEFAULT_METADATA_MODEL, "Qwen3.5-9B-MLX-4bit");
  assert.equal(status.model, DEFAULT_METADATA_MODEL);
});

void test("saveLlmProviderConfig trims a whitespace-only API key so env clearing is not triggered", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mindmap-config-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ llm_api_key_env: "OPENAI_API_KEY" }), "utf8");

  const status: LlmProviderConfigStatus = {
    provider: "openai_compatible",
    baseUrl: "http://localhost:8000/v1",
    model: DEFAULT_METADATA_MODEL,
    apiKey: "",
    maxTokens: 1024,
    enableThinking: true,
    canManage: true,
    configPath,
    guidance: "",
  };

  saveLlmProviderConfig(status, { ...status, apiKey: "   " });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(saved.llm_api_key, "");
  assert.equal(saved.llm_api_key_env, "OPENAI_API_KEY");
});

void test("saveLlmProviderConfig trims a real API key before persisting and clears the env var", () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mindmap-config-")), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ llm_api_key_env: "OPENAI_API_KEY" }), "utf8");

  const status: LlmProviderConfigStatus = {
    provider: "openai_compatible",
    baseUrl: "http://localhost:8000/v1",
    model: DEFAULT_METADATA_MODEL,
    apiKey: "",
    maxTokens: 1024,
    enableThinking: true,
    canManage: true,
    configPath,
    guidance: "",
  };

  saveLlmProviderConfig(status, { ...status, apiKey: "  sk-test-123  " });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert.equal(saved.llm_api_key, "sk-test-123");
  assert.equal(saved.llm_api_key_env, "");
});
