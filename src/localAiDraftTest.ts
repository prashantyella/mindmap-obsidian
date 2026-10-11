import { validateOllamaEndpoint } from "./engine/ollamaEmbeddingProvider";
import type { LocalAiConfig } from "./pluginConfig";

const MAX_RESPONSE_CHARS = 1_000_000;

function comparableModelName(model: string): string {
  const trimmed = model.trim();
  return trimmed.includes(":") || trimmed.includes("@") ? trimmed : `${trimmed}:latest`;
}

export async function testLocalAiDraft(config: LocalAiConfig, fetchImpl: typeof fetch): Promise<string> {
  if (!config.embedModel.trim()) {
    throw new Error("Embedding model is required. Enter the model installed in Ollama.");
  }
  if (!config.llmModel.trim()) {
    throw new Error("Summaries and tags model is required. Enter the model installed in Ollama.");
  }
  const targets = new Map<string, string[]>();
  for (const [rawUrl, model] of [[config.embedBaseUrl, config.embedModel], [config.llmBaseUrl, config.llmModel]] as const) {
    const baseUrl = validateOllamaEndpoint(rawUrl.trim());
    const models = targets.get(baseUrl) ?? [];
    if (!models.includes(model.trim())) models.push(model.trim());
    targets.set(baseUrl, models);
  }
  for (const [baseUrl, requiredModels] of targets) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${baseUrl}/api/tags`, { method: "GET", signal: controller.signal });
      if (!response.ok) throw new Error("response");
      text = await response.text();
    } catch {
      throw new Error("Could not reach Ollama. Check the displayed address and make sure Ollama is running.");
    } finally {
      window.clearTimeout(timeout);
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new Error("Ollama returned too much model data to validate safely.");
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error("Ollama returned an unreadable model list."); }
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { models?: unknown }).models)) {
      throw new Error("Ollama returned a malformed model list. Restart or update Ollama, then test again.");
    }
    const installed = new Set<string>();
    for (const entry of (payload as { models: unknown[] }).models) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Ollama returned a malformed model list. Restart or update Ollama, then test again.");
      }
      const { name, model } = entry as { name?: unknown; model?: unknown };
      if (typeof name !== "string" && typeof model !== "string") {
        throw new Error("Ollama returned a malformed model list. Restart or update Ollama, then test again.");
      }
      if (typeof name === "string") installed.add(comparableModelName(name));
      if (typeof model === "string") installed.add(comparableModelName(model));
    }
    const missing = requiredModels.filter((model) => !model || !installed.has(comparableModelName(model)));
    if (missing.length) throw new Error(`Ollama is reachable, but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not installed.`);
  }
  return "Ollama is reachable and the displayed models are installed.";
}
