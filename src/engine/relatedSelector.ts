import type { CanonicalPath, RelatedCandidateKind, RelatedCandidateV1 } from "./contracts";

/**
 * Ports `select_mindmap_links` from python/mindmap.py behaviorally.
 * Selection/tie-breaking only -- rendering (`relatedSectionWriter.ts`,
 * `appleAnnotationWikilinks.ts`) and persistence (note/frontmatter writes)
 * are deliberately out of scope here.
 */
export interface RelatedCandidateScore {
  path: CanonicalPath;
  score: number;
}

export interface RelatedSelectionOptions {
  selfPath: CanonicalPath;
  relatedLimit: number;
  overreachCount: number;
  creativeCount: number;
  creativeMin: number;
  creativeMax: number;
  /** Candidates scoring below this are excluded entirely (Python's `min_score` in `related_from_chunks`). Defaults to no minimum. */
  minScore?: number;
  /**
   * Excludes structurally unsafe or otherwise ineligible candidates (e.g. a
   * plugin-internal path, or a note that fails individual-note eligibility)
   * before selection runs. Defaults to accepting every candidate.
   */
  isEligible?: (path: CanonicalPath) => boolean;
}

function topLevelFolder(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? path : path.slice(0, slash);
}

/**
 * Deduplicates by path (keeping the first/highest-scoring occurrence, since
 * candidates are sorted descending by score before this runs), excludes
 * `selfPath`, non-finite/negative scores, anything below `minScore`, and
 * anything `isEligible` rejects. The dedupe-by-first-occurrence choice keeps
 * the highest score for a path that appears more than once, since sorting
 * happens first.
 */
function sanitizeCandidates(candidates: readonly RelatedCandidateScore[], options: RelatedSelectionOptions): RelatedCandidateScore[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: RelatedCandidateScore[] = [];
  for (const candidate of sorted) {
    if (candidate.path === options.selfPath) continue;
    if (!Number.isFinite(candidate.score)) continue;
    if (options.minScore !== undefined && candidate.score < options.minScore) continue;
    if (options.isEligible && !options.isEligible(candidate.path)) continue;
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    out.push(candidate);
  }
  return out;
}

/**
 * Four-phase selection mirroring `select_mindmap_links` exactly: highest-
 * scoring "core" picks first, then forced cross-domain "overreach" picks,
 * then mid-similarity-band "creative" picks, then any remaining slots filled
 * with the next-best-scoring candidates ("fill"). Each phase walks the same
 * sanitized, score-descending candidate list and skips anything already
 * picked, so ties resolve by original (post-sanitize) relative order.
 */
export function selectRelatedCandidates(candidates: readonly RelatedCandidateScore[], options: RelatedSelectionOptions): RelatedCandidateV1[] {
  if (options.relatedLimit <= 0) return [];

  const sanitized = sanitizeCandidates(candidates, options);
  const selfDomain = topLevelFolder(options.selfPath);
  const picked: { path: CanonicalPath; kind: RelatedCandidateKind }[] = [];
  const pickedSet = new Set<string>();
  const scoreByPath = new Map(sanitized.map((c) => [c.path as string, c.score]));

  const coreCount = Math.max(0, options.relatedLimit - options.overreachCount - options.creativeCount);
  for (const candidate of sanitized) {
    if (pickedSet.has(candidate.path)) continue;
    picked.push({ path: candidate.path, kind: "core" });
    pickedSet.add(candidate.path);
    if (picked.length >= coreCount) break;
  }

  if (options.overreachCount > 0) {
    for (const candidate of sanitized) {
      if (pickedSet.has(candidate.path)) continue;
      if (topLevelFolder(candidate.path) === selfDomain) continue;
      picked.push({ path: candidate.path, kind: "overreach" });
      pickedSet.add(candidate.path);
      if (picked.length >= coreCount + options.overreachCount) break;
    }
  }

  if (options.creativeCount > 0) {
    for (const candidate of sanitized) {
      if (pickedSet.has(candidate.path)) continue;
      if (candidate.score >= options.creativeMin && candidate.score <= options.creativeMax) {
        picked.push({ path: candidate.path, kind: "creative" });
        pickedSet.add(candidate.path);
      }
      if (picked.length >= coreCount + options.overreachCount + options.creativeCount) break;
    }
  }

  for (const candidate of sanitized) {
    if (picked.length >= options.relatedLimit) break;
    if (pickedSet.has(candidate.path)) continue;
    picked.push({ path: candidate.path, kind: "fill" });
    pickedSet.add(candidate.path);
  }

  return picked.slice(0, options.relatedLimit).map(({ path, kind }) => ({
    schemaVersion: 1,
    path,
    score: scoreByPath.get(path) ?? 0,
    kind,
  }));
}
