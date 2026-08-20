import { READING_SOURCE_END } from "./readingTypes";
import type { ReadingVault, VaultEntry } from "./readingVault";
import type { ResearchResult, ResearchSource } from "./webResearchTypes";

export const RESEARCH_START = "<!-- mindmap:research:start -->";
export const RESEARCH_END = "<!-- mindmap:research:end -->";

export function validateSynthesis(synthesis: string, sources: ResearchSource[]): string | null {
  const trimmed = synthesis.trim().slice(0, 6_000);
  if (!trimmed || sources.length === 0) return null;
  if (/mindmap:(research|apple-books)/i.test(trimmed)) return null;
  const citations = [...trimmed.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (citations.length === 0 || citations.some((index) => index < 1 || index > sources.length)) return null;
  return trimmed;
}

function renderSourceLines(sources: ResearchSource[]): string[] {
  const lines: string[] = [];
  for (const [index, source] of sources.entries()) {
    lines.push(`${index + 1}. [${escapeLinkText(source.title)}](<${source.url}>)`);
    if (source.author) lines.push(`   Author: ${source.author}`);
    if (source.publishedAt) lines.push(`   Published: ${source.publishedAt}`);
    lines.push(`   Retrieved: ${source.retrievedAt}`);
  }
  return lines;
}

export function renderResearchBlock(result: ResearchResult): string | null {
  const synthesis = validateSynthesis(result.synthesis, result.sources);
  if (!synthesis) return null;
  return [RESEARCH_START, "## Research", synthesis, "", "### Sources", ...renderSourceLines(result.sources), RESEARCH_END].join("\n");
}

export function renderCompanionResearchContent(result: ResearchResult): string | null {
  const synthesis = validateSynthesis(result.synthesis, result.sources);
  if (!synthesis) return null;
  return [synthesis, "", "## Sources", ...renderSourceLines(result.sources)].join("\n");
}

export async function writeResearch(vault: ReadingVault, note: VaultEntry, result: ResearchResult): Promise<boolean> {
  const block = renderResearchBlock(result);
  if (!block) return false;
  const existing = await vault.read(note);
  const next = upsertResearchBlock(existing, block);
  if (next === existing) return true;
  await vault.modify(note, next);
  return true;
}

export function upsertResearchBlock(text: string, block: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const rendered = block.replace(/\n/g, newline);
  const start = text.indexOf(RESEARCH_START);
  const end = start >= 0 ? text.indexOf(RESEARCH_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const after = end + RESEARCH_END.length;
    return `${text.slice(0, start)}${rendered}${text.slice(after)}`;
  }
  if (start >= 0 || end >= 0) throw new Error("Managed research markers are incomplete.");
  const sourceEnd = text.indexOf(READING_SOURCE_END);
  if (sourceEnd >= 0) {
    const after = sourceEnd + READING_SOURCE_END.length;
    return `${text.slice(0, after)}${newline}${newline}${rendered}${text.slice(after)}`;
  }
  return `${text}${text.endsWith(newline) ? newline : `${newline}${newline}`}${rendered}${newline}`;
}

function escapeLinkText(value: string): string {
  return value.split("[").join("\\[").split("]").join("\\]");
}
