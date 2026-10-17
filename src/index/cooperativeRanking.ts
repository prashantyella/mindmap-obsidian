import { TopKAccumulator } from "./topK";
import type { ScoredNote } from "./vectorTypes";
import { throwIfAborted, yieldToProcessingLoop } from "./cooperativeWork";

export interface CooperativeRankingOptions {
  blockSize?: number;
  yieldAfterMs?: number;
  now?: () => number;
  yieldToEventLoop?: () => Promise<void>;
  signal?: AbortSignal;
}

/** Async production selector that bounds uninterrupted scoring segments while preserving exact ordering. */
export async function rankCompositeCooperatively(
  itemCount: number,
  scoreAt: (index: number) => ScoredNote | null,
  limit: number,
  options: CooperativeRankingOptions = {},
): Promise<ScoredNote[]> {
  const blockSize = options.blockSize ?? 128;
  const yieldAfterMs = options.yieldAfterMs ?? 4;
  if (!Number.isInteger(itemCount) || itemCount < 0 || !Number.isInteger(blockSize) || blockSize <= 0 || !(yieldAfterMs > 0)) {
    throw new Error("invalid cooperative ranking bounds.");
  }
  const now = options.now ?? (() => performance.now());
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => yieldToProcessingLoop(options.signal));
  const retained = new TopKAccumulator(limit);
  let segmentStarted = now();
  throwIfAborted(options.signal);
  for (let start = 0; start < itemCount; start += blockSize) {
    throwIfAborted(options.signal);
    const end = Math.min(itemCount, start + blockSize);
    for (let index = start; index < end; index += 1) {
      const item = scoreAt(index);
      if (item) retained.add(item);
    }
    if (end < itemCount && now() - segmentStarted >= yieldAfterMs) {
      await yieldToEventLoop();
      throwIfAborted(options.signal);
      segmentStarted = now();
    }
  }
  return retained.values();
}
