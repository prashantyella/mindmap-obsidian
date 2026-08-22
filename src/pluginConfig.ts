import fs from "node:fs";

import { isScopeSetupComplete, readScopeSelection, updateScopeSelection, type ScopeSelection } from "./onboarding";
import type { ResolvedRuntime } from "./pathResolver";

export interface ScopeSetupStatus {
  complete: boolean;
  canManage: boolean;
  configPath: string | null;
  currentPaths: string[];
  allPaths: string[];
  guidance: string;
}

export interface LlmProviderConfig {
  provider: "ollama" | "openai_compatible";
  baseUrl: string;
  model: string;
  apiKey: string;
  maxTokens: number;
  enableThinking: boolean;
}

export interface LlmProviderConfigStatus extends LlmProviderConfig {
  canManage: boolean;
  configPath: string | null;
  guidance: string;
}

export const DEFAULT_METADATA_MODEL = "Qwen3.5-9B-MLX-4bit";

const DEFAULT_PROVIDER_CONFIG: LlmProviderConfig = {
  provider: "openai_compatible",
  baseUrl: "http://localhost:8000/v1",
  model: DEFAULT_METADATA_MODEL,
  apiKey: "",
  maxTokens: 1024,
  enableThinking: true,
};

export function readRuntimeConfig(configPath: string): Record<string, unknown> {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("Mindmap config must be a JSON object.");
  }
  return config as Record<string, unknown>;
}

export function getScopeSetupStatus(runtime: ResolvedRuntime, canManageConfig: boolean): ScopeSetupStatus {
  if (!runtime.valid) {
    const error = runtime.messages.find((message) => message.level === "error");
    return {
      complete: false,
      canManage: false,
      configPath: null,
      currentPaths: [],
      allPaths: [],
      guidance: error?.message ?? "Mindmap runtime is not ready.",
    };
  }

  if (!canManageConfig) {
    return {
      complete: false,
      canManage: false,
      configPath: runtime.configPath,
      currentPaths: [],
      allPaths: [],
      guidance: "Scope setup controls only the bundled plugin config. Reset config path to default or update your custom config manually.",
    };
  }

  try {
    const rawConfig = fs.readFileSync(runtime.configPath, "utf8");
    const selection = readScopeSelection(rawConfig);
    return {
      complete: isScopeSetupComplete(selection),
      canManage: true,
      configPath: runtime.configPath,
      currentPaths: selection.currentPaths,
      allPaths: selection.allPaths,
      guidance: isScopeSetupComplete(selection)
        ? "Scope folders are configured."
        : "Select at least one folder for current and all scopes, then save setup.",
    };
  } catch (error) {
    return {
      complete: false,
      canManage: true,
      configPath: runtime.configPath,
      currentPaths: [],
      allPaths: [],
      guidance: error instanceof Error
        ? `Mindmap config could not be read: ${error.message}`
        : "Mindmap config could not be read.",
    };
  }
}

export function saveScopeSetup(status: ScopeSetupStatus, selection: ScopeSelection): string {
  if (!status.canManage || !status.configPath) {
    throw new Error(status.guidance);
  }

  const updated = updateScopeSelection(fs.readFileSync(status.configPath, "utf8"), selection);
  fs.writeFileSync(status.configPath, updated, "utf8");
  return status.configPath;
}

export function getLlmProviderConfigStatus(runtime: ResolvedRuntime, canManageConfig: boolean): LlmProviderConfigStatus {
  if (!runtime.valid) {
    const error = runtime.messages.find((message) => message.level === "error");
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      canManage: false,
      configPath: null,
      guidance: error?.message ?? "Mindmap runtime is not ready.",
    };
  }

  if (!canManageConfig) {
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      canManage: false,
      configPath: runtime.configPath,
      guidance: "Provider setup controls only the bundled plugin config. Reset config path to default or update your custom config manually.",
    };
  }

  try {
    const config = readRuntimeConfig(runtime.configPath);
    const provider = config.llm_provider === "openai_compatible" ? "openai_compatible" : "ollama";
    const templateKwargs = typeof config.llm_chat_template_kwargs === "object" && config.llm_chat_template_kwargs !== null && !Array.isArray(config.llm_chat_template_kwargs)
      ? config.llm_chat_template_kwargs as Record<string, unknown>
      : {};
    const maxTokens = Number.parseInt(String(config.llm_max_tokens ?? DEFAULT_PROVIDER_CONFIG.maxTokens), 10);
    return {
      provider,
      baseUrl: String(config.llm_base_url ?? config.ollama_base_url ?? DEFAULT_PROVIDER_CONFIG.baseUrl),
      model: String(config.llm_model ?? DEFAULT_PROVIDER_CONFIG.model),
      apiKey: String(config.llm_api_key ?? ""),
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_PROVIDER_CONFIG.maxTokens,
      enableThinking: templateKwargs.enable_thinking === false ? false : true,
      canManage: true,
      configPath: runtime.configPath,
      guidance: "LLM provider config is editable.",
    };
  } catch (error) {
    return {
      ...DEFAULT_PROVIDER_CONFIG,
      canManage: true,
      configPath: runtime.configPath,
      guidance: error instanceof Error
        ? `Mindmap config could not be read: ${error.message}`
        : "Mindmap config could not be read.",
    };
  }
}

export function saveLlmProviderConfig(status: LlmProviderConfigStatus, providerConfig: LlmProviderConfig): string {
  if (!status.canManage || !status.configPath) {
    throw new Error(status.guidance);
  }

  const config = readRuntimeConfig(status.configPath);
  config.llm_provider = providerConfig.provider;
  config.llm_base_url = providerConfig.baseUrl.trim();
  config.llm_model = providerConfig.model.trim();
  const trimmedApiKey = providerConfig.apiKey.trim();
  config.llm_api_key = trimmedApiKey;
  if (trimmedApiKey !== "") {
    config.llm_api_key_env = "";
  }
  config.llm_max_tokens = Number.isFinite(providerConfig.maxTokens) && providerConfig.maxTokens > 0
    ? Math.trunc(providerConfig.maxTokens)
    : 1024;

  const templateKwargs = typeof config.llm_chat_template_kwargs === "object" && config.llm_chat_template_kwargs !== null && !Array.isArray(config.llm_chat_template_kwargs)
    ? config.llm_chat_template_kwargs as Record<string, unknown>
    : {};
  templateKwargs.enable_thinking = providerConfig.enableThinking;
  config.llm_chat_template_kwargs = templateKwargs;

  fs.writeFileSync(status.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return status.configPath;
}
