import { writeResearch } from "./researchWriter";
import type { ReadingVault, VaultEntry } from "./readingVault";
import {
  boundResearchText,
  deduplicateResearchSources,
  normalizeResearchSource,
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  WebResearchError,
} from "./webResearchTypes";

export interface LocalResearchModel {
  deriveQueries(request: ResearchRequest): Promise<string[]>;
  synthesize(request: ResearchRequest, sources: ResearchResult["sources"]): Promise<string>;
}

export interface ManualResearchDependencies {
  provider: ResearchProvider;
  model: LocalResearchModel;
  vault: ReadingVault;
}

export async function researchNote(
  deps: ManualResearchDependencies,
  note: VaultEntry,
  request: ResearchRequest,
): Promise<ResearchResult | null> {
  const bounded = { ...request, text: boundResearchText(request.text, request.maxChars) };
  if (!bounded.text) throw new WebResearchError("RESEARCH_INPUT_EMPTY", "Research needs selected text or an active note excerpt.");
  const queries = (await deps.model.deriveQueries(bounded)).map((query) => query.trim()).filter(Boolean).slice(0, 2);
  if (queries.length === 0) throw new WebResearchError("QUERY_DERIVATION_FAILED", "Local model did not derive a usable research query.");
  const retrievedAt = new Date().toISOString();
  const sources = deduplicateResearchSources((await deps.provider.search(queries))
    .map((source) => normalizeResearchSource(source, source.retrievedAt || retrievedAt))
    .filter((source): source is NonNullable<typeof source> => source !== null));
  if (sources.length === 0) return null;
  const synthesis = await deps.model.synthesize(bounded, sources);
  const result = { synthesis, sources };
  if (!(await writeResearch(deps.vault, note, result))) return null;
  return result;
}
