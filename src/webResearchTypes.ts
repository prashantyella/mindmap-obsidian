export type WebResearchMode = "off" | "manual";
export type WebResearchActivity = "off" | "ready" | "deriving" | "searching" | "writing" | "error";

export interface ResearchRequest {
  text: string;
  title?: string;
  bookTitle?: string;
  maxChars: number;
}

export interface ResearchSource {
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  retrievedAt: string;
  highlights: string[];
}

export interface ResearchResult {
  synthesis: string;
  sources: ResearchSource[];
}

export interface ResearchProvider {
  search(queries: string[]): Promise<ResearchSource[]>;
}

export class WebResearchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export const MAX_RESEARCH_INPUT_CHARS = 4_000;
export const MAX_RESEARCH_HIGHLIGHT_CHARS = 800;
export const MAX_RESEARCH_SOURCES = 5;
export const MAX_RESEARCH_QUERIES = 2;

export function boundResearchText(value: string, limit = MAX_RESEARCH_INPUT_CHARS): string {
  return value.replace(/\r\n?/g, "\n").trim().slice(0, limit);
}

export function normalizeResearchSource(value: unknown, retrievedAt: string): ResearchSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.url !== "string" || typeof source.title !== "string") return null;
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const clean = (input: string, limit: number) => input.split("").filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("").replace(/mindmap:(research|apple-books)/gi, "").replace(/\s+/g, " ").trim().slice(0, limit);
  const title = clean(source.title, 300);
  if (!title) return null;
  const highlights = Array.isArray(source.highlights)
    ? source.highlights.filter((item): item is string => typeof item === "string").map((item) => clean(boundResearchText(item, MAX_RESEARCH_HIGHLIGHT_CHARS), MAX_RESEARCH_HIGHLIGHT_CHARS)).filter(Boolean).slice(0, 3)
    : typeof source.text === "string"
      ? [boundResearchText(source.text, MAX_RESEARCH_HIGHLIGHT_CHARS)].filter(Boolean)
      : [];
  const date = typeof source.publishedAt === "string" ? source.publishedAt : source.publishedDate;
  const publishedAt = typeof date === "string" && !Number.isNaN(Date.parse(date))
    ? new Date(date).toISOString()
    : undefined;
  return {
    title,
    url: url.toString(),
    ...(typeof source.author === "string" && clean(source.author, 200) ? { author: clean(source.author, 200) } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    retrievedAt,
    highlights,
  };
}

export function deduplicateResearchSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = new URL(source.url).toString();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_RESEARCH_SOURCES);
}
