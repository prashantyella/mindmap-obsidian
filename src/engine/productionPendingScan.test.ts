import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "./contracts";
import { createProductionPendingScanService } from "./productionPendingScan";
import { PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_CURRENT, type ProductionEngine } from "./productionEngine";

function identity(path: string): NoteIdentityV1 {
  return stableNoteIdentity(canonicalizePath(path));
}

interface FakeJob {
  status: "queued" | "active" | "failed" | "cancelled" | "completed";
  job: { kind: "process-note"; target: { kind: "note"; identity: NoteIdentityV1 }; sourceHash?: string };
}

function fakeEngine(options: {
  current?: { identity: NoteIdentityV1; sourceHash: string }[];
  all?: { identity: NoteIdentityV1; sourceHash: string }[];
  catalog?: { identity: NoteIdentityV1; sourceHash: string }[] | null;
  jobs?: FakeJob[];
}): ProductionEngine {
  const current = options.current ?? [];
  const all = options.all ?? current;
  return {
    async getPendingCandidates(scopeId: string) {
      if (scopeId === PRODUCTION_SCOPE_CURRENT) return current;
      if (scopeId === PRODUCTION_SCOPE_ALL) return all;
      return [];
    },
    indexStore: {
      snapshotCatalog: async () => (options.catalog !== undefined ? options.catalog : []),
    },
    jobStore: {
      list: async () => options.jobs ?? [],
    },
  } as unknown as ProductionEngine;
}

function fakeDeps() {
  const logs: string[] = [];
  const updates: number[] = [];
  return {
    log: (message: string) => logs.push(message),
    now: () => Date.now(),
    setTimer: (callback: () => void, _delayMs: number) => setTimeout(callback, 0),
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onUpdated: () => updates.push(1),
    logs,
    updates,
  };
}

void test("ProductionPendingScanService reports unavailable with an empty snapshot when no engine is composed for this vault", async () => {
  const deps = fakeDeps();
  const service = createProductionPendingScanService(() => null, deps.log, deps.onUpdated);
  await service.warm();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.current.total, 0);
  assert.equal(snapshot.all.total, 0);
});

void test("ProductionPendingScanService: a discovered note absent from the committed catalog and with no queued job is pending", async () => {
  const deps = fakeDeps();
  const active = { identity: identity("Notes/active.md"), sourceHash: "a".repeat(64) };
  const engine = fakeEngine({ current: [active], all: [active], catalog: [] });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.current.total, 1);
  assert.deepEqual(snapshot.current.items, ["Notes/active.md"]);
  assert.equal(snapshot.all.total, 1);
});

void test("ProductionPendingScanService: a discovered note whose sourceHash MATCHES the committed catalog record is NOT pending", async () => {
  const deps = fakeDeps();
  const hash = "b".repeat(64);
  const note = { identity: identity("Notes/indexed.md"), sourceHash: hash };
  const engine = fakeEngine({ current: [note], all: [note], catalog: [{ identity: note.identity, sourceHash: hash }] });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.current.total, 0);
  assert.equal(snapshot.all.total, 0);
  assert.equal(snapshot.metrics.totalTracked, 1);
});

void test("ProductionPendingScanService: a STALE committed record (different sourceHash) IS pending again", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/stale.md"), sourceHash: "c".repeat(64) };
  const engine = fakeEngine({ current: [note], all: [note], catalog: [{ identity: note.identity, sourceHash: "d".repeat(64) }] });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(service.getSnapshot().current.total, 1);
});

void test("ProductionPendingScanService: a note already queued/active with a MATCHING sourceHash is NOT re-counted as pending", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/queued.md"), sourceHash: "e".repeat(64) };
  const engine = fakeEngine({
    current: [note],
    all: [note],
    catalog: [],
    jobs: [{ status: "queued", job: { kind: "process-note", target: { kind: "note", identity: note.identity }, sourceHash: note.sourceHash } }],
  });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(service.getSnapshot().current.total, 0);
});

void test("ProductionPendingScanService: a TERMINAL job (completed/failed/cancelled) never suppresses a pending note, even with a matching sourceHash", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/done.md"), sourceHash: "f".repeat(64) };
  const engine = fakeEngine({
    current: [note],
    all: [note],
    catalog: [],
    jobs: [{ status: "completed", job: { kind: "process-note", target: { kind: "note", identity: note.identity }, sourceHash: note.sourceHash } }],
  });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(service.getSnapshot().current.total, 1, "a completed job's sourceHash should have already landed in the committed catalog -- it must never independently suppress pending status");
});

void test("ProductionPendingScanService: a null catalog (verification failed) reports available:false but still runs the comparison without throwing", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/unverified.md"), sourceHash: "1".repeat(64) };
  const engine = fakeEngine({ current: [note], all: [note], catalog: null });
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.current.total, 1, "with no trustworthy catalog, every discovered note is conservatively treated as pending");
});

void test("ProductionPendingScanService uses targeted changed-path discovery after warm without dropping rename/delete paths", async () => {
  const deps = fakeDeps();
  const a = { identity: identity("Notes/a.md"), sourceHash: "a".repeat(64) };
  const b = { identity: identity("Notes/b.md"), sourceHash: "b".repeat(64) };
  const targeted: string[][] = [];
  const engine = {
    async getPendingCandidates() { return [a]; },
    async getPendingCandidatesForPaths(_scope: string, paths: readonly string[]) { targeted.push([...paths]); return paths.includes("Notes/b.md") ? [b] : []; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  service.requestRefresh("rename", ["Notes/a.md", "Notes/b.md"]);
  await service.warm();
  assert.deepEqual(targeted, [["Notes/a.md", "Notes/b.md"], ["Notes/a.md", "Notes/b.md"]]);
  assert.deepEqual(service.getSnapshot().all.items, ["Notes/b.md"]);
});

// --- Full-refresh flag tests ---

void test("ProductionPendingScanService: a no-paths requestRefresh forces full discovery even when dirty paths are queued", async () => {
  const deps = fakeDeps();
  const a = { identity: identity("Notes/a.md"), sourceHash: "a".repeat(64) };
  const b = { identity: identity("Notes/b.md"), sourceHash: "b".repeat(64) };
  let fullCallCount = 0;
  const targetedCalls: string[][] = [];
  const engine = {
    async getPendingCandidates() { fullCallCount++; return [a, b]; },
    async getPendingCandidatesForPaths(_scope: string, paths: readonly string[]) { targetedCalls.push([...paths]); return []; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm(); // initial full scan
  const initialFullCalls = fullCallCount;
  // Queue a dirty path, then request a full refresh (no paths = settings/scope change)
  service.requestRefresh("file change", ["Notes/a.md"]);
  service.requestRefresh("settings change"); // no paths → full refresh forced
  await service.warm();
  // Must have used full discovery, not targeted, despite dirty paths being queued
  assert.equal(targetedCalls.length, 0, "targeted discovery must not be used when fullRefreshRequested is set");
  assert.ok(fullCallCount > initialFullCalls, "full discovery must be called");
});

void test("ProductionPendingScanService: full refresh replaces both scope caches entirely (deleted notes removed)", async () => {
  const deps = fakeDeps();
  const a = { identity: identity("Notes/a.md"), sourceHash: "a".repeat(64) };
  const b = { identity: identity("Notes/b.md"), sourceHash: "b".repeat(64) };
  let discoveredNotes = [a, b];
  const engine = {
    async getPendingCandidates() { return discoveredNotes; },
    async getPendingCandidatesForPaths() { return []; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(service.getSnapshot().all.total, 2);
  // Now note "a" is deleted — a full refresh must not retain it from cache
  discoveredNotes = [b];
  service.requestRefresh("scope change"); // full refresh
  await service.warm();
  assert.equal(service.getSnapshot().all.total, 1);
  assert.deepEqual(service.getSnapshot().all.items, ["Notes/b.md"]);
});

void test("ProductionPendingScanService: fullRefreshRequested is restored on failure", async () => {
  const deps = fakeDeps();
  let shouldFail = true;
  let fullCallCount = 0;
  const engine = {
    async getPendingCandidates() { fullCallCount++; if (shouldFail) throw new Error("scan failed"); return []; },
    async getPendingCandidatesForPaths() { return []; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  // Request full refresh — will fail
  service.requestRefresh("settings change");
  await service.warm();
  assert.equal(service.getSnapshot().available, false, "failed scan reports unavailable");
  // Retry — should still do full discovery (flag was restored)
  shouldFail = false;
  fullCallCount = 0;
  await service.warm();
  assert.ok(fullCallCount > 0, "full discovery must be retried after failure restored the flag");
});

// --- Targeted fallback test ---

void test("ProductionPendingScanService: falls back to full discovery when getPendingCandidatesForPaths returns null", async () => {
  const deps = fakeDeps();
  const a = { identity: identity("Notes/a.md"), sourceHash: "a".repeat(64) };
  let fullCallCount = 0;
  const engine = {
    async getPendingCandidates() { fullCallCount++; return [a]; },
    async getPendingCandidatesForPaths() { return null; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm(); // initial full scan
  const initialFullCalls = fullCallCount;
  // Now trigger a targeted refresh — should fall back to full since targeted returns null
  service.requestRefresh("file change", ["Notes/a.md"]);
  await service.warm();
  assert.ok(fullCallCount > initialFullCalls, "must fall back to full discovery when targeted returns null");
  assert.equal(service.getSnapshot().all.total, 1);
});

// --- Failed scan path restoration test ---

void test("ProductionPendingScanService: dirty paths are restored after a failed scan so the next scan retries them", async () => {
  const deps = fakeDeps();
  let shouldFail = true;
  const targeted: string[][] = [];
  const engine = {
    async getPendingCandidates() { if (shouldFail) throw new Error("boom"); return []; },
    async getPendingCandidatesForPaths(_scope: string, paths: readonly string[]) { if (shouldFail) throw new Error("boom"); targeted.push([...paths]); return []; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  // Initial warm to populate discovered cache
  shouldFail = false;
  await service.warm();
  // Queue paths and then fail
  shouldFail = true;
  service.requestRefresh("rename", ["Notes/x.md"]);
  await service.warm();
  assert.equal(service.getSnapshot().available, false);
  // Retry — the dirty paths should still be present
  shouldFail = false;
  await service.warm();
  assert.ok(targeted.some((call) => call.includes("Notes/x.md")), "dirty paths must be retried after failure");
});

// --- Catalog null retry test ---

void test("ProductionPendingScanService: a null catalog is retried on the next scan (never cached as stable)", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/n.md"), sourceHash: "n".repeat(64) };
  let catalogCalls = 0;
  const engine = {
    async getPendingCandidates() { return [note]; },
    indexStore: {
      getRevision: () => 0,
      snapshotCatalog: async (): Promise<{ identity: NoteIdentityV1; sourceHash: string }[] | null> => { catalogCalls++; return null; },
    },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(service.getSnapshot().available, false, "null catalog → unavailable");
  const callsAfterFirst = catalogCalls;
  // Second scan — null should NOT have been cached; snapshotCatalog must be called again
  await service.warm();
  assert.ok(catalogCalls > callsAfterFirst, "null catalog must not be cached — snapshotCatalog must be called again");
});

// --- Revision-only catalog recheck test ---

void test("ProductionPendingScanService: catalog is not re-verified when revision is unchanged (job-only transitions)", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/n.md"), sourceHash: "n".repeat(64) };
  let catalogCalls = 0;
  const engine = {
    async getPendingCandidates() { return [note]; },
    indexStore: {
      getRevision: () => 1,
      snapshotCatalog: async () => { catalogCalls++; return []; },
    },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  assert.equal(catalogCalls, 1);
  // Second scan with same revision — catalog should be cached
  await service.warm();
  assert.equal(catalogCalls, 1, "catalog must not be re-verified when revision is unchanged");
});

// --- Revision change during discovery triggers follow-up ---

void test("ProductionPendingScanService: a revision change during discovery triggers exactly one follow-up scan", async () => {
  const deps = fakeDeps();
  const note = { identity: identity("Notes/n.md"), sourceHash: "n".repeat(64) };
  let revision = 0;
  let discoveryCalls = 0;
  const engine = {
    async getPendingCandidates() {
      discoveryCalls++;
      // Simulate index mutation happening during discovery
      if (discoveryCalls === 1) revision = 1;
      return [note];
    },
    indexStore: {
      getRevision: () => revision,
      snapshotCatalog: async () => [],
    },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const service = createProductionPendingScanService(() => engine, deps.log, deps.onUpdated);
  await service.warm();
  // Initial scan = 2 calls (current + all), follow-up = 2 more = 4 total
  assert.equal(discoveryCalls, 4, "expected one initial scan and exactly one follow-up scan");
});

// --- Coalesced scans with controlled timer ---

void test("ProductionPendingScanService: multiple requestRefresh calls within debounce window coalesce into one scan", async () => {
  let timerCallback: (() => void) | null = null;
  const controlledDeps = {
    log: (_message: string) => {},
    now: () => Date.now(),
    setTimer: (callback: () => void, _delayMs: number) => { timerCallback = callback; return 1; },
    clearTimer: (_handle: unknown) => { timerCallback = null; },
    onUpdated: () => {},
  };
  const note = { identity: identity("Notes/a.md"), sourceHash: "a".repeat(64) };
  let discoveryCalls = 0;
  const engine = {
    async getPendingCandidates() { discoveryCalls++; return [note]; },
    indexStore: { getRevision: () => 0, snapshotCatalog: async () => [] },
    jobStore: { list: async () => [] },
  } as unknown as ProductionEngine;
  const { ProductionPendingScanService: ScanService } = await import("./productionPendingScan");
  const service = new ScanService(() => engine, controlledDeps);
  // Trigger multiple refreshes before the timer fires
  service.requestRefresh("change 1", ["Notes/a.md"]);
  service.requestRefresh("change 2", ["Notes/b.md"]);
  service.requestRefresh("change 3", ["Notes/c.md"]);
  assert.equal(discoveryCalls, 0, "no scan yet — timer hasn't fired");
  // Fire the debounce timer
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timerCallback is set asynchronously by the debouncer
  if (!timerCallback) throw new Error("a timer must have been scheduled");
  (timerCallback as () => void)();
  // Allow microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Should be exactly one full scan (initial, discovered cache is empty)
  assert.equal(discoveryCalls, 2, "exactly one coalesced scan (2 calls: current + all scopes)");
});
