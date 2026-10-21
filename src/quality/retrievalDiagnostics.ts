/** Known-source recovery, not exhaustive semantic relevance judgments. */
export function knownSourceResult(ranked: readonly string[], equivalentSources: ReadonlySet<string>, k = 8) {
  if (!equivalentSources.size || !Number.isInteger(k) || k < 1) throw new Error("Known-source evaluation requires labels and a positive result limit.");
  const index = ranked.findIndex((p) => equivalentSources.has(p));
  return { hitAt1: index === 0 ? 1 : 0, hitAtK: index >= 0 && index < k ? 1 : 0, reciprocalRankAtK: index >= 0 && index < k ? 1 / (index + 1) : 0, rankWithinCandidates: index < 0 ? null : index + 1 };
}

export function overlapAtK(left: readonly string[], right: readonly string[], k = 8): number {
  const other = new Set(right.slice(0, k));
  const first = new Set(left.slice(0, k));
  const denominator = Math.min(k, Math.max(first.size, other.size));
  return denominator === 0 ? 1 : [...first].filter((p) => other.has(p)).length / denominator;
}
