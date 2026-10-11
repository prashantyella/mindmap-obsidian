import type { ScoredNote } from "./vectorTypes";

/** Deterministic ranking: descending score, then ascending canonical path. */
export function compareScored(a: ScoredNote, b: ScoredNote): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

/** Exact bounded selection. Keeps only the best `limit` items, then emits them in canonical ranking order. */
export class TopKAccumulator {
  private readonly heap: ScoredNote[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer.");
  }

  add(item: ScoredNote): void {
    if (this.limit === 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(item);
      this.siftUp(this.heap.length - 1);
    } else if (compareScored(item, this.heap[0]) < 0) {
      this.heap[0] = item;
      this.siftDown();
    }
  }

  values(): ScoredNote[] { return [...this.heap].sort(compareScored); }

  private swap(a: number, b: number): void { [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]]; }
  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareScored(this.heap[index], this.heap[parent]) <= 0) break;
      this.swap(index, parent);
      index = parent;
    }
  }
  private siftDown(): void {
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) return;
      const right = left + 1;
      let worse = left;
      if (right < this.heap.length && compareScored(this.heap[right], this.heap[left]) > 0) worse = right;
      if (compareScored(this.heap[worse], this.heap[index]) <= 0) return;
      this.swap(index, worse);
      index = worse;
    }
  }
}

export function selectTopK(items: Iterable<ScoredNote>, limit: number): ScoredNote[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("limit must be a non-negative integer.");
  const accumulator = new TopKAccumulator(limit);
  for (const item of items) accumulator.add(item);
  return accumulator.values();
}
