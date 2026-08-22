import {
  deduplicateResearchSources,
  MAX_RESEARCH_QUERIES,
  MAX_RESEARCH_SOURCES,
  normalizeResearchSource,
  type ResearchProvider,
  type ResearchSource,
  WebResearchError,
} from "./webResearchTypes";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_TIMEOUT_MS = 15_000;

export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export class ExaResearchProvider implements ResearchProvider {
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = fetch) {}

  async search(queries: string[]): Promise<ResearchSource[]> {
    const requested = queries.map((query) => query.trim().slice(0, 240)).filter(Boolean).slice(0, MAX_RESEARCH_QUERIES);
    if (requested.length === 0) return [];
    const perQuery = Math.max(1, Math.floor(MAX_RESEARCH_SOURCES / requested.length));
    const responses = await Promise.all(requested.map((query) => this.searchOne(query, perQuery)));
    return deduplicateResearchSources(responses.flat()).slice(0, MAX_RESEARCH_SOURCES);
  }

  private async searchOne(query: string, numResults: number): Promise<ResearchSource[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXA_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(EXA_SEARCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify({
          query,
          type: "fast",
          numResults,
          moderation: true,
          contents: { highlights: true, text: { maxCharacters: 800 } },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WebResearchError(`EXA_HTTP_${response.status}`, `Web Research provider request failed (${response.status}).`);
      }
      const body = await response.json() as unknown;
      const results = body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : [];
      const retrievedAt = new Date().toISOString();
      return results.map((item) => normalizeResearchSource(item, retrievedAt)).filter((item): item is ResearchSource => item !== null);
    } catch (error) {
      if (error instanceof WebResearchError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new WebResearchError("EXA_TIMEOUT", "Web Research provider timed out.");
      }
      throw new WebResearchError("EXA_NETWORK", "Web Research provider network request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}
