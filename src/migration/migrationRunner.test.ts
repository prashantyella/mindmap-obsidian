import test from "node:test";
import assert from "node:assert/strict";

import { buildGeneration, loadCurrentGenerationId, switchCurrentGeneration } from "../index/generationStore";
import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import { stableNoteIdentity, canonicalizePath, type NoteIdentityV1 } from "../engine/contracts";
import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { projectSource } from "../engine/sourceProjection";
import { BUDGET_DISK_BYTES, computeDiskBytes } from "../index/budgets";
import { MAX_MANIFEST_SHARD_ROW_COUNT } from "../index/indexManifest";
import type { EmbeddedNote, NoteEmbeddingSeam } from "../jobs/noteJob";
import type { ScopeDiscoveryItem, ScopeDiscoverySeam } from "../jobs/scopeJob";
import type { MigrationSourceReader } from "./migrationIngest";
import { MigrationRunner, type MigrationRunnerDeps } from "./migrationRunner";
import { MigrationStore } from "./migrationStore";
import { listStagedNotes, writeStagedNote } from "./migrationStaging";
import { buildMigrationPlanV1, MigrationPlanStore } from "./migrationPlan";

const DEFAULT_DIMENSION = 4;
const DEFAULT_MODEL = "nomic-embed-text";

/** A tiny in-memory "vault": path -> raw content. Shared by the fake discovery seam and the fake source reader so both agree on exactly the same `sourceHash` (via the REAL `projectSource`), matching how `migrationIngest.ts` independently recomputes and cross-checks it. */
class FakeVault {
  private readonly content = new Map<string, string>();

  set(path: string, body: string): void {
    this.content.set(path, body);
  }

  delete(path: string): void {
    this.content.delete(path);
  }

  paths(): string[] {
    return [...this.content.keys()];
  }

  read(path: string): string | undefined {
    return this.content.get(path);
  }
}

function seedNotes(vault: FakeVault, count: number, prefix = "Notes"): void {
  for (let i = 0; i < count; i += 1) {
    vault.set(`${prefix}/note-${i}.md`, `# Note ${i}\n\nbody ${i}`);
  }
}

function fakeDiscovery(vault: FakeVault, embeddingModel = DEFAULT_MODEL): ScopeDiscoverySeam {
  return {
    async discover(): Promise<ScopeDiscoveryItem[]> {
      return vault.paths().map((path) => {
        const identity = stableNoteIdentity(canonicalizePath(path));
        const rawContent = vault.read(path)!;
        return { identity, sourceHash: projectSource(identity, rawContent).sourceHash, embeddingModel };
      });
    },
  };
}

function fakeSourceReader(vault: FakeVault): MigrationSourceReader {
  return {
    async read(identity: NoteIdentityV1): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
      const rawContent = vault.read(identity.canonicalPath);
      if (rawContent === undefined) return null;
      return { identity, rawContent };
    },
  };
}

interface FakeEmbeddingOptions {
  model?: string;
  dimension?: number;
  failIdentities?: Set<string>;
  wrongDimensionIdentities?: Set<string>;
}

function unitVector(dimension: number): Float32Array {
  const v = new Float32Array(dimension);
  v[0] = 1;
  return v;
}

function fakeEmbedding(options: FakeEmbeddingOptions = {}): NoteEmbeddingSeam {
  const model = options.model ?? DEFAULT_MODEL;
  const dimension = options.dimension ?? DEFAULT_DIMENSION;
  return {
    async embed(projection): Promise<EmbeddedNote> {
      const path = projection.identity.canonicalPath;
      if (options.failIdentities?.has(path)) {
        throw new Error("simulated embedding provider failure");
      }
      const dim = options.wrongDimensionIdentities?.has(path) ? dimension + 1 : dimension;
      return { model, dimension: dim, noteVector: unitVector(dim), chunkVectors: [unitVector(dim)] };
    },
  };
}

/** Review item 13: counts every `rename()` call landing on the pointer file (`current.json`) -- the ONE place a generation activation actually becomes visible. Wraps (never replaces) the real `FakeIndexFs.rename`. */
function countPointerSwitches(fs: FakeIndexFs): { count: () => number } {
  const original = fs.rename.bind(fs);
  let switches = 0;
  fs.rename = async (fromPath: string, toPath: string) => {
    if (toPath.endsWith("/current.json") || toPath === "current.json") switches += 1;
    return original(fromPath, toPath);
  };
  return { count: () => switches };
}

function makeRunner(overrides: Partial<MigrationRunnerDeps> & { vault?: FakeVault; embedding?: NoteEmbeddingSeam } = {}) {
  const fs = (overrides.fs as FakeIndexFs) ?? new FakeIndexFs();
  const dataRoot = overrides.dataRoot ?? "/data";
  const vault = overrides.vault ?? new FakeVault();
  const store = new MigrationStore(fs, dataRoot);
  const runner = new MigrationRunner({
    store,
    discovery: overrides.discovery ?? fakeDiscovery(vault, overrides.embeddingModel ?? DEFAULT_MODEL),
    ingestion: { sourceReader: fakeSourceReader(vault), embedding: overrides.embedding ?? fakeEmbedding({ model: overrides.embeddingModel ?? DEFAULT_MODEL }) },
    fs,
    dataRoot,
    embeddingModel: overrides.embeddingModel ?? DEFAULT_MODEL,
    dimension: "dimension" in overrides ? overrides.dimension : DEFAULT_DIMENSION,
    pipelineVersion: overrides.pipelineVersion ?? 1,
    ingestBatchSize: overrides.ingestBatchSize,
    runIdFactory: overrides.runIdFactory,
    clock: overrides.clock,
    signal: overrides.signal,
  });
  return { runner, fs, dataRoot, vault, store };
}

/** Drives `reconcile()` until a terminal phase (or a bounded number of ticks elapses, to fail fast on an infinite loop bug rather than hanging the test run). */
async function runToTerminal(runner: MigrationRunner, maxTicks = 20_000) {
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "complete" && status.phase !== "failed" && status.phase !== "cancelled") {
    status = await runner.reconcile();
    ticks += 1;
    if (ticks > maxTicks) throw new Error(`runToTerminal exceeded ${maxTicks} ticks without reaching a terminal phase (stuck at "${status.phase}").`);
  }
  return status;
}

void test("fresh install: getStatus() synthesizes not-started without persisting until start() is called", async () => {
  const { runner, fs, dataRoot } = makeRunner();
  const status = await runner.getStatus();
  assert.equal(status.phase, "not-started");
  assert.equal(status.canStart, true);
  assert.equal(await new MigrationStore(fs, dataRoot).load(), null, "getStatus() must not itself persist a not-started record");
});

void test("full happy path: discover -> plan -> build -> verify -> activate -> complete, staging every note and switching the pointer exactly once", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 3);

  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "complete");
  assert.equal(final.messageCode, "COMPLETE");
  assert.equal(final.processedCount, 3);
  assert.equal(final.failedCount, 0);

  const generationId = await loadCurrentGenerationId(fs, dataRoot);
  assert.ok(generationId !== null, "a generation must have been activated");

  // Staging/plan artifacts are cleared once activation completes.
  const runId = final.runId!;
  const staged = await listStagedNotes(fs, dataRoot, runId);
  assert.equal(staged.length, 0, "staging must be cleared after a successful activation");
  const plan = await new MigrationPlanStore(fs, dataRoot, runId).load();
  assert.equal(plan, null, "the plan artifact must be cleared after a successful activation");
});

void test("zero effects outside the migration-owned subtree: never touches NoteWriter/vault/overlay-shaped paths", async () => {
  const { runner, fs, vault } = makeRunner();
  seedNotes(vault, 2);
  await runner.start();
  await runToTerminal(runner);
  for (const path of [...fs.files.keys(), ...fs.dirs, ...fs.binaryFiles.keys()]) {
    assert.doesNotMatch(path.toLowerCase(), /chroma/);
    assert.doesNotMatch(path, /^overlays\//, "migration must never write to the active-overlay namespace");
  }
});

void test("empty corpus builds/verifies/activates a valid empty generation using the configured model/dimension -- never an arbitrary one", async () => {
  const { runner, fs, dataRoot } = makeRunner();
  const final = await runToTerminal(await runner.start().then(() => runner));
  assert.equal(final.phase, "complete");
  const generationId = await loadCurrentGenerationId(fs, dataRoot);
  assert.ok(generationId !== null);
});

void test("empty corpus with no configured dimension fails closed rather than guessing one", async () => {
  const { runner } = makeRunner({ dimension: undefined });
  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "failed");
});

async function seedMatchingGeneration(fs: FakeIndexFs, dataRoot: string, vault: FakeVault, embeddingModel: string, dimension: number, generationId = 1): Promise<void> {
  const items = await fakeDiscovery(vault, embeddingModel).discover("migration:full-vault", new AbortController().signal);
  const notes = items.map((item) => ({ identity: item.identity, sourceHash: item.sourceHash, vector: unitVector(dimension), chunkCount: 0, loadChunkVectors: async () => [] }));
  await buildGeneration(fs, dataRoot, { generationId, embeddingModel, dimension, notes }, {});
  await switchCurrentGeneration(fs, dataRoot, generationId);
}

void test("already-migrated matching generation is a genuine full-verify no-op -- no staging/plan artifacts are written", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 2);
  await seedMatchingGeneration(fs, dataRoot, vault, DEFAULT_MODEL, DEFAULT_DIMENSION);

  const status = await runner.start();
  assert.equal(status.phase, "complete");
  assert.equal(status.messageCode, "ALREADY_UP_TO_DATE");
});

void test("item 1: an existing generation whose note set does not EXACTLY match the current vault (stale/missing/extra rows) is never accepted as already up to date", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 2);
  // Seed a generation matching only ONE of the two current notes -- a stale/incomplete prior state.
  const oneNoteVault = new FakeVault();
  oneNoteVault.set("Notes/note-0.md", vault.read("Notes/note-0.md")!);
  await seedMatchingGeneration(fs, dataRoot, oneNoteVault, DEFAULT_MODEL, DEFAULT_DIMENSION);

  const status = await runner.start();
  assert.notEqual(status.messageCode, "ALREADY_UP_TO_DATE", "a generation missing a currently-discovered note must never be accepted as up to date");
});

void test("a corrupt current generation is never treated as up to date -- migration proceeds to build a fresh one", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 1);
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: DEFAULT_MODEL, dimension: DEFAULT_DIMENSION, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  // Corrupt the activated generation's manifest.
  fs.files.set("/data/generations/gen-1/manifest.json", "{ not valid json");

  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "complete");
  assert.equal(final.messageCode, "COMPLETE", "must have actually rebuilt, never short-circuited to ALREADY_UP_TO_DATE over a corrupt generation");
});

void test("a changed embedding model/dimension invalidates a completed plan and starts a fresh migration", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner({ embeddingModel: DEFAULT_MODEL, dimension: DEFAULT_DIMENSION });
  seedNotes(vault, 1);
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "different-model", dimension: 512, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  const status = await runner.start();
  assert.notEqual(status.phase, "complete");
});

void test("start() is idempotent while a run is already in flight -- never restarts in-progress work", async () => {
  const { runner, vault } = makeRunner();
  seedNotes(vault, 2);
  const first = await runner.start();
  const second = await runner.start();
  assert.deepEqual(first, second);
});

void test("item 3: any owned note-ingestion failure blocks activation -- the run surfaces failed rather than proceeding to build/verify/activate", async () => {
  const { runner, vault } = makeRunner({ embedding: fakeEmbedding({ failIdentities: new Set(["Notes/note-1.md"]) }) });
  seedNotes(vault, 3);
  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "failed");
  assert.equal(final.failedCount, 1);
});

void test("item 3: a mismatched embedding dimension is rejected rather than silently accepted", async () => {
  const { runner, vault } = makeRunner({ embedding: fakeEmbedding({ wrongDimensionIdentities: new Set(["Notes/note-0.md"]) }) });
  seedNotes(vault, 1);
  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "failed");
});

void test("restart-safety: a brand-new MigrationRunner instance mid-build resumes from persisted cursor/staging, without re-ingesting an already-staged note", async () => {
  const fs = new FakeIndexFs();
  const vault = new FakeVault();
  seedNotes(vault, 3);
  let embedCalls = 0;
  const countingEmbedding: NoteEmbeddingSeam = {
    async embed(projection, signal) {
      embedCalls += 1;
      return fakeEmbedding().embed(projection, signal);
    },
  };
  const { runner: first } = makeRunner({ fs, dataRoot: "/data", vault, embedding: countingEmbedding, ingestBatchSize: 1 });
  await first.start(); // lands at "build", cursorIndex 0 -- nothing ingested yet
  await first.reconcile(); // ingests exactly one note (batch size 1)
  const midStatus = await first.getStatus();
  assert.equal(midStatus.phase, "build");
  assert.equal(embedCalls, 1);

  // Simulate a crash: a fresh MigrationRunner instance, no in-memory state carried over.
  const { runner: resumed } = makeRunner({ fs, dataRoot: "/data", vault, embedding: countingEmbedding, ingestBatchSize: 1 });
  await resumed.reconcile(); // ingests the second note
  await resumed.reconcile(); // ingests the third note -> moves to verify
  assert.equal(embedCalls, 3, "the already-staged first note must never be re-embedded across the restart");
  const final = await runToTerminal(resumed);
  assert.equal(final.phase, "complete");
});

void test("restart-safety: resuming after a crash between build-generation and activation adopts the already-built target rather than building a second one", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 2);
  await runner.start();
  // Drive manually up through "activate" without letting it complete, by reconciling until phase === "activate".
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && status.phase !== "failed" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");
  const targetId = (await new MigrationStore(fs, dataRoot).load())?.activationGenerationId;
  assert.ok(targetId !== undefined);

  const { runner: resumed } = makeRunner({ fs, dataRoot, vault });
  const finalStatus = await runToTerminal(resumed);
  assert.equal(finalStatus.phase, "complete");
  const currentId = await loadCurrentGenerationId(fs, dataRoot);
  assert.equal(currentId, targetId, "must have activated the SAME already-built generation, never a second one");
});

void test("item 4/3: post-ingest drift (the vault changed since planning) is caught at verify -- build itself never re-discovers per note", async () => {
  const { runner, vault } = makeRunner({ ingestBatchSize: 1 });
  seedNotes(vault, 1);
  await runner.start(); // phase "build", cursorIndex 0 -- nothing ingested yet
  const afterIngest = await runner.reconcile(); // ingests the single note, cursor reaches plan length -> "verify"
  assert.equal(afterIngest.phase, "verify");
  // Mutate the vault AFTER build finished but BEFORE verify's own (single) discovery check runs.
  vault.set("Notes/late-arrival.md", "# late\n\nbody");
  const status = await runner.reconcile();
  assert.equal(status.phase, "build", "verify's drift check must route back through a fresh plan/build, never silently ignored");
});

void test("item 7: cancel() before activation persists intent and settles cancelled without touching the generation pointer", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 3);
  await runner.start();
  const status = await runner.cancel();
  assert.equal(status.phase, "cancelled");
  assert.equal(await loadCurrentGenerationId(fs, dataRoot), null, "no generation pointer should ever have been touched");
});

void test("item 7: cancellation is not honored once activation (the locked pointer switch) has begun", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 1);
  await runner.start();
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");
  const cancelled = await runner.cancel();
  assert.equal(cancelled.phase, "activate", "cancel() must be a no-op once activation has begun");
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "complete");
  assert.ok((await loadCurrentGenerationId(fs, dataRoot)) !== null);
});

void test("a failed target-generation verification during activation leaves the OLD pointer untouched", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 1);
  // Seed an existing current generation so there IS an old pointer to preserve.
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "different-model", dimension: 999, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  await runner.start();
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && status.phase !== "failed" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");
  const record = await new MigrationStore(fs, dataRoot).load();
  const targetId = record!.activationGenerationId!;
  // Corrupt the freshly-built target generation right before the switch would happen.
  fs.files.delete(`/data/generations/gen-${targetId}/manifest.json`);

  const failed = await runner.reconcile();
  assert.equal(failed.phase, "failed");
  const currentId = await loadCurrentGenerationId(fs, dataRoot);
  assert.equal(currentId, 1, "the OLD pointer must be left exactly as it was");
});

void test("a fresh retry after a failed run never touches (or deletes) the failed run's own staging/plan artifacts", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner({ embedding: fakeEmbedding({ failIdentities: new Set(["Notes/note-0.md"]) }) });
  seedNotes(vault, 1);
  await runner.start();
  const failedStatus = await runToTerminal(runner);
  assert.equal(failedStatus.phase, "failed");
  const failedRunId = failedStatus.runId!;

  const { runner: retried } = makeRunner({ fs, dataRoot, vault, embedding: fakeEmbedding() });
  await retried.start();
  const retriedFinal = await runToTerminal(retried);
  assert.equal(retriedFinal.phase, "complete");
  assert.notEqual(retriedFinal.runId, failedRunId, "a retry mints its own fresh runId, never reusing the failed run's");
});

void test("item 1: start() mints a fresh runId every NEW run, and it is carried unchanged through every phase transition of that run", async () => {
  const { runner, vault } = makeRunner();
  seedNotes(vault, 1);
  const build = await runner.start();
  assert.ok(build.runId, "a runId must be minted the moment a run begins");
  const runId = build.runId;
  const final = await runToTerminal(runner);
  assert.equal(final.runId, runId, "runId must survive all the way through to complete");
});

void test("subscribe/unsubscribe fanout: a throwing listener never breaks another subscriber, and unsubscribe stops further notifications", async () => {
  const { runner, vault } = makeRunner();
  seedNotes(vault, 1);
  const received: string[] = [];
  const unsubscribeThrowing = runner.subscribe(() => {
    throw new Error("boom");
  });
  const unsubscribeOk = runner.subscribe((status) => received.push(status.phase));

  await runner.start();
  assert.ok(received.length > 0);

  unsubscribeOk();
  received.length = 0;
  await runner.cancel();
  assert.deepEqual(received, [], "unsubscribed listener must not be notified");
  unsubscribeThrowing();
});

void test("dispose() clears every subscriber; no late notification arrives after dispose", async () => {
  const { runner, vault } = makeRunner();
  seedNotes(vault, 1);
  const received: string[] = [];
  runner.subscribe((status) => received.push(status.phase));
  await runner.start();
  received.length = 0;
  runner.dispose();
  await runner.cancel();
  assert.deepEqual(received, []);
});

void test("scale: 2,001 notes (above the 2,000 overlay cap) migrate to one generation with exact final counts", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner({ ingestBatchSize: 500 });
  seedNotes(vault, 2001);
  await runner.start();
  const final = await runToTerminal(runner, 50);
  assert.equal(final.phase, "complete");
  assert.equal(final.processedCount, 2001);
  assert.equal(final.failedCount, 0);
  assert.ok((await loadCurrentGenerationId(fs, dataRoot)) !== null);
});

void test("scale: exactly 10,000 notes at a tiny dimension migrate successfully with exact final counts, a single pointer switch, and bounded per-read residency (never one blob for the whole corpus)", async () => {
  const dimension = 2;
  const { runner, fs, dataRoot, vault } = makeRunner({ dimension, ingestBatchSize: 1000, embedding: fakeEmbedding({ dimension }) });
  const pointerSwitches = countPointerSwitches(fs);

  // Item 7: instruments every binary read (staging AND generation-build shard reads alike) to
  // prove genuine streaming residency -- at no point does any single read pull in anywhere close
  // to the whole 10,000-note corpus's worth of bytes; the largest single read stays bounded by
  // roughly one shard (<= MAX_MANIFEST_SHARD_ROW_COUNT rows) or one note's own tiny vector.
  let maxSingleReadBytes = 0;
  let readCount = 0;
  const originalReadFileBytes = fs.readFileBytes.bind(fs);
  fs.readFileBytes = async (path: string) => {
    const bytes = await originalReadFileBytes(path);
    readCount += 1;
    maxSingleReadBytes = Math.max(maxSingleReadBytes, bytes.length);
    return bytes;
  };

  seedNotes(vault, 10_000);
  await runner.start();
  const final = await runToTerminal(runner, 50);
  assert.equal(final.phase, "complete");
  assert.equal(final.processedCount, 10_000);
  assert.ok((await loadCurrentGenerationId(fs, dataRoot)) !== null);
  assert.equal(pointerSwitches.count(), 1, "exactly one pointer switch for the whole 10,000-note run");
  for (const path of [...fs.files.keys(), ...fs.binaryFiles.keys()]) {
    assert.doesNotMatch(path, /^\/data\/overlays\//, "10,000-note migration must never write into the active-overlay namespace");
  }
  assert.ok(readCount > 0, "sanity: the instrumented read path was actually exercised");
  // One full shard's worth of encoded chunk bytes at this dimension, generously bounded -- the
  // whole 10,000-note corpus at this dimension would be roughly 10x this if ever read as one blob.
  const oneShardBoundBytes = MAX_MANIFEST_SHARD_ROW_COUNT * dimension * 4 * 2 + 4096;
  assert.ok(maxSingleReadBytes <= oneShardBoundBytes, `expected the largest single binary read (${maxSingleReadBytes} bytes) to stay within one shard's bound (${oneShardBoundBytes} bytes), never the whole corpus at once`);
});

void test("item 3: build performs O(1) full discoveries total, never one per note -- instrumented over a 500-note stable run", async () => {
  let discoverCalls = 0;
  const vault = new FakeVault();
  seedNotes(vault, 500);
  const countingDiscovery: ScopeDiscoverySeam = {
    async discover(scopeId, signal) {
      discoverCalls += 1;
      return fakeDiscovery(vault).discover(scopeId, signal);
    },
  };
  const { runner } = makeRunner({ vault, discovery: countingDiscovery, ingestBatchSize: 1 });
  await runner.start();
  const final = await runToTerminal(runner, 1000);
  assert.equal(final.phase, "complete");
  // plan (1) + verify's own pre-build check (1) + activate's own pre-switch check (1) -- never
  // proportional to the 500 notes ingested one reconcile() tick at a time.
  assert.ok(discoverCalls <= 4, `expected O(1) discovery calls for a 500-note stable run, got ${discoverCalls}`);
});

void test("item 2: a mid-run embedding-model change abandons the in-flight run and starts a fresh one under the new config, never finishing the old run", async () => {
  const fs = new FakeIndexFs();
  const vault = new FakeVault();
  seedNotes(vault, 2);
  const { runner: original } = makeRunner({ fs, vault, embeddingModel: "model-a", ingestBatchSize: 1 });
  const firstStatus = await original.start();
  const originalRunId = firstStatus.runId;
  assert.equal(firstStatus.phase, "build");

  // A NEW runner instance over the SAME store/root, configured with a DIFFERENT embedding model --
  // simulates the user changing the Ollama model in settings between restarts while a migration was
  // still mid-flight.
  const { runner: reconfigured } = makeRunner({ fs, vault, embeddingModel: "model-b", ingestBatchSize: 1 });
  const afterDrift = await reconfigured.reconcile();
  assert.notEqual(afterDrift.runId, originalRunId, "a config-drifted reconcile must mint a fresh run, never reuse the old run's id");
  assert.notEqual(afterDrift.phase, "complete", "the OLD run's in-flight work must never be silently finished under the new config");

  const final = await runToTerminal(reconfigured);
  assert.equal(final.phase, "complete");
});

void test("item 6: a crash immediately after persisting complete (cleanupPending still true) resumes cleanup on the NEXT reconcile(), without ever re-entering activation", async () => {
  const { runner, vault, store } = makeRunner();
  seedNotes(vault, 1);
  await runner.start();
  const final = await runToTerminal(runner);
  assert.equal(final.phase, "complete");

  const record = await store.load();
  assert.ok(record);
  const runId = record!.runId!;
  // Simulate a crash that persisted "complete" but never got to run its best-effort cleanup: flip
  // cleanupPending back to true (revision continues to advance normally through setPhase).
  await store.setPhase("complete", "COMPLETE", { discoveredCount: record!.discoveredCount, processedCount: record!.processedCount, failedCount: 0 }, new Date(0).toISOString(), {
    runId,
    stagingRunId: runId,
    desiredEmbeddingModel: record!.desiredEmbeddingModel,
    desiredDimension: record!.desiredDimension,
    desiredPipelineVersion: record!.desiredPipelineVersion,
    cleanupPending: true,
  });

  const resumed = await runner.reconcile();
  assert.equal(resumed.phase, "complete");
  const afterCleanup = await store.load();
  assert.equal(afterCleanup?.cleanupPending, false, "the pending cleanup must have been retried and cleared");
});

void test("item 7: an idempotent activation retry (currentId already equals targetId) still re-verifies the target fingerprint -- a fully-valid-but-different generation swapped in at the same id is rejected, never silently accepted", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 1);
  await runner.start();
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");
  const record = await new MigrationStore(fs, dataRoot).load();
  const targetId = record!.activationGenerationId!;

  // Manually pre-switch the pointer to targetId OUTSIDE the runner's own transaction (simulating an
  // idempotent retry landing after the switch already committed on a prior attempt).
  await switchCurrentGeneration(fs, dataRoot, targetId);

  // Build a SECOND, fully self-consistent generation with genuinely different content at a
  // DIFFERENT id, then physically relocate its artifacts onto targetId's own paths (patching only
  // the manifest's embedded generationId field back to targetId) -- a fully-valid, checksum-clean,
  // generationId-matching generation that is nonetheless NOT the one this run itself built.
  const decoyId = 9999;
  const decoyIdentity = stableNoteIdentity(canonicalizePath("Notes/decoy.md"));
  await buildGeneration(
    fs,
    dataRoot,
    { generationId: decoyId, embeddingModel: DEFAULT_MODEL, dimension: DEFAULT_DIMENSION, notes: [{ identity: decoyIdentity, sourceHash: "c".repeat(64), vector: unitVector(DEFAULT_DIMENSION), chunkCount: 0, loadChunkVectors: async () => [] }] },
    {},
  );
  const decoyPrefix = `/data/generations/gen-${decoyId}/`;
  const targetPrefix = `/data/generations/gen-${targetId}/`;
  for (const [path, content] of [...fs.files.entries()]) {
    if (!path.startsWith(decoyPrefix)) continue;
    const targetPath = targetPrefix + path.slice(decoyPrefix.length);
    let patched = content;
    if (path.endsWith("manifest.json")) {
      // AtomicStore's own on-disk wrapper is `{ schemaVersion, data: <the actual manifest> }` --
      // the generationId that must match the directory lives under `.data`, not at the top level.
      const wrapper = JSON.parse(content);
      patched = JSON.stringify({ ...wrapper, data: { ...wrapper.data, generationId: targetId } });
    }
    fs.files.set(targetPath, patched);
  }
  for (const [path, bytes] of [...fs.binaryFiles.entries()]) {
    if (!path.startsWith(decoyPrefix)) continue;
    fs.binaryFiles.set(targetPrefix + path.slice(decoyPrefix.length), bytes);
  }

  const outcome = await runner.reconcile();
  assert.equal(outcome.phase, "failed", "a same-id-but-different-content generation must be rejected even on the idempotent already-switched path");
});

void test("item 14: a fresh start() sweeps a prior failed run's abandoned staging/plan directories, never the run it is about to create", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner({ embedding: fakeEmbedding({ failIdentities: new Set(["Notes/note-0.md"]) }) });
  seedNotes(vault, 1);
  await runner.start();
  const failed = await runToTerminal(runner);
  assert.equal(failed.phase, "failed");
  const failedRunId = failed.runId!;
  // The failed run's plan artifact is still on disk (only a successful completion clears it).
  assert.ok(await new MigrationPlanStore(fs, dataRoot, failedRunId).load());

  const { runner: retried } = makeRunner({ fs, dataRoot, vault, embedding: fakeEmbedding() });
  const retriedStatus = await retried.start();
  assert.notEqual(retriedStatus.runId, failedRunId);
  // The abandoned run's plan.json must have been swept as part of starting the fresh one.
  assert.equal(await new MigrationPlanStore(fs, dataRoot, failedRunId).load(), null, "start() must sweep the abandoned prior run's plan artifact");
  const final = await runToTerminal(retried);
  assert.equal(final.phase, "complete");
});

void test("item 11: repeated ingestion ticks never leak AbortSignal listeners on the long-lived outer signal", async () => {
  const vault = new FakeVault();
  seedNotes(vault, 20);
  const outerController = new AbortController();
  let addCount = 0;
  let removeCount = 0;
  const outerSignal = outerController.signal;
  const originalAdd = outerSignal.addEventListener.bind(outerSignal);
  const originalRemove = outerSignal.removeEventListener.bind(outerSignal);
  outerSignal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
    addCount += 1;
    return originalAdd(...args);
  }) as typeof originalAdd;
  outerSignal.removeEventListener = ((...args: Parameters<typeof originalRemove>) => {
    removeCount += 1;
    return originalRemove(...args);
  }) as typeof originalRemove;

  const { runner } = makeRunner({ vault, signal: outerSignal, ingestBatchSize: 1 });
  await runner.start();
  await runToTerminal(runner, 1000);
  assert.equal(addCount, removeCount, `every listener added to the outer signal must be removed again (added ${addCount}, removed ${removeCount})`);
  assert.ok(addCount > 0, "sanity: the combining branch must actually have been exercised (both cancelController and deps.signal present)");
});

void test("item 12: two MigrationRunner instances over the SAME (fs, dataRoot) racing reconcile() never duplicate ingestion effects -- exactly one pointer switch, exact final counts", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const vault = new FakeVault();
  seedNotes(vault, 30);
  let embedCalls = 0;
  const countingEmbedding: NoteEmbeddingSeam = {
    async embed(projection, signal) {
      embedCalls += 1;
      return fakeEmbedding().embed(projection, signal);
    },
  };
  const pointerSwitches = countPointerSwitches(fs);
  const { runner: a } = makeRunner({ fs, dataRoot, vault, embedding: countingEmbedding, ingestBatchSize: 3 });
  const { runner: b } = makeRunner({ fs, dataRoot, vault, embedding: countingEmbedding, ingestBatchSize: 3 });

  await a.start();
  // Race many concurrent reconcile() calls from BOTH instances -- the shared per-root reconcile lock
  // must serialize every one of them into a single effect lane.
  for (let round = 0; round < 20; round += 1) {
    await Promise.all([a.reconcile(), b.reconcile()]);
  }
  const finalA = await a.getStatus();
  const finalB = await b.getStatus();
  assert.deepEqual(finalA, finalB, "both instances must observe the exact same final state");
  assert.equal(finalA.phase, "complete");
  assert.equal(finalA.processedCount, 30);
  assert.equal(embedCalls, 30, "each note must be embedded exactly once total across BOTH racing instances, never duplicated");
  assert.equal(pointerSwitches.count(), 1, "exactly one pointer switch despite two racing instances");
});

void test("item 1: sweepAbandonedRuns finds and clears a STAGING-ONLY orphan (a plan.json that was already removed, staging left behind) via the union of runs+staging listings", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  const orphanRunId = "orphan-run";
  await writeStagedNote(fs, dataRoot, orphanRunId, {
    identity: stableNoteIdentity(canonicalizePath("Notes/orphan.md")),
    sourceHash: "a".repeat(64),
    embeddingModel: DEFAULT_MODEL,
    dimension: DEFAULT_DIMENSION,
    noteVector: unitVector(DEFAULT_DIMENSION),
    chunkVectors: [],
  });
  // No migration/runs/orphan-run/plan.json was ever written -- listMigrationRunIds alone would
  // never find this orphan; only the union with listStagingRunIds does.
  assert.equal((await listStagedNotes(fs, dataRoot, orphanRunId)).length, 1);

  seedNotes(vault, 1);
  await runner.start();
  assert.equal((await listStagedNotes(fs, dataRoot, orphanRunId)).length, 0, "the staging-only orphan must have been swept by the fresh start()");
});

void test("item 3: corruption introduced AFTER this instance already trusted a prefix is caught on the very next tick via the per-tick spot-check, not merely at restart", async () => {
  const { runner, fs, vault } = makeRunner({ ingestBatchSize: 1 });
  seedNotes(vault, 2);
  await runner.start();
  const afterFirst = await runner.reconcile(); // ingests note-0, this instance now trusts cursor=1
  assert.equal(afterFirst.phase, "build");
  assert.equal(afterFirst.processedCount, 1);
  const runId = afterFirst.runId!;

  // Corrupt the just-trusted note's binary directly on disk -- e.g. external interference -- WITHOUT
  // ever restarting the runner instance.
  const notePath = [...fs.binaryFiles.keys()].find((p) => p.includes(`/staging/${runId}/`) && p.endsWith(".note.mvx"));
  assert.ok(notePath);
  fs.binaryFiles.delete(notePath!);

  const afterSecond = await runner.reconcile();
  // The spot-check must have caught the corruption and re-ingested note-0 rather than trusting the
  // (now-invalid) high-water mark and only ingesting note-1.
  assert.ok(afterSecond.processedCount <= 1, "corruption must reset progress, never silently continue past an invalid entry");

  const final = await runToTerminal(runner);
  assert.equal(final.phase, "complete");
  assert.equal(final.processedCount, 2, "the final generation must still end up with both notes despite the mid-run corruption");
});

void test("item 3: a tampered (understated) persisted stagedChunkCount is never trusted -- a fresh instance reconstructs the true total from verified staged metadata before continuing", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const vault = new FakeVault();
  seedNotes(vault, 5);
  const store = new MigrationStore(fs, dataRoot);

  const { runner: first } = makeRunner({ fs, dataRoot, vault, ingestBatchSize: 3 });
  await first.start();
  const afterFirstBatch = await first.reconcile();
  assert.equal(afterFirstBatch.phase, "build");
  assert.equal(afterFirstBatch.processedCount, 3);

  // Tamper the persisted stagedChunkCount down to 0 (simulating corruption/a manual edit) while
  // leaving cursorIndex/phase untouched -- if a fresh instance ever trusted this blindly, it would
  // resume believing only 0 chunks were staged instead of the real 3 (one chunk per note).
  await store.mutate((cur) => ({ ...cur!, stagedChunkCount: 0 }));

  const { runner: resumed } = makeRunner({ fs, dataRoot, vault, ingestBatchSize: 1 });
  await resumed.reconcile(); // ingests note index 3
  const record = await store.load();
  assert.equal(record?.stagedChunkCount, 4, "stagedChunkCount must be reconstructed from real staged metadata (3 already-staged + 1 just-ingested), never resumed from the tampered 0");

  const final = await runToTerminal(resumed);
  assert.equal(final.phase, "complete");
  assert.equal(final.processedCount, 5);
});

void test("item 4: an unverifiable base whose raw manifest bytes CHANGE before the pointer switch is detected as drift and triggers a replan, never activated over", async () => {
  const { runner, fs, vault } = makeRunner();
  seedNotes(vault, 1);
  fs.dirs.add("/data/generations/gen-1");
  fs.files.set("/data/generations/gen-1/manifest.json", "{ not valid json v1");
  fs.files.set("/data/current.json", JSON.stringify({ schemaVersion: 1, data: { generationId: 1 } }));

  await runner.start();
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && status.phase !== "failed" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");

  // The base generation's raw manifest bytes change (still invalid JSON, but DIFFERENT bytes) --
  // simulating something else touching it between "verify" and the locked pointer switch.
  fs.files.set("/data/generations/gen-1/manifest.json", "{ not valid json v2 -- changed");

  const afterChange = await runner.reconcile();
  assert.equal(afterChange.phase, "build", "a changed (still-unverifiable) base must be treated as drift and trigger a fresh plan, never a silent activation over it");
});

void test("item 4: a base generation the current pointer names but whose manifest is entirely MISSING (not merely corrupt) fails closed rather than proceeding with no fingerprint", async () => {
  const { runner, fs, vault } = makeRunner();
  seedNotes(vault, 1);
  // current.json points at generation 1, but NOTHING was ever written under generations/gen-1/ --
  // genuinely missing, not just unparseable.
  fs.files.set("/data/current.json", JSON.stringify({ schemaVersion: 1, data: { generationId: 1 } }));

  const status = await runner.start();
  assert.equal(status.phase, "failed", "an unverifiable base with no readable manifest bytes at all must fail closed, never be captured as a fingerprint-less snapshot");
});

void test("item 6: shared budget helpers -- a high-dimension, MODEST note/chunk count crosses the approved disk budget (the exact formula MigrationRunner's own per-tick check uses, via the same estimateShardCounts-style greedy split)", () => {
  const dimension = MAX_EMBEDDING_DIMENSION;
  const noteCount = 100;
  const chunksPerNote = 200;
  const totalChunks = noteCount * chunksPerNote;
  const shardCounts: number[] = [];
  let remaining = totalChunks;
  while (remaining > 0) {
    const take = Math.min(remaining, MAX_MANIFEST_SHARD_ROW_COUNT);
    shardCounts.push(take);
    remaining -= take;
  }
  const diskBytes = computeDiskBytes(dimension, noteCount, shardCounts);
  assert.ok(diskBytes > BUDGET_DISK_BYTES, `expected ${diskBytes} bytes to exceed the ${BUDGET_DISK_BYTES}-byte disk budget for ${noteCount} notes at dimension ${dimension} -- note/chunk COUNT bounds alone are dimension-independent and would accept this.`);
});

void test("item 6: aggregate chunk count crossing MAX_MANIFEST_CHUNK_COUNT (100,000) is rejected before the run is allowed to advance past the entry that would cross it", async () => {
  const manyChunksEmbedding: NoteEmbeddingSeam = {
    async embed(): Promise<EmbeddedNote> {
      return { model: DEFAULT_MODEL, dimension: 2, noteVector: unitVector(2), chunkVectors: Array.from({ length: 10_000 }, () => unitVector(2)) };
    },
  };
  const { runner, vault } = makeRunner({ dimension: 2, ingestBatchSize: 1, embedding: manyChunksEmbedding });
  seedNotes(vault, 11); // 11 * 10,000 = 110,000 > 100,000
  await runner.start();
  const final = await runToTerminal(runner, 20);
  assert.equal(final.phase, "failed");
  assert.equal(final.lastFailureCode, "JOB_CAP_EXCEEDED");
});

void test("item 2: an IMMEDIATELY IMPOSSIBLE plan (the minimum floor -- every planned note, zero chunks -- already exceeds budget) fails closed with ZERO staged files ever written, and never even calls the embedding seam", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const runId = "run-1";
  let embedCalls = 0;
  const countingEmbedding: NoteEmbeddingSeam = {
    async embed(projection, signal) {
      embedCalls += 1;
      return fakeEmbedding({ dimension: MAX_EMBEDDING_DIMENSION }).embed(projection, signal);
    },
  };
  // 10,000 notes (the approved ceiling) at the maximum embedding dimension -- the note-matrix
  // alone (zero chunks) already exceeds the approved rebuild-peak-memory budget, so this must be
  // rejected before a single note is ingested.
  const entries = Array.from({ length: 10_000 }, (_v, i) => ({
    identity: stableNoteIdentity(canonicalizePath(`Notes/n${i}.md`)),
    sourceHash: "a".repeat(64),
    embeddingModel: DEFAULT_MODEL,
  }));
  const plan = buildMigrationPlanV1({ runId, desiredEmbeddingModel: DEFAULT_MODEL, desiredDimension: MAX_EMBEDDING_DIMENSION, desiredPipelineVersion: 1, baseGenerationState: "none", entries });
  await new MigrationPlanStore(fs, dataRoot, runId).save(plan);
  const store = new MigrationStore(fs, dataRoot);
  await store.setPhase("build", "BUILDING_INDEX", { discoveredCount: entries.length, processedCount: 0, failedCount: 0 }, new Date(0).toISOString(), {
    runId,
    stagingRunId: runId,
    desiredEmbeddingModel: DEFAULT_MODEL,
    desiredDimension: MAX_EMBEDDING_DIMENSION,
    desiredPipelineVersion: 1,
    planFingerprint: plan.planFingerprint,
    baseGenerationState: "none",
    cursorIndex: 0,
    stagedChunkCount: 0,
  });

  const runner = new MigrationRunner({
    store,
    discovery: { async discover() { return entries.map((e) => ({ identity: e.identity, sourceHash: e.sourceHash, embeddingModel: e.embeddingModel })); } },
    ingestion: { sourceReader: fakeSourceReader(new FakeVault()), embedding: countingEmbedding },
    fs,
    dataRoot,
    embeddingModel: DEFAULT_MODEL,
    dimension: MAX_EMBEDDING_DIMENSION,
    pipelineVersion: 1,
  });

  const status = await runner.reconcile();
  assert.equal(status.phase, "failed");
  assert.equal(status.lastFailureCode, "JOB_CAP_EXCEEDED");
  assert.equal(embedCalls, 0, "the embedding seam must never be invoked for an already-impossible plan");
  assert.equal((await listStagedNotes(fs, dataRoot, runId)).length, 0, "zero staged files for a plan that was impossible before any ingestion began");
});

void test("item 2: budget is enforced with the REAL post-embed chunk count BEFORE the crossing entry is written -- staging is byte-identical before and after the rejected attempt", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const runId = "run-1";
  const dimension = MAX_EMBEDDING_DIMENSION;
  const okIdentity = stableNoteIdentity(canonicalizePath("Notes/ok.md"));
  const crossingIdentity = stableNoteIdentity(canonicalizePath("Notes/crossing.md"));
  const okSourceHash = projectSource(okIdentity, "ok").sourceHash;
  const crossingSourceHash = projectSource(crossingIdentity, "crossing").sourceHash;
  const entries = [
    { identity: okIdentity, sourceHash: okSourceHash, embeddingModel: DEFAULT_MODEL },
    { identity: crossingIdentity, sourceHash: crossingSourceHash, embeddingModel: DEFAULT_MODEL },
  ];
  const plan = buildMigrationPlanV1({ runId, desiredEmbeddingModel: DEFAULT_MODEL, desiredDimension: dimension, desiredPipelineVersion: 1, baseGenerationState: "none", entries });
  await new MigrationPlanStore(fs, dataRoot, runId).save(plan);

  // Pre-stage the first entry directly (cheap -- 1 chunk), simulating a prior tick that already
  // committed it.
  await writeStagedNote(fs, dataRoot, runId, { identity: okIdentity, sourceHash: okSourceHash, embeddingModel: DEFAULT_MODEL, dimension, noteVector: unitVector(dimension), chunkVectors: [unitVector(dimension)] });

  const store = new MigrationStore(fs, dataRoot);
  await store.setPhase("build", "BUILDING_INDEX", { discoveredCount: entries.length, processedCount: 1, failedCount: 0 }, new Date(0).toISOString(), {
    runId,
    stagingRunId: runId,
    desiredEmbeddingModel: DEFAULT_MODEL,
    desiredDimension: dimension,
    desiredPipelineVersion: 1,
    planFingerprint: plan.planFingerprint,
    baseGenerationState: "none",
    cursorIndex: 1,
    stagedChunkCount: 1,
  });

  // The STAGING snapshot BEFORE the crossing attempt -- only the pre-staged entry's own files
  // under migration/staging/<runId>/ (migration/state.json and migration/runs/<runId>/plan.json
  // are EXPECTED to change when the run legitimately fails -- only the staged ARTIFACTS themselves
  // must stay byte-identical).
  const stagingPrefix = `/data/migration/staging/${runId}/`;
  const beforeFiles = new Map([...fs.files].filter(([path]) => path.startsWith(stagingPrefix)));
  const beforeBinaries = new Map([...fs.binaryFiles].filter(([path]) => path.startsWith(stagingPrefix)));

  // The crossing entry's embed produces the maximum legal per-note chunk count (10,000) at the
  // maximum dimension -- alone already exceeds the rebuild-peak memory budget.
  const crossingEmbedding: NoteEmbeddingSeam = {
    async embed(): Promise<EmbeddedNote> {
      return { model: DEFAULT_MODEL, dimension, noteVector: unitVector(dimension), chunkVectors: Array.from({ length: MAX_MANIFEST_SHARD_ROW_COUNT }, () => unitVector(dimension)) };
    },
  };
  const sourceVault = new FakeVault();
  sourceVault.set(okIdentity.canonicalPath, "ok");
  sourceVault.set(crossingIdentity.canonicalPath, "crossing");
  const runner = new MigrationRunner({
    store,
    discovery: { async discover() { return entries; } },
    ingestion: { sourceReader: fakeSourceReader(sourceVault), embedding: crossingEmbedding },
    fs,
    dataRoot,
    embeddingModel: DEFAULT_MODEL,
    dimension,
    pipelineVersion: 1,
  });

  const status = await runner.reconcile();
  assert.equal(status.phase, "failed");
  assert.equal(status.lastFailureCode, "JOB_CAP_EXCEEDED");

  const afterFiles = new Map([...fs.files].filter(([path]) => path.startsWith(stagingPrefix)));
  const afterBinaries = new Map([...fs.binaryFiles].filter(([path]) => path.startsWith(stagingPrefix)));
  assert.deepEqual([...afterFiles.keys()].sort(), [...beforeFiles.keys()].sort(), "no new staged JSON metadata file may exist for the rejected crossing entry");
  assert.deepEqual([...afterBinaries.keys()].sort(), [...beforeBinaries.keys()].sort(), "no new staged binary artifact may exist for the rejected crossing entry");
  for (const [path, content] of beforeFiles) assert.equal(afterFiles.get(path), content, `${path} must be byte-identical to before the rejected attempt`);
});

void test("item 1: a genuine (non-ENOENT) readdir failure during cleanup leaves cleanupPending true and the plan artifact intact, retried automatically once the fault clears", async () => {
  const { runner, fs, dataRoot, vault } = makeRunner();
  seedNotes(vault, 1);
  await runner.start();
  let status = await runner.getStatus();
  let ticks = 0;
  while (status.phase !== "activate" && ticks < 1000) {
    status = await runner.reconcile();
    ticks += 1;
  }
  assert.equal(status.phase, "activate");

  fs.faults.add("readdir"); // injected fault, no typed missing-path code -- clearStaging must report failure
  const afterActivate = await runner.reconcile();
  assert.equal(afterActivate.phase, "complete", "the pointer switch itself must still succeed even though cleanup will fail");
  const runId = afterActivate.runId!;
  const record = await new MigrationStore(fs, dataRoot).load();
  assert.equal(record?.cleanupPending, true, "cleanup must remain pending after a genuine (non-missing) cleanup failure");
  assert.ok(await new MigrationPlanStore(fs, dataRoot, runId).load(), "the plan artifact must remain intact while cleanup is still pending -- never deleted on a failed attempt");

  fs.faults.delete("readdir");
  const resumed = await runner.reconcile();
  assert.equal(resumed.phase, "complete");
  const finalRecord = await new MigrationStore(fs, dataRoot).load();
  assert.equal(finalRecord?.cleanupPending, false, "cleanup must succeed and clear cleanupPending once the fault is gone");
  assert.equal(await new MigrationPlanStore(fs, dataRoot, runId).load(), null, "the plan artifact is finally cleared once cleanup actually succeeds");
});
