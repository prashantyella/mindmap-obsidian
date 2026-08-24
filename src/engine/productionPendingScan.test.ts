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
