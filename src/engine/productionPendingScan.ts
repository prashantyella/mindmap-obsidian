import { isTerminalJobStatus } from "../jobs/jobTypes";
import { emptyMetrics, emptySummary, DebouncedRefreshController, type PendingSnapshot } from "../pendingScan";
import { PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_CURRENT, type ProductionEngine } from "./productionEngine";

const MAX_PENDING_ITEMS = 5;
const DEFAULT_DEBOUNCE_MS = 500;

export interface ProductionPendingServiceDeps {
  log(message: string): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  onUpdated?(): void;
}

/**
 * Checkpoint 10B PENDING: the TypeScript replacement for `PendingScanService`
 * -- same public shape (`warm`/`requestRefresh`/`getSnapshot`/`dispose`) and
 * the SAME `PendingSnapshot`/`DebouncedRefreshController` types the Python
 * `state.json`-backed version used, so status-bar/menu code that only ever
 * called those four methods needs no changes at all. The backend is
 * entirely different: no `state.json`, no config-file polling -- "pending"
 * is derived by discovering current on-disk notes through
 * `ProductionEngine.getPendingCandidates` (the SAME `streamFullCatalogDiscovery`
 * pass, and therefore the SAME strict Reading-artifact exclusions,
 * `"scope-refresh"` jobs themselves use) and comparing each discovered
 * `{identity, sourceHash}` against BOTH the fully-verified committed
 * `IndexStore` catalog snapshot AND every non-terminal `"process-note"`
 * job already queued/active for that identity -- a note already queued
 * with a matching `sourceHash` is not re-counted as newly pending.
 */
export class ProductionPendingScanService {
  private readonly debouncer: DebouncedRefreshController;
  private snapshot: PendingSnapshot = {
    available: false,
    reason: "Pending scan has not started yet.",
    current: emptySummary(),
    all: emptySummary(),
    metrics: emptyMetrics(),
    lastUpdatedAt: null,
  };
  private refreshInFlight: Promise<void> | null = null;
  private queuedRefresh = false;

  constructor(
    private readonly getEngine: () => ProductionEngine | null,
    private readonly deps: ProductionPendingServiceDeps,
  ) {
    this.debouncer = new DebouncedRefreshController(
      (callback, delayMs) => deps.setTimer(callback, delayMs),
      (handle) => deps.clearTimer(handle),
      () => { void this.refresh(); },
      DEFAULT_DEBOUNCE_MS,
    );
  }

  async warm(): Promise<void> {
    await this.refresh();
  }

  /** `relpaths` is accepted only to keep the exact call signature `registerVaultRefreshEvents`/existing call sites already use -- a targeted rescan is not worth the complexity a full discovery pass already re-derives everything fresh on every debounced refresh. */
  requestRefresh(reason: string, relpaths: string[] = []): void {
    this.deps.log(`Pending refresh requested: ${reason}${relpaths.length ? ` (${relpaths.join(", ")})` : ""}`);
    this.debouncer.trigger();
  }

  getSnapshot(): PendingSnapshot {
    return this.snapshot;
  }

  dispose(): void {
    this.debouncer.dispose();
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      this.queuedRefresh = true;
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.runRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
      if (this.queuedRefresh) {
        this.queuedRefresh = false;
        await this.refresh();
      }
    }
  }

  private async runRefresh(): Promise<void> {
    const start = this.deps.now();
    const engine = this.getEngine();
    if (!engine) {
      this.snapshot = {
        available: false,
        reason: "The Mindmap TypeScript engine is not available in this vault.",
        current: emptySummary(),
        all: emptySummary(),
        metrics: emptyMetrics(),
        lastUpdatedAt: this.deps.now(),
      };
      this.deps.onUpdated?.();
      return;
    }

    try {
      const [currentDiscovered, allDiscovered, catalog, jobs] = await Promise.all([
        engine.getPendingCandidates(PRODUCTION_SCOPE_CURRENT),
        engine.getPendingCandidates(PRODUCTION_SCOPE_ALL),
        engine.indexStore.snapshotCatalog(),
        engine.jobStore.list(),
      ]);

      const indexedHashByPath = new Map<string, string>();
      if (catalog) {
        for (const record of catalog) indexedHashByPath.set(record.identity.canonicalPath, record.sourceHash);
      }
      const queuedHashByPath = new Map<string, string>();
      for (const persisted of jobs) {
        if (persisted.job.kind !== "process-note" || persisted.job.target.kind !== "note") continue;
        if (isTerminalJobStatus(persisted.status)) continue;
        if (typeof persisted.job.sourceHash !== "string") continue;
        queuedHashByPath.set(persisted.job.target.identity.canonicalPath, persisted.job.sourceHash);
      }

      const isPending = (canonicalPath: string, sourceHash: string): boolean => {
        if (indexedHashByPath.get(canonicalPath) === sourceHash) return false;
        if (queuedHashByPath.get(canonicalPath) === sourceHash) return false;
        return true;
      };

      const currentPending = currentDiscovered.filter((item) => isPending(item.identity.canonicalPath, item.sourceHash));
      const allPending = allDiscovered.filter((item) => isPending(item.identity.canonicalPath, item.sourceHash));
      const end = this.deps.now();

      this.snapshot = {
        available: catalog !== null,
        reason: catalog !== null ? "Pending scan ready." : "The TypeScript index could not be verified; pending counts are unavailable.",
        current: { total: currentPending.length, items: currentPending.slice(0, MAX_PENDING_ITEMS).map((item) => item.identity.canonicalPath) },
        all: { total: allPending.length, items: allPending.slice(0, MAX_PENDING_ITEMS).map((item) => item.identity.canonicalPath) },
        metrics: {
          durationMs: end - start,
          filesListed: allDiscovered.length,
          filesScanned: allDiscovered.length,
          filesUpdated: allDiscovered.length,
          totalTracked: catalog?.length ?? 0,
          dirtyPaths: 0,
          stateReloaded: false,
          configReloaded: false,
        },
        lastUpdatedAt: end,
      };
      this.deps.onUpdated?.();
      this.deps.log(
        `Pending scan updated in ${this.snapshot.metrics.durationMs}ms (current ${currentPending.length}, all ${allPending.length}, tracked ${this.snapshot.metrics.totalTracked}).`,
      );
    } catch (error) {
      this.snapshot = {
        available: false,
        reason: error instanceof Error ? error.message : "Pending scan failed.",
        current: emptySummary(),
        all: emptySummary(),
        metrics: emptyMetrics(),
        lastUpdatedAt: this.deps.now(),
      };
      this.deps.onUpdated?.();
      this.deps.log(`Pending scan failed: ${this.snapshot.reason}`);
    }
  }
}

export function createProductionPendingScanService(
  getEngine: () => ProductionEngine | null,
  log: (message: string) => void,
  onUpdated?: () => void,
): ProductionPendingScanService {
  return new ProductionPendingScanService(getEngine, {
    log,
    now: () => Date.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle as ReturnType<typeof window.setTimeout>),
    onUpdated,
  });
}
