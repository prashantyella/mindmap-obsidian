import { isTerminalJobStatus } from "../jobs/jobTypes";
import { emptyMetrics, emptySummary, DebouncedRefreshController, type PendingSnapshot } from "../pendingScan";
import { PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_CURRENT, type ProductionEngine } from "./productionEngine";
import type { NoteIdentityV1 } from "./contracts";

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
  private dirtyPaths = new Set<string>();
  private discovered = new Map<string, Map<string, { identity: NoteIdentityV1; sourceHash: string }>>();
  private catalogCache: Awaited<ReturnType<ProductionEngine["indexStore"]["snapshotCatalog"]>> | undefined;
  private catalogRevision: number | null = null;
  private fullRefreshRequested = false;

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

  /** `paths` scopes the refresh to specific changed files when non-empty; an empty array (settings/scope/recovery callers) forces a full discovery that replaces both scope caches entirely, even when targeted dirty paths are already queued. */
  requestRefresh(reason: string, paths: string[] = []): void {
    if (paths.length === 0) {
      this.fullRefreshRequested = true;
    }
    for (const path of paths) this.dirtyPaths.add(path);
    this.deps.log(`Pending refresh requested: ${reason}${paths.length ? ` (${paths.join(", ")})` : ""}`);
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

    let scanPaths: string[] = [];
    let wasFullRefresh = false;
    try {
      wasFullRefresh = this.fullRefreshRequested;
      this.fullRefreshRequested = false;
      scanPaths = [...this.dirtyPaths];
      this.dirtyPaths.clear();
      const paths = scanPaths;
      const revisionBefore = typeof engine.indexStore.getRevision === "function" ? engine.indexStore.getRevision() : 0;
      let targeted = !wasFullRefresh && paths.length > 0 && this.discovered.size > 0 && typeof engine.getPendingCandidatesForPaths === "function";
      let currentDiscovered: { identity: NoteIdentityV1; sourceHash: string }[];
      let allDiscovered: { identity: NoteIdentityV1; sourceHash: string }[];
      let jobs: Awaited<ReturnType<ProductionEngine["jobStore"]["list"]>>;
      if (targeted) {
        const [currentResult, allResult, jobsResult] = await Promise.all([
          engine.getPendingCandidatesForPaths(PRODUCTION_SCOPE_CURRENT, paths),
          engine.getPendingCandidatesForPaths(PRODUCTION_SCOPE_ALL, paths),
          engine.jobStore.list(),
        ]);
        jobs = jobsResult;
        if (currentResult === null || allResult === null) {
          // Targeted not supported — fall back to full discovery
          targeted = false;
          [currentDiscovered, allDiscovered] = await Promise.all([
            engine.getPendingCandidates(PRODUCTION_SCOPE_CURRENT),
            engine.getPendingCandidates(PRODUCTION_SCOPE_ALL),
          ]);
        } else {
          currentDiscovered = currentResult;
          allDiscovered = allResult;
        }
      } else {
        [currentDiscovered, allDiscovered, jobs] = await Promise.all([
          engine.getPendingCandidates(PRODUCTION_SCOPE_CURRENT),
          engine.getPendingCandidates(PRODUCTION_SCOPE_ALL),
          engine.jobStore.list(),
        ]);
      }
      if (this.catalogCache === undefined || this.catalogRevision !== revisionBefore) {
        const verifiedCatalog = await engine.indexStore.snapshotCatalog();
        this.catalogCache = verifiedCatalog;
        this.catalogRevision = verifiedCatalog === null ? null : revisionBefore;
      }
      const catalog = this.catalogCache;
      if (typeof engine.indexStore.getRevision === "function" && engine.indexStore.getRevision() !== revisionBefore) this.queuedRefresh = true;

      const merge = (scope: string, items: readonly { identity: NoteIdentityV1; sourceHash: string }[]): { identity: NoteIdentityV1; sourceHash: string }[] => {
        const map = targeted ? this.discovered.get(scope) ?? new Map<string, { identity: NoteIdentityV1; sourceHash: string }>() : new Map<string, { identity: NoteIdentityV1; sourceHash: string }>();
        if (targeted) {
          for (const path of paths) map.delete(path);
        }
        for (const item of items) map.set(item.identity.canonicalPath, item);
        this.discovered.set(scope, map);
        return [...map.values()];
      };
      const currentItems = merge(PRODUCTION_SCOPE_CURRENT, currentDiscovered);
      const allItems = merge(PRODUCTION_SCOPE_ALL, allDiscovered);

      const indexedByPath = new Map<string, { sourceHash: string; relatedVersion?: number }>();
      if (catalog) {
        for (const record of catalog) indexedByPath.set(record.identity.canonicalPath, { sourceHash: record.sourceHash, relatedVersion: record.relatedVersion });
      }
      const queuedHashByPath = new Map<string, string>();
      for (const persisted of jobs) {
        if (persisted.job.kind !== "process-note" || persisted.job.target.kind !== "note") continue;
        if (isTerminalJobStatus(persisted.status)) continue;
        if (typeof persisted.job.sourceHash !== "string") continue;
        queuedHashByPath.set(persisted.job.target.identity.canonicalPath, persisted.job.sourceHash);
      }

      const expectedRelatedVersion = engine.relatedVersion;
      const isPending = (canonicalPath: string, sourceHash: string): boolean => {
        const indexed = indexedByPath.get(canonicalPath);
        if (indexed && indexed.sourceHash === sourceHash) {
          if (expectedRelatedVersion !== undefined && (indexed.relatedVersion ?? 0) < expectedRelatedVersion) return true;
          return false;
        }
        if (queuedHashByPath.get(canonicalPath) === sourceHash) return false;
        return true;
      };

      const currentPending = currentItems.filter((item) => isPending(item.identity.canonicalPath, item.sourceHash));
      const allPending = allItems.filter((item) => isPending(item.identity.canonicalPath, item.sourceHash));
      const end = this.deps.now();

      this.snapshot = {
        available: catalog !== null,
        reason: catalog !== null ? "Pending scan ready." : "The TypeScript index could not be verified; pending counts are unavailable.",
        current: { total: currentPending.length, items: currentPending.slice(0, MAX_PENDING_ITEMS).map((item) => item.identity.canonicalPath) },
        all: { total: allPending.length, items: allPending.slice(0, MAX_PENDING_ITEMS).map((item) => item.identity.canonicalPath) },
        metrics: {
          durationMs: end - start,
          filesListed: allItems.length,
          filesScanned: targeted ? paths.length : allItems.length,
          filesUpdated: paths.length,
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
      for (const path of scanPaths) this.dirtyPaths.add(path);
      if (wasFullRefresh) this.fullRefreshRequested = true;
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
