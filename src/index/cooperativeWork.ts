export interface CooperativeWorkOptions {
  signal?: AbortSignal;
  sliceMs?: number;
  now?: () => number;
  yieldControl?: (signal?: AbortSignal) => Promise<void>;
  onSlice?: (durationMs: number) => void;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/** A lifecycle-safe browser-timer yield: abort clears both timer and listener before rejecting. */
export function yieldWithWindowTimer(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = window.setTimeout(() => finish(resolve), 0);
    const onAbort = () => {
      window.clearTimeout(timer);
      finish(() => reject(abortError(signal)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs bounded blocks and yields after a measured slice reaches the configured target. */
export async function runCooperativeBlocks(
  total: number,
  blockSize: number,
  work: (start: number, end: number) => void,
  options: CooperativeWorkOptions = {},
): Promise<{ maxSliceMs: number; yieldCount: number }> {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error("invalid cooperative work bounds.");
  const sliceMs = options.sliceMs ?? 4;
  if (!Number.isFinite(sliceMs) || !(sliceMs > 0)) throw new Error("sliceMs must be finite and positive.");
  const now = options.now ?? (() => performance.now());
  const yieldControl = options.yieldControl ?? yieldWithWindowTimer;
  let sliceStarted = now();
  let maxSliceMs = 0;
  let yieldCount = 0;
  throwIfAborted(options.signal);
  for (let start = 0; start < total; start += blockSize) {
    throwIfAborted(options.signal);
    work(start, Math.min(total, start + blockSize));
    const elapsed = now() - sliceStarted;
    maxSliceMs = Math.max(maxSliceMs, elapsed);
    if (start + blockSize < total && elapsed >= sliceMs) {
      options.onSlice?.(elapsed);
      await yieldControl(options.signal);
      throwIfAborted(options.signal);
      yieldCount += 1;
      sliceStarted = now();
    }
  }
  const finalSlice = now() - sliceStarted;
  maxSliceMs = Math.max(maxSliceMs, finalSlice);
  options.onSlice?.(finalSlice);
  return { maxSliceMs, yieldCount };
}
