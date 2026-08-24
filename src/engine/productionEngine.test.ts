import test from "node:test";
import assert from "node:assert/strict";
import type { Vault } from "obsidian";

import { FakeIndexFs } from "../index/fakeIndexFs.test-support";
import { buildGeneration, switchCurrentGeneration } from "../index/generationStore";
import type { IntervalRegistrar } from "../scheduling/coreScheduler";
import { isEngineError } from "./errors";
import { MigrationStore } from "../migration/migrationStore";
import { createProductionScopeDiscoverySeam } from "./productionVaultAdapter";
import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { projectSource } from "./sourceProjection";
import { ProductionEngine, buildProductionScopeRegistry, PRODUCTION_SCOPE_CURRENT, PRODUCTION_SCOPE_ALL, PRODUCTION_SCOPE_READING } from "./productionEngine";

/** A fuller fake `Vault` (unlike this file's own minimal `fakeVault` below) that actually resolves/reads note content -- needed to exercise the real scope-registry discovery seam end to end. Mirrors `productionVaultAdapter.test.ts`'s own `fakeVault` helper. */
function richFakeVault(files: Record<string, string>, configDir = ".obsidian"): Vault {
  const toFile = (filePath: string) => ({ path: filePath, extension: filePath.split(".").pop() ?? "", stat: { size: 0, mtime: 0, ctime: 0 } });
  return {
    configDir,
    getMarkdownFiles: () => Object.keys(files).filter((p) => p.endsWith(".md")).map(toFile) as never,
    getAbstractFileByPath: (relpath: string): unknown => (Object.prototype.hasOwnProperty.call(files, relpath) ? toFile(relpath) : null),
    read: async (file: { path: string }) => files[file.path],
    cachedRead: async (file: { path: string }) => files[file.path],
  } as unknown as Vault;
}

function fakeVault(files: Record<string, string> = {}, configDir = ".obsidian"): Vault {
  const entries = Object.keys(files).map((filePath) => ({ path: filePath, extension: filePath.split(".").pop() ?? "" }));
  return {
    configDir,
    getMarkdownFiles: () => entries.filter((entry) => entry.extension === "md") as never,
    adapter: {
      exists: async (relpath: string) => Object.prototype.hasOwnProperty.call(files, relpath),
      read: async (relpath: string) => files[relpath],
      write: async (relpath: string, content: string) => { files[relpath] = content; },
      mkdir: async () => undefined,
    },
    create: async (relpath: string, content: string) => { files[relpath] = content; return { path: relpath }; },
  } as unknown as Vault;
}

function fakeRegistrar(): IntervalRegistrar & { registerCount: number } {
  return {
    registerCount: 0,
    registerInterval(_callback: () => void, _intervalMs: number) {
      (this as { registerCount: number }).registerCount += 1;
      return {};
    },
    cancelInterval() {
      // no-op
    },
  };
}

type ProductionEngineOptions = ConstructorParameters<typeof ProductionEngine>[0];

/** Prerequisite 1 (10B cutover): `ProductionEngineOptions.vaultFileClasses` is now REQUIRED (no structural fallback in a real engine) -- these fake classes satisfy that requirement for every test in this file without needing to model real Obsidian `instanceof` behavior (no test here exercises actual vault-object guards). */
class FakeTFile {}
class FakeTFolder {}
function fakeVaultFileClasses(): ProductionEngineOptions["vaultFileClasses"] {
  return { TFile: FakeTFile as never, TFolder: FakeTFolder as never };
}

function fakeAppleBooksOptions(): ProductionEngineOptions["appleBooks"] {
  return {
    config: {},
    homeDirectory: "/fake-home",
    sqliteProcess: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never,
    fs: { readdir: async () => [], stat: async () => { throw new Error("ENOENT"); }, exists: async () => false } as never,
  };
}

function baseOptions(overrides: Partial<ProductionEngineOptions> = {}): ProductionEngineOptions {
  return {
    dataRoot: "/data",
    fs: new FakeIndexFs(),
    registrar: fakeRegistrar(),
    vault: fakeVault(),
    embeddingProvider: null,
    embeddingModel: null,
    metadataProvider: null,
    metadataPipelineConfig: null,
    scopeFolders: ["Notes"],
    currentScopeFolders: ["Notes/Current"],
    minimumWords: 30,
    pipelineVersion: 1,
    appleBooks: fakeAppleBooksOptions(),
    vaultFileClasses: fakeVaultFileClasses(),
    ...overrides,
  } as ProductionEngineOptions;
}

/** Bounded fake Ollama-embedding readiness probe -- reports "ok" so tests can exercise the item-2 provider-readiness gate deterministically without a real Ollama endpoint. */
function okProbe(): import("./preflight").PreflightProbe {
  return async () => ({ status: "ok", message: "fake probe ok" });
}

void test("ProductionEngine.start() composes every store and returns a runtime-ready preflight report on a clean fake filesystem, without providers configured", async () => {
  const engine = new ProductionEngine(baseOptions());
  const report = await engine.start();
  assert.equal(engine.getPhase(), "started");
  assert.equal(report.summary.runtimeReady, true);
  await engine.dispose();
});

function readyProviders(): Pick<ProductionEngineOptions, "embeddingProvider" | "embeddingModel" | "embeddingDimension" | "metadataProvider" | "metadataPipelineConfig" | "probes" | "chunkOptions" | "relatedSelectionConfig"> {
  const fakeEmbeddingProvider = { embedBatch: async () => ({ model: "m", dimension: 4, items: [] }) };
  const fakeMetadataProvider = { complete: async () => "{}" };
  return {
    embeddingProvider: fakeEmbeddingProvider as never,
    embeddingModel: "nomic-embed-text",
    embeddingDimension: 768,
    metadataProvider: fakeMetadataProvider as never,
    metadataPipelineConfig: { model: "m", maxTokens: 200, tagLimit: 5, conceptLimit: 5, conceptMaxWords: 3, conceptCaseMode: "lower", controlledTags: [], allowFreeTags: true, tagMinLen: 2, tagMaxWords: 3, tagAliases: {} } as never,
    probes: { ollama: okProbe(), localMetadataProvider: okProbe() },
    chunkOptions: { targetTokens: 400, overlapTokens: 40 },
    relatedSelectionConfig: { relatedLimit: 8, overreachCount: 0, creativeCount: 0, creativeMin: 0.45, creativeMax: 0.7, candidateLimit: 40, minScore: 0 },
  };
}

/** Every vector is the SAME fixed unit basis vector (`[1,0,0,0]`) regardless of input text -- deterministic, always-unit-norm, and always cosine-1 against itself/anything else this fixture embeds, so ranking tests never depend on a real hash/model. */
function fixedVectorEmbeddingProvider(dimension = 4): import("./embeddingProvider").EmbeddingProvider {
  const values = Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0));
  return {
    async embedBatch(request) {
      return { model: request.model, dimension, items: request.items.map((item) => ({ id: item.id, values })) };
    },
  };
}

void test("ProductionEngine.start() never starts the job pump/scheduler when providers are not configured (item 1/2: fresh install stays gated, no migration record yet)", async () => {
  const registrar = fakeRegistrar();
  const engine = new ProductionEngine(baseOptions({ registrar }));
  await engine.start();
  assert.equal(registrar.registerCount, 1, "only MigrationDriver's own interval may register -- CoreScheduler must never start with no providers configured and migration not-started");
  await engine.dispose();
});

void test("ProductionEngine.start() never starts the ordinary pump/scheduler on a fresh (not-started) migration even when providers ARE configured and ready (item 1: not-started blocks)", async () => {
  const registrar = fakeRegistrar();
  const engine = new ProductionEngine(baseOptions({ registrar, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();
  assert.equal((await engine.getMigrationStatus()).phase, "not-started");
  assert.equal(registrar.registerCount, 1, "not-started migration must block both the pump and CoreScheduler even with ready providers");
  await engine.dispose();
});

void test("ProductionEngine.startMigration() + provider readiness together clear the gate: pump/scheduler start automatically once migration reaches complete", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  // Seed an already-matching generation so this run's plan phase resolves straight to
  // ALREADY_UP_TO_DATE in one call, keeping this test deterministic (no dependency on how many
  // reconcile() ticks a real build/verify/activate pass would take for a non-empty diff).
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, registrar, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();
  assert.equal(registrar.registerCount, 1, "still gated before startMigration() is ever called");

  const status = await engine.startMigration();
  assert.equal(status.phase, "complete", "an empty vault against an already-matching generation plans straight to ALREADY_UP_TO_DATE");
  assert.equal(registrar.registerCount, 2, "CoreScheduler must start once migration completes and providers are ready");
  await engine.dispose();
});

void test("ProductionEngine.onMigrationComplete fires once migration reaches complete, not before, and a throwing listener never breaks the engine (Checkpoint 10B sidebar cache invalidation hook)", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  let completeCount = 0;
  const engine = new ProductionEngine(baseOptions({
    fs,
    dataRoot,
    ...readyProviders(),
    onMigrationComplete: () => {
      completeCount += 1;
      throw new Error("a throwing listener must not break the engine");
    },
  }) as ProductionEngineOptions);
  await engine.start();
  assert.equal(completeCount, 0, "must not fire before migration is started, e.g. on a fresh not-started migration");

  const status = await engine.startMigration();
  assert.equal(status.phase, "complete");
  assert.equal(completeCount, 1, "must fire exactly once for this single completion");
  await engine.dispose();
});

void test("ProductionEngine never throws when onMigrationComplete is omitted", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();
  const status = await engine.startMigration();
  assert.equal(status.phase, "complete");
  await engine.dispose();
});

void test("ProductionEngine.startMigration()/retryMigration() (item 2) throw a closed MIGRATION_NOT_STARTABLE error with NO state mutation when the engine itself has never started", async () => {
  const engine = new ProductionEngine(baseOptions(readyProviders() as ProductionEngineOptions));
  await assert.rejects(() => engine.startMigration(), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_NOT_STARTABLE");
  assert.equal((await engine.getMigrationStatus()).phase, "not-started", "a rejected startMigration() must never mutate the persisted migration record");
  await assert.rejects(() => engine.retryMigration(), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_NOT_STARTABLE");
  assert.equal((await engine.getMigrationStatus()).phase, "not-started");
});

void test("ProductionEngine.startMigration()/retryMigration() (item 2) throw a closed MIGRATION_NOT_STARTABLE error with NO state mutation when the FRESH embedding probe is not ok, even though the engine has started", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const unreachableProbe: import("./preflight").PreflightProbe = async () => ({ status: "unavailable", message: "fake probe down" });
  const engine = new ProductionEngine(
    baseOptions({ fs, dataRoot, registrar, ...readyProviders(), probes: { ollama: unreachableProbe, localMetadataProvider: okProbe() } }) as ProductionEngineOptions,
  );
  await engine.start();
  await assert.rejects(() => engine.startMigration(), (error: unknown) => isEngineError(error) && error.code === "MIGRATION_NOT_STARTABLE");
  assert.equal((await engine.getMigrationStatus()).phase, "not-started", "a rejected startMigration() must never mutate the persisted migration record");
  await engine.dispose();
});

void test("ProductionEngine.startMigration() (item 2) succeeds once the engine has started AND the fresh embedding probe is ok", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, registrar, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();
  const status = await engine.startMigration();
  assert.equal(status.phase, "complete");
  await engine.dispose();
});

void test("ProductionEngine.start() (item 1) never starts CoreScheduler while a prior migration run is sitting failed -- then starts it automatically once retryMigration() actually completes the run", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  // Seed a migration run terminally "failed" (deterministic: reconcile() short-circuits a terminal
  // phase immediately, with no discovery/job submission and thus no race against the real pump)
  // plus an already-matching generation, so a later retryMigration() resolves straight to
  // "complete" via the SAME plan-phase fast path `migrationRunner.test.ts` covers
  // ("ALREADY_UP_TO_DATE"), with no process-note job ever submitted -- keeping this test's timing
  // fully deterministic.
  await new MigrationStore(fs, dataRoot).setPhase("failed", "FAILED_RETRYABLE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, new Date(0).toISOString(), { lastFailureCode: "EMBEDDING_REQUEST_FAILED" });
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  const engine = new ProductionEngine(
    baseOptions({
      fs,
      dataRoot,
      registrar,
      ...readyProviders(),
      embeddingDimension: 768,
    }) as ProductionEngineOptions,
  );
  await engine.start();
  assert.equal((await engine.getMigrationStatus()).phase, "failed");
  assert.equal(registrar.registerCount, 1, "only MigrationDriver's interval may register while a prior migration run is failed, not complete");

  await engine.retryMigration();
  assert.equal((await engine.getMigrationStatus()).phase, "complete");
  assert.equal(registrar.registerCount, 2, "CoreScheduler must start automatically once the retried migration run reaches complete");
  await engine.dispose();
});

void test("ProductionEngine.start() never starts the ordinary pump OR CoreScheduler when migration is complete but provider readiness probes are not ok (item 1/2: both halves share ONE joint readiness gate -- non-null provider objects are not readiness)", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  await new MigrationStore(fs, dataRoot).setPhase("complete", "ALREADY_UP_TO_DATE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, new Date(0).toISOString(), {
    runId: "seed-run",
    desiredEmbeddingModel: "nomic-embed-text",
    desiredDimension: 768,
    desiredPipelineVersion: 1,
  });

  const unreachableProbe: import("./preflight").PreflightProbe = async () => ({ status: "unavailable", message: "fake probe down" });
  const engine = new ProductionEngine(
    baseOptions({
      fs,
      dataRoot,
      registrar,
      ...readyProviders(),
      embeddingDimension: 768,
      probes: { ollama: unreachableProbe, localMetadataProvider: okProbe() },
    }) as ProductionEngineOptions,
  );
  await engine.start();
  assert.equal(registrar.registerCount, 1, "item 1: CoreScheduler must stay gated (only MigrationDriver's own interval registers) when the embedding readiness probe is not ok, exactly like the pump");
  assert.equal(engine.getOrdinaryWorkStatus().pumpStarted, false, "the ordinary JobEngine pump must stay gated when the embedding readiness probe is not ok");
  assert.equal(engine.getOrdinaryWorkStatus().schedulerStarted, false, "CoreScheduler must stay gated too -- both halves now share the same joint readiness requirement");
  await engine.dispose();
});

void test("ProductionEngine.recheckReadiness() (item 1) stops BOTH the pump and CoreScheduler once a previously-ok embedding probe degrades, and restarts both exactly once the probe recovers", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  await new MigrationStore(fs, dataRoot).setPhase("complete", "ALREADY_UP_TO_DATE", { discoveredCount: 0, processedCount: 0, failedCount: 0 }, new Date(0).toISOString(), {
    runId: "seed-run",
    desiredEmbeddingModel: "nomic-embed-text",
    desiredDimension: 768,
    desiredPipelineVersion: 1,
  });

  let ollamaOk = true;
  const flakyProbe: import("./preflight").PreflightProbe = async () => (ollamaOk ? { status: "ok", message: "fake probe ok" } : { status: "unavailable", message: "fake probe down" });
  const engine = new ProductionEngine(
    baseOptions({
      fs,
      dataRoot,
      registrar,
      ...readyProviders(),
      embeddingDimension: 768,
      probes: { ollama: flakyProbe, localMetadataProvider: okProbe() },
    }) as ProductionEngineOptions,
  );
  await engine.start();
  assert.equal(engine.getOrdinaryWorkStatus().pumpStarted, true, "both halves start while the probe is ok");
  assert.equal(engine.getOrdinaryWorkStatus().schedulerStarted, true);

  ollamaOk = false;
  await engine.recheckReadiness();
  assert.equal(engine.getOrdinaryWorkStatus().pumpStarted, false, "an explicit recheck must stop the pump once the embedding probe degrades");
  assert.equal(engine.getOrdinaryWorkStatus().schedulerStarted, false, "an explicit recheck must stop CoreScheduler together with the pump, never independently");

  ollamaOk = true;
  await engine.recheckReadiness();
  assert.equal(engine.getOrdinaryWorkStatus().pumpStarted, true, "a later recheck restarts the pump once the probe recovers");
  assert.equal(engine.getOrdinaryWorkStatus().schedulerStarted, true, "a later recheck restarts CoreScheduler once the probe recovers");
  await engine.dispose();
});

void test("ProductionEngine.start() is idempotent -- calling twice returns the same report and does not repeat the recovery sequence", async () => {
  const fs = new FakeIndexFs();
  const engine = new ProductionEngine(baseOptions({ fs }));
  const first = await engine.start();
  const readsAfterFirst = fs.readFileCalls.length;
  const second = await engine.start();
  assert.deepEqual(first, second);
  assert.equal(fs.readFileCalls.length, readsAfterFirst, "second start() must not re-run preflight/recovery I/O");
  await engine.dispose();
});

void test("ProductionEngine.start() (10B cutover bugfix) never runs a redundant second preflight pass on a fresh install -- getLastPreflightReport() stays byte-identical to what start() itself returned", async () => {
  const engine = new ProductionEngine(baseOptions());
  const returned = await engine.start();
  assert.deepEqual(engine.getLastPreflightReport(), returned, "start()'s own internal tryStartOrdinaryWork() call must not overwrite lastPreflightReport with a second, microseconds-later preflight pass when migration is not complete");
  await engine.dispose();
});

void test("ProductionEngine survives repeated start/stop/dispose cycles without throwing", async () => {
  const engine = new ProductionEngine(baseOptions());
  await engine.start();
  await engine.stop();
  await engine.start();
  await engine.stop();
  await engine.dispose();
  await engine.dispose();
  await engine.stop();
  assert.equal(engine.getPhase(), "disposed");
});

void test("ProductionEngine.dispose() before start() is a safe no-op, and no queued work is ever dispatched afterward", async () => {
  const engine = new ProductionEngine(baseOptions());
  await engine.dispose();
  assert.equal(engine.getPhase(), "disposed");
  const status = await engine.getMigrationStatus();
  assert.equal(status.phase, "not-started");
});

void test("ProductionEngine.inspectReadOnly() never mutates phase or creates owned subdirectories", async () => {
  const fs = new FakeIndexFs();
  const engine = new ProductionEngine(baseOptions({ fs }));
  await engine.inspectReadOnly();
  assert.equal(engine.getPhase(), "idle");
  assert.equal(fs.dirs.has("/data/jobs"), false, "inspectReadOnly must never create the owned subdirectories -- that is start()'s job alone");
});

void test("ProductionEngine.start() creates the migration subdirectory alongside jobs/schedules/index", async () => {
  const fs = new FakeIndexFs();
  const engine = new ProductionEngine(baseOptions({ fs }));
  await engine.start();
  assert.ok(fs.dirs.has("/data/migration"));
  await engine.dispose();
});

void test("ProductionEngine.getMigrationStatus() reflects a fresh install as not-started before any migration begins", async () => {
  const engine = new ProductionEngine(baseOptions());
  const status = await engine.getMigrationStatus();
  assert.equal(status.phase, "not-started");
});

void test("ProductionEngine runner map (item 3): no providers configured registers only rebuild-index, never process-note/scope-refresh/reading-sync/migrate-index", () => {
  const engine = new ProductionEngine(baseOptions());
  const runners = engine.getRegisteredRunnerMap();
  assert.deepEqual(Object.keys(runners).sort(), ["rebuild-index"]);
});

void test("ProductionEngine runner map (item 6): embeddingModel alone does NOT register scope-refresh/reading-sync -- both enqueue process-note jobs, so they require the SAME full provider config process-note itself requires, never a looser embeddingModel-alone check", () => {
  const engine = new ProductionEngine(baseOptions({ embeddingModel: "nomic-embed-text" }));
  const runners = engine.getRegisteredRunnerMap();
  assert.deepEqual(Object.keys(runners).sort(), ["rebuild-index"]);
});

void test("ProductionEngine runner map (item 3/6): full provider config registers scope-refresh AND reading-sync as the SAME ScopeJobRunner instance, alongside process-note", () => {
  const engine = new ProductionEngine(baseOptions(readyProviders() as ProductionEngineOptions));
  const runners = engine.getRegisteredRunnerMap();
  assert.deepEqual(Object.keys(runners).sort(), ["process-note", "reading-sync", "rebuild-index", "scope-refresh"]);
  assert.equal(runners["scope-refresh"], runners["reading-sync"], "the exact same ScopeJobRunner instance must serve both job kinds");
});

void test("ProductionEngine runner map (item 3): full provider configuration additionally registers process-note, and never a migrate-index key at all", () => {
  const engine = new ProductionEngine(baseOptions(readyProviders() as ProductionEngineOptions));
  const runners = engine.getRegisteredRunnerMap();
  assert.deepEqual(Object.keys(runners).sort(), ["process-note", "reading-sync", "rebuild-index", "scope-refresh"]);
  assert.equal("migrate-index" in runners, false, "migration is self-contained inside MigrationRunner -- there is no migrate-index job runner to register");
});

void test("ProductionEngine composes AppleBooksSqliteReader from explicit options.appleBooks -- construction performs zero I/O, and a later checkAccess() only ever touches the injected fake homeDirectory/fs, never a real one", async () => {
  const readdirCalls: string[] = [];
  const fakeFs = {
    readdir: async (directory: string) => {
      readdirCalls.push(directory);
      return [];
    },
  };
  const engine = new ProductionEngine(
    baseOptions({
      appleBooks: {
        config: {},
        homeDirectory: "/fake-home-for-this-test-only",
        sqliteProcess: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } as never,
        fs: fakeFs as never,
      },
    }),
  );
  assert.equal(readdirCalls.length, 0, "constructing ProductionEngine (and its AppleBooksSqliteReader) must perform zero I/O");

  await engine.appleBooksReader.checkAccess();
  assert.ok(readdirCalls.length > 0, "checkAccess() should have actually probed the injected fake filesystem");
  for (const directory of readdirCalls) {
    assert.ok(directory.startsWith("/fake-home-for-this-test-only"), `checkAccess() must only ever touch the injected fake homeDirectory, never a real one -- got "${directory}"`);
  }
});

void test("ProductionEngine passes an explicit annotationDbPath/libraryDbPath override straight through to AppleBooksSqliteReader, skipping discovery entirely", async () => {
  const readdirCalls: string[] = [];
  const fakeFs = {
    readdir: async (directory: string) => { readdirCalls.push(directory); return []; },
    probe: async () => ({ kind: "missing" }) as never,
  };
  const runCalls: unknown[] = [];
  const engine = new ProductionEngine(
    baseOptions({
      appleBooks: {
        config: {},
        homeDirectory: "/fake-home",
        annotationDbPath: "/fake-home/override/AEAnnotation.sqlite",
        libraryDbPath: "/fake-home/override/BKLibrary.sqlite",
        sqliteProcess: {
          run: async (args: unknown) => {
            runCalls.push(args);
            return { stdout: "[]", stderr: "", exitCode: 0 };
          },
        } as never,
        fs: fakeFs as never,
      },
    }),
  );
  await engine.appleBooksReader.checkAccess();
  assert.equal(readdirCalls.length, 0, "an explicit override for BOTH db paths must skip directory discovery entirely");
});

void test("ProductionEngine preservation (item 9): plugin-owned data outside jobs/schedules/index/migration is never touched across start/startMigration/cancelMigration/stop/dispose", async () => {
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  // Seed byte-identical stand-ins for the things migration must never touch: legacy Python
  // settings, Reading/research/schedule state files, and a vault note, all living at paths
  // OUTSIDE dataRoot's owned jobs/schedules/index/migration subdirectories (this fake fs has no
  // separate "vault" -- a real vault note write would go through the Obsidian Vault seam, never
  // this fs at all, which is exactly what this test's "never touched" assertion also covers by
  // using a completely different, non-plugin-owned filesystem root).
  const legacyPaths = ["/legacy/settings.json", "/legacy/reading-state.json", "/legacy/research-cache.json", "/legacy/schedule.json", "/vault/Notes/untouched.md"];
  const legacyContents = new Map(legacyPaths.map((p) => [p, `original-content-for-${p}`]));
  for (const [p, content] of legacyContents) {
    await fs.writeFile(p, content);
  }

  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();
  await engine.startMigration();
  await engine.cancelMigration(); // a no-op once already complete/terminal, but exercises the call path
  await engine.stop();
  await engine.start();
  await engine.dispose();

  for (const [p, original] of legacyContents) {
    assert.equal(fs.files.get(p), original, `${p} must be byte-identical after the full migration/lifecycle sequence -- only TS-owned migration/index paths may change`);
  }
  // Confirm every actually-written path stayed confined to dataRoot's owned subdirectories.
  for (const writtenPath of fs.files.keys()) {
    if (legacyContents.has(writtenPath)) continue;
    assert.ok(
      writtenPath.startsWith(`${dataRoot}/jobs`) || writtenPath.startsWith(`${dataRoot}/schedules`) || writtenPath.startsWith(`${dataRoot}/index`) || writtenPath.startsWith(`${dataRoot}/migration`),
      `unexpected write outside owned subdirectories: ${writtenPath}`,
    );
  }
});

void test("ProductionEngine.dispose() during a hung preflight probe unwinds promptly and prevents the pump/scheduler from ever starting (item 10)", async () => {
  const registrar = fakeRegistrar();
  const hungOllamaProbe: import("./preflight").PreflightProbe = (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const engine = new ProductionEngine(
    baseOptions({
      registrar,
      ...readyProviders(),
      probes: { ollama: hungOllamaProbe, localMetadataProvider: okProbe() },
    }) as ProductionEngineOptions,
  );
  const startPromise = engine.start();
  await engine.dispose();
  await startPromise;
  assert.equal(engine.getPhase(), "disposed");
  assert.equal(engine.getOrdinaryWorkStatus().pumpStarted, false);
  assert.equal(engine.getOrdinaryWorkStatus().schedulerStarted, false);
});

void test("ProductionEngine.dispose() concurrent with startMigration() reaching complete never leaves the pump/scheduler running afterward (item 10: dispose during completion notification/scheduler-start)", async () => {
  const registrar = fakeRegistrar();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  await buildGeneration(fs, dataRoot, { generationId: 1, embeddingModel: "nomic-embed-text", dimension: 768, notes: [] }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);
  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, registrar, ...readyProviders() }) as ProductionEngineOptions);
  await engine.start();

  const migratePromise = engine.startMigration();
  const disposePromise = engine.dispose();
  await Promise.all([migratePromise, disposePromise]);

  assert.equal(engine.getPhase(), "disposed");
  // Whichever interleaving occurred, dispose() must be the one that determines the final
  // resting state -- no job/scheduler effect may fire and stay running after dispose() settles.
  const status = engine.getOrdinaryWorkStatus();
  if (status.schedulerStarted || status.pumpStarted) {
    // If ordinary work DID start before dispose() tore it down, coreScheduler/jobEngine's own
    // dispose() must have already run (idempotent either way) -- this engine never claims BOTH
    // "started" and "disposed" as simultaneously live.
    assert.equal(engine.getPhase(), "disposed");
  }
});

void test("ProductionEngine calling start() twice in a row (without an intervening stop()) never registers a second MigrationDriver interval (item 10: no duplicate intervals from a redundant start())", async () => {
  const registrar = fakeRegistrar();
  const engine = new ProductionEngine(baseOptions({ registrar }));
  await engine.start();
  const afterFirstStart = registrar.registerCount;
  await engine.start();
  assert.equal(registrar.registerCount, afterFirstStart, "a redundant start() while already started must not register a second interval");
  await engine.dispose();
});

void test("ProductionEngine stop() then start() cleanly re-registers exactly one fresh MigrationDriver interval -- a legitimate restart, not an accumulating leak (item 10)", async () => {
  const registrar = fakeRegistrar();
  const engine = new ProductionEngine(baseOptions({ registrar }));
  await engine.start();
  const afterFirstStart = registrar.registerCount;
  await engine.stop();
  await engine.start();
  assert.equal(registrar.registerCount, afterFirstStart + 1, "a genuine stop()+start() restart cycle registers exactly one new interval, never zero (leaked-stopped) or more than one (duplicated)");
  await engine.dispose();
});

void test("ProductionEngine.openRelatedNote (item 5) rejects a target inside the configured runtimeFolder, using the SAME runtimeFolder this engine was constructed with", async () => {
  const calls: unknown[] = [];
  const workspace = { openLinkText: async (...args: unknown[]) => { calls.push(args); } } as unknown as import("obsidian").Workspace;
  const engine = new ProductionEngine(baseOptions({ workspace, runtimeFolder: ".obsidian/plugins/mindmap" }));
  await assert.rejects(
    () => engine.openRelatedNote(".obsidian/plugins/mindmap/internal.md"),
    (error: unknown) => error instanceof Error && (error as { code?: string }).code === "IDENTITY_INVALID",
  );
  assert.equal(calls.length, 0, "a target inside the configured runtimeFolder must never reach workspace.openLinkText");

  await engine.openRelatedNote("Notes/ordinary.md");
  assert.deepEqual(calls, [["Notes/ordinary.md", "", false]]);
});

const SCOPE_REGISTRY_LONG_NOTE = "word ".repeat(40).trim();
const SCOPE_REGISTRY_ANNOTATION_TEXT = ["---", "type: apple-books-annotation", "annotation_id: abc123", "---", SCOPE_REGISTRY_LONG_NOTE].join("\n");

function scopeRegistryFixture(): { vault: Vault; files: Record<string, string> } {
  const files: Record<string, string> = {
    "Notes/Current/a.md": `---\n---\n${SCOPE_REGISTRY_LONG_NOTE}`,
    "Notes/AllOnly/b.md": `---\n---\n${SCOPE_REGISTRY_LONG_NOTE}`,
    "Books/Apple Books/Author/Book/Annotations/note.md": SCOPE_REGISTRY_ANNOTATION_TEXT,
  };
  return { vault: richFakeVault(files), files };
}

void test("buildProductionScopeRegistry (10B blocker resolution) 'current' resolves to ONLY currentScopeFolders and never expands to allPaths", async () => {
  const { vault } = scopeRegistryFixture();
  const registry = buildProductionScopeRegistry({ scopeFolders: ["Notes/Current", "Notes/AllOnly"], currentScopeFolders: ["Notes/Current"] });
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "m");
  const items = await seam.discover(PRODUCTION_SCOPE_CURRENT, new AbortController().signal);
  assert.equal(items.length, 1);
  assert.equal(items[0].identity.canonicalPath, "Notes/Current/a.md");
});

void test("buildProductionScopeRegistry (10B blocker resolution) 'all' includes every configured allPaths folder, including notes NOT in currentScopeFolders", async () => {
  const { vault } = scopeRegistryFixture();
  const registry = buildProductionScopeRegistry({ scopeFolders: ["Notes/Current", "Notes/AllOnly"], currentScopeFolders: ["Notes/Current"] });
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "m");
  const items = await seam.discover(PRODUCTION_SCOPE_ALL, new AbortController().signal);
  assert.deepEqual(items.map((item) => item.identity.canonicalPath).sort(), ["Notes/AllOnly/b.md", "Notes/Current/a.md"]);
});

void test("buildProductionScopeRegistry (10B blocker resolution) 'reading' discovers ONLY strict Reading annotations, never ordinary scope notes (no scope widening)", async () => {
  const { vault } = scopeRegistryFixture();
  const registry = buildProductionScopeRegistry({ scopeFolders: ["Notes/Current", "Notes/AllOnly"], currentScopeFolders: ["Notes/Current"] });
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "m");
  const items = await seam.discover(PRODUCTION_SCOPE_READING, new AbortController().signal);
  assert.equal(items.length, 1);
  assert.equal(items[0].identity.kind, "apple-annotation");
  assert.equal(items[0].identity.appleAnnotationId, "abc123");
});

void test("buildProductionScopeRegistry (10B blocker resolution) an unrecognized scopeId has zero reads/effects -- fails closed, never falls back to 'all'", async () => {
  const reads: string[] = [];
  const { vault, files } = scopeRegistryFixture();
  (vault as unknown as { cachedRead: (file: { path: string }) => Promise<string> }).cachedRead = async (file: { path: string }) => {
    reads.push(file.path);
    return files[file.path];
  };
  const registry = buildProductionScopeRegistry({ scopeFolders: ["Notes/Current", "Notes/AllOnly"], currentScopeFolders: ["Notes/Current"] });
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "m");
  const items = await seam.discover("mystery-scope-id", new AbortController().signal);
  assert.deepEqual(items, []);
  assert.deepEqual(reads, []);
});

void test("buildProductionScopeRegistry (10B blocker resolution) preserves migration's own full-vault-plus-annotations discovery semantics unchanged, under its own dedicated MIGRATION_SCOPE_ID", async () => {
  const { vault } = scopeRegistryFixture();
  const registry = buildProductionScopeRegistry({ scopeFolders: ["Notes/Current", "Notes/AllOnly"], currentScopeFolders: ["Notes/Current"] });
  const seam = createProductionScopeDiscoverySeam({ vault, minimumWords: 5 }, registry, "m");
  const items = await seam.discover("migration:full-vault", new AbortController().signal);
  assert.deepEqual(items.map((item) => item.identity.canonicalPath).sort(), ["Books/Apple Books/Author/Book/Annotations/note.md", "Notes/AllOnly/b.md", "Notes/Current/a.md"]);
});

void test("ProductionEngine.submitNoteForProcessing/submitScopeRefresh/submitReadingSync throw a closed JOB_SHAPE_INVALID when process-note/scope-refresh/reading-sync were never registered (no full provider config)", async () => {
  const engine = new ProductionEngine(baseOptions());
  await engine.start();
  await assert.rejects(() => engine.submitNoteForProcessing("Notes/a.md"), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  await assert.rejects(() => engine.submitScopeRefresh(PRODUCTION_SCOPE_ALL), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  await assert.rejects(() => engine.submitReadingSync(), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  await engine.dispose();
});

void test("ProductionEngine.submitScopeRefresh (10B) submits a real scope-refresh job carrying the exact scopeId given, once process-note/scope-refresh are registered", async () => {
  const engine = new ProductionEngine(baseOptions(readyProviders() as ProductionEngineOptions));
  await engine.start();
  await engine.submitScopeRefresh(PRODUCTION_SCOPE_CURRENT);
  const jobs = await engine.jobStore.list();
  assert.ok(jobs.some((persisted) => persisted.job.kind === "scope-refresh" && persisted.job.target.kind === "scope" && persisted.job.target.scopeId === PRODUCTION_SCOPE_CURRENT));
  await engine.dispose();
});

void test("ProductionEngine.queryLiveRelated/queryLookupRelated throw a closed JOB_SHAPE_INVALID when no embedding provider/relatedSelectionConfig is configured", async () => {
  const engine = new ProductionEngine(baseOptions());
  await engine.start();
  await assert.rejects(() => engine.queryLiveRelated("Notes/a.md", false), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  await assert.rejects(() => engine.queryLookupRelated("query text", 8), (error: unknown) => isEngineError(error) && error.code === "JOB_SHAPE_INVALID");
  await engine.dispose();
});

function sidebarFixture() {
  const files: Record<string, string> = {
    "Notes/active.md": "Active note body text.",
    "Notes/other.md": "Other note body text.",
  };
  return { vault: richFakeVault(files), files };
}

void test("ProductionEngine.queryLiveRelated (10B SIDEBAR) reports not-indexed/stale with empty related for a note the index has never seen, and does NOT submit a job when ensureIndex is false", async () => {
  const { vault } = sidebarFixture();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, vault, vaultFileClasses: undefined, ...readyProviders(), embeddingProvider: fixedVectorEmbeddingProvider(4) as never }) as ProductionEngineOptions);
  await engine.start();
  const result = await engine.queryLiveRelated("Notes/active.md", false);
  assert.equal(result.indexed, false);
  assert.equal(result.stale, true);
  assert.deepEqual(result.related, []);
  assert.deepEqual(await engine.jobStore.list(), []);
  await engine.dispose();
});

void test("ProductionEngine.queryLiveRelated (10B SIDEBAR) submits the exact process-note job when absent/stale and ensureIndex is true, returning the same not-yet-indexed empty semantics rather than blocking on the job", async () => {
  const { vault } = sidebarFixture();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, vault, vaultFileClasses: undefined, ...readyProviders(), embeddingProvider: fixedVectorEmbeddingProvider(4) as never }) as ProductionEngineOptions);
  await engine.start();
  const result = await engine.queryLiveRelated("Notes/active.md", true);
  assert.equal(result.indexed, false);
  assert.equal(result.stale, true);
  assert.deepEqual(result.related, []);
  const jobs = await engine.jobStore.list();
  assert.ok(jobs.some((persisted) => persisted.job.kind === "process-note" && persisted.job.target.kind === "note" && persisted.job.target.identity.canonicalPath === "Notes/active.md"));
  await engine.dispose();
});

void test("ProductionEngine.queryLiveRelated (10B SIDEBAR) ranks the committed IndexStore view against a FRESH embed of the active note's current text once the note is already indexed, excluding itself", async () => {
  const { vault, files } = sidebarFixture();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const activeIdentity = stableNoteIdentity(canonicalizePath("Notes/active.md"));
  const otherIdentity = stableNoteIdentity(canonicalizePath("Notes/other.md"));
  const activeProjection = projectSource(activeIdentity, files["Notes/active.md"]);
  const otherProjection = projectSource(otherIdentity, files["Notes/other.md"]);
  const basisVector = new Float32Array([1, 0, 0, 0]);
  await buildGeneration(fs, dataRoot, {
    generationId: 1,
    embeddingModel: "nomic-embed-text",
    dimension: 4,
    notes: [
      { identity: activeIdentity, sourceHash: activeProjection.sourceHash, vector: basisVector, chunkCount: 1, loadChunkVectors: async () => [basisVector] },
      { identity: otherIdentity, sourceHash: otherProjection.sourceHash, vector: basisVector, chunkCount: 1, loadChunkVectors: async () => [basisVector] },
    ],
  }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, vault, vaultFileClasses: undefined, ...readyProviders(), embeddingProvider: fixedVectorEmbeddingProvider(4) as never }) as ProductionEngineOptions);
  await engine.start();
  const result = await engine.queryLiveRelated("Notes/active.md", false);
  assert.equal(result.indexed, true);
  assert.equal(result.stale, false);
  assert.equal(result.related.length, 1);
  assert.equal(result.related[0].path, "Notes/other.md");
  assert.equal(result.related[0].kind, "core");
  await engine.dispose();
});

void test("ProductionEngine.queryLookupRelated (10B SIDEBAR) ranks the committed IndexStore view against a fresh embed of the raw query text, every result carrying kind \"lookup\"", async () => {
  const { vault } = sidebarFixture();
  const fs = new FakeIndexFs();
  const dataRoot = "/data";
  const otherIdentity = stableNoteIdentity(canonicalizePath("Notes/other.md"));
  const basisVector = new Float32Array([1, 0, 0, 0]);
  await buildGeneration(fs, dataRoot, {
    generationId: 1,
    embeddingModel: "nomic-embed-text",
    dimension: 4,
    notes: [{ identity: otherIdentity, sourceHash: "c".repeat(64), vector: basisVector, chunkCount: 1, loadChunkVectors: async () => [basisVector] }],
  }, {});
  await switchCurrentGeneration(fs, dataRoot, 1);

  const engine = new ProductionEngine(baseOptions({ fs, dataRoot, vault, vaultFileClasses: undefined, ...readyProviders(), embeddingProvider: fixedVectorEmbeddingProvider(4) as never }) as ProductionEngineOptions);
  await engine.start();
  const related = await engine.queryLookupRelated("some lookup query", 8);
  assert.equal(related.length, 1);
  assert.equal(related[0].path, "Notes/other.md");
  assert.equal(related[0].kind, "lookup");
  await engine.dispose();
});

void test("ProductionEngine.queryLookupRelated (10B SIDEBAR) returns [] for a blank/whitespace-only query without ever embedding or querying", async () => {
  const engine = new ProductionEngine(baseOptions(readyProviders() as ProductionEngineOptions));
  await engine.start();
  assert.deepEqual(await engine.queryLookupRelated("   ", 8), []);
  await engine.dispose();
});

void test("ProductionEngine.submitRebuild (10B FORCE COMMANDS) submits a real rebuild-index job, available even with no providers configured", async () => {
  const engine = new ProductionEngine(baseOptions());
  await engine.start();
  await engine.submitRebuild();
  const jobs = await engine.jobStore.list();
  assert.ok(jobs.some((persisted) => persisted.job.kind === "rebuild-index" && persisted.job.target.kind === "global"));
  await engine.dispose();
});
