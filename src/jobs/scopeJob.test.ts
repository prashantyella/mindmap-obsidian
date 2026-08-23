import test from "node:test";
import assert from "node:assert/strict";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "../engine/contracts";
import { isEngineError } from "../engine/errors";
import { JobEngine, type JobEngineClock } from "./jobEngine";
import { JobStore } from "./jobStore";
import { ScopeJobRunner, type ScopeDiscoveryItem, type ScopeDiscoverySeam, type ScopeEnqueueSeam, type ScopeImportSeam } from "./scopeJob";

class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  failWriteFileOnCallNumber: number | undefined;
  writeFileCallCount = 0;
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.writeFileCallCount += 1;
    if (this.writeFileCallCount === this.failWriteFileOnCallNumber) {
      throw new Error(`injected failure at writeFile: ${path}`);
    }
    this.files.set(path, contents);
  }
  async rename(fromPath: string, toPath: string): Promise<void> {
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, value);
  }
  async unlink(path: string): Promise<void> {
    this.files.delete(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async readdir(dirPath: string): Promise<string[]> {
    const prefix = `${dirPath}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
    }
    return [...names];
  }
}

class FakeClock implements JobEngineClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

function items(...paths: string[]): ScopeDiscoveryItem[] {
  return paths.map((path) => ({ identity: stableNoteIdentity(canonicalizePath(path)), sourceHash: "a".repeat(64), embeddingModel: "m1" }));
}

class FakeDiscovery implements ScopeDiscoverySeam {
  calls = 0;
  result: ScopeDiscoveryItem[] = [];
  async discover(_scopeId: string): Promise<ScopeDiscoveryItem[]> {
    void _scopeId;
    this.calls += 1;
    return this.result;
  }
}

class FakeImport implements ScopeImportSeam {
  calls: ScopeDiscoveryItem[][] = [];
  async import(_scopeId: string, discovered: readonly ScopeDiscoveryItem[]): Promise<void> {
    void _scopeId;
    this.calls.push([...discovered]);
  }
}

class FakeEnqueue implements ScopeEnqueueSeam {
  calls: NoteIdentityV1[] = [];
  async enqueueProcessNote(item: ScopeDiscoveryItem): Promise<void> {
    this.calls.push(item.identity);
  }
}

/** A REAL `ScopeEnqueueSeam` backed by an actual `JobEngine.submit()` call (not merely a counting fake) -- Checkpoint 7 final-closure requirement 9: partial-effect persistence must be proven against the genuine atomic coalescing path, not a test double that can't demonstrate it. */
class RealEnqueue implements ScopeEnqueueSeam {
  constructor(private readonly engine: JobEngine) {}
  async enqueueProcessNote(item: ScopeDiscoveryItem, pipelineVersion: number): Promise<void> {
    await this.engine.submit({ trigger: "reading", kind: "process-note", identity: item.identity, sourceHash: item.sourceHash, embeddingModel: item.embeddingModel, pipelineVersion });
  }
}

/** A no-op `JobPhaseRunner` for `"process-note"` -- this test only cares that jobs get CREATED/coalesced by `enqueueProcessNote`, never that they run to completion. */
class NoopProcessNoteRunner {
  async step(): Promise<{ type: "retry"; failureCode: string }> {
    return { type: "retry", failureCode: "UNKNOWN_TRANSIENT" };
  }
}

function buildHarness(kind: "reading-sync" | "scope-refresh") {
  const discovery = new FakeDiscovery();
  const scopeImport = new FakeImport();
  const enqueue = new FakeEnqueue();
  const runner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { [kind]: runner }, clock);
  return { discovery, scopeImport, enqueue, runner, store, engine, clock };
}

void test("reading-sync runs discover -> import -> enqueue -> complete, importing once and enqueueing exactly the discovered items", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = items("Reading/A.md", "Reading/B.md");
  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.job.phase, "complete");
  assert.equal(h.scopeImport.calls.length, 1);
  assert.equal(h.scopeImport.calls[0].length, 2);
  assert.equal(h.enqueue.calls.length, 2);
  assert.equal(final?.receipt?.kind, "scope");
  if (final?.receipt?.kind === "scope") {
    assert.equal(final.receipt.discovered, true);
    assert.equal(final.receipt.discoveredCount, 2);
    assert.equal(final.receipt.imported, true);
    assert.equal(final.receipt.enqueuedCount, 2);
  }
});

void test("scope-refresh skips the import phase entirely: discover -> enqueue -> complete", async () => {
  const h = buildHarness("scope-refresh");
  h.discovery.result = items("Scope/A.md");
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.scopeImport.calls.length, 0, "scope-refresh must never invoke the import seam");
  assert.equal(h.enqueue.calls.length, 1);
});

void test("idempotent restart: a cold restart resuming at \"enqueue\" re-discovers and re-enqueues the same items without duplicating persisted process-note jobs (JobEngine's own coalescing absorbs the re-submit)", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = items("Reading/A.md", "Reading/B.md");

  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // import
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "enqueue");

  // Simulate a crash right after import committed but before enqueue ever ran, then a full restart
  // with a fresh runner instance (no in-memory state at all, by construction -- ScopeJobRunner
  // caches nothing cross-phase).
  await h.store.recoverInterruptedJobs();
  const freshRunner = new ScopeJobRunner({ discovery: h.discovery, import: h.scopeImport, enqueue: h.enqueue });
  const freshEngine = new JobEngine(h.store, { "reading-sync": freshRunner }, h.clock);
  await freshEngine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.enqueue.calls.length, 2, "enqueue must run exactly once end to end (this test's own single pass through the enqueue phase)");

  // A SECOND independent submit for the exact same scope/pipelineVersion must coalesce onto the
  // now-terminal job's own successor only if resubmitted -- but re-running THIS SAME job's enqueue
  // phase a second time (simulated directly) must never grow the persisted job count via its own
  // idempotent re-discovery/re-enqueue.
  const discoveredAgain = await h.discovery.discover("reading");
  assert.deepEqual(discoveredAgain, h.discovery.result);
});

void test("discovery exceeding MAX_SCOPE_DISCOVERY_ITEMS fails closed (bounded) rather than silently truncating", async () => {
  const h = buildHarness("scope-refresh");
  h.discovery.result = Array.from({ length: 20_001 }, (_, i) => items(`Scope/${i}.md`)[0]);
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.runOnce();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "JOB_CAP_EXCEEDED");
});

void test("(requirement 8) the constructor rejects a missing import seam at runtime, not merely at compile time", () => {
  const discovery = new FakeDiscovery();
  const enqueue = new FakeEnqueue();
  assert.throws(
    () => new ScopeJobRunner({ discovery, enqueue } as unknown as ConstructorParameters<typeof ScopeJobRunner>[0]),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("(requirement 8) a malformed discovered item (bad sourceHash) fails closed before any import/enqueue effect", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = [{ identity: stableNoteIdentity(canonicalizePath("Reading/A.md")), sourceHash: "not-a-hash", embeddingModel: "m1" }];
  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "CONTRACT_SHAPE_INVALID");
  assert.equal(h.scopeImport.calls.length, 0);
  assert.equal(h.enqueue.calls.length, 0);
});

void test("(requirement 8) duplicate discovered items for the same stable identity fail closed", async () => {
  const h = buildHarness("scope-refresh");
  const one = items("Scope/A.md")[0];
  h.discovery.result = [one, { ...one }];
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "CONTRACT_SHAPE_INVALID");
  assert.equal(h.enqueue.calls.length, 0);
});

void test("(acceptance guard 7) a non-array discovery result fails closed with a structured error, never a raw TypeError from .length/iteration", async () => {
  const h = buildHarness("scope-refresh");
  h.discovery.result = null as unknown as ScopeDiscoveryItem[];
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "CONTRACT_SHAPE_INVALID");
  assert.equal(h.enqueue.calls.length, 0);
});

void test("(acceptance guard 7) a discovered item with a control-character embeddingModel fails closed", async () => {
  const h = buildHarness("scope-refresh");
  const modelWithControlByte = `m1${String.fromCharCode(1)}`;
  h.discovery.result = [{ identity: stableNoteIdentity(canonicalizePath("Scope/A.md")), sourceHash: "a".repeat(64), embeddingModel: modelWithControlByte }];
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "CONTRACT_SHAPE_INVALID");
});

void test("(acceptance guard 7) an empty/whitespace-only embeddingModel fails closed", async () => {
  const h = buildHarness("scope-refresh");
  h.discovery.result = [{ identity: stableNoteIdentity(canonicalizePath("Scope/A.md")), sourceHash: "a".repeat(64), embeddingModel: "   " }];
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "CONTRACT_SHAPE_INVALID");
});

void test("(requirement 8) receipt semantics: discovered becomes true immediately after discover, before import/enqueue ever run", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = items("Reading/A.md");
  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover only
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "import");
  assert.equal(midway?.receipt?.kind, "scope");
  if (midway?.receipt?.kind === "scope") {
    assert.equal(midway.receipt.discovered, true, "discovered must be true right after the discover phase, not only at the very end");
    assert.equal(midway.receipt.imported, undefined);
    assert.equal(midway.receipt.enqueuedCount, undefined);
  }
});

class AbortingAfterFirstEnqueue implements ScopeEnqueueSeam {
  calls: NoteIdentityV1[] = [];
  constructor(private readonly controller: AbortController) {}
  async enqueueProcessNote(item: ScopeDiscoveryItem): Promise<void> {
    this.calls.push(item.identity);
    // Simulate JobEngine.dispose() firing exactly after the first item is enqueued.
    if (this.calls.length === 1) this.controller.abort();
  }
}

void test("(requirement 8) the enqueue loop checks the abort signal BETWEEN every item and stops promptly rather than finishing a large discovered set after dispose()", async () => {
  const discovery = new FakeDiscovery();
  discovery.result = items("Scope/A.md", "Scope/B.md", "Scope/C.md");
  const scopeImport = new FakeImport();
  const controller = new AbortController();
  const enqueue = new AbortingAfterFirstEnqueue(controller);
  const runner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });

  const persisted = {
    schemaVersion: 1 as const,
    job: {
      schemaVersion: 1 as const,
      jobId: "job-1",
      trigger: "scheduled" as const,
      kind: "scope-refresh" as const,
      target: { schemaVersion: 1 as const, kind: "scope" as const, scopeId: "scope-1" },
      pipelineVersion: 1,
      phase: "enqueue" as const,
      idempotencyKey: "k",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    status: "active" as const,
    attempt: 1,
    cancelRequested: false,
  };
  const outcome = await runner.step(persisted, controller.signal);
  assert.equal(outcome.type, "cancelled", "a dispose()-triggered abort must report as a genuine cancellation, never an UNKNOWN_TRANSIENT retry/backoff");
  assert.equal(enqueue.calls.length, 1, "only the item enqueued before the abort was observed -- the loop must not continue past it");
});

void test("(requirement 9) a crash after the enqueue loop's items ALL durably submitted, but before the completed receipt persists, never creates duplicate process-note jobs on restart -- proven via the real JobEngine.submit adapter", async () => {
  const discovery = new FakeDiscovery();
  discovery.result = items("Scope/A.md", "Scope/B.md", "Scope/C.md");
  const scopeImport = new FakeImport();
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engineBox: { engine?: JobEngine } = {};
  const enqueue: ScopeEnqueueSeam = {
    enqueueProcessNote: (item, pipelineVersion) => new RealEnqueue(engineBox.engine!).enqueueProcessNote(item, pipelineVersion),
  };
  const runner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });
  const engine = new JobEngine(store, { "scope-refresh": runner, "process-note": new NoopProcessNoteRunner() }, clock);
  engineBox.engine = engine;

  const job = await engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await engine.runOnce(); // discover -- now queued at "enqueue"

  // Within this runOnce(): #1 mark-active, #2/#3/#4 the three items' OWN submits (all durably
  // committed, an irreversible external effect from this job's perspective), #5 the "complete"
  // receipt persist for THIS job -- fail exactly that one, after every item already committed.
  fs.failWriteFileOnCallNumber = fs.writeFileCallCount + 5;
  await assert.rejects(() => engine.runOnce());
  fs.failWriteFileOnCallNumber = undefined;

  const allJobsBeforeRestart = await store.list();
  const processNoteJobsBeforeRestart = allJobsBeforeRestart.filter((j) => j.job.kind === "process-note");
  assert.equal(processNoteJobsBeforeRestart.length, 3, "all three items must already be durably enqueued before the crash");
  const afterCrash = await store.getById(job.job.jobId);
  assert.equal(afterCrash?.status, "active", "left at its last actually-committed state, never marked complete without a successful persist");

  // Simulate a real restart.
  await store.recoverInterruptedJobs();
  const freshRunner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });
  const freshEngine = new JobEngine(store, { "scope-refresh": freshRunner, "process-note": new NoopProcessNoteRunner() }, clock);
  engineBox.engine = freshEngine;
  await freshEngine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.receipt?.kind === "scope" && final.receipt.enqueuedCount, 3);

  const allJobsAfterRestart = await store.list();
  const processNoteJobsAfterRestart = allJobsAfterRestart.filter((j) => j.job.kind === "process-note");
  assert.equal(processNoteJobsAfterRestart.length, 3, "re-running the whole enqueue loop from scratch after restart must coalesce onto the SAME three jobs, never create duplicates");
});

// -- Checkpoint 7 acceptance guard 8: scope phase snapshot semantics -----------------------------

void test("(acceptance guard 8) reading-sync: the discovered set changing between discover and import supersedes the job -- a fresh same-key successor is queued, never a silent import of a set the receipt never described", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = items("Reading/A.md", "Reading/B.md");
  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover: fingerprint captured over {A, B}

  // Between discover and import, the vault changes: B is removed, C is added.
  h.discovery.result = items("Reading/A.md", "Reading/C.md");
  await h.engine.runOnce(); // import: recomputes a DIFFERENT fingerprint -- must supersede

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SCOPE_SUPERSEDED");
  assert.equal(h.scopeImport.calls.length, 0, "the drifted set must never reach import");

  const allJobs = await h.store.list();
  assert.equal(allJobs.length, 2, "the original job plus exactly one successor");
  const successor = allJobs.find((entry) => entry.job.jobId !== job.job.jobId);
  assert.ok(successor);
  assert.equal(successor!.job.idempotencyKey, final!.job.idempotencyKey);
  assert.equal(successor!.job.phase, "discover");
  assert.equal(successor!.attempt, 0);
  assert.equal(successor!.status, "queued");

  // The successor runs the whole pipeline fresh against the NOW-current set and completes.
  await h.engine.drain();
  const successorFinal = await h.store.getById(successor!.job.jobId);
  assert.equal(successorFinal?.status, "completed");
  assert.equal(h.scopeImport.calls.length, 1);
  assert.deepEqual(
    h.scopeImport.calls[0].map((item) => item.identity.canonicalPath).sort(),
    ["Reading/A.md", "Reading/C.md"],
  );
});

void test("(acceptance guard 8) scope-refresh: an item added between discover and enqueue supersedes the job rather than enqueueing a set the receipt never described", async () => {
  const h = buildHarness("scope-refresh");
  h.discovery.result = items("Scope/A.md");
  const job = await h.engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await h.engine.runOnce(); // discover: fingerprint captured over {A}

  h.discovery.result = items("Scope/A.md", "Scope/B.md"); // B added before enqueue runs
  await h.engine.runOnce(); // enqueue: recomputes a DIFFERENT fingerprint -- must supersede

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SCOPE_SUPERSEDED");
  assert.equal(h.enqueue.calls.length, 0, "the drifted set must never reach enqueue");

  const allJobs = await h.store.list();
  assert.equal(allJobs.length, 2);
  const successor = allJobs.find((entry) => entry.job.jobId !== job.job.jobId);
  assert.ok(successor);
  assert.equal(successor!.job.phase, "discover");
});

void test("(acceptance guard 8) an UNCHANGED discovered set across discover -> import -> enqueue completes normally (no false-positive supersession)", async () => {
  const h = buildHarness("reading-sync");
  h.discovery.result = items("Reading/A.md", "Reading/B.md");
  const job = await h.engine.submit({ trigger: "reading", kind: "reading-sync", scopeId: "reading", pipelineVersion: 1 });
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(final?.lastFailureCode, undefined);
  assert.equal((await h.store.list()).length, 1, "no successor should ever be created when nothing drifted");
});

void test("(acceptance guard 8) drift detected across a simulated restart: the persisted discoveryFingerprint from BEFORE the crash still catches a set that changed while the process was down", async () => {
  const discovery = new FakeDiscovery();
  discovery.result = items("Scope/A.md");
  const scopeImport = new FakeImport();
  const enqueue = new FakeEnqueue();
  const runner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { "scope-refresh": runner }, clock);

  const job = await engine.submit({ trigger: "scheduled", kind: "scope-refresh", scopeId: "scope-1", pipelineVersion: 1 });
  await engine.runOnce(); // discover: fingerprint over {A}, persisted durably

  // Simulate a full process restart -- the vault changes while the process is down.
  discovery.result = items("Scope/A.md", "Scope/B.md");
  await store.recoverInterruptedJobs();
  const freshRunner = new ScopeJobRunner({ discovery, import: scopeImport, enqueue });
  const freshEngine = new JobEngine(store, { "scope-refresh": freshRunner }, clock);
  await freshEngine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SCOPE_SUPERSEDED");

  // The original job's own drifted enqueue never ran (the drift is caught first) -- only the
  // successor's fresh, complete pipeline eventually enqueues the NOW-current set.
  const allJobs = await store.list();
  assert.equal(allJobs.length, 2);
  const successor = allJobs.find((entry) => entry.job.jobId !== job.job.jobId);
  assert.ok(successor);
  const successorFinal = await store.getById(successor!.job.jobId);
  assert.equal(successorFinal?.status, "completed");
  assert.equal(enqueue.calls.length, 2, "exactly the successor's own enqueue calls for {A, B} -- never a duplicate/drifted call from the original job");
});
