/**
 * A from-scratch TypeScript port of Python's `difflib.SequenceMatcher.ratio()`
 * and `difflib.get_close_matches()`, used only by `filterAndMapTags` (ported
 * from `filter_and_map_tags` in python/mindmap.py, which calls
 * `difflib.get_close_matches(tag, controlled_norm, n=1, cutoff=0.75)`).
 *
 * Junk-element handling (`isjunk`/`autojunk`) is intentionally omitted:
 * Python's `autojunk` activates only for sequences of 200+ characters, and
 * this port's own parity claim depends on every input actually staying
 * under that threshold. `closestMatches` therefore enforces
 * `MAX_JUNK_FREE_LENGTH` itself rather than trusting every call site to
 * stay short: `word` and every `possibilities` entry at or above the bound
 * is excluded from matching (documented, not silent -- see
 * `closestMatches`'s own comment) instead of ever being compared with an
 * algorithm whose parity to Python is unverified at that length. A
 * metadata pipeline tag long enough to trip this is already pathological
 * (`normalize_tags`/`filter_and_map_tags` expect short kebab-case themes,
 * not sentences), so excluding it from fuzzy matching -- falling through
 * to the same "no match found" path an ordinary non-matching tag takes --
 * is a safe, conservative behavior change, never a silent correctness gap.
 */
export const MAX_JUNK_FREE_LENGTH = 199;

interface MatchBlock {
  aStart: number;
  bStart: number;
  size: number;
}

function buildB2j(b: string): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let index = 0; index < b.length; index += 1) {
    const char = b[index];
    const list = b2j.get(char);
    if (list) list.push(index);
    else b2j.set(char, [index]);
  }
  return b2j;
}

function findLongestMatch(a: string, b: string, aLow: number, aHigh: number, bLow: number, bHigh: number, b2j: Map<string, number[]>): MatchBlock {
  let bestI = aLow;
  let bestJ = bLow;
  let bestSize = 0;
  let j2len = new Map<number, number>();
  for (let i = aLow; i < aHigh; i += 1) {
    const newJ2len = new Map<number, number>();
    const indices = b2j.get(a[i]) ?? [];
    for (const j of indices) {
      if (j < bLow) continue;
      if (j >= bHigh) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newJ2len.set(j, k);
      if (k > bestSize) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestSize = k;
      }
    }
    j2len = newJ2len;
  }
  while (bestI > aLow && bestJ > bLow && a[bestI - 1] === b[bestJ - 1]) {
    bestI -= 1;
    bestJ -= 1;
    bestSize += 1;
  }
  while (bestI + bestSize < aHigh && bestJ + bestSize < bHigh && a[bestI + bestSize] === b[bestJ + bestSize]) {
    bestSize += 1;
  }
  return { aStart: bestI, bStart: bestJ, size: bestSize };
}

function matchingBlockSizeSum(a: string, b: string): number {
  const b2j = buildB2j(b);
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  let total = 0;
  while (queue.length > 0) {
    const [aLow, aHigh, bLow, bHigh] = queue.pop()!;
    const match = findLongestMatch(a, b, aLow, aHigh, bLow, bHigh, b2j);
    if (match.size === 0) continue;
    total += match.size;
    if (aLow < match.aStart && bLow < match.bStart) {
      queue.push([aLow, match.aStart, bLow, match.bStart]);
    }
    if (match.aStart + match.size < aHigh && match.bStart + match.size < bHigh) {
      queue.push([match.aStart + match.size, aHigh, match.bStart + match.size, bHigh]);
    }
  }
  return total;
}

export function sequenceRatio(a: string, b: string): number {
  const totalLength = a.length + b.length;
  if (totalLength === 0) return 1;
  return (2 * matchingBlockSizeSum(a, b)) / totalLength;
}

/**
 * Mirrors `difflib.get_close_matches(word, possibilities, n, cutoff)`:
 * ratios below `cutoff` are dropped, the rest are ranked by
 * `(ratio, possibility)` descending (Python's `heapq.nlargest` tuple
 * comparison, which breaks ratio ties by comparing the candidate string
 * itself), and only the top `n` survive.
 *
 * `word` longer than `MAX_JUNK_FREE_LENGTH` returns no matches at all
 * (this module's autojunk-free ratio has no verified parity to Python at
 * that length); any `possibilities` entry longer than the same bound is
 * excluded from the candidate pool rather than aborting the whole call --
 * every other, shorter possibility can still match normally.
 */
export function closestMatches(word: string, possibilities: readonly string[], n: number, cutoff: number): string[] {
  if (word.length > MAX_JUNK_FREE_LENGTH) {
    return [];
  }
  const scored = possibilities
    .filter((possibility) => possibility.length <= MAX_JUNK_FREE_LENGTH)
    .map((possibility) => ({ possibility, ratio: sequenceRatio(word, possibility) }))
    .filter((entry) => entry.ratio >= cutoff);
  scored.sort((x, y) => (y.ratio - x.ratio) || (x.possibility < y.possibility ? 1 : x.possibility > y.possibility ? -1 : 0));
  return scored.slice(0, n).map((entry) => entry.possibility);
}
