import test from "node:test";
import assert from "node:assert/strict";

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

  async rename(fromPath: string, toPath: string): Promise<void> {
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
