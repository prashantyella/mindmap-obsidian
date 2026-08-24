const DEFAULT_DEBOUNCE_MS = 500;

export interface PendingSummary {
  total: number;
  items: string[];
}

export interface PendingMetrics {
  durationMs: number;
  filesListed: number;
  filesScanned: number;
  filesUpdated: number;
  totalTracked: number;
  dirtyPaths: number;
  stateReloaded: boolean;
  configReloaded: boolean;
}

export interface PendingSnapshot {
  available: boolean;
  reason: string;
  current: PendingSummary;
  all: PendingSummary;
  metrics: PendingMetrics;
  lastUpdatedAt: number | null;
}

export function emptySummary(): PendingSummary {
  return { total: 0, items: [] };
}

export function emptyMetrics(): PendingMetrics {
  return {
    durationMs: 0,
    filesListed: 0,
    filesScanned: 0,
    filesUpdated: 0,
    totalTracked: 0,
    dirtyPaths: 0,
    stateReloaded: false,
    configReloaded: false,
  };
}

/**
 * Generic trailing debounce: collapses repeated `trigger()` calls into one
 * `callback()` invocation after `delayMs` of quiet. Used by
 * `productionPendingScan.ts` to coalesce bursts of vault-change events into
 * a single pending-notes rescan.
 */
export class DebouncedRefreshController {
  private handle: unknown = null;

  constructor(
    private readonly setTimer: (callback: () => void, delayMs: number) => unknown,
    private readonly clearTimer: (handle: unknown) => void,
    private readonly callback: () => void,
    private readonly delayMs = DEFAULT_DEBOUNCE_MS,
  ) { }

  trigger(): void {
    if (this.handle) {
      this.clearTimer(this.handle);
    }
    this.handle = this.setTimer(() => {
      this.handle = null;
      this.callback();
    }, this.delayMs);
  }

  dispose(): void {
    if (this.handle) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }
}
