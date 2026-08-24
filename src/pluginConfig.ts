import { isScopeSetupComplete, validateScopeSelection, type ScopeSelection } from "./onboarding";
import type { MindmapSettings } from "./settings";

export interface ScopeSetupStatus {
  complete: boolean;
  currentPaths: string[];
  allPaths: string[];
  guidance: string;
}

export function getScopeSetupStatus(settings: MindmapSettings): ScopeSetupStatus {
  const selection: ScopeSelection = { currentPaths: settings.scopeCurrentPaths, allPaths: settings.scopeAllPaths };
  const complete = isScopeSetupComplete(selection);
  return {
    complete,
    currentPaths: selection.currentPaths,
    allPaths: selection.allPaths,
    guidance: complete
      ? "Scope folders are configured."
      : "Select at least one folder for current and all scopes, then save setup.",
  };
}

/** Validates and writes the given selection directly into plugin settings -- the caller (main.ts) persists it via `saveSettings()`. Throws with a user-facing message on an invalid (empty) selection. */
export function saveScopeSetup(settings: MindmapSettings, selection: ScopeSelection): void {
  const validated = validateScopeSelection(selection);
  settings.scopeCurrentPaths = validated.currentPaths;
  settings.scopeAllPaths = validated.allPaths;
}

export interface LlmProviderConfigStatus {
  baseUrl: string;
  model: string;
  maxTokens: number;
  guidance: string;
}

/** Ollama-only (Checkpoint 11: the TypeScript engine's local metadata provider is Ollama-only -- see `ProductionEngine`'s own composition -- so this surface no longer models a provider choice, API key, or "thinking" toggle at all). */
export function getLlmProviderConfigStatus(settings: MindmapSettings): LlmProviderConfigStatus {
  return {
    baseUrl: settings.llmBaseUrl,
    model: settings.llmModel,
    maxTokens: settings.llmMaxTokens,
    guidance: "Ollama local metadata model.",
  };
}

export function saveLlmProviderConfig(settings: MindmapSettings, patch: Partial<Pick<LlmProviderConfigStatus, "baseUrl" | "model" | "maxTokens">>): void {
  if (patch.baseUrl !== undefined) settings.llmBaseUrl = patch.baseUrl.trim();
  if (patch.model !== undefined) settings.llmModel = patch.model.trim();
  if (patch.maxTokens !== undefined) settings.llmMaxTokens = Number.isFinite(patch.maxTokens) && patch.maxTokens > 0 ? Math.trunc(patch.maxTokens) : settings.llmMaxTokens;
}
