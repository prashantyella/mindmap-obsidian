import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, computeJobIdempotencyKey, stableNoteIdentity, type QueueJobV1 } from "../engine/contracts";
import { isEngineError } from "../engine/errors";
import { JobStore } from "./jobStore";
import type { PersistedJobV1 } from "./jobTypes";

type FaultPoint = "writeFile" | "fsync" | "rename" | "readFile" | "unlink" | "fsyncDir";

class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  faults = new Set<FaultPoint>();
  corruptNextReadOf = new Set<string>();

  async readFile(path: string): Promise<string> {
    if (this.corruptNextReadOf.has(path)) {
      this.corruptNextReadOf.delete(path);
      return "{not-valid-json";
    }
    if (this.faults.has("readFile")) throw new Error(`injected failure at readFile: ${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  async writeFile(path: string, contents: string): Promise<void> {
    if (this.faults.has("writeFile")) throw new Error(`injected failure at writeFile: ${path}`);
    this.files.set(path, contents);
  }

  renameCallCount = 0;

  async rename(fromPath: string, toPath: string): Promise<void> {
    this.renameCallCount += 1; // `rename` is AtomicStore's one atomic-commit call -- its count is exactly "how many times something was actually persisted"
    if (this.faults.has("rename")) throw new Error(`injected failure at rename: ${fromPath}`);
    const value = this.files.get(fromPath);
    if (value === undefined) throw new Error(`ENOENT: ${fromPath}`);
    this.files.delete(fromPath);
    this.files.set(toPath, value);
  }

  async unlink(path: string): Promise<void> {
    if (this.faults.has("unlink")) throw new Error(`injected failure at unlink: ${path}`);
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

  async fsync(path: string): Promise<void> {
    if (this.faults.has("fsync")) throw new Error(`injected failure at fsync: ${path}`);
  }

  async fsyncDir(): Promise<void> {
    if (this.faults.has("fsyncDir")) throw new Error("injected failure at fsyncDir");
  }
}

function buildJob(overrides: Partial<Pick<QueueJobV1, "trigger" | "phase" | "createdAt" | "updatedAt">> & { path?: string } = {}): QueueJobV1 {
  const identity = stableNoteIdentity(canonicalizePath(overrides.path ?? "Notes/A.md"));
  const trigger = overrides.trigger ?? "manual";
  const kind = "process-note" as const;
  const target = { schemaVersion: 1 as const, kind: "note" as const, identity };
  const pipelineVersion = 1;
  const sourceHash = "a".repeat(64);
  const embeddingModel = "nomic-embed-text";
  const idempotencyKey = computeJobIdempotencyKey(kind, target, pipelineVersion, sourceHash, embeddingModel);
  return {
    schemaVersion: 1,
    jobId: `job-${identity.canonicalPath}-${trigger}-${Math.random().toString(36).slice(2, 8)}`,
    trigger,
    kind,
    target,
    sourceHash,
    embeddingModel,
    pipelineVersion,
    phase: overrides.phase ?? "discover",
    idempotencyKey,
    createdAt: overrides.createdAt ?? "2026-08-23T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-23T00:00:00.000Z",
  };
}

function buildPersisted(overrides: Partial<PersistedJobV1> & { path?: string; trigger?: QueueJobV1["trigger"]; phase?: QueueJobV1["phase"] } = {}): PersistedJobV1 {
  return {
    schemaVersion: 1,
    job: buildJob({ path: overrides.path, trigger: overrides.trigger, phase: overrides.phase }),
    status: overrides.status ?? "queued",
    attempt: overrides.attempt ?? 0,
    cancelRequested: overrides.cancelRequested ?? false,
    lastFailureCode: overrides.lastFailureCode,
    lastFailureClass: overrides.lastFailureClass,
    receipt: overrides.receipt,
  };
}

void test("appendJob then list returns the job in insertion order", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const a = buildPersisted({ path: "Notes/A.md" });
  const b = buildPersisted({ path: "Notes/B.md" });
  await store.appendJob(a);
  await store.appendJob(b);
  const jobs = await store.list();
  assert.deepEqual(
    jobs.map((j) => j.job.jobId),
    [a.job.jobId, b.job.jobId],
  );
});

void test("appendJob rejects a duplicate jobId without mutating the store", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const a = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(a);
  const dupe = { ...a, job: { ...a.job } };
  await assert.rejects(() => store.appendJob(dupe), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  assert.equal((await store.list()).length, 1);
});

void test("appendJob rejects a duplicate ACTIVE idempotencyKey (coalescing enforcement) but allows a second job once the first is terminal", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const first = buildPersisted({ path: "Notes/A.md", trigger: "manual" });
  await store.appendJob(first);
  const second = buildPersisted({ path: "Notes/A.md", trigger: "manual" });
  await assert.rejects(() => store.appendJob(second), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");

  await store.updateJob(first.job.jobId, (current) => ({ ...current, status: "cancelled" }));
  await store.appendJob(second);
  assert.equal((await store.list()).length, 2);
});

void test("getActiveByIdempotencyKey ignores terminal jobs", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(job);
  assert.ok(await store.getActiveByIdempotencyKey(job.job.idempotencyKey));
  await store.updateJob(job.job.jobId, (current) => ({ ...current, status: "cancelled" }));
  assert.equal(await store.getActiveByIdempotencyKey(job.job.idempotencyKey), null);
});

void test("updateJob enforces legal forward-only phase transitions and rejects a skip or backward move", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", phase: "discover" });
  await store.appendJob(job);

  await assert.rejects(
    () => store.updateJob(job.job.jobId, (current) => ({ ...current, job: { ...current.job, phase: "confirm-source" } })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_TRANSITION_INVALID",
  );

  const advanced = await store.updateJob(job.job.jobId, (current) => ({ ...current, job: { ...current.job, phase: "embed" } }));
  assert.equal(advanced.job.phase, "embed");

  await assert.rejects(
    () => store.updateJob(job.job.jobId, (current) => ({ ...current, job: { ...current.job, phase: "discover" } })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_TRANSITION_INVALID",
  );
});

void test("updateJob rejects a decreasing attempt count and an identity field change", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", attempt: 2 });
  await store.appendJob(job);
  await assert.rejects(
    () => store.updateJob(job.job.jobId, (current) => ({ ...current, attempt: 1 })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
  await assert.rejects(
    () => store.updateJob(job.job.jobId, (current) => ({ ...current, job: { ...current.job, jobId: "different-id" } })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("updateJob on a nonexistent jobId throws JOB_NOT_FOUND", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  await assert.rejects(
    () => store.updateJob("missing", (current) => current),
    (error: unknown) => isEngineError(error) && error.code === "JOB_NOT_FOUND",
  );
});

void test("recoverInterruptedJobs converts every active job to queued at its current phase, and is idempotent across repeated startups", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", status: "active", phase: "embed" });
  await store.appendJob(job);
  const recoveredOnce = await store.recoverInterruptedJobs();
  assert.equal(recoveredOnce, 1);
  const after = await store.getById(job.job.jobId);
  assert.equal(after?.status, "queued");
  assert.equal(after?.job.phase, "embed");

  const recoveredTwice = await store.recoverInterruptedJobs();
  assert.equal(recoveredTwice, 0);
});

void test("a fresh JobStore instance over the same fs reloads recovered/persisted state (simulated restart)", async () => {
  const fs = new FakeFs();
  const first = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", status: "active" });
  await first.appendJob(job);

  const second = new JobStore(fs, "/root");
  const recovered = await second.recoverInterruptedJobs();
  assert.equal(recovered, 1);
  const jobs = await second.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "queued");
});

void test("save() write-back failure (fsync fault) leaves the previously committed document unchanged", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const first = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(first);

  fs.faults.add("fsync");
  const second = buildPersisted({ path: "Notes/B.md" });
  await assert.rejects(() => store.appendJob(second));
  fs.faults.delete("fsync");

  const jobs = await store.list();
  assert.deepEqual(
    jobs.map((j) => j.job.jobId),
    [first.job.jobId],
  );
});

void test("rename failure during appendJob leaves the previously committed document unchanged", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const first = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(first);

  fs.faults.add("rename");
  const second = buildPersisted({ path: "Notes/B.md" });
  await assert.rejects(() => store.appendJob(second));
  fs.faults.delete("rename");

  const jobs = await store.list();
  assert.equal(jobs.length, 1);
});

void test("a corrupt/truncated committed file fails closed on next load rather than silently reinterpreting", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  await store.appendJob(buildPersisted({ path: "Notes/A.md" }));

  fs.files.set("/root/jobs/queue.json", "{not-valid-json-at-all");
  const fresh = new JobStore(fs, "/root");
  await assert.rejects(() => fresh.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("a duplicate jobId injected directly into the persisted document fails closed on load", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(job);

  const raw = fs.files.get("/root/jobs/queue.json");
  assert.ok(raw);
  const parsed = JSON.parse(raw) as { data: { jobs: unknown[] } };
  parsed.data.jobs.push(parsed.data.jobs[0]);
  fs.files.set("/root/jobs/queue.json", JSON.stringify(parsed));

  const fresh = new JobStore(fs, "/root");
  await assert.rejects(() => fresh.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("concurrent appendJob calls never lose an update (serialized mutation tail)", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const jobs = Array.from({ length: 20 }, (_, i) => buildPersisted({ path: `Notes/${i}.md` }));
  await Promise.all(jobs.map((job) => store.appendJob(job)));
  const listed = await store.list();
  assert.equal(listed.length, 20);
  const ids = new Set(listed.map((j) => j.job.jobId));
  assert.equal(ids.size, 20);
});

void test("appendOrCoalesce: concurrent identical submits race the atomic mutation and never both append -- exactly one job persisted", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const a = buildPersisted({ path: "Notes/A.md" });
  const b = { ...a, job: { ...a.job, jobId: "different-job-id" } };
  const [r1, r2] = await Promise.all([store.appendOrCoalesce(a), store.appendOrCoalesce(b)]);
  assert.equal(r1.job.job.jobId, r2.job.job.jobId);
  assert.ok(r1.coalesced || r2.coalesced, "exactly one of the two racing submits must observe the other's already-committed job");
  assert.equal((await store.list()).length, 1);
});

void test("appendOrCoalesce returns the existing non-terminal job unmodified (coalesced: true) and returns coalesced: false plus the new job on first append", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const a = buildPersisted({ path: "Notes/A.md" });
  const first = await store.appendOrCoalesce(a);
  assert.equal(first.coalesced, false);
  assert.equal(first.job.job.jobId, a.job.jobId);

  const dupe = { ...a, job: { ...a.job, jobId: "another-id" } };
  const second = await store.appendOrCoalesce(dupe);
  assert.equal(second.coalesced, true);
  assert.equal(second.job.job.jobId, a.job.jobId);
  assert.equal((await store.list()).length, 1);
});

void test("store ownership: mutating a value returned by list()/getById() throws (frozen) and never corrupts committed/cached state", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(job);

  const listed = await store.list();
  assert.throws(() => {
    (listed[0] as { status: string }).status = "completed";
  });

  const fetched = await store.getById(job.job.jobId);
  assert.throws(() => {
    (fetched as unknown as { attempt: number }).attempt = 999;
  });

  const stillListed = await store.list();
  assert.equal(stillListed[0].status, "queued");
  assert.equal(stillListed[0].attempt, 0);
});

void test("store ownership: an updater that mutates its `current` argument in place and then throws leaves committed/cached state byte-identical", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", attempt: 1 });
  await store.appendJob(job);
  const before = await store.getById(job.job.jobId);
  const beforeJson = JSON.stringify(before);

  await assert.rejects(
    () =>
      store.updateJob(job.job.jobId, (current) => {
        // Mutate the working copy in place, then throw -- this must never reach the cache/store.
        (current as unknown as { attempt: number }).attempt = 12345;
        (current as unknown as { status: string }).status = "completed";
        throw new Error("deliberate updater failure after mutation");
      }),
    /deliberate updater failure/,
  );

  const after = await store.getById(job.job.jobId);
  assert.equal(JSON.stringify(after), beforeJson, "committed/cached state must be byte-identical to before the failed update");
  assert.equal(after?.attempt, 1);
  assert.equal(after?.status, "queued");
});

void test("store ownership: a reader concurrent with an in-flight save observes only the prior committed snapshot, never a partially-applied one", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md", phase: "write-overlay" });
  await store.appendJob(job);

  let releaseWrite: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const originalWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (path: string, contents: string) => {
    await gate;
    return originalWriteFile(path, contents);
  };

  const updatePromise = store.updateJob(job.job.jobId, (current) => ({
    ...current,
    status: "completed",
    job: { ...current.job, phase: "complete" },
    receipt: { kind: "note", noteCommitted: true, noteContentHash: "a".repeat(64), overlayCommitted: true },
  }));
  // While the save is gated (mid-flight), a concurrent read must still see the prior committed status.
  const duringWrite = await store.getById(job.job.jobId);
  assert.equal(duringWrite?.status, "queued");

  releaseWrite();
  await updatePromise;
  const after = await store.getById(job.job.jobId);
  assert.equal(after?.status, "completed");
});

function buildSuccessorFor(old: PersistedJobV1, overrides: Partial<Pick<QueueJobV1, "jobId" | "phase">> = {}): PersistedJobV1 {
  return {
    schemaVersion: 1,
    job: {
      ...old.job,
      jobId: overrides.jobId ?? `${old.job.jobId}-successor`,
      phase: overrides.phase ?? "discover",
      createdAt: "2026-08-23T01:00:00.000Z",
      updatedAt: "2026-08-23T01:00:00.000Z",
    },
    status: "queued",
    attempt: 0,
    cancelRequested: false,
  };
}

void test("supersedeWithSuccessor atomically marks the old job terminal and appends a fresh same-key successor in one commit", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);

  const successor = buildSuccessorFor(old);
  const result = await store.supersedeWithSuccessor(
    old.job.jobId,
    (current) => ({ ...current, status: "cancelled", lastFailureCode: "REBUILD_SUPERSEDED", lastFailureClass: "terminal" }),
    successor,
  );
  assert.equal(result.coalesced, false);
  assert.equal(result.old.status, "cancelled");
  assert.equal(result.old.lastFailureCode, "REBUILD_SUPERSEDED");
  assert.equal(result.successor.job.jobId, successor.job.jobId);
  assert.equal(result.successor.status, "queued");

  const jobs = await store.list();
  assert.equal(jobs.length, 2);
  const persistedOld = jobs.find((j) => j.job.jobId === old.job.jobId);
  const persistedSuccessor = jobs.find((j) => j.job.jobId === successor.job.jobId);
  assert.equal(persistedOld?.status, "cancelled");
  assert.equal(persistedSuccessor?.status, "queued");
  assert.equal(persistedSuccessor?.job.idempotencyKey, old.job.idempotencyKey);
});

void test("supersedeWithSuccessor: a store fault during the commit leaves both the old job and the queue byte-identical to before -- no partial terminal-without-successor state", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const before = await store.list();
  const beforeJson = JSON.stringify(before);

  fs.faults.add("writeFile");
  await assert.rejects(() =>
    store.supersedeWithSuccessor(
      old.job.jobId,
      (current) => ({ ...current, status: "cancelled" }),
      buildSuccessorFor(old),
    ),
  );
  fs.faults.delete("writeFile");

  const after = await store.list();
  assert.equal(JSON.stringify(after), beforeJson, "a failed supersede commit must leave the prior committed document untouched");
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "active", "the old job must remain active (not stranded as terminal-without-successor) so recovery can retry");
});

void test("supersedeWithSuccessor survives a simulated restart: a fresh JobStore instance over the same fs sees both the terminal old job and the queued successor", async () => {
  const fs = new FakeFs();
  const first = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await first.appendJob(old);
  const successor = buildSuccessorFor(old);
  await first.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), successor);

  const second = new JobStore(fs, "/root");
  const jobs = await second.list();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((j) => j.job.jobId === old.job.jobId)?.status, "cancelled");
  assert.equal(jobs.find((j) => j.job.jobId === successor.job.jobId)?.status, "queued");
});

void test("supersedeWithSuccessor: two concurrent supersede requests for the same old job racing to create same-key successors coalesce onto exactly one successor job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);

  const successorA = buildSuccessorFor(old, { jobId: "successor-a" });
  const successorB = buildSuccessorFor(old, { jobId: "successor-b" });
  const markTerminal = (current: PersistedJobV1): PersistedJobV1 => ({ ...current, status: "cancelled" });

  const [r1, r2] = await Promise.all([
    store.supersedeWithSuccessor(old.job.jobId, markTerminal, successorA),
    store.supersedeWithSuccessor(old.job.jobId, markTerminal, successorB),
  ]);

  assert.equal(r1.successor.job.jobId, r2.successor.job.jobId, "exactly one successor jobId must win");
  assert.ok(r1.coalesced || r2.coalesced, "the losing racer must observe the winner's already-committed successor");

  const jobs = await store.list();
  assert.equal(jobs.length, 2, "the original job plus exactly one successor -- never two");
  assert.equal(jobs.find((j) => j.job.jobId === old.job.jobId)?.status, "cancelled");
});

void test("supersedeWithSuccessor rejects when the old jobId does not exist", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const fake = buildPersisted({ path: "Notes/A.md" });
  await assert.rejects(
    () => store.supersedeWithSuccessor("missing", (current) => ({ ...current, status: "cancelled" }), buildSuccessorFor(fake)),
    (error: unknown) => isEngineError(error) && error.code === "JOB_NOT_FOUND",
  );
});

void test("supersedeWithSuccessor rejects a markOldTerminal that leaves the old job non-terminal", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active" });
  await store.appendJob(old);
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => current, buildSuccessorFor(old)),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

// -- Checkpoint 7 last-contract guard 2: supersedeWithSuccessor validates successor shape --------

void test("supersedeWithSuccessor rejects a successor with the OLD job's own jobId (must be a genuinely different job)", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), buildSuccessorFor(old, { jobId: old.job.jobId })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor of a DIFFERENT kind than the old job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const badSuccessor = buildSuccessorFor(old);
  (badSuccessor.job as { kind: string }).kind = "rebuild-index";
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), badSuccessor),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor with a DIFFERENT pipelineVersion than the old job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const badSuccessor = buildSuccessorFor(old);
  (badSuccessor.job as { pipelineVersion: number }).pipelineVersion = old.job.pipelineVersion + 1;
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), badSuccessor),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor with a DIFFERENT sourceHash/embeddingModel than the old job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const badSuccessor = buildSuccessorFor(old);
  (badSuccessor.job as { sourceHash?: string }).sourceHash = "f".repeat(64);
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), badSuccessor),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor targeting a DIFFERENT note/scope/generation than the old job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const badSuccessor = buildSuccessorFor(old);
  (badSuccessor.job as { target: unknown }).target = { schemaVersion: 1, kind: "note", identity: stableNoteIdentity(canonicalizePath("Notes/B.md")) };
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), badSuccessor),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor whose idempotencyKey does not match the old job's, even if every other field superficially agrees", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  const badSuccessor = buildSuccessorFor(old);
  (badSuccessor.job as { idempotencyKey: string }).idempotencyKey = "corrupted-idempotency-key";
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), badSuccessor),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor NOT starting at the initial phase for its kind", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const old = buildPersisted({ path: "Notes/A.md", status: "active", phase: "write-overlay" });
  await store.appendJob(old);
  await assert.rejects(
    () => store.supersedeWithSuccessor(old.job.jobId, (current) => ({ ...current, status: "cancelled" }), buildSuccessorFor(old, { phase: "embed" })),
    (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
  );
});

void test("supersedeWithSuccessor rejects a successor with a non-queued status, a nonzero attempt, cancelRequested true, a receipt, a failure code, or backoff bookkeeping", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const markTerminal = (current: PersistedJobV1): PersistedJobV1 => ({ ...current, status: "cancelled" });

  const cases: Array<Partial<PersistedJobV1>> = [
    { status: "active" },
    { attempt: 1 },
    { cancelRequested: true },
    { receipt: { kind: "note", noteCommitted: false, overlayCommitted: false } },
    { lastFailureCode: "UNKNOWN_TRANSIENT", lastFailureClass: "transient" },
    { nextAttemptAtMs: 5000 },
  ];
  for (const [i, override] of cases.entries()) {
    const old = buildPersisted({ path: `Notes/Case${i}.md`, status: "active", phase: "write-overlay" });
    await store.appendJob(old);
    const badSuccessor = { ...buildSuccessorFor(old), ...override };
    await assert.rejects(
      () => store.supersedeWithSuccessor(old.job.jobId, markTerminal, badSuccessor),
      (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID",
      `case ${i} (${JSON.stringify(override)}) must be rejected`,
    );
  }
});

void test("(last-contract guard 2) supersedeWithSuccessor keeps `old` well-defined in its result even when the commit is at capacity and the just-superseded old job would otherwise be the prime pruning target", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");

  // Fill the store to exactly MAX_PERSISTED_JOBS with old, already-terminal, OLDER-updatedAt jobs
  // -- every one of them is a more attractive pruning target (by updatedAt) than the job we are
  // about to supersede, whose own `job.updatedAt` (fixed at append time, never touched by
  // markOldTerminal below) is deliberately the OLDEST of all -- the exact scenario that would make
  // it the prime pruning target the instant it becomes terminal. Seeded directly into `fs` (never
  // 4999 sequential `appendJob` calls, which would be needlessly slow) since only the FINAL
  // document shape matters here, not how it was built up.
  const fillerCount = 4999; // MAX_PERSISTED_JOBS - 1
  const fillerJobs: PersistedJobV1[] = [];
  for (let i = 0; i < fillerCount; i += 1) {
    const job = buildJob({ path: `Notes/Filler${i}.md`, updatedAt: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    fillerJobs.push({ schemaVersion: 1, job, status: "cancelled", attempt: 0, cancelRequested: false });
  }
  const oldJob = buildJob({ path: "Notes/ToSupersede.md", phase: "write-overlay", updatedAt: "2020-01-01T00:00:00.000Z" });
  const old: PersistedJobV1 = { schemaVersion: 1, job: oldJob, status: "active", attempt: 0, cancelRequested: false };
  const seededDoc = { schemaVersion: 1 as const, jobs: [...fillerJobs, old], providerPause: { active: false as const } };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: seededDoc }));
  assert.equal((await store.list()).length, 5000);

  const successor = buildSuccessorFor(old);
  const result = await store.supersedeWithSuccessor(
    old.job.jobId,
    // markOldTerminal deliberately does NOT bump updatedAt -- the exact scenario that made the old
    // job look like the OLDEST terminal entry the instant it becomes terminal.
    (current) => ({ ...current, status: "cancelled" }),
    successor,
  );
  assert.equal(result.old.job.jobId, old.job.jobId, "`old` in the result must be well-defined, never silently pruned away");
  assert.equal(result.old.status, "cancelled");
  assert.equal(result.successor.job.jobId, successor.job.jobId);

  const persistedOld = await store.getById(old.job.jobId);
  assert.ok(persistedOld, "the old job itself must still be persisted and retrievable after the commit, not silently evicted");
  assert.equal(persistedOld?.status, "cancelled");
});

void test("provider pause round-trips through save/load", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  assert.equal((await store.getProviderPause()).active, false);
  await store.setProviderPause({ active: true, code: "EMBEDDING_ENDPOINT_INVALID", pausedAtMs: 1000 });
  assert.deepEqual(await store.getProviderPause(), { active: true, code: "EMBEDDING_ENDPOINT_INVALID", pausedAtMs: 1000 });

  const fresh = new JobStore(fs, "/root");
  assert.deepEqual(await fresh.getProviderPause(), { active: true, code: "EMBEDDING_ENDPOINT_INVALID", pausedAtMs: 1000 });
});

// ---------------------------------------------------------------------------
// Checkpoint 8 requirement 6: crash-safe scheduled occurrence registry
// ---------------------------------------------------------------------------

function occurrenceIdFor(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex");
}

void test("submitScheduledOccurrence: a brand-new occurrenceId appends the job AND its registry link atomically ('new')", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  const occurrenceId = occurrenceIdFor("occ-1");

  const result = await store.submitScheduledOccurrence(occurrenceId, job, "2026-08-23T00:00:00.000Z");
  assert.equal(result.linked, "new");
  assert.equal(result.job.job.jobId, job.job.jobId);

  const occurrence = await store.getScheduledOccurrence(occurrenceId);
  assert.ok(occurrence);
  assert.equal(occurrence?.jobId, job.job.jobId);
  assert.equal(occurrence?.idempotencyKey, job.job.idempotencyKey);
  assert.equal(occurrence?.acknowledged, false);
  assert.equal((await store.list()).length, 1);
});

void test("submitScheduledOccurrence: a retry with the SAME occurrenceId returns the SAME job, even after it reached a terminal status ('existing-occurrence')", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  const occurrenceId = occurrenceIdFor("occ-2");

  const first = await store.submitScheduledOccurrence(occurrenceId, job, "2026-08-23T00:00:00.000Z");
  assert.equal(first.linked, "new");

  // Simulate the job racing to completion synchronously, before any outcome was ever persisted
  // by the caller (the exact scenario requirement 6 targets) -- walking legally one phase at a
  // time, exactly as JobEngine's own phase-step machinery would.
  for (const phase of ["embed", "extract-metadata", "confirm-source", "write-note", "write-overlay"] as const) {
    await store.updateJob(job.job.jobId, (current) => ({ ...current, job: { ...current.job, phase } }));
  }
  await store.updateJob(job.job.jobId, (current) => ({ ...current, status: "completed", job: { ...current.job, phase: "complete" } }));

  // A brand-new PersistedJobV1 (different jobId) is what a naive retry would construct -- but the
  // SAME occurrenceId must short-circuit to the already-completed job instead.
  const retryJob = buildPersisted({ path: "Notes/A.md" });
  assert.notEqual(retryJob.job.jobId, job.job.jobId);
  const retry = await store.submitScheduledOccurrence(occurrenceId, retryJob, "2026-08-23T00:05:00.000Z");
  assert.equal(retry.linked, "existing-occurrence");
  assert.equal(retry.job.job.jobId, job.job.jobId);
  assert.equal(retry.job.status, "completed");
  assert.equal((await store.list()).length, 1, "at most one job for this occurrence, ever");
});

void test("submitScheduledOccurrence: a manual/timer race for the SAME work links this occurrence to the ALREADY-existing non-terminal job instead of duplicating it ('existing-work')", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const manualJob = buildPersisted({ path: "Notes/A.md", trigger: "manual" });
  await store.appendJob(manualJob);

  const scheduledJob = buildPersisted({ path: "Notes/A.md", trigger: "scheduled" });
  assert.equal(scheduledJob.job.idempotencyKey, manualJob.job.idempotencyKey, "identical work -> identical idempotencyKey");
  const occurrenceId = occurrenceIdFor("occ-race");

  const result = await store.submitScheduledOccurrence(occurrenceId, scheduledJob, "2026-08-23T00:00:00.000Z");
  assert.equal(result.linked, "existing-work");
  assert.equal(result.job.job.jobId, manualJob.job.jobId, "linked to whichever job actually won the race");
  assert.equal((await store.list()).length, 1, "no duplicate job created");

  const occurrence = await store.getScheduledOccurrence(occurrenceId);
  assert.equal(occurrence?.jobId, manualJob.job.jobId);
});

void test("ordinary appendOrCoalesce (plain JobEngine.submit path) is completely unaffected by the occurrence registry -- a manual rerun after terminal still creates a NEW job", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  await store.appendJob(job);
  await store.updateJob(job.job.jobId, (current) => ({ ...current, status: "cancelled" }));

  const rerun = buildPersisted({ path: "Notes/A.md" });
  const { coalesced } = await store.appendOrCoalesce(rerun);
  assert.equal(coalesced, false, "a terminal job must never block a deliberate manual rerun through the ordinary submit path");
  assert.equal((await store.list()).length, 2);
});

void test("acknowledgeScheduledOccurrence is idempotent: unknown, first-time, and already-acknowledged occurrenceIds are all safe no-ops/successes", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  const occurrenceId = occurrenceIdFor("occ-ack");

  await assert.doesNotReject(() => store.acknowledgeScheduledOccurrence(occurrenceId, "2026-08-23T00:00:00.000Z"));
  assert.equal(await store.getScheduledOccurrence(occurrenceId), null);

  await store.submitScheduledOccurrence(occurrenceId, job, "2026-08-23T00:00:00.000Z");
  await store.acknowledgeScheduledOccurrence(occurrenceId, "2026-08-23T00:05:00.000Z");
  const acked = await store.getScheduledOccurrence(occurrenceId);
  assert.equal(acked?.acknowledged, true);
  assert.equal(acked?.acknowledgedAt, "2026-08-23T00:05:00.000Z");

  // Acking again (e.g. a retried best-effort ack) must not change acknowledgedAt or throw.
  await store.acknowledgeScheduledOccurrence(occurrenceId, "2026-08-23T00:10:00.000Z");
  const stillAcked = await store.getScheduledOccurrence(occurrenceId);
  assert.equal(stillAcked?.acknowledgedAt, "2026-08-23T00:05:00.000Z");
});

void test("terminal-job cap pruning never removes a job an UNACKNOWLEDGED occurrence still references", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");

  const pendingJob = buildJob({ path: "Notes/Pending.md", updatedAt: "2019-01-01T00:00:00.000Z", phase: "complete" }); // oldest updatedAt -> prime pruning target
  const pendingPersisted: PersistedJobV1 = { schemaVersion: 1, job: pendingJob, status: "completed", attempt: 1, cancelRequested: false };
  const occurrenceId = occurrenceIdFor("occ-protected");
  const registryRecord = { schemaVersion: 1 as const, occurrenceId, idempotencyKey: pendingJob.idempotencyKey, jobId: pendingJob.jobId, acknowledged: false, createdAt: "2026-08-23T00:00:00.000Z" };

  const fillerCount = 4999;
  const fillerJobs: PersistedJobV1[] = [];
  for (let i = 0; i < fillerCount; i += 1) {
    const job = buildJob({ path: `Notes/Filler${i}.md`, updatedAt: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    fillerJobs.push({ schemaVersion: 1, job, status: "cancelled", attempt: 0, cancelRequested: false });
  }
  const seededDoc = { schemaVersion: 1 as const, jobs: [pendingPersisted, ...fillerJobs], providerPause: { active: false as const }, scheduledOccurrences: [registryRecord] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: seededDoc }));
  assert.equal((await store.list()).length, 5000);

  // Appending one more job would exceed the cap -- ordinary terminal-job pruning must skip the
  // occurrence-protected job even though it is the oldest-by-updatedAt terminal entry.
  const newJob = buildPersisted({ path: "Notes/New.md" });
  await store.appendJob(newJob);

  const stillThere = await store.getById(pendingJob.jobId);
  assert.ok(stillThere, "a job an unacknowledged occurrence still references must never be pruned");
});

void test("scheduled-occurrence registry parse: migrates a document with NO scheduledOccurrences field to an empty registry", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const preExistingDoc = { schemaVersion: 1 as const, jobs: [buildPersisted({ path: "Notes/A.md" })], providerPause: { active: false as const } };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: preExistingDoc }));

  const jobs = await store.list();
  assert.equal(jobs.length, 1);
  assert.equal(await store.getScheduledOccurrence(occurrenceIdFor("anything")), null);

  // And a subsequent occurrence submit against this migrated store works normally.
  const result = await store.submitScheduledOccurrence(occurrenceIdFor("occ-post-migration"), buildPersisted({ path: "Notes/B.md" }), "2026-08-23T00:00:00.000Z");
  assert.equal(result.linked, "new");
});

void test("scheduled-occurrence registry parse: rejects a non-array scheduledOccurrences (fails closed, never silently accepted)", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const doc = { schemaVersion: 1 as const, jobs: [], providerPause: { active: false as const }, scheduledOccurrences: "not-an-array" };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  await assert.rejects(() => store.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("scheduled-occurrence registry parse: rejects a dangling job reference", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const record = { schemaVersion: 1 as const, occurrenceId: occurrenceIdFor("dangling"), idempotencyKey: "some-key", jobId: "no-such-job", acknowledged: false, createdAt: "2026-08-23T00:00:00.000Z" };
  const doc = { schemaVersion: 1 as const, jobs: [], providerPause: { active: false as const }, scheduledOccurrences: [record] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  await assert.rejects(() => store.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("scheduled-occurrence registry parse: rejects a duplicate occurrenceId", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildJob({ path: "Notes/A.md" });
  const persisted: PersistedJobV1 = { schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false };
  const occurrenceId = occurrenceIdFor("dup");
  const record = { schemaVersion: 1 as const, occurrenceId, idempotencyKey: job.idempotencyKey, jobId: job.jobId, acknowledged: false, createdAt: "2026-08-23T00:00:00.000Z" };
  const doc = { schemaVersion: 1 as const, jobs: [persisted], providerPause: { active: false as const }, scheduledOccurrences: [record, record] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  await assert.rejects(() => store.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("scheduled-occurrence registry parse: rejects an idempotencyKey that does not match its referenced job's own key", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildJob({ path: "Notes/A.md" });
  const persisted: PersistedJobV1 = { schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false };
  const record = { schemaVersion: 1 as const, occurrenceId: occurrenceIdFor("mismatch"), idempotencyKey: "not-the-real-key", jobId: job.jobId, acknowledged: false, createdAt: "2026-08-23T00:00:00.000Z" };
  const doc = { schemaVersion: 1 as const, jobs: [persisted], providerPause: { active: false as const }, scheduledOccurrences: [record] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  await assert.rejects(() => store.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("scheduled-occurrence registry parse: acknowledgedAt must be present iff acknowledged is true", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildJob({ path: "Notes/A.md" });
  const persisted: PersistedJobV1 = { schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false };
  const badRecord = { schemaVersion: 1 as const, occurrenceId: occurrenceIdFor("bad-ack"), idempotencyKey: job.idempotencyKey, jobId: job.jobId, acknowledged: true, createdAt: "2026-08-23T00:00:00.000Z" };
  const doc = { schemaVersion: 1 as const, jobs: [persisted], providerPause: { active: false as const }, scheduledOccurrences: [badRecord] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  await assert.rejects(() => store.list(), (error: unknown) => isEngineError(error) && error.code === "STORE_SCHEMA_INVALID");
});

void test("occurrence registry cap: acknowledged entries are pruned oldest-first, but unacknowledged entries are never dropped and fail closed when the registry is full of them", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");

  const jobs: PersistedJobV1[] = [];
  const records: { schemaVersion: 1; occurrenceId: string; idempotencyKey: string; jobId: string; acknowledged: boolean; createdAt: string; acknowledgedAt?: string }[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const job = buildJob({ path: `Notes/Occ${i}.md`, updatedAt: "2026-08-23T00:00:00.000Z", phase: "complete" });
    jobs.push({ schemaVersion: 1, job, status: "completed", attempt: 1, cancelRequested: false });
    records.push({
      schemaVersion: 1,
      occurrenceId: occurrenceIdFor(`cap-${i}`),
      idempotencyKey: job.idempotencyKey,
      jobId: job.jobId,
      acknowledged: true,
      createdAt: "2026-08-23T00:00:00.000Z",
      acknowledgedAt: `2026-08-23T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
    });
  }
  const doc = { schemaVersion: 1 as const, jobs, providerPause: { active: false as const }, scheduledOccurrences: records };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc }));
  assert.equal((await store.list()).length, 2000);

  // Registry is exactly at cap (2000), all acknowledged -- adding one more must prune the oldest
  // acknowledged entry to make room, never fail.
  const newJob = buildPersisted({ path: "Notes/NewOcc.md" });
  const newOccurrenceId = occurrenceIdFor("cap-new");
  const result = await store.submitScheduledOccurrence(newOccurrenceId, newJob, "2026-08-23T01:00:00.000Z");
  assert.equal(result.linked, "new");
  assert.ok(await store.getScheduledOccurrence(newOccurrenceId));
  assert.equal(await store.getScheduledOccurrence(occurrenceIdFor("cap-0")), null, "the oldest-acknowledged entry was pruned to make room");

  // Now fill the registry to cap with entries that are ALL unacknowledged -- no more pruning is
  // possible, so one more must fail closed rather than silently drop a live crash-recovery receipt.
  const allUnackedJobs: PersistedJobV1[] = [];
  const allUnackedRecords: { schemaVersion: 1; occurrenceId: string; idempotencyKey: string; jobId: string; acknowledged: boolean; createdAt: string }[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const job = buildJob({ path: `Notes/Unacked${i}.md`, updatedAt: "2026-08-23T00:00:00.000Z" });
    allUnackedJobs.push({ schemaVersion: 1, job, status: "queued", attempt: 0, cancelRequested: false });
    allUnackedRecords.push({ schemaVersion: 1, occurrenceId: occurrenceIdFor(`unacked-${i}`), idempotencyKey: job.idempotencyKey, jobId: job.jobId, acknowledged: false, createdAt: "2026-08-23T00:00:00.000Z" });
  }
  const fs2 = new FakeFs();
  const store2 = new JobStore(fs2, "/root");
  const doc2 = { schemaVersion: 1 as const, jobs: allUnackedJobs, providerPause: { active: false as const }, scheduledOccurrences: allUnackedRecords };
  fs2.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: doc2 }));
  assert.equal((await store2.list()).length, 2000);

  const overflowJob = buildPersisted({ path: "Notes/Overflow.md" });
  await assert.rejects(
    () => store2.submitScheduledOccurrence(occurrenceIdFor("overflow"), overflowJob, "2026-08-23T01:00:00.000Z"),
    (error: unknown) => isEngineError(error) && error.code === "JOB_CAP_EXCEEDED",
  );
});

// ---------------------------------------------------------------------------
// Final-integration requirement 1: occurrence/job pruning consistency
// ---------------------------------------------------------------------------

/** Seeds a store at exactly MAX_PERSISTED_JOBS with one ACKNOWLEDGED-occurrence-linked terminal job (oldest updatedAt -> prime pruning target) plus filler terminal jobs, and returns the target job + its occurrenceId. */
function seedAtCapWithAcknowledgedOccurrence(fs: FakeFs): { job: QueueJobV1; occurrenceId: string } {
  const targetJob = buildJob({ path: "Notes/Acked.md", updatedAt: "2019-01-01T00:00:00.000Z", phase: "complete" });
  const targetPersisted: PersistedJobV1 = { schemaVersion: 1, job: targetJob, status: "completed", attempt: 1, cancelRequested: false };
  const occurrenceId = occurrenceIdFor("prune-consistency");
  const record = {
    schemaVersion: 1 as const,
    occurrenceId,
    idempotencyKey: targetJob.idempotencyKey,
    jobId: targetJob.jobId,
    acknowledged: true,
    createdAt: "2019-01-01T00:00:00.000Z",
    acknowledgedAt: "2019-01-01T00:01:00.000Z",
  };

  const fillerCount = 4999;
  const fillerJobs: PersistedJobV1[] = [];
  for (let i = 0; i < fillerCount; i += 1) {
    const job = buildJob({ path: `Notes/Filler${i}.md`, updatedAt: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    fillerJobs.push({ schemaVersion: 1, job, status: "cancelled", attempt: 0, cancelRequested: false });
  }
  const seededDoc = { schemaVersion: 1 as const, jobs: [targetPersisted, ...fillerJobs], providerPause: { active: false as const }, scheduledOccurrences: [record] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: seededDoc }));
  return { job: targetJob, occurrenceId };
}

void test("(final-integration 1) appendJob pruning a terminal job referenced by an ACKNOWLEDGED occurrence removes that occurrence record in the SAME commit -- no dangling reference", async () => {
  const fs = new FakeFs();
  const { job: targetJob, occurrenceId } = seedAtCapWithAcknowledgedOccurrence(fs);
  const store = new JobStore(fs, "/root");
  assert.equal((await store.list()).length, 5000);

  await store.appendJob(buildPersisted({ path: "Notes/New.md" }));

  assert.equal(await store.getById(targetJob.jobId), null, "the acknowledged-occurrence job was pruned");
  assert.equal(await store.getScheduledOccurrence(occurrenceId), null, "its now-dangling occurrence record was pruned together with it");

  // Reload from a fresh store instance -- the persisted document itself must parse cleanly (no
  // dangling cross-reference was ever written to disk).
  const fresh = new JobStore(fs, "/root");
  await assert.doesNotReject(() => fresh.list());
});

void test("(final-integration 1) appendOrCoalesce pruning a terminal job referenced by an ACKNOWLEDGED occurrence removes that occurrence record too", async () => {
  const fs = new FakeFs();
  const { job: targetJob, occurrenceId } = seedAtCapWithAcknowledgedOccurrence(fs);
  const store = new JobStore(fs, "/root");

  await store.appendOrCoalesce(buildPersisted({ path: "Notes/New2.md" }));

  assert.equal(await store.getById(targetJob.jobId), null);
  assert.equal(await store.getScheduledOccurrence(occurrenceId), null);
  const fresh = new JobStore(fs, "/root");
  await assert.doesNotReject(() => fresh.list());
});

void test("(final-integration 1) supersedeWithSuccessor pruning a terminal job referenced by an ACKNOWLEDGED occurrence removes that occurrence record too", async () => {
  const fs = new FakeFs();
  const { job: targetJob, occurrenceId } = seedAtCapWithAcknowledgedOccurrence(fs);
  const store = new JobStore(fs, "/root");

  const doc = await store.list();
  const oldForSupersede = doc.find((entry) => entry.job.jobId !== targetJob.jobId)!;
  for (const phase of ["embed", "extract-metadata", "confirm-source", "write-note", "write-overlay"] as const) {
    await store.updateJob(oldForSupersede.job.jobId, (current) => ({ ...current, job: { ...current.job, phase } }));
  }
  await store.updateJob(oldForSupersede.job.jobId, (current) => ({ ...current, status: "active" }));
  const active = await store.getById(oldForSupersede.job.jobId);
  await store.supersedeWithSuccessor(active!.job.jobId, (current) => ({ ...current, status: "cancelled" }), buildSuccessorFor(active!));

  assert.equal(await store.getById(targetJob.jobId), null);
  assert.equal(await store.getScheduledOccurrence(occurrenceId), null);
  const fresh = new JobStore(fs, "/root");
  await assert.doesNotReject(() => fresh.list());
});

void test("(final-integration 1) submitScheduledOccurrence's 'new' branch pruning a terminal job referenced by an ACKNOWLEDGED occurrence removes that occurrence record too", async () => {
  const fs = new FakeFs();
  const { job: targetJob, occurrenceId } = seedAtCapWithAcknowledgedOccurrence(fs);
  const store = new JobStore(fs, "/root");

  await store.submitScheduledOccurrence(occurrenceIdFor("prune-consistency-new"), buildPersisted({ path: "Notes/New3.md" }), "2026-08-23T00:00:00.000Z");

  assert.equal(await store.getById(targetJob.jobId), null);
  assert.equal(await store.getScheduledOccurrence(occurrenceId), null);
  const fresh = new JobStore(fs, "/root");
  await assert.doesNotReject(() => fresh.list());
});

void test("(final-integration 1) UNACKNOWLEDGED-occurrence jobs remain fully protected across every append path (never pruned, regardless of which path triggers pruning)", async () => {
  const fs = new FakeFs();
  const pendingJob = buildJob({ path: "Notes/StillPending.md", updatedAt: "2018-01-01T00:00:00.000Z", phase: "complete" });
  const pendingPersisted: PersistedJobV1 = { schemaVersion: 1, job: pendingJob, status: "completed", attempt: 1, cancelRequested: false };
  const pendingOccurrenceId = occurrenceIdFor("still-pending");
  const pendingRecord = { schemaVersion: 1 as const, occurrenceId: pendingOccurrenceId, idempotencyKey: pendingJob.idempotencyKey, jobId: pendingJob.jobId, acknowledged: false, createdAt: "2018-01-01T00:00:00.000Z" };

  const fillerCount = 4999;
  const fillerJobs: PersistedJobV1[] = [];
  for (let i = 0; i < fillerCount; i += 1) {
    const job = buildJob({ path: `Notes/Filler${i}.md`, updatedAt: `2021-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z` });
    fillerJobs.push({ schemaVersion: 1, job, status: "cancelled", attempt: 0, cancelRequested: false });
  }
  const seededDoc = { schemaVersion: 1 as const, jobs: [pendingPersisted, ...fillerJobs], providerPause: { active: false as const }, scheduledOccurrences: [pendingRecord] };
  fs.files.set("/root/jobs/queue.json", JSON.stringify({ schemaVersion: 1, data: seededDoc }));

  const store = new JobStore(fs, "/root");
  await store.appendJob(buildPersisted({ path: "Notes/New4.md" }));
  assert.ok(await store.getById(pendingJob.jobId), "an unacknowledged occurrence's job must never be pruned");
  assert.ok(await store.getScheduledOccurrence(pendingOccurrenceId));
});

// ---------------------------------------------------------------------------
// Last-acceptance requirement 2: JobStore ack no-op must not save
// ---------------------------------------------------------------------------

void test("(last-acceptance 2) acknowledgeScheduledOccurrence for an UNKNOWN occurrenceId performs zero writes", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  await store.appendJob(buildPersisted({ path: "Notes/A.md" })); // one initial write to prime the store
  const before = fs.renameCallCount;
  await store.acknowledgeScheduledOccurrence(occurrenceIdFor("unknown"), "2026-08-23T00:00:00.000Z");
  assert.equal(fs.renameCallCount, before, "no write for an unknown occurrenceId");
});

void test("(last-acceptance 2) acknowledgeScheduledOccurrence is a single write for the first call, then zero writes for every repeat", async () => {
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const job = buildPersisted({ path: "Notes/A.md" });
  const occurrenceId = occurrenceIdFor("repeat-ack");
  await store.submitScheduledOccurrence(occurrenceId, job, "2026-08-23T00:00:00.000Z");
  const afterSubmit = fs.renameCallCount;

  await store.acknowledgeScheduledOccurrence(occurrenceId, "2026-08-23T00:05:00.000Z");
  assert.equal(fs.renameCallCount, afterSubmit + 1, "the first ack writes exactly once");

  for (let i = 0; i < 10; i += 1) {
    await store.acknowledgeScheduledOccurrence(occurrenceId, "2026-08-23T00:10:00.000Z");
  }
  assert.equal(fs.renameCallCount, afterSubmit + 1, "every repeated ack of an already-acknowledged occurrence performs zero further writes");
});
