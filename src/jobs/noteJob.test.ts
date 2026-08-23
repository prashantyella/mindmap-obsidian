import test from "node:test";
import assert from "node:assert/strict";

import type { AtomicStoreFs } from "../engine/atomicStore";
import { canonicalizePath, computeJobIdempotencyKey, stableNoteIdentity, type MetadataOutputV1, type NoteIdentityV1, type SourceProjectionV1 } from "../engine/contracts";
import { EngineError } from "../engine/errors";
import { NoteWriter, type NoteVaultAdapter } from "../engine/noteWriter";
import { projectSource } from "../engine/sourceProjection";
import { JobEngine, type JobEngineClock } from "./jobEngine";
import { JobStore } from "./jobStore";
import { NoteJobRunner, type EmbeddedNote, type NoteEmbeddingSeam, type NoteMetadataSeam, type NoteSourceReader, type UpsertNoteOverlaySeam } from "./noteJob";

class FakeFs implements AtomicStoreFs {
  files = new Map<string, string>();
  faults = new Set<"writeFile" | "rename">();
  /** 1-indexed: the Nth `writeFile` call from here fails (once), instead of every call while a fault is armed -- lets a test fail exactly one `JobStore.save()` out of several within a single `runOnce()`. `undefined` disables this. */
  failWriteFileOnCallNumber: number | undefined;
  writeFileCallCount = 0;
  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }
  async writeFile(path: string, contents: string): Promise<void> {
    this.writeFileCallCount += 1;
    if (this.faults.has("writeFile") || this.writeFileCallCount === this.failWriteFileOnCallNumber) {
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

class FakeVault implements NoteVaultAdapter {
  files = new Map<string, string>();
  modifyCount = 0;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async modify(path: string, content: string): Promise<void> {
    this.modifyCount += 1;
    this.files.set(path, content);
  }
  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async ensureFolder(): Promise<void> {}
}

class FakeSourceReader implements NoteSourceReader {
  /** appleAnnotationId -> current canonical path, for apple-annotation identities whose path has been renamed since the job was queued. */
  annotationCurrentPath = new Map<string, string>();

  constructor(private readonly vault: FakeVault) {}

  async read(identity: NoteIdentityV1): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
    if (identity.kind === "apple-annotation" && identity.appleAnnotationId !== undefined) {
      const annotationId = identity.appleAnnotationId;
      const currentPath = this.annotationCurrentPath.get(annotationId) ?? identity.canonicalPath;
      const content = this.vault.files.get(currentPath);
      if (content === undefined) return null;
      return { identity: { schemaVersion: 1, kind: "apple-annotation", canonicalPath: canonicalizePath(currentPath), appleAnnotationId: annotationId }, rawContent: content };
    }
    const content = this.vault.files.get(identity.canonicalPath);
    return content === undefined ? null : { identity, rawContent: content };
  }
}

class FakeEmbedding implements NoteEmbeddingSeam {
  calls = 0;
  nextError: Error | null = null;
  errorCountRemaining = 0;
  /** Item 7 (embedding result validation) test knobs -- each overrides one facet of an otherwise well-formed result. */
  nextModel: string | undefined;
  dimensionOverride: number | undefined;
  noteVectorOverride: Float32Array | undefined;
  chunkDimensionOverride: number | undefined;
  chunkVectorCountOverride: number | undefined;
  /** Acceptance guard 6 test knob -- bypasses TypeScript's static `EmbeddedNote` shape entirely, returning whatever raw (possibly malformed) value a test supplies, to prove `validateEmbeddedNote` fails closed on the seam's ACTUAL runtime shape rather than trusting the type annotation. */
  rawOverride: unknown | undefined;

  async embed(_projection: SourceProjectionV1, _signal: AbortSignal): Promise<EmbeddedNote> {
    void _projection;
    void _signal;
    this.calls += 1;
    if (this.errorCountRemaining > 0) {
      this.errorCountRemaining -= 1;
      throw this.nextError ?? new Error("embed failed");
    }
    if (this.rawOverride !== undefined) {
      return this.rawOverride as EmbeddedNote;
    }
    const dimension = this.dimensionOverride ?? 3;
    const chunkDimension = this.chunkDimensionOverride ?? dimension;
    const chunkCount = this.chunkVectorCountOverride ?? 1;
    const chunkVector = new Float32Array(chunkDimension);
    if (chunkDimension > 0) chunkVector[0] = 1;
    return {
      model: this.nextModel ?? "test-model",
      dimension,
      noteVector: this.noteVectorOverride ?? new Float32Array([1, 0, 0].slice(0, dimension)),
      chunkVectors: Array.from({ length: chunkCount }, () => chunkVector),
    };
  }
}

class FakeMetadata implements NoteMetadataSeam {
  calls = 0;
  async extract(projection: SourceProjectionV1, _signal: AbortSignal): Promise<MetadataOutputV1> {
    void _signal;
    this.calls += 1;
    return { schemaVersion: 1, identity: projection.identity, summary: "A summary.", tags: ["alpha"], concepts: ["Concept"], related: [] };
  }
}

class FakeIndex implements UpsertNoteOverlaySeam {
  calls: unknown[] = [];
  errorCountRemaining = 0;
  nextError: Error | null = null;

  async upsertNote(input: Parameters<UpsertNoteOverlaySeam["upsertNote"]>[0]): Promise<void> {
    if (this.errorCountRemaining > 0) {
      this.errorCountRemaining -= 1;
      throw this.nextError ?? new Error("index upsert failed");
    }
    this.calls.push(input);
  }
}

class FakeClock implements JobEngineClock {
  ms = 1_000_000;
  now(): number {
    return this.ms;
  }
}

const NOTE_PATH = "Notes/Example.md";
const RAW_CONTENT = "---\ntitle: Example\n---\nBody.\n";

function identity(): NoteIdentityV1 {
  return stableNoteIdentity(canonicalizePath(NOTE_PATH));
}

function sourceHashOf(rawContent: string): string {
  return projectSource(identity(), rawContent).sourceHash;
}

/** Records every call but never actually enqueues anything -- the default `replacement` for tests that are not themselves about the replacement mechanism (so their own note/index/vault write-count assertions stay about the ONE job under test, not a real replacement job this seam would otherwise spin up and run to completion). */
class NoopReplacement {
  calls: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }[] = [];
  async enqueueReplacement(input: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }): Promise<void> {
    this.calls.push(input);
  }
}

/** A real, functioning `NoteReplacementSeam` backed by an injected `JobEngine` reference (via a mutable box, since the engine itself is constructed after the runner that depends on this seam) -- exercises the actual coalescing/durability path end to end rather than merely counting calls. Used only by the tests that specifically exercise requirement 9's replacement/coalescing behavior. */
class FakeReplacement {
  calls: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }[] = [];
  errorCountRemaining = 0;
  private readonly engineBox: { engine?: JobEngine };
  constructor(engineBox: { engine?: JobEngine }) {
    this.engineBox = engineBox;
  }
  async enqueueReplacement(input: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }): Promise<void> {
    if (this.errorCountRemaining > 0) {
      this.errorCountRemaining -= 1;
      throw new Error("injected replacement enqueue failure");
    }
    this.calls.push(input);
    await this.engineBox.engine!.submit({ trigger: "reading", kind: "process-note", identity: input.identity, sourceHash: input.sourceHash, embeddingModel: input.embeddingModel, pipelineVersion: input.pipelineVersion });
  }
}

interface Harness {
  vault: FakeVault;
  sourceReader: FakeSourceReader;
  embedding: FakeEmbedding;
  metadata: FakeMetadata;
  index: FakeIndex;
  noteWriter: NoteWriter;
  runner: NoteJobRunner;
  replacement: NoopReplacement;
  fs: FakeFs;
  store: JobStore;
  engine: JobEngine;
  clock: FakeClock;
}

function buildHarness(initialContent = RAW_CONTENT): Harness {
  const vault = new FakeVault();
  vault.files.set(NOTE_PATH, initialContent);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const replacement = new NoopReplacement();
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { "process-note": runner }, clock);
  return { vault, sourceReader, embedding, metadata, index, noteWriter, runner, replacement, fs, store, engine, clock };
}

async function submitNoteJob(h: Harness, sourceHash: string) {
  return h.engine.submit({ trigger: "manual", kind: "process-note", identity: identity(), sourceHash, embeddingModel: "test-model", pipelineVersion: 1 });
}

void test("happy path: note job runs discover->embed->extract-metadata->confirm-source->write-note->write-overlay->complete, writing the note once and upserting the overlay once", async () => {
  const h = buildHarness();
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.vault.modifyCount, 1);
  assert.equal(h.index.calls.length, 1);
  assert.equal(final?.receipt?.kind, "note");
  if (final?.receipt?.kind === "note") {
    assert.equal(final.receipt.noteCommitted, true);
    assert.equal(final.receipt.overlayCommitted, true);
    assert.ok(final.receipt.noteContentHash);
  }
});

void test("note write commits, then index upsert fails once: retry repairs the overlay without rewriting the note a second time", async () => {
  const h = buildHarness();
  h.index.errorCountRemaining = 1;
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  // First drain pass: index fails once (transient), job stays queued backing off.
  let current = await h.store.getById(job.job.jobId);
  assert.equal(current?.status, "queued");
  assert.equal(current?.job.phase, "write-overlay");
  assert.equal(h.vault.modifyCount, 1, "the note must be written exactly once even though the overlay write failed");

  h.clock.ms += 60_000;
  await h.engine.drain();
  current = await h.store.getById(job.job.jobId);
  assert.equal(current?.status, "completed");
  assert.equal(h.vault.modifyCount, 1, "retry must not rewrite the note bytes a second time");
  assert.equal(h.index.calls.length, 1);
});

void test("source edited during inference (between discover and confirm-source) discards the job with zero note/index writes", async () => {
  const h = buildHarness();
  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await submitNoteJob(h, originalHash);

  // Run discover, then edit the source before embed/extract-metadata/confirm-source observe it.
  await h.engine.runOnce();
  h.vault.files.set(NOTE_PATH, "---\ntitle: Example\n---\nEdited during inference.\n");
  await h.engine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SOURCE_STALE");
  assert.equal(h.vault.modifyCount, 0);
  assert.equal(h.index.calls.length, 0);
});

void test("source edited immediately before write-note (after extract-metadata) is caught by confirm-source: zero writes", async () => {
  const h = buildHarness();
  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await submitNoteJob(h, originalHash);

  // Advance through discover, embed, extract-metadata.
  await h.engine.runOnce();
  await h.engine.runOnce();
  await h.engine.runOnce();
  let current = await h.store.getById(job.job.jobId);
  assert.equal(current?.job.phase, "confirm-source");

  h.vault.files.set(NOTE_PATH, "---\ntitle: Example\n---\nEdited right before write.\n");
  await h.engine.drain();

  current = await h.store.getById(job.job.jobId);
  assert.equal(current?.status, "cancelled");
  assert.equal(current?.lastFailureCode, "SOURCE_STALE");
  assert.equal(h.vault.modifyCount, 0);
  assert.equal(h.index.calls.length, 0);
});

void test("note deleted while the job is queued/active resolves to obsolete with zero writes, never creating a replacement", async () => {
  const h = buildHarness();
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.runOnce(); // discover succeeds
  h.vault.files.delete(NOTE_PATH);
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SOURCE_STALE");
  assert.equal(h.vault.modifyCount, 0);
  assert.equal(h.vault.files.has(NOTE_PATH), false);
});

void test("a terminal provider failure fails the job immediately without exhausting retries", async () => {
  const h = buildHarness();
  h.embedding.errorCountRemaining = 1;
  h.embedding.nextError = new EngineError("EMBEDDING_DIMENSION_MISMATCH", "dimension mismatch");
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureClass, "terminal");
  assert.equal(h.embedding.calls, 1);
});

void test("a transient provider failure retries and eventually succeeds", async () => {
  const h = buildHarness();
  h.embedding.errorCountRemaining = 2;
  h.embedding.nextError = new EngineError("EMBEDDING_TIMEOUT", "timed out");
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));

  for (let i = 0; i < 5; i += 1) {
    await h.engine.drain();
    const current = await h.store.getById(job.job.jobId);
    if (current?.status === "completed") break;
    h.clock.ms += 60_000;
  }
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.embedding.calls, 3);
});

void test("an embedding-endpoint failure pauses the provider rather than failing/retrying this job alone", async () => {
  const h = buildHarness();
  h.embedding.errorCountRemaining = 1;
  h.embedding.nextError = new EngineError("EMBEDDING_ENDPOINT_INVALID", "bad endpoint");
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const pause = await h.store.getProviderPause();
  assert.equal(pause.active, true);
  assert.equal(pause.code, "EMBEDDING_ENDPOINT_INVALID");
  const current = await h.store.getById(job.job.jobId);
  assert.equal(current?.status, "queued");
});

void test("a cold restart (fresh NoteJobRunner, empty in-memory cache) resumes correctly from the persisted phase and still completes exactly once", async () => {
  const h = buildHarness();
  const hash = sourceHashOf(RAW_CONTENT);
  const job = await submitNoteJob(h, hash);

  // Advance to "confirm-source" using the first runner instance (its memory cache is now populated).
  await h.engine.runOnce();
  await h.engine.runOnce();
  await h.engine.runOnce();
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "confirm-source");

  // Simulate a process restart: a brand-new runner (empty memory) wired to the SAME store/vault/index.
  const freshRunner = new NoteJobRunner({ sourceReader: h.sourceReader, embedding: h.embedding, metadata: h.metadata, noteWriter: h.noteWriter, indexStore: h.index, replacement: h.replacement });
  await h.store.recoverInterruptedJobs();
  const freshEngine = new JobEngine(h.store, { "process-note": freshRunner }, h.clock);
  await freshEngine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.vault.modifyCount, 1, "the note must still be written exactly once across the restart");
  assert.equal(h.index.calls.length, 1);
});

void test("cancellation requested before write-note writes nothing; cancellation after write-note is ignored and the overlay still gets written", async () => {
  const h1 = buildHarness();
  const job1 = await submitNoteJob(h1, sourceHashOf(RAW_CONTENT));
  await h1.engine.requestCancel(job1.job.jobId);
  await h1.engine.drain();
  const final1 = await h1.store.getById(job1.job.jobId);
  assert.equal(final1?.status, "cancelled");
  assert.equal(h1.vault.modifyCount, 0);
  assert.equal(h1.index.calls.length, 0);

  const h2 = buildHarness();
  const job2 = await submitNoteJob(h2, sourceHashOf(RAW_CONTENT));
  let current = job2;
  while (current.job.phase !== "write-note") {
    await h2.engine.runOnce();
    current = (await h2.store.getById(job2.job.jobId))!;
  }
  await h2.engine.requestCancel(job2.job.jobId);
  await h2.engine.drain();
  const final2 = await h2.store.getById(job2.job.jobId);
  assert.equal(final2?.status, "completed");
  assert.equal(h2.vault.modifyCount, 1);
  assert.equal(h2.index.calls.length, 1);
});

void test("(requirement 7) note write succeeds; a one-time JobStore persistence failure while saving the advance/receipt does not mark the job failed, and restart recovers and completes without a second byte-changing note write", async () => {
  const h = buildHarness();
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));

  await h.engine.runOnce(); // discover
  await h.engine.runOnce(); // embed
  await h.engine.runOnce(); // extract-metadata
  await h.engine.runOnce(); // confirm-source -> now queued at "write-note"
  const midway = await h.store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "write-note");

  // write-note's OWN effect (the vault write) succeeds; the ENGINE's subsequent persistence of the
  // resulting advance+receipt fails once (a JobStore/AtomicStore write failure, not an invalid
  // outcome) -- runOnce() must reject (propagated, not silently swallowed into a second update).
  // The 1st writeFile call in this runOnce() is the "mark active" persist (must succeed, so the
  // runner actually runs); the 2nd is the post-effect advance+receipt persist (must fail).
  h.fs.failWriteFileOnCallNumber = h.fs.writeFileCallCount + 2;
  await assert.rejects(() => h.engine.runOnce());
  h.fs.failWriteFileOnCallNumber = undefined;

  assert.equal(h.vault.modifyCount, 1, "the note must have been written exactly once during the failed-persistence attempt");
  const afterFailedPersist = await h.store.getById(job.job.jobId);
  assert.equal(afterFailedPersist?.status, "active", "the job must be left at its last actually-committed state, never marked failed, and the receipt must not be discarded");
  assert.equal(afterFailedPersist?.job.phase, "write-note", "the persisted phase must not silently advance without a successful commit");

  // Simulate a real restart: recoverInterruptedJobs + a brand-new runner/engine over the same store.
  await h.store.recoverInterruptedJobs();
  const freshRunner = new NoteJobRunner({ sourceReader: h.sourceReader, embedding: h.embedding, metadata: h.metadata, noteWriter: h.noteWriter, indexStore: h.index, replacement: h.replacement });
  const freshEngine = new JobEngine(h.store, { "process-note": freshRunner }, h.clock);
  await freshEngine.drain();

  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(h.vault.modifyCount, 1, "restart must not rewrite the note a second time -- NoteWriter's own idempotency makes the redone write-note phase a byte-identical no-op");
  assert.equal(h.index.calls.length, 1);
});

function appleAnnotationIdentity(path: string, annotationId: string): NoteIdentityV1 {
  return stableNoteIdentity(canonicalizePath(path), annotationId);
}

void test("(requirement 8) a rename mid-job (apple-annotation identity) is followed to its new path: write/index target only the new path, the old path is never read/written/created", async () => {
  const vault = new FakeVault();
  const oldPath = "Notes/Old.md";
  const newPath = "Notes/New.md";
  const annotationId = "annotation-1";
  const content = "---\ntitle: Example\n---\nBody.\n";
  vault.files.set(oldPath, content);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const unusedReplacement = { enqueueReplacement: async () => { throw new Error("must not be called in this test"); } };
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement: unusedReplacement });
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engine = new JobEngine(store, { "process-note": runner }, clock);

  const identity = appleAnnotationIdentity(oldPath, annotationId);
  const hash = projectSource(identity, content).sourceHash;
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity, sourceHash: hash, embeddingModel: "test-model", pipelineVersion: 1 });

  await engine.runOnce(); // discover -- resolves against oldPath, still current

  // Rename: the file moves to newPath (annotation id unchanged) BEFORE embed/write ever run.
  vault.files.delete(oldPath);
  vault.files.set(newPath, content);
  sourceReader.annotationCurrentPath.set(annotationId, newPath);

  await engine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "completed");
  assert.equal(vault.files.has(oldPath), false, "the old path must never be recreated/written");
  assert.equal(index.calls.length, 1);
  const upserted = index.calls[0] as { identity: NoteIdentityV1 };
  assert.equal(upserted.identity.canonicalPath, newPath, "the overlay must be indexed under the NEW path");
});

void test("(requirement 8) a mismatched resolved stable identity from the source reader fails closed (obsolete), never trusted", async () => {
  const h = buildHarness();
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  // Force the reader to resolve to a completely different identity than what was requested.
  const originalRead = h.sourceReader.read.bind(h.sourceReader);
  h.sourceReader.read = async (requested) => {
    const result = await originalRead(requested);
    if (!result) return result;
    return { ...result, identity: stableNoteIdentity(canonicalizePath("Notes/SomewhereElse.md")) };
  };
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  // Distinct code from SOURCE_STALE (requirement 6): this is a routing/identity failure, not an
  // ordinary edit-in-flight race, and it must never enqueue a replacement or write anything.
  assert.equal(final?.lastFailureCode, "IDENTITY_INVALID");
  assert.equal(h.vault.modifyCount, 0);
  assert.equal(h.index.calls.length, 0);
  assert.equal(h.replacement.calls.length, 0, "a mismatched identity must never enqueue a replacement");
});

void test("(requirement 9) source edited during inference enqueues exactly one coalesced replacement job carrying the new sourceHash; the old job is terminal-obsolete with zero stale writes", async () => {
  const vault = new FakeVault();
  vault.files.set(NOTE_PATH, RAW_CONTENT);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engineBox: { engine?: JobEngine } = {};
  const replacement = new FakeReplacement(engineBox);
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const engine = new JobEngine(store, { "process-note": runner }, clock);
  engineBox.engine = engine;

  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: identity(), sourceHash: originalHash, embeddingModel: "test-model", pipelineVersion: 1 });

  await engine.runOnce(); // discover
  const editedContent = "---\ntitle: Example\n---\nEdited during inference.\n";
  vault.files.set(NOTE_PATH, editedContent);
  const newHash = sourceHashOf(editedContent);

  await engine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SOURCE_STALE");

  assert.equal(replacement.calls.length, 1, "exactly one replacement enqueue call");
  assert.equal(replacement.calls[0].sourceHash, newHash);

  const allJobs = await store.list();
  const replacementJobs = allJobs.filter((j) => j.job.jobId !== job.job.jobId);
  assert.equal(replacementJobs.length, 1, "exactly one new-source job queued");
  assert.equal(replacementJobs[0]?.status, "completed", "the replacement job must run to completion");
  assert.equal(index.calls.length, 1, "exactly one index write total -- the replacement's, never the stale obsolete job's");
  assert.equal(vault.modifyCount, 1, "the replacement job performs the one real write for the edited content, never a second/stale one");
});

void test("(requirement 9) source edited immediately before write-note enqueues exactly one replacement job; zero stale writes from the obsolete job", async () => {
  const vault = new FakeVault();
  vault.files.set(NOTE_PATH, RAW_CONTENT);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engineBox: { engine?: JobEngine } = {};
  const replacement = new FakeReplacement(engineBox);
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const engine = new JobEngine(store, { "process-note": runner }, clock);
  engineBox.engine = engine;

  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: identity(), sourceHash: originalHash, embeddingModel: "test-model", pipelineVersion: 1 });

  await engine.runOnce(); // discover
  await engine.runOnce(); // embed
  await engine.runOnce(); // extract-metadata
  const midway = await store.getById(job.job.jobId);
  assert.equal(midway?.job.phase, "confirm-source");

  vault.files.set(NOTE_PATH, "---\ntitle: Example\n---\nEdited right before write.\n");
  await engine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(vault.modifyCount, 1, "only the replacement job's own write, never the stale obsolete job's");
  assert.equal(replacement.calls.length, 1);
  const allJobs = await store.list();
  assert.equal(allJobs.length, 2);
});

void test("(requirement 6) a replacement enqueue that fails once is retried at the SAME stale phase (never swallowed), and succeeds on the next attempt with exactly one replacement job", async () => {
  const vault = new FakeVault();
  vault.files.set(NOTE_PATH, RAW_CONTENT);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engineBox: { engine?: JobEngine } = {};
  const replacement = new FakeReplacement(engineBox);
  replacement.errorCountRemaining = 1;
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const engine = new JobEngine(store, { "process-note": runner }, clock);
  engineBox.engine = engine;

  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: identity(), sourceHash: originalHash, embeddingModel: "test-model", pipelineVersion: 1 });
  await engine.runOnce(); // discover
  vault.files.set(NOTE_PATH, "---\ntitle: Example\n---\nEdited during inference.\n");

  // First attempt: the seam throws -- must be a transient retry AT THE CURRENT (stale) phase, never
  // silently swallowed into an immediate obsolete.
  await engine.runOnce(); // embed -- detects staleness, enqueue fails once
  const afterFailedEnqueue = await store.getById(job.job.jobId);
  assert.equal(afterFailedEnqueue?.status, "queued");
  assert.equal(afterFailedEnqueue?.job.phase, "embed", "must stay at the stale phase, not advance or go obsolete on a failed enqueue");
  assert.equal(replacement.calls.length, 0, "the failed attempt must not count as a successful enqueue");

  clock.ms += 60_000;
  await engine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SOURCE_STALE");
  assert.equal(replacement.calls.length, 1, "exactly one successful enqueue call, after the retry");
  const allJobs = await store.list();
  assert.equal(allJobs.length, 2, "exactly one replacement job, never duplicated by the retried attempt");
});

void test("(requirement 6) a crash after the replacement enqueue succeeds but before the obsolete receipt persists never re-enqueues a duplicate on restart", async () => {
  const vault = new FakeVault();
  vault.files.set(NOTE_PATH, RAW_CONTENT);
  const sourceReader = new FakeSourceReader(vault);
  const embedding = new FakeEmbedding();
  const metadata = new FakeMetadata();
  const index = new FakeIndex();
  const noteWriter = new NoteWriter(vault);
  const fs = new FakeFs();
  const store = new JobStore(fs, "/root");
  const clock = new FakeClock();
  const engineBox: { engine?: JobEngine } = {};
  const replacement = new FakeReplacement(engineBox);
  const runner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const engine = new JobEngine(store, { "process-note": runner }, clock);
  engineBox.engine = engine;

  const originalHash = sourceHashOf(RAW_CONTENT);
  const job = await engine.submit({ trigger: "manual", kind: "process-note", identity: identity(), sourceHash: originalHash, embeddingModel: "test-model", pipelineVersion: 1 });
  await engine.runOnce(); // discover -- now queued at "embed"
  vault.files.set(NOTE_PATH, "---\ntitle: Example\n---\nEdited during inference.\n");

  // Within this one runOnce(): 1st writeFile is the "mark active" persist; 2nd is the
  // replacement job's OWN append (JobEngine.submit's appendOrCoalesce, called from inside
  // enqueueReplacement); 3rd is the post-effect obsolete-receipt persist for THIS job -- fail
  // exactly that one, after the irreversible enqueue effect has already durably committed.
  fs.failWriteFileOnCallNumber = fs.writeFileCallCount + 3;
  await assert.rejects(() => engine.runOnce());
  fs.failWriteFileOnCallNumber = undefined;

  assert.equal(replacement.calls.length, 1, "the enqueue itself must have already succeeded (an irreversible external effect)");
  const afterCrash = await store.getById(job.job.jobId);
  assert.equal(afterCrash?.status, "active", "left at its last actually-committed state, never marked obsolete without a successful persist");

  // Simulate a real restart.
  await store.recoverInterruptedJobs();
  const freshRunner = new NoteJobRunner({ sourceReader, embedding, metadata, noteWriter, indexStore: index, replacement });
  const freshEngine = new JobEngine(store, { "process-note": freshRunner }, clock);
  await freshEngine.drain();

  const final = await store.getById(job.job.jobId);
  assert.equal(final?.status, "cancelled");
  assert.equal(final?.lastFailureCode, "SOURCE_STALE");
  // A cold restart's fresh runner has no memory of the pre-crash successful enqueue, so it may
  // legitimately call the seam again while re-detecting the same staleness -- that repeat call is
  // exactly what JobEngine.submit's own idempotency-key coalescing exists to absorb harmlessly.
  // The actual durability guarantee is on the STORE, not the seam's call count:
  const allJobs = await store.list();
  assert.equal(allJobs.length, 2, "exactly one replacement job total, even across the crash/restart");
});

void test("(requirement 7) a runner-model mismatch is a terminal failure, never cached or written under the wrong model", async () => {
  const h = buildHarness();
  h.embedding.nextModel = "a-different-model";
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_MODEL_MISMATCH");
  assert.equal(h.vault.modifyCount, 0);
  assert.equal(h.index.calls.length, 0);
});

void test("(requirement 7) an oversized chunk vector list is a terminal failure", async () => {
  const h = buildHarness();
  h.embedding.chunkVectorCountOverride = 10_001;
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_COUNT_MISMATCH");
});

void test("(requirement 7) a chunk vector with the wrong dimension is a terminal failure", async () => {
  const h = buildHarness();
  h.embedding.chunkDimensionOverride = 2;
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("(requirement 7) a zero note vector (non-unit-norm) is a terminal failure", async () => {
  const h = buildHarness();
  h.embedding.noteVectorOverride = new Float32Array([0, 0, 0]);
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_VECTOR_INVALID");
});

void test("(requirement 7) a non-finite value in the note vector is a terminal failure", async () => {
  const h = buildHarness();
  h.embedding.noteVectorOverride = new Float32Array([Number.NaN, 0, 0]);
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_VECTOR_INVALID");
});

void test("(requirement 7) an out-of-bounds dimension is a terminal failure", async () => {
  const h = buildHarness();
  h.embedding.dimensionOverride = 0;
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed");
  assert.equal(final?.lastFailureCode, "EMBEDDING_DIMENSION_INVALID");
});

// -- Checkpoint 7 acceptance guard 6: embedding seam runtime shape -- casted-malformed matrix ----

async function assertMalformedEmbedFailsClosed(raw: unknown, expectedCode: string): Promise<void> {
  const h = buildHarness();
  h.embedding.rawOverride = raw;
  const job = await submitNoteJob(h, sourceHashOf(RAW_CONTENT));
  await h.engine.drain();
  const final = await h.store.getById(job.job.jobId);
  assert.equal(final?.status, "failed", `expected a terminal failure for ${JSON.stringify(raw)}`);
  assert.equal(final?.lastFailureCode, expectedCode);
}

void test("(acceptance guard 6) a null embed() result fails closed with a structured outcome, never a raw TypeError", async () => {
  await assertMalformedEmbedFailsClosed(null, "EMBEDDING_VECTOR_INVALID");
});

void test("(acceptance guard 6) a non-object (string) embed() result fails closed", async () => {
  await assertMalformedEmbedFailsClosed("not-an-object", "EMBEDDING_VECTOR_INVALID");
});

void test("(acceptance guard 6) an array embed() result fails closed", async () => {
  await assertMalformedEmbedFailsClosed([1, 2, 3], "EMBEDDING_VECTOR_INVALID");
});

void test("(acceptance guard 6) a non-string model fails closed as a model mismatch, never a raw TypeError from string comparison", async () => {
  await assertMalformedEmbedFailsClosed({ model: 12345, dimension: 3, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [] }, "EMBEDDING_MODEL_MISMATCH");
});

void test("(acceptance guard 6) a null noteVector fails closed as invalid dimension, never a raw TypeError from .length access", async () => {
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: null, chunkVectors: [] }, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("(acceptance guard 6) a plain-object (non-Float32Array, non-array) noteVector fails closed, never a raw TypeError from Array.from", async () => {
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: { 0: 1, 1: 0, 2: 0, length: 3 }, chunkVectors: [] }, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("(acceptance guard 6) a noteVector that is a plain number[] (not a Float32Array) is validated the same way, without Array.from", async () => {
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: [0, 0, 0], chunkVectors: [] }, "EMBEDDING_VECTOR_INVALID");
});

void test("(acceptance guard 6) a null chunkVectors array fails closed, never a raw TypeError from iterating it", async () => {
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: new Float32Array([1, 0, 0]), chunkVectors: null }, "EMBEDDING_COUNT_MISMATCH");
});

void test("(acceptance guard 6) a sparse chunkVectors array (a hole) fails closed, never a raw TypeError", async () => {
  const sparse = [new Float32Array([1, 0, 0])];
  sparse[2] = new Float32Array([1, 0, 0]); // leaves index 1 a genuine hole
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: new Float32Array([1, 0, 0]), chunkVectors: sparse }, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("(last-contract guard) a fully-sparse chunkVectors array (every entry a hole, e.g. `new Array(n)`) fails closed, never a raw TypeError from .length/iteration on any entry", async () => {
  const fullySparse = new Array(3) as Float32Array[];
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: new Float32Array([1, 0, 0]), chunkVectors: fullySparse }, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("(acceptance guard 6) a chunkVectors entry that is null fails closed, never a raw TypeError from .length access", async () => {
  await assertMalformedEmbedFailsClosed({ model: "test-model", dimension: 3, noteVector: new Float32Array([1, 0, 0]), chunkVectors: [null] }, "EMBEDDING_DIMENSION_MISMATCH");
});

void test("duplicate manual triggers for the same note/sourceHash coalesce into one job", async () => {
  const h = buildHarness();
  const hash = sourceHashOf(RAW_CONTENT);
  const first = await submitNoteJob(h, hash);
  const second = await submitNoteJob(h, hash);
  assert.equal(first.job.jobId, second.job.jobId);
  const key = computeJobIdempotencyKey("process-note", { schemaVersion: 1, kind: "note", identity: identity() }, 1, hash, "test-model");
  assert.equal(first.job.idempotencyKey, key);
});
