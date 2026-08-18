import type { LocalResearchModel } from "./webResearch";
import type { ResearchRequest, ResearchSource } from "./webResearchTypes";
import { WebResearchError } from "./webResearchTypes";

export interface LocalResearchConfig {
  provider: "ollama" | "openai_compatible";
  baseUrl: string;
  model: string;
  apiKey?: string;
  chatTemplateKwargs?: Record<string, unknown>;
  temperature?: number;
  timeoutMs?: number;
}

export function createConfiguredLocalResearchModel(config: LocalResearchConfig, fetchImpl: typeof fetch = fetch): LocalResearchModel {
  validateLocalEndpoint(config.baseUrl);
  if (!config.model) throw new WebResearchError("LOCAL_MODEL_UNAVAILABLE", "Configured local model is unavailable.");
  return {
    deriveQueries: async (request) => {
      const content = await complete(config, fetchImpl, `Return only JSON object {"queries":["query"]}. Derive one or two focused web queries.\nTitle: ${request.title ?? ""}\nText: ${request.text}`, true);
      const parsed = parseQueryObject(content);
      if (parsed.length === 0) throw new WebResearchError("QUERY_DERIVATION_FAILED", "Local model did not return research queries.");
      return parsed;
    },
    synthesize: async (request: ResearchRequest, sources: ResearchSource[]) => await complete(config, fetchImpl, `Write a concise grounded research note. Include at least one citation [n]. Cite only [1] through [${sources.length}]. Never emit managed markers.\nText: ${request.text}\nSources:\n${sources.map((source, index) => `${index + 1}. ${source.title}\n${source.highlights.join("\n")}`).join("\n")}`, false),
  };
}

export function validateLocalEndpoint(baseUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new WebResearchError("LOCAL_MODEL_ENDPOINT_INVALID", "Configured local model endpoint is invalid."); }
  if (!(["http:", "https:"].includes(parsed.protocol)) || !(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname))) {
    throw new WebResearchError("LOCAL_MODEL_ENDPOINT_INVALID", "Configured local model must use a loopback HTTP(S) endpoint.");
  }
}

function parseQueryObject(value: string): string[] {
  const bounded = value.trim().slice(0, 2_000);
  const candidate = bounded.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? bounded;
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); } catch { return []; }
  const queries = parsed && typeof parsed === "object" ? (parsed as { queries?: unknown }).queries : undefined;
  return Array.isArray(queries) ? queries.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 240)).filter(Boolean).slice(0, 2) : [];
}

async function complete(config: LocalResearchConfig, fetchImpl: typeof fetch, prompt: string, jsonMode: boolean): Promise<string> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = config.provider === "ollama" ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;
  const body = config.provider === "ollama"
    ? { model: config.model, stream: false, format: jsonMode ? "json" : undefined, options: typeof config.temperature === "number" ? { temperature: config.temperature } : undefined, messages: [{ role: "user", content: prompt }] }
    : { model: config.model, max_tokens: 800, temperature: config.temperature ?? 0.2, response_format: jsonMode ? { type: "json_object" } : undefined, chat_template_kwargs: config.chatTemplateKwargs, messages: [{ role: "user", content: prompt }] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) throw new WebResearchError("LOCAL_MODEL_UNAVAILABLE", "Configured local model is unavailable.");
    const payload = await response.json() as Record<string, unknown>;
    const content = config.provider === "ollama"
      ? (payload.message as Record<string, unknown> | undefined)?.content
      : ((payload.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content;
    if (typeof content !== "string" || !content.trim()) throw new WebResearchError("LOCAL_MODEL_INVALID", "Configured local model returned no usable output.");
    return content.trim().slice(0, 6_000);
  } catch (error) {
    if (error instanceof WebResearchError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new WebResearchError("LOCAL_MODEL_TIMEOUT", "Configured local model timed out.");
    throw new WebResearchError("LOCAL_MODEL_NETWORK", "Configured local model is unavailable.");
  } finally { clearTimeout(timeout); }
}
