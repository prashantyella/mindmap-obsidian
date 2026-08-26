import type { Vault, Workspace } from "obsidian";

import type { AtomicStoreFs } from "./atomicStore";
import { EngineError, isEngineError } from "./errors";
import type { IndexFs } from "../index/indexFs";
import { IndexStore } from "../index/indexStore";
import { JobEngine, type JobEngineFault, type JobPhaseRunner } from "../jobs/jobEngine";
import type { EngineActivitySnapshot } from "../jobs/jobActivity";
import { JobStore } from "../jobs/jobStore";
import { NoteJobRunner, type NoteSourceReader } from "../jobs/noteJob";
import { canonicalizePath, stableNoteIdentity, type JobTrigger } from "./contracts";
import { projectSource } from "./sourceProjection";
import { RebuildJobRunner } from "../jobs/rebuildJob";
import { ScopeJobRunner } from "../jobs/scopeJob";
import { CoreScheduler, type IntervalRegistrar, type SchedulerClock, type SchedulerFault } from "../scheduling/coreScheduler";
import { ScheduleStore } from "../scheduling/scheduleStore";
import { BackgroundScheduler, type BackgroundSchedulerOptions } from "../scheduling/backgroundScheduler";
import { PREFLIGHT_CHECK_CODES, runPreflight, type PreflightCheckDefinition, type PreflightCheckCode, type PreflightProbe, type PreflightReportV1 } from "./preflight";
import type { EmbeddingProvider } from "./embeddingProvider";
import type { MetadataInferenceProvider, MetadataPipelineConfig } from "./metadataPipeline";
import { AppleBooksSqliteReader, createNodeAppleBooksFsAdapter, type AppleBooksFsAdapter } from "../reading/appleBooksSqlite";
import { createNodeSqliteProcess, type SqliteProcess } from "../reading/sqliteProcess";
import {
  createDeferredScopeImportSeam,
  createProductionNoteReplacementSeam,
  createProductionNoteSourceReader,
  createProductionNoteVaultAdapter,
  createProductionScopeDiscoverySeam,
  createProductionScopeEnqueueSeam,
  openRelatedNote,
  type ScopeRegistry,
  type VaultFileClasses,
} from "./productionVaultAdapter";
import { createProductionNoteEmbeddingSeam, createProductionNoteMetadataSeam } from "./productionProviderSeams";
import { selectRelatedCandidates, type RelatedCandidateScore } from "./relatedSelector";
import type { CanonicalPath, RelatedCandidateKind } from "./contracts";
import type { NoteEmbeddingSeam } from "../jobs/noteJob";
import { NoteWriter } from "./noteWriter";
import { MigrationRunner, MIGRATION_SCOPE_ID } from "../migration/migrationRunner";
import { MigrationStore } from "../migration/migrationStore";
import type { MigrationStatusV1 } from "../migration/migrationContract";
import { MigrationDriver } from "../migration/migrationDriver";

/**
 * Checkpoint 10B blocker resolution: the CLOSED set of scope ids a
 * production job (never migration, which keeps its own separate
 * `MIGRATION_SCOPE_ID` entry -- see `buildProductionScopeRegistry`) may
 * ever be submitted with. `"current"`/`"all"` cover ordinary vault notes
 * ONLY (`includeReadingAnnotations: false` for both -- Reading annotation
 * sync is a wholly separate concern, never folded into an ordinary
 * scope-refresh); `"reading"` is the mirror image, STRICT annotation-only
 * discovery with zero ordinary scope widening (`scopeFolders: []`).
 */
export const PRODUCTION_SCOPE_CURRENT = "current";
export const PRODUCTION_SCOPE_ALL = "all";
export const PRODUCTION_SCOPE_READING = "reading";

/** Exported for direct, focused testing of the exact registry `ProductionEngine` itself composes -- see `productionEngine.test.ts`'s own scope-registry regression tests. Never imported/used by any other production module. */
export function buildProductionScopeRegistry(options: Pick<ProductionEngineOptions, "scopeFolders" | "currentScopeFolders">): ScopeRegistry {
  const registry = new Map<string, { scopeFolders: readonly string[]; includeReadingAnnotations: boolean }>();
  registry.set(PRODUCTION_SCOPE_CURRENT, { scopeFolders: options.currentScopeFolders, includeReadingAnnotations: false });
  registry.set(PRODUCTION_SCOPE_ALL, { scopeFolders: options.scopeFolders, includeReadingAnnotations: false });
  registry.set(PRODUCTION_SCOPE_READING, { scopeFolders: [], includeReadingAnnotations: true });
  // Migration's own discovery semantics are UNCHANGED by this blocker resolution: full configured
  // scope (`allPaths`) PLUS Reading annotations, exactly as before -- registered under its own
  // dedicated id so migration is never accidentally affected by (or conflated with) the ordinary
  // "current"/"all"/"reading" job-triggered scopes above.
  registry.set(MIGRATION_SCOPE_ID, { scopeFolders: options.scopeFolders, includeReadingAnnotations: true });
  return registry;
}

/**
 * Checkpoint 10A item 4: bounded, explicit Apple Books composition input --
 * NEVER a hardcoded `config: {}` / implicit `os.homedir()` (a prior version
 * of this module fell back to the REAL home directory whenever a caller,
 * including a test, omitted this field -- exactly the "implicit real home
 * in tests" bug item 4 calls out). Every field here is threaded straight
 * into `AppleBooksSqliteReader`'s own constructor, which itself stays
 * inert (no disk/process access) until a read is actually attempted --
 * composing this options object performs no I/O of its own.
 */
export interface ProductionAppleBooksOptions {
  /** Raw, already-parsed user configuration (e.g. an explicit database path override) -- never inferred. */
  config: Record<string, unknown>;
  /** Explicit home directory `selectAppleBooksDatabaseRoles` discovery is confined to -- a test MUST supply its own fake path here rather than relying on any default. */
  homeDirectory: string;
  annotationDbPath?: string;
  libraryDbPath?: string;
  /** Test seam: overrides the real `createNodeSqliteProcess()`. */
  sqliteProcess?: SqliteProcess;
  /** Test seam: overrides the real `createNodeAppleBooksFsAdapter()`. */
  fs?: AppleBooksFsAdapter;
  snapshotRetries?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const UNKNOWN_FAULT_CODE = "UNKNOWN_FAULT";

function safelyNotify(onFault: (() => void) | undefined): void {
  try {
    onFault?.();
  } catch {
    // A throwing observer cannot leak past this boundary (mirrors mindmapEngine.ts's own guard).
  }
}

export interface ProductionEngineFault {
  source: "job-engine" | "core-scheduler";
  code: string;
  atMs: number;
}

export interface ProductionEngineProbes {
  ollama?: PreflightProbe;
  localMetadataProvider?: PreflightProbe;
  appleBooksReading?: PreflightProbe;
  researchProvider?: PreflightProbe;
  backgroundScheduler?: PreflightProbe;
}

/** Mirrors `python/mindmap.py`'s `select_mindmap_links`/`query_related_for_text` config surface -- see `ProductionEngineOptions.relatedSelectionConfig`. */
export interface RelatedSelectionConfig {
  relatedLimit: number;
  overreachCount: number;
  creativeCount: number;
  creativeMin: number;
  creativeMax: number;
  /** Candidate pool size `IndexStore.queryRelated` is asked for before selection narrows it -- mirrors Python's `related_candidate_limit`. */
  candidateLimit: number;
  minScore: number;
}

/**
 * A read-API related result -- deliberately a WIDER kind union than the
 * persisted `RelatedCandidateV1` contract (`RelatedCandidateKind` plus
 * `"lookup"`, mirroring `query_related_for_text`'s own fixed `"lookup"`
 * kind): these results are never written back into a note's frontmatter,
 * so they are not held to that contract's closed kind set.
 */
export interface ProductionRelatedResult {
  path: CanonicalPath;
  score: number;
  kind: RelatedCandidateKind | "lookup";
}

/** Result of `ProductionEngine.queryLiveRelated` -- see that method's own doc comment. */
export interface ProductionLiveRelatedResult {
  path: string;
  sourceHash: string;
  indexed: boolean;
  stale: boolean;
  related: ProductionRelatedResult[];
}

export interface ProductionEngineOptions {
  /** Absolute, plugin-owned data directory this whole engine instance is confined to. */
  dataRoot: string;
  /** Real (`NodeOwnedFs`) or fake filesystem seam every persistent store is built over. */
  fs: IndexFs & AtomicStoreFs;
  registrar: IntervalRegistrar;
  /** Obsidian's real `Vault` -- the ONE place this factory's composed adapters touch it (via `productionVaultAdapter.ts`), never a raw Node `fs` call against a vault-relative path. */
  vault: Vault;
  /** Optional: only needed for `openRelatedNote`; omit in a headless/test composition. */
  workspace?: Workspace;
  /** Item 3 (10A) / prerequisite 1 (10B cutover): the REAL `TFile`/`TFolder` classes, required -- `productionVaultAdapter.ts`'s own structural-shape fallback exists purely for that module's lower-level exported factories to stay test-friendly; the actual composition root (`ProductionEngine`, ultimately `main.ts`) must always supply the real classes so every vault-object guard in a live engine uses genuine `instanceof`, never a duck-typed approximation. A test composing `ProductionEngine` directly supplies its own fake classes (see `VaultFileClasses`) rather than omitting this field. */
  vaultFileClasses: VaultFileClasses;
  clock?: SchedulerClock;
  backgroundScheduler?: BackgroundSchedulerOptions;
  /** `null` when Ollama embeddings are not configured -- `process-note`/`migrate-index` jobs can still be COMPOSED but the pump is never started while this is `null` (see `start()`'s gating). */
  embeddingProvider: EmbeddingProvider | null;
  embeddingModel: string | null;
  embeddingDimension?: number;
  /** Item 7: the configured chunk target/overlap token counts every embedding seam this engine composes uses -- REQUIRED whenever `embeddingProvider`/`embeddingModel` are configured, never a hardcoded production default baked into `productionProviderSeams.ts` itself. */
  chunkOptions?: { targetTokens: number; overlapTokens: number };
  /** `null` when a local metadata provider is not configured. */
  metadataProvider: MetadataInferenceProvider | null;
  metadataPipelineConfig: MetadataPipelineConfig | null;
  /** `ScopeSelection.allPaths` -- the FULL configured scope. Backs the `"all"` scope registry entry AND migration discovery (which has always covered the full configured scope, independent of the `"current"`/`"all"` job-triggered ids -- see `PRODUCTION_SCOPE_REGISTRY_ENTRIES`). */
  scopeFolders: readonly string[];
  /** `ScopeSelection.currentPaths` -- the smaller day-to-day working set. Backs ONLY the `"current"` scope registry entry; never used for migration or the `"all"`/`"reading"` entries. */
  currentScopeFolders: readonly string[];
  minimumWords: number;
  /** Checkpoint 10B SIDEBAR: config for `queryLiveRelated`'s core/overreach/creative/fill selection -- mirrors `select_mindmap_links`'s own config surface (`related_limit`/`related_overreach`/`related_creative`/`related_creative_min`/`related_creative_max`/`related_candidate_limit`/`related_min_score`). Required whenever `embeddingProvider` is configured; `queryLiveRelated`/`queryLookupRelated` throw `JOB_SHAPE_INVALID` without it. */
  relatedSelectionConfig?: RelatedSelectionConfig;
  configDir?: string;
  /** Item 5: the plugin's own runtime-internal folder inside the vault (`<configDir>/plugins/<pluginId>`), when the plugin stores anything there -- threaded through to `openRelatedNote` so a related-note target inside it is rejected, exactly like a target inside `configDir` itself. */
  runtimeFolder?: string;
  pipelineVersion: number;
  /** Item 4: required (never a hardcoded/implicit fallback) -- see `ProductionAppleBooksOptions`'s own doc comment. */
  appleBooks: ProductionAppleBooksOptions;
  probes?: ProductionEngineProbes;
  onFault?: (fault: ProductionEngineFault) => void;
  /** Checkpoint 10B SIDEBAR: fired every time migration settles at phase `"complete"` (mirrors the internal `tryStartOrdinaryWork()` call this shares a subscription with -- safe to fire more than once per engine instance, e.g. a later config-driven re-migration) -- lets a caller (main.ts) refresh anything that cached an empty/not-indexed result while migration was still running (e.g. an open Mindmap sidebar's `queryLiveRelated` cache), since the engine itself has no other way to reach that caller. Never fired for any other phase. */
  onMigrationComplete?: () => void;
  preflightTimeoutMs?: number;
}

export type ProductionEnginePhase = "idle" | "started" | "disposed";

const REQUIRED_SUBDIRECTORIES = ["jobs", "schedules", "index", "migration"];

/**
 * Checkpoint 10A: the ONE production, write-capable composition root --
 * the authoritative counterpart to Checkpoint 9's READ-ONLY
 * `MindmapEngine`. Owns/coordinates `JobStore`/`JobEngine` (wired with
 * REAL `NoteJobRunner`/`ScopeJobRunner`/`RebuildJobRunner` phase runners,
 * every one of them backed by Obsidian-isolated Vault adapters and
 * Ollama-only providers -- never a Python fallback or localhost IPC to
 * anything but Ollama itself), `ScheduleStore`/`CoreScheduler`, the
 * optional `BackgroundScheduler`, `IndexStore`, the optional
 * `AppleBooksSqliteReader` (composed fresh, never auto-invoked -- see
 * `inspectReadOnly`-style probes), and the restart-safe `MigrationRunner`.
 *
 * `main.ts` does NOT construct or call this factory in 10A -- nothing
 * user-reachable cuts over from Python this checkpoint. This class exists
 * so the write-capable composition and the migration state machine can be
 * built and thoroughly tested in isolation before any command wiring
 * happens.
 *
 * Lifecycle mirrors `MindmapEngine` exactly: single-settlement
 * `start()`/`stop()`/`dispose()`, concurrent calls to the same method
 * share one in-flight settlement, every method is idempotent, and
 * `dispose()` aborts the shared lifecycle signal immediately (before
 * queuing its own teardown) so a `start()` blocked on a hung optional
 * probe unwinds promptly.
 */
export class ProductionEngine {
  readonly jobStore: JobStore;
  readonly jobEngine: JobEngine;
  readonly scheduleStore: ScheduleStore;
  readonly coreScheduler: CoreScheduler;
  readonly indexStore: IndexStore;
  readonly backgroundScheduler: BackgroundScheduler | null;
  readonly migrationStore: MigrationStore;
  readonly migrationRunner: MigrationRunner;
  readonly migrationDriver: MigrationDriver;
  readonly appleBooksReader: AppleBooksSqliteReader;

  private readonly options: ProductionEngineOptions;
  private phase: ProductionEnginePhase = "idle";
  private opTail: Promise<void> = Promise.resolve();
  private lifecycleAbort = new AbortController();
  private lastPreflightReport: PreflightReportV1 | null = null;
  private readonly capabilityFaults: Map<string, string> = new Map();
  /** Item 3 test introspection ONLY -- the exact runner map this instance was constructed with; never consulted by any production code path (`jobEngine` itself owns the copy that actually dispatches). */
  private readonly registeredRunners: Partial<Record<import("./contracts").JobKind, JobPhaseRunner>>;
  private disposeRequested = false;
  private pumpStarted = false;
  private schedulerStarted = false;
  private unsubscribeMigration: (() => void) | null = null;
  /** Reused by `submitNoteForProcessing` -- the SAME `NoteSourceReader` `"process-note"` jobs themselves resolve identities through, never a second, parallel adapter. */
  private readonly noteSourceReader: NoteSourceReader;
  /** Checkpoint 10B SIDEBAR: the SAME strict embedding seam `NoteJobRunner`'s own `"embed"` phase uses -- `null` only when no embedding provider/model/chunkOptions is configured (mirrors `migrationEmbeddingSeam`'s own construction above). `queryLiveRelated`/`queryLookupRelated` throw a closed `JOB_SHAPE_INVALID` rather than silently falling back to a different embedding path when this is `null`. */
  private readonly noteEmbeddingSeam: NoteEmbeddingSeam | null;
  /** Checkpoint 10B PENDING: discovery is pure text/hash work (no embedding call), so this is constructed UNCONDITIONALLY -- unlike `noteEmbeddingSeam`, a pending-notes count must stay available even before any provider is configured. Reused by `getPendingCandidates` only; the `"scope-refresh"`/migration runners above keep their own separately-constructed seams unchanged. */
  private readonly pendingDiscoverySeam: import("../jobs/scopeJob").ScopeDiscoverySeam;

  constructor(options: ProductionEngineOptions) {
    this.options = options;
    this.jobStore = new JobStore(options.fs, options.dataRoot);

    // `NoteJobRunner`'s `replacement` seam and `ScopeJobRunner`'s `enqueue` seam both need to call
    // `JobEngine.submit` -- but `JobEngine` itself is constructed AFTER these runners (it needs the
    // runners map up front, as a readonly constructor argument). This late-binding indirection
    // (a mutable holder resolved to the real `this.jobEngine` the moment construction finishes)
    // lets both seams close over a STABLE reference that is always live by the time either is
    // actually invoked -- neither seam is ever called synchronously during construction itself,
    // only later, from an actual job phase-step.
    const jobEngineRef: { current: JobEngine | null } = { current: null };
    const lateJobSubmitter = {
      submit: (input: Parameters<JobEngine["submit"]>[0]) => {
        if (!jobEngineRef.current) throw new Error("ProductionEngine.jobEngine used before construction completed.");
        return jobEngineRef.current.submit(input);
      },
      submitBulkChild: (batchId: string, input: Parameters<JobEngine["submitBulkChild"]>[1]) => {
        if (!jobEngineRef.current) throw new Error("ProductionEngine.jobEngine used before construction completed.");
        return jobEngineRef.current.submitBulkChild(batchId, input);
      },
      requestCancel: (jobId: string) => {
        if (!jobEngineRef.current) throw new Error("ProductionEngine.jobEngine used before construction completed.");
        return jobEngineRef.current.requestCancel(jobId);
      },
    };

    const scopeRegistry = buildProductionScopeRegistry(options);
    const runners: Partial<Record<import("./contracts").JobKind, JobPhaseRunner>> = {};
    const noteVaultAdapter = createProductionNoteVaultAdapter(options.vault, options.vaultFileClasses);
    const noteWriter = new NoteWriter(noteVaultAdapter);
    const sourceReader = createProductionNoteSourceReader({ vault: options.vault, scopeFolders: options.scopeFolders, minimumWords: options.minimumWords, configDir: options.configDir, vaultFileClasses: options.vaultFileClasses });
    this.noteSourceReader = sourceReader;
    this.noteEmbeddingSeam =
      options.embeddingProvider && options.embeddingModel && options.chunkOptions
        ? createProductionNoteEmbeddingSeam(options.embeddingProvider, options.embeddingModel, options.chunkOptions)
        : null;
    this.pendingDiscoverySeam = createProductionScopeDiscoverySeam({ vault: options.vault, minimumWords: options.minimumWords, configDir: options.configDir, vaultFileClasses: options.vaultFileClasses }, scopeRegistry, options.embeddingModel ?? "");
    // Item 6 (10A blocker pass): "reading-sync"/"scope-refresh" both ultimately ENQUEUE
    // "process-note" jobs (via `createProductionScopeEnqueueSeam` below) -- registering either one
    // without a "process-note" runner to actually dispatch those enqueued jobs would silently
    // accept work this JobEngine instance can never complete. Both therefore live inside the SAME
    // gate as "process-note" itself, never a separate, looser `options.embeddingModel`-alone check.
    if (options.embeddingProvider && options.embeddingModel && options.metadataProvider && options.metadataPipelineConfig) {
      if (!options.chunkOptions) {
        throw new Error("ProductionEngineOptions.chunkOptions is required whenever embeddingProvider/embeddingModel are configured.");
      }
      runners["process-note"] = new NoteJobRunner({
        sourceReader,
        embedding: createProductionNoteEmbeddingSeam(options.embeddingProvider, options.embeddingModel, options.chunkOptions),
        metadata: createProductionNoteMetadataSeam(options.metadataProvider, options.metadataPipelineConfig),
        noteWriter,
        indexStore: { upsertNote: (input) => this.indexStoreUpsert(input) },
        replacement: createProductionNoteReplacementSeam(lateJobSubmitter, "manual"),
      });
      // Item 3: the SAME `ScopeJobRunner` instance is deliberately registered for BOTH
      // "reading-sync" and "scope-refresh" -- one runner, two job kinds, exactly like
      // `RebuildJobRunner` below serves "rebuild-index" alone. `"reading-sync"`'s own `"import"`
      // phase stays the explicit, documented no-op seam (`createDeferredScopeImportSeam`) --
      // pulling newly-read Apple Books annotations into the vault remains deferred past 10A.
      const scopeRunner = new ScopeJobRunner({
        discovery: createProductionScopeDiscoverySeam({ vault: options.vault, minimumWords: options.minimumWords, configDir: options.configDir, vaultFileClasses: options.vaultFileClasses }, scopeRegistry, options.embeddingModel),
        import: createDeferredScopeImportSeam(),
        enqueue: createProductionScopeEnqueueSeam(lateJobSubmitter, "manual"),
      });
      runners["scope-refresh"] = scopeRunner;
      runners["reading-sync"] = scopeRunner;
    }
    runners["rebuild-index"] = new RebuildJobRunner({ fs: options.fs, root: options.dataRoot });
    // Item 3: migration is now fully self-contained inside `MigrationRunner` (it builds/verifies/
    // activates its own generation directly -- see that module's own doc comment, "Depends on
    // NEITHER JobEngine NOR JobStore") -- there is no longer a "migrate-index" JOB KIND for this
    // JobEngine to run at all; registering `RebuildJobRunner` under that key here would be dead,
    // never-dispatched code.

    this.registeredRunners = runners;
    this.jobEngine = new JobEngine(this.jobStore, runners, undefined, (fault: JobEngineFault) => {
      this.capabilityFaults.set("JOB_STORE", fault.code);
      safelyNotify(() => options.onFault?.({ source: "job-engine", code: fault.code, atMs: fault.atMs }));
    });
    jobEngineRef.current = this.jobEngine;

    this.scheduleStore = new ScheduleStore(options.fs, options.dataRoot);
    this.coreScheduler = new CoreScheduler({
      store: this.scheduleStore,
      jobSubmitter: this.jobEngine,
      registrar: options.registrar,
      clock: options.clock,
      onScheduleError: (fault: SchedulerFault) => {
        this.capabilityFaults.set("SCHEDULE_STORE", fault.code);
        safelyNotify(() => options.onFault?.({ source: "core-scheduler", code: fault.code, atMs: fault.atMs }));
      },
    });
    this.indexStore = new IndexStore(options.fs, options.dataRoot);
    this.backgroundScheduler = options.backgroundScheduler ? new BackgroundScheduler(options.backgroundScheduler) : null;
    // Item 4: every field comes from the caller's EXPLICIT `options.appleBooks` -- never a bare
    // `config: {}` or `os.homedir()` fallback that would silently point a test (or a misconfigured
    // caller) at whatever machine this happens to run on.
    this.appleBooksReader = new AppleBooksSqliteReader({
      sqliteProcess: options.appleBooks.sqliteProcess ?? createNodeSqliteProcess(),
      fs: options.appleBooks.fs ?? createNodeAppleBooksFsAdapter(),
      config: options.appleBooks.config,
      homeDirectory: options.appleBooks.homeDirectory,
      annotationDbPath: options.appleBooks.annotationDbPath,
      libraryDbPath: options.appleBooks.libraryDbPath,
      snapshotRetries: options.appleBooks.snapshotRetries,
      timeoutMs: options.appleBooks.timeoutMs,
      maxOutputBytes: options.appleBooks.maxOutputBytes,
    });

    this.migrationStore = new MigrationStore(options.fs, options.dataRoot);
    // Item 1 (sub-milestone B): migration ingestion is Ollama-only and never touches
    // `NoteWriter`/`JobEngine`/metadata inference -- reuses the SAME `sourceReader` and
    // `createProductionNoteEmbeddingSeam` `NoteJobRunner` itself is composed with above, just
    // without the metadata/write/overlay phases. When no embedding provider/model is configured
    // yet, the embed seam is a documented, honest stub that throws if ever actually invoked --
    // `MigrationRunner.start()` already refuses to start with a blank `embeddingModel` before this
    // could ever be reached (see its own `MIGRATION_NOT_STARTABLE` guard).
    const migrationEmbeddingSeam =
      options.embeddingProvider && options.embeddingModel && options.chunkOptions
        ? createProductionNoteEmbeddingSeam(options.embeddingProvider, options.embeddingModel, options.chunkOptions)
        : { embed: (): never => { throw new Error("Migration ingestion invoked with no embedding provider configured."); } };
    this.migrationRunner = new MigrationRunner({
      store: this.migrationStore,
      discovery: createProductionScopeDiscoverySeam({ vault: options.vault, minimumWords: options.minimumWords, configDir: options.configDir, vaultFileClasses: options.vaultFileClasses }, scopeRegistry, options.embeddingModel ?? ""),
      ingestion: { sourceReader, embedding: migrationEmbeddingSeam },
      fs: options.fs,
      dataRoot: options.dataRoot,
      embeddingModel: options.embeddingModel ?? "",
      dimension: options.embeddingDimension,
      pipelineVersion: options.pipelineVersion,
    });
    this.migrationDriver = new MigrationDriver({
      runner: this.migrationRunner,
      registrar: options.registrar,
      onFault: (code) => {
        this.capabilityFaults.set("MIGRATION_STORE", code);
        safelyNotify(() => options.onFault?.({ source: "job-engine", code, atMs: Date.now() }));
      },
    });
    // Item 1: migration is the gate on BOTH the ordinary JobEngine pump and CoreScheduler -- ONLY
    // a fully verified `"complete"` migration record (or the fast `ALREADY_UP_TO_DATE` path, which
    // itself settles at phase `"complete"`) ever clears it. `"not-started"`/`"discover"`/`"plan"`/
    // `"build"`/`"verify"`/`"activate"`/`"failed"`/`"cancelled"` all keep BOTH stopped. This
    // subscription is the ONLY path that starts ordinary work for an engine instance that began
    // `start()` while migration was still in flight (or had never begun at all); it re-checks
    // provider readiness itself (never assumes the snapshot `start()` captured is still current)
    // and is safe to fire more than once (`tryStartOrdinaryWork` itself is idempotent per
    // capability).
    this.unsubscribeMigration = this.migrationRunner.subscribe((status) => {
      if (status.phase !== "complete") return;
      safelyNotify(() => options.onMigrationComplete?.());
      void this.tryStartOrdinaryWork();
    });
  }

  private indexStoreUpsert(input: Parameters<IndexStore["upsertNote"]>[0]): Promise<void> {
    return this.indexStore.upsertNote(input);
  }

  getPhase(): ProductionEnginePhase {
    return this.phase;
  }

  getLastPreflightReport(): PreflightReportV1 | null {
    return this.lastPreflightReport;
  }

  /** Item 1/2 observability: whether the ordinary JobEngine pump / CoreScheduler have actually started -- distinct from each other since the pump additionally requires provider readiness the scheduler does not. */
  getOrdinaryWorkStatus(): { pumpStarted: boolean; schedulerStarted: boolean } {
    return { pumpStarted: this.pumpStarted, schedulerStarted: this.schedulerStarted };
  }

  /** Item 3 test introspection: the exact set of job kinds this instance registered a runner for, plus the runner instance itself -- so a test can assert both "which keys exist" and "same instance reused across keys" without reaching into `jobEngine`'s own private state. */
  getRegisteredRunnerMap(): Partial<Record<import("./contracts").JobKind, JobPhaseRunner>> {
    return this.registeredRunners;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opTail.then(fn, fn);
    this.opTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async safely(code: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.capabilityFaults.delete(code);
    } catch (error) {
      this.capabilityFaults.set(code, isEngineError(error) ? error.code : UNKNOWN_FAULT_CODE);
    }
  }

  /** Item 1: same as `safely`, but reports whether `fn` actually SUCCEEDED -- used everywhere a caller must only flip a "this half is now running" flag AFTER the underlying start effect is confirmed to have not thrown, never unconditionally alongside attempting it. */
  private async safelyOk(code: string, fn: () => Promise<void>): Promise<boolean> {
    await this.safely(code, fn);
    return !this.capabilityFaults.has(code);
  }

  private buildPreflightDefinitions(): PreflightCheckDefinition[] {
    const probes = this.options.probes ?? {};
    const fs = this.options.fs;
    const dataRoot = this.options.dataRoot;
    return [
      { code: "VAULT_ADAPTER", probe: async () => ({ status: "ok", message: "Vault adapter is configured." }) },
      {
        code: "OWNED_DATA_PATHS",
        probe: async () => {
          const missing: string[] = [];
          for (const subdirectory of REQUIRED_SUBDIRECTORIES) {
            const present = await fs.exists(`${dataRoot}/${subdirectory}`);
            if (!present) missing.push(subdirectory);
          }
          if (missing.length === 0) return { status: "ok", message: "Plugin-owned data paths are accessible." };
          return { status: "degraded", message: "Some plugin-owned data paths do not exist yet.", context: { missingCount: missing.length } };
        },
      },
      {
        code: "JOB_STORE",
        probe: async () => {
          await this.jobStore.list();
          return { status: "ok", message: "Job store loads and parses.", context: { runnersConfigured: true } };
        },
      },
      {
        code: "SCHEDULE_STORE",
        probe: async () => {
          await this.scheduleStore.list();
          return { status: "ok", message: "Schedule store loads and parses." };
        },
      },
      {
        code: "INDEX_STORE",
        probe: async () => {
          const staleStaging = await this.indexStore.countStaleStaging();
          if (staleStaging === 0) return { status: "ok", message: "Index store filesystem layer is reachable." };
          return { status: "degraded", message: "Index store has stale staging directories pending cleanup.", context: { staleStaging } };
        },
      },
      {
        code: "TEMP_CLEANUP",
        probe: async () => {
          const jobTemp = await this.jobStore.countStaleTempFiles();
          const scheduleTemp = await this.scheduleStore.countStaleTempFiles();
          const staleTempCount = jobTemp + scheduleTemp;
          if (staleTempCount === 0) return { status: "ok", message: "No stale temp files pending cleanup.", context: { jobTemp, scheduleTemp } };
          return { status: "degraded", message: "Stale temp files are pending cleanup.", context: { jobTemp, scheduleTemp } };
        },
      },
      { code: "OLLAMA_EMBEDDINGS", probe: probes.ollama },
      { code: "LOCAL_METADATA_PROVIDER", probe: probes.localMetadataProvider },
      { code: "APPLE_BOOKS_READING", probe: probes.appleBooksReading },
      { code: "RESEARCH_PROVIDER", probe: probes.researchProvider },
      { code: "BACKGROUND_SCHEDULER", probe: probes.backgroundScheduler },
    ];
  }

  /** Item 2: `true` only when the corresponding bounded readiness PROBE (never a bare non-null-object check) reported `"ok"` in `report`. An unconfigured/missing probe (no `code` entry at all, or the check itself absent) is treated as NOT ready -- "unconfigured is degraded", never silently trusted. */
  private probeIsOk(report: PreflightReportV1, code: PreflightCheckCode): boolean {
    const check = report.checks.find((entry) => entry.code === code);
    return check?.status === "ok";
  }

  /** Item 2: embedding readiness requires BOTH a composed provider/model AND its bounded Ollama probe reporting `"ok"` in `report` -- a non-null `embeddingProvider` alone is never sufficient. */
  private embeddingReady(report: PreflightReportV1): boolean {
    return this.options.embeddingProvider !== null && this.options.embeddingModel !== null && this.probeIsOk(report, "OLLAMA_EMBEDDINGS");
  }

  /** Item 2: metadata readiness requires BOTH a composed provider/config AND its bounded local-metadata probe reporting `"ok"` in `report`. */
  private metadataReady(report: PreflightReportV1): boolean {
    return this.options.metadataProvider !== null && this.options.metadataPipelineConfig !== null && this.probeIsOk(report, "LOCAL_METADATA_PROVIDER");
  }

  /** Item 1: `true` only once migration is `"complete"`, core stores are healthy, AND BOTH the embedding and metadata readiness probes report `"ok"` -- the ONE joint gate `tryStartOrdinaryWork`/`recheckReadiness` both start (and, on `recheckReadiness`, stop) the pump and CoreScheduler together against. Neither half is ever started (or left running) on a looser condition than the other. */
  private ordinaryWorkReady(migrationStatus: MigrationStatusV1, report: PreflightReportV1): boolean {
    return migrationStatus.phase === "complete" && report.summary.runtimeReady && this.embeddingReady(report) && this.metadataReady(report);
  }

  /**
   * Item 1/2: starts the ordinary JobEngine pump and CoreScheduler the
   * instant BOTH of their own prerequisites are satisfied (see
   * `ordinaryWorkReady` -- migration complete, core stores healthy, AND
   * both provider readiness probes ok), and is always safe to call more
   * than once (each half only ever starts once, guarded by
   * `pumpStarted`/`schedulerStarted`, and each flag is set ONLY once its
   * own start effect is confirmed to have actually succeeded -- never
   * unconditionally alongside merely attempting it). Re-runs preflight
   * itself rather than trusting `lastPreflightReport` (item 2: "recovery
   * rechecks and resumes safely" -- a provider that was down at `start()`
   * time and has since recovered must be re-probed, not assumed still
   * degraded).
   *
   * This method only ever STARTS -- it never stops an already-running
   * half. Stopping on a since-degraded readiness is `recheckReadiness`'s
   * own explicit responsibility (item 1), so an automatic trigger (the
   * migration-complete subscription, or `start()` itself) can never cause
   * a surprise shutdown of already-running work.
   */
  private async tryStartOrdinaryWork(): Promise<void> {
    if (this.phase !== "started" || this.disposeRequested) return;
    if (this.pumpStarted && this.schedulerStarted) return;

    const migrationStatus = await this.migrationRunner.getStatus();
    // Bugfix (10B cutover): nothing below can ever start while migration is not "complete" --
    // bail out BEFORE running (and overwriting `lastPreflightReport` with) a redundant fresh
    // preflight pass. Without this guard, `start()`'s own unconditional `tryStartOrdinaryWork()`
    // call at the end of its sequence silently re-ran preflight a SECOND time on every single
    // `start()` (even a fresh install with migration `"not-started"`) and clobbered the report
    // `start()` itself was about to return with a microseconds-later one -- both wasteful and the
    // exact cause of `ProductionEngine.start() is idempotent`'s intermittent `generatedAtIso`
    // flake (a later `start()` call's early-return path returns THIS overwritten report, which
    // could differ by a millisecond from the one the first call actually returned).
    if (migrationStatus.phase !== "complete") return;

    const report = await runPreflight(this.buildPreflightDefinitions(), {
      signal: this.lifecycleAbort.signal,
      defaultTimeoutMs: this.options.preflightTimeoutMs,
    });
    if (this.disposeRequested) return;
    this.lastPreflightReport = report;
    if (!this.ordinaryWorkReady(migrationStatus, report)) return;

    // Item 10: this check and the start effects immediately below run with no `await` between
    // them -- JS's single-threaded execution guarantees dispose()'s own synchronous
    // `disposeRequested = true` (its FIRST statement, before it ever queues its async teardown)
    // cannot land in between, so this check is race-free against a concurrent dispose() even
    // though `tryStartOrdinaryWork` itself does not run inside the `enqueue()` lane
    // `start()`/`stop()`/`dispose()` share.
    if (this.disposeRequested) return;
    if (!this.pumpStarted) {
      const started = await this.safelyOk("JOB_STORE", async () => {
        this.jobEngine.start();
      });
      if (this.disposeRequested) return;
      if (started) this.pumpStarted = true;
    }
    // Same race-free guarantee as above, immediately before the scheduler-start effect itself.
    if (this.disposeRequested) return;
    if (!this.schedulerStarted) {
      const started = await this.safelyOk("SCHEDULE_STORE", () => this.coreScheduler.start());
      if (started) this.schedulerStarted = true;
    }
  }

  /**
   * Startup recovery order (mirrors `MindmapEngine.start()`, extended for
   * write capability): create owned subdirectories -> stale-temp cleanup
   * (jobs/schedules) -> stale-staging cleanup (index) -> recover
   * interrupted jobs -> reconcile any in-flight migration ONE step
   * (`migrationRunner.reconcile()` -- RESUMES an already-active run, never
   * begins a NEW one: only `startMigration()`/`retryMigration()` do that)
   * -> start the ALWAYS-safe `migrationDriver` (its own reconcile loop
   * no-ops on `"not-started"`/a terminal phase, so starting it here never
   * begins anything on its own either) -> preflight -> enable the ordinary
   * JobEngine pump/CoreScheduler ONLY when migration is fully verified
   * `"complete"` AND both Ollama embedding/metadata readiness probes are
   * `"ok"` (item 1/2 -- see `tryStartOrdinaryWork`). A fresh install (never-
   * started migration) therefore leaves Standard Mode (manual note
   * editing, settings, the plugin itself) fully usable while index-
   * dependent work stays gated until the user explicitly starts/completes
   * migration.
   *
   * Idempotent: calling while already started returns the last report
   * without repeating the sequence.
   */
  async start(): Promise<PreflightReportV1> {
    return this.enqueue(async () => {
      if (this.phase === "disposed" || this.disposeRequested) {
        return this.lastPreflightReport ?? this.emptyPreflightReport();
      }
      if (this.phase === "started" && this.lastPreflightReport) {
        return this.lastPreflightReport;
      }

      await this.safely("OWNED_DATA_PATHS", async () => {
        for (const subdirectory of REQUIRED_SUBDIRECTORIES) {
          await this.options.fs.mkdir(`${this.options.dataRoot}/${subdirectory}`);
        }
      });
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      await this.safely("JOB_STORE", () => this.jobStore.cleanupStaleTempFiles().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      await this.safely("INDEX_STORE", () => this.indexStore.cleanupStaleStaging().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      await this.safely("SCHEDULE_STORE", () => this.scheduleStore.cleanupStaleTempFiles().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      await this.safely("JOB_STORE", () => this.jobEngine.recoverInterruptedJobs().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      await this.safely("MIGRATION_STORE", () => this.migrationStore.cleanupStaleTempFiles().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      // Resumes whatever migration state already exists (advances an in-flight run by one step,
      // no-ops on "not-started"/a terminal phase) -- never starts a brand-new migration on its own.
      await this.safely("MIGRATION_STORE", () => this.migrationRunner.reconcile().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? this.emptyPreflightReport();

      const report = await runPreflight(this.buildPreflightDefinitions(), {
        signal: this.lifecycleAbort.signal,
        defaultTimeoutMs: this.options.preflightTimeoutMs,
      });
      if (this.disposeRequested) return report;
      this.lastPreflightReport = report;

      this.phase = "started";

      // Item 1: the migration driver is ALWAYS started here (once) -- it is the automatic,
      // lost-wakeup-safe reconcile loop that keeps an ALREADY-active run's own phase machine
      // moving forward with zero further caller intervention, but its `reconcile()` calls are
      // themselves inert on "not-started"/a terminal phase (see `MigrationRunner.reconcileLocked`'s
      // own default case) -- it never begins a fresh migration by itself.
      this.migrationDriver.start();
      if (this.disposeRequested) return report;

      // Item 1/2: the ordinary pump/CoreScheduler start here ONLY if migration already happens to
      // be "complete" (a prior run finished before this `start()` call) AND providers are already
      // probed ready. Every other case (not-started/in-flight/failed/cancelled, or a provider not
      // yet ready) is picked up later -- either by `unsubscribeMigration`'s listener (once
      // migration reaches "complete") or by a caller-driven `recheckReadiness()` (once a degraded
      // provider recovers).
      await this.tryStartOrdinaryWork();
      return report;
    });
  }

  /**
   * Item 1: "an explicit recheck stops both on degradation and restarts
   * once on recovery" -- re-probes provider readiness (and migration
   * status), and is the ONE path that can ever STOP an already-running
   * pump/CoreScheduler: the instant either provider readiness probe (or
   * core-store health, or migration itself) is no longer ok, BOTH halves
   * are stopped together (never independently -- see `ordinaryWorkReady`),
   * with `pumpStarted`/`schedulerStarted` cleared so a LATER recovery is
   * free to restart them (once each, via the ordinary `tryStartOrdinaryWork`
   * start-only guard below). Safe to call at any time, including before
   * `start()` (a no-op then) or while nothing has degraded (also a no-op).
   */
  async recheckReadiness(): Promise<PreflightReportV1> {
    if (this.phase !== "started" || this.disposeRequested) {
      return this.lastPreflightReport ?? this.emptyPreflightReport();
    }
    const migrationStatus = await this.migrationRunner.getStatus();
    const report = await runPreflight(this.buildPreflightDefinitions(), {
      signal: this.lifecycleAbort.signal,
      defaultTimeoutMs: this.options.preflightTimeoutMs,
    });
    if (this.disposeRequested) return report;
    this.lastPreflightReport = report;

    if (!this.ordinaryWorkReady(migrationStatus, report)) {
      if (this.pumpStarted) {
        this.jobEngine.stop();
        this.pumpStarted = false;
      }
      if (this.schedulerStarted) {
        this.coreScheduler.stop();
        this.schedulerStarted = false;
      }
      return report;
    }

    await this.tryStartOrdinaryWork();
    return this.lastPreflightReport ?? report;
  }

  /**
   * Item 1: the ONLY path that begins a BRAND-NEW migration run (never
   * `start()`/`reconcile()` alone). Item 2: refuses (a closed, static
   * `MIGRATION_NOT_STARTABLE` error, with NO state mutation -- neither this
   * engine's nor `MigrationRunner`'s own persisted record is touched)
   * unless this engine itself has actually `start()`ed AND a FRESH
   * embedding-readiness probe (re-run right now, never `lastPreflightReport`)
   * reports `"ok"` -- migration ingestion embeds directly through its own
   * seam, so beginning a run against a provider that is not currently
   * reachable would only ever fail partway through. Once past that guard,
   * delegates to `MigrationRunner.start()` (which itself refuses to
   * restart an already-in-flight run -- see that method's own doc comment)
   * and immediately kicks `migrationDriver` so progress begins on this
   * very tick rather than waiting for its next interval.
   */
  async startMigration(): Promise<MigrationStatusV1> {
    await this.assertMigrationStartable();
    const status = await this.migrationRunner.start();
    this.migrationDriver.notifyProgress();
    // Deterministically settled (never relying solely on the fire-and-forget `subscribe()`
    // listener's own timing) -- a caller awaiting `startMigration()` sees any newly-cleared pump/
    // scheduler gate reflected in `getOrdinaryWorkStatus()` the instant this resolves.
    if (status.phase === "complete") await this.tryStartOrdinaryWork();
    return status;
  }

  /** Item 1/2: alias for `startMigration()` -- valid (has any effect) only when the current status reports `canRetry` (phase `"failed"`); otherwise behaves exactly like `MigrationRunner.start()`'s own no-op-if-in-flight guard. Subject to the exact same `assertMigrationStartable` closed guard as `startMigration()`. */
  async retryMigration(): Promise<MigrationStatusV1> {
    await this.assertMigrationStartable();
    const status = await this.migrationRunner.retry();
    this.migrationDriver.notifyProgress();
    if (status.phase === "complete") await this.tryStartOrdinaryWork();
    return status;
  }

  /** Item 2: the closed precondition `startMigration()`/`retryMigration()` share -- see their own doc comments. Throws a static `MIGRATION_NOT_STARTABLE` `EngineError` (never leaking the underlying probe failure's own message) and performs ZERO state mutation on failure. */
  private async assertMigrationStartable(): Promise<void> {
    if (this.phase !== "started") {
      throw new EngineError("MIGRATION_NOT_STARTABLE", "Migration cannot be started or retried before this engine has itself started.");
    }
    const probe = this.options.probes?.ollama;
    if (!this.options.embeddingProvider || !this.options.embeddingModel || !probe) {
      throw new EngineError("MIGRATION_NOT_STARTABLE", "Migration cannot be started or retried without a configured embedding provider/model.");
    }
    let ok: boolean;
    try {
      const result = await probe(this.lifecycleAbort.signal);
      ok = result.status === "ok";
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new EngineError("MIGRATION_NOT_STARTABLE", "Migration cannot be started or retried while the embedding provider readiness probe is not ok.");
    }
  }

  /** Item 1: delegates cancellation to `MigrationRunner.cancel()` (which itself is a no-op once `"activate"` has begun) and kicks the driver so the resulting `"cancelled"` transition (or the settled in-flight reconcile) is reflected immediately. */
  async cancelMigration(): Promise<MigrationStatusV1> {
    const status = await this.migrationRunner.cancel();
    this.migrationDriver.notifyProgress();
    return status;
  }

  /** TRUE read-only inspection path -- mirrors `MindmapEngine.inspectReadOnly()` exactly: runs only the preflight probes, never mutates anything, never requires (or reaches) `phase === "started"`. */
  async inspectReadOnly(): Promise<PreflightReportV1> {
    return runPreflight(this.buildPreflightDefinitions(), { signal: this.lifecycleAbort.signal, defaultTimeoutMs: this.options.preflightTimeoutMs });
  }

  /** Current migration status without advancing it -- convenience passthrough to `migrationRunner.getStatus()`. */
  getMigrationStatus(): Promise<MigrationStatusV1> {
    return this.migrationRunner.getStatus();
  }

  /** Item 6: opens a related note in the workspace, validated against this engine's own configured `configDir` (`options.vault.configDir`, never a hardcoded `.obsidian`) before ever reaching `workspace.openLinkText` -- see `openRelatedNote`'s own doc comment for the exact closed rejection set. Throws `JOB_SHAPE_INVALID`-flavored `IDENTITY_INVALID` if `options.workspace` was never supplied (a headless/test composition that never needed this). */
  async openRelatedNote(notePath: string): Promise<void> {
    if (!this.options.workspace) {
      throw new EngineError("IDENTITY_INVALID", "openRelatedNote requires ProductionEngineOptions.workspace to be configured.");
    }
    await openRelatedNote(this.options.workspace, notePath, { configDir: this.options.vault.configDir, runtimeFolder: this.options.runtimeFolder });
  }

  /**
   * Checkpoint 10B item 2 (active-note processing): submits ONE
   * `"process-note"` job for a single vault-relative path -- resolves the
   * note's CURRENT content through the exact same `NoteSourceReader`
   * `"process-note"` jobs themselves use, and computes `sourceHash`
   * through the SAME `projectSource` normalization every other write path
   * uses (never a raw-content hash, and never a caller-supplied hash that
   * could be stale by the time this actually submits). Throws a closed
   * `JOB_SHAPE_INVALID` if `"process-note"` was never registered (no full
   * provider configuration -- see the constructor's own item-6 gate), or
   * `SOURCE_STALE` if the path does not currently resolve to a note.
   */
  async submitNoteForProcessing(canonicalPath: string, trigger: JobTrigger = "manual"): Promise<void> {
    if (!this.registeredRunners["process-note"] || !this.options.embeddingModel) {
      throw new EngineError("JOB_SHAPE_INVALID", "submitNoteForProcessing requires process-note to be registered (full provider configuration).");
    }
    const canonical = canonicalizePath(canonicalPath);
    const resolved = await this.noteSourceReader.read(stableNoteIdentity(canonical));
    if (!resolved) {
      throw new EngineError("SOURCE_STALE", "submitNoteForProcessing: the given path does not currently resolve to a note.");
    }
    const sourceHash = projectSource(resolved.identity, resolved.rawContent).sourceHash;
    await this.jobEngine.submit({ trigger, kind: "process-note", identity: resolved.identity, sourceHash, embeddingModel: this.options.embeddingModel, pipelineVersion: this.options.pipelineVersion });
  }

  /**
   * Checkpoint 10B item 2 (scope-wide runs): submits a `"scope-refresh"`
   * job under the given scope id -- `"current"`/`"all"` are the ONLY ids
   * this engine's own scope registry recognizes for ordinary runs (see
   * `PRODUCTION_SCOPE_CURRENT`/`PRODUCTION_SCOPE_ALL`); an unrecognized id
   * still submits (the job itself settles, harmlessly, against zero
   * discovered items -- the registry's own closed fail-shut behavior, not
   * a rejection here) rather than this method silently guessing a
   * fallback scope.
   */
  async submitScopeRefresh(scopeId: string, trigger: JobTrigger = "manual"): Promise<void> {
    if (!this.registeredRunners["scope-refresh"]) {
      throw new EngineError("JOB_SHAPE_INVALID", "submitScopeRefresh requires scope-refresh to be registered (full provider configuration).");
    }
    await this.jobEngine.submit({ trigger, kind: "scope-refresh", scopeId, pipelineVersion: this.options.pipelineVersion });
  }

  /** Checkpoint 10B item 6: submits a `"reading-sync"` job under the fixed `PRODUCTION_SCOPE_READING` id -- the ONLY scope id `"reading-sync"` is ever submitted with in production. */
  async submitReadingSync(trigger: JobTrigger = "manual"): Promise<void> {
    if (!this.registeredRunners["reading-sync"]) {
      throw new EngineError("JOB_SHAPE_INVALID", "submitReadingSync requires reading-sync to be registered (full provider configuration).");
    }
    await this.jobEngine.submit({ trigger, kind: "reading-sync", scopeId: PRODUCTION_SCOPE_READING, pipelineVersion: this.options.pipelineVersion });
  }

  /**
   * Checkpoint 10B FORCE COMMANDS: submits one `"rebuild-index"` job --
   * the TS mapping for the retired `rebuildAll` Python run profile
   * (`--all --refresh-all --rebuild --apply`). `RebuildJobRunner` is
   * registered UNCONDITIONALLY (never gated on embedding/metadata
   * provider configuration -- see the constructor above), so this never
   * throws `JOB_SHAPE_INVALID` in practice; the guard is kept only for
   * defensive symmetry with every other `submit*` method on this class.
   */
  async submitRebuild(trigger: JobTrigger = "manual"): Promise<void> {
    if (!this.registeredRunners["rebuild-index"]) {
      throw new EngineError("JOB_SHAPE_INVALID", "submitRebuild requires rebuild-index to be registered.");
    }
    await this.jobEngine.submit({ trigger, kind: "rebuild-index", pipelineVersion: this.options.pipelineVersion });
  }

  /**
   * Checkpoint 10B SIDEBAR: resolves the CURRENT text of the note at
   * `canonicalPath` through the same `NoteSourceReader` "process-note"
   * jobs use, projects it through `projectSource` (never a raw-content
   * hash), and reports whether `IndexStore`'s committed view currently
   * holds a matching record. When `ensureIndex` is true and the record is
   * absent or its `sourceHash` has drifted, submits the EXACT same
   * `process-note` job `submitNoteForProcessing` would (never a daemon,
   * never a synchronous inline embed-then-index like the retired Python
   * worker) and returns immediately with the SAME "not yet indexed"
   * loading/empty semantics the UI already renders for `indexed: false`/
   * `stale: true` -- the caller is expected to re-query once the
   * submitted job completes, exactly like polling any other job result.
   * Related candidates are only ever computed against an ALREADY
   * indexed, non-stale-at-submission-time record: `related` mirrors
   * `query_related_for_note`'s selection (`selectRelatedCandidates`), and
   * the note's own vector for ranking is a FRESH embed through
   * `noteEmbeddingSeam` -- never a stored vector pulled back out of the
   * index -- so ranking always reflects the note's current on-disk text.
   */
  async queryLiveRelated(canonicalPathInput: string, ensureIndex: boolean): Promise<ProductionLiveRelatedResult> {
    if (!this.noteEmbeddingSeam || !this.options.embeddingModel || !this.options.relatedSelectionConfig) {
      throw new EngineError("JOB_SHAPE_INVALID", "queryLiveRelated requires an embedding provider/model and relatedSelectionConfig to be configured.");
    }
    const canonical = canonicalizePath(canonicalPathInput);
    const identity = stableNoteIdentity(canonical);
    const resolved = await this.noteSourceReader.read(identity);
    if (!resolved) {
      throw new EngineError("SOURCE_STALE", "queryLiveRelated: the given path does not currently resolve to a note.");
    }
    const projection = projectSource(resolved.identity, resolved.rawContent);
    const record = await this.indexStore.getRecord(resolved.identity);
    const indexed = record !== null;
    const stale = !indexed || record.sourceHash !== projection.sourceHash;

    if (ensureIndex && stale && this.registeredRunners["process-note"]) {
      await this.jobEngine
        .submit({ trigger: "manual", kind: "process-note", identity: resolved.identity, sourceHash: projection.sourceHash, embeddingModel: this.options.embeddingModel, pipelineVersion: this.options.pipelineVersion })
        .catch(() => undefined);
      return { path: canonical, sourceHash: projection.sourceHash, indexed, stale, related: [] };
    }

    if (!indexed) {
      return { path: canonical, sourceHash: projection.sourceHash, indexed, stale, related: [] };
    }

    const embedded = await this.noteEmbeddingSeam.embed(projection, this.lifecycleAbort.signal);
    const config = this.options.relatedSelectionConfig;
    const candidates = await this.indexStore.queryRelated({
      queryVector: embedded.noteVector,
      queryChunkVectors: embedded.chunkVectors,
      excludePath: canonical,
      limit: config.candidateLimit,
    });
    const related = selectRelatedCandidates(
      candidates.map((c): RelatedCandidateScore => ({ path: c.path, score: c.score })),
      { selfPath: canonical, relatedLimit: config.relatedLimit, overreachCount: config.overreachCount, creativeCount: config.creativeCount, creativeMin: config.creativeMin, creativeMax: config.creativeMax, minScore: config.minScore },
    );
    return { path: canonical, sourceHash: projection.sourceHash, indexed, stale, related };
  }

  /**
   * Checkpoint 10B SIDEBAR: projects the raw lookup query text through the
   * SAME `projectSource`/`noteEmbeddingSeam` pipeline (a synthetic,
   * never-persisted `"path"` identity -- this text is never written or
   * indexed as a note) and ranks `IndexStore`'s committed view against
   * the result. Unlike `queryLiveRelated`, results are the PLAIN
   * score-descending top-`limit` (mirroring `query_related_for_text`,
   * which never runs core/overreach/creative selection) -- every result
   * carries `kind: "lookup"`.
   */
  async queryLookupRelated(queryText: string, limit: number): Promise<ProductionRelatedResult[]> {
    if (!this.noteEmbeddingSeam || !this.options.relatedSelectionConfig) {
      throw new EngineError("JOB_SHAPE_INVALID", "queryLookupRelated requires an embedding provider/model and relatedSelectionConfig to be configured.");
    }
    const trimmed = queryText.trim();
    if (trimmed === "") return [];
    const identity = stableNoteIdentity(canonicalizePath("__lookup-query__"));
    const projection = projectSource(identity, trimmed);
    const embedded = await this.noteEmbeddingSeam.embed(projection, this.lifecycleAbort.signal);
    const boundedLimit = Math.max(1, limit);
    const candidateLimit = Math.max(boundedLimit, this.options.relatedSelectionConfig.candidateLimit);
    const candidates = await this.indexStore.queryRelated({ queryVector: embedded.noteVector, queryChunkVectors: embedded.chunkVectors, limit: candidateLimit });
    return candidates.slice(0, boundedLimit).map((c) => ({ schemaVersion: 1, path: c.path, score: c.score, kind: "lookup" }));
  }

  /**
   * Checkpoint 10B PENDING: the ONLY entry point a pending-notes scanner
   * (`productionPendingScan.ts`) needs into this engine -- discovers every
   * currently-eligible `{identity, sourceHash}` pair under `scopeId`
   * (`PRODUCTION_SCOPE_CURRENT`/`PRODUCTION_SCOPE_ALL`) through the SAME
   * `streamFullCatalogDiscovery` pass (and therefore the SAME strict
   * Reading-artifact exclusions) `"scope-refresh"` jobs themselves
   * discover against, content-free (never retains a note body). Available
   * regardless of whether embedding/metadata providers are configured --
   * discovery is pure text/hash work, so "N notes pending" must stay
   * meaningful even before a vault's providers are set up.
   */
  async getPendingCandidates(scopeId: string, signal?: AbortSignal): Promise<{ identity: import("./contracts").NoteIdentityV1; sourceHash: string }[]> {
    const items = await this.pendingDiscoverySeam.discover(scopeId, signal ?? this.lifecycleAbort.signal);
    return items.map((item) => ({ identity: item.identity, sourceHash: item.sourceHash }));
  }

  private emptyPreflightReport(nowIso: string = new Date().toISOString()): PreflightReportV1 {
    return { schemaVersion: 1, generatedAtIso: nowIso, checks: [], summary: { runtimeReady: false, overallStatus: "unavailable", requiredOkCount: 0, requiredCount: 0, optionalOkCount: 0, optionalCount: 0 } };
  }

  /** Stops the pump/scheduler/migration driver; does not interrupt in-flight I/O. Idempotent. */
  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== "started") return;
      this.coreScheduler.stop();
      this.jobEngine.stop();
      this.migrationDriver.stop();
      this.pumpStarted = false;
      this.schedulerStarted = false;
      this.phase = "idle";
    });
  }

  /**
   * Aborts every in-flight/pending probe immediately, then tears down
   * every owned component exactly once. Idempotent. No queued job/
   * scheduler/provider effect fires after `dispose()` returns -- the pump
   * is disposed (not merely stopped), which also aborts the `AbortSignal`
   * threaded into every phase runner's `step()` call, and the
   * `migrationRunner`'s own subscribers are cleared so a caller that
   * disposed this engine never receives a late status notification.
   */
  async dispose(): Promise<void> {
    this.disposeRequested = true;
    this.lifecycleAbort.abort();
    this.unsubscribeMigration?.();
    this.unsubscribeMigration = null;
    return this.enqueue(async () => {
      if (this.phase === "disposed") return;
      this.coreScheduler.dispose();
      this.jobEngine.dispose();
      this.migrationDriver.dispose();
      this.migrationRunner.dispose();
      this.pumpStarted = false;
      this.schedulerStarted = false;
      this.phase = "disposed";
    });
  }

  getCapabilityFaults(): ReadonlyMap<string, string> {
    return this.capabilityFaults;
  }

  subscribeActivity(listener: (snapshot: EngineActivitySnapshot) => void): () => void {
    return this.jobEngine.subscribeActivity(listener);
  }
}

export { PREFLIGHT_CHECK_CODES };
