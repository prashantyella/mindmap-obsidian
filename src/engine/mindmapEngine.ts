import type { AtomicStoreFs } from "./atomicStore";
import { isEngineError } from "./errors";
import type { IndexFs } from "../index/indexFs";
import { IndexStore } from "../index/indexStore";
import { JobEngine, type JobEngineFault, type JobPhaseRunner } from "../jobs/jobEngine";
import type { JobKind } from "./contracts";
import { JobStore } from "../jobs/jobStore";
import { CoreScheduler, type IntervalRegistrar, type SchedulerClock, type SchedulerFault } from "../scheduling/coreScheduler";
import { ScheduleStore } from "../scheduling/scheduleStore";
import { BackgroundScheduler, type BackgroundSchedulerOptions } from "../scheduling/backgroundScheduler";
import { PREFLIGHT_CHECK_CODES, runPreflight, type PreflightCheckDefinition, type PreflightProbe, type PreflightReportV1 } from "./preflight";

/** Closed fallback fault code `safely()` stores when the caught value is not an `EngineError` (whose own `.code` is already a closed `EngineErrorCode`) -- never a constructor name or raw message (Checkpoint 9 requirement 8). */
const UNKNOWN_FAULT_CODE = "UNKNOWN_FAULT";

function emptyPreflightReport(nowIso: string = new Date().toISOString()): PreflightReportV1 {
  return { schemaVersion: 1, generatedAtIso: nowIso, checks: [], summary: { runtimeReady: false, overallStatus: "unavailable", requiredOkCount: 0, requiredCount: 0, optionalOkCount: 0, optionalCount: 0 } };
}

/** Isolates a caller-supplied observer: a throwing `onFault` must never propagate out through the internal fault-handling path that invokes it (Checkpoint 9 requirement 8). */
function safelyNotify(onFault: (() => void) | undefined): void {
  try {
    onFault?.();
  } catch {
    // A throwing observer cannot leak past this boundary -- see this function's doc comment.
  }
}

export interface MindmapEngineFault {
  source: "job-engine" | "core-scheduler";
  code: string;
  atMs: number;
}

/**
 * Optional readiness probes for capabilities `MindmapEngine` does not own
 * the implementation of (Ollama, a local metadata provider, Apple Books,
 * Exa/Keychain research). Omitting a probe means the capability is not
 * configured -- `runPreflight` reports it `"ok"`/"not configured" rather
 * than treating an intentionally-disabled capability as a failure
 * (Checkpoint 9 requirement 1).
 */
export interface MindmapEngineProbes {
  ollama?: PreflightProbe;
  localMetadataProvider?: PreflightProbe;
  appleBooksReading?: PreflightProbe;
  researchProvider?: PreflightProbe;
  backgroundScheduler?: PreflightProbe;
}

export interface MindmapEngineOptions {
  /** Absolute, plugin-owned data directory this whole engine instance is confined to. */
  dataRoot: string;
  /** Real or fake filesystem seam every persistent store is built over -- the one place a real Node adapter (`NodeOwnedFs`) meets this composition. */
  fs: IndexFs & AtomicStoreFs;
  /** Obsidian's `registerInterval`/`clearInterval` wrapper (or a fake in tests). */
  registrar: IntervalRegistrar;
  clock?: SchedulerClock;
  /** Present only when the optional macOS LaunchAgent adapter is available and its own composition succeeded; absent entirely on non-macOS or when consent/config is missing. */
  backgroundScheduler?: BackgroundSchedulerOptions;
  /** `process-note`/`rebuild-index`/etc. phase runners. Deliberately omittable per kind: Checkpoint 9 composes `JobEngine` for its lifecycle/recovery/preflight role only -- no runner capable of a vault/index write is wired in this checkpoint, and `JobEngine.start()` (the pump) is never called by this module, so even a future runner addition cannot execute here yet (requirement 3: "No production JobEngine start that can write"). */
  jobRunners?: Readonly<Partial<Record<JobKind, JobPhaseRunner>>>;
  probes?: MindmapEngineProbes;
  onFault?: (fault: MindmapEngineFault) => void;
  preflightTimeoutMs?: number;
}

export type MindmapEnginePhase = "idle" | "started" | "disposed";

const REQUIRED_SUBDIRECTORIES = ["jobs", "schedules", "index"];

/**
 * The one composition root: owns/coordinates `JobStore`/`JobEngine`,
 * `ScheduleStore`/`CoreScheduler`, the optional `BackgroundScheduler`, and
 * `IndexStore`, all over one injected filesystem seam confined to
 * `dataRoot`. A single-settlement `start()`/`stop()`/`dispose()` lifecycle
 * (Checkpoint 9 requirement 1): concurrent calls to the same method share
 * one in-flight settlement rather than racing, and every method is
 * idempotent -- calling `start()` twice, or `dispose()` after `stop()`,
 * never throws or double-runs teardown.
 *
 * `dispose()` is deliberately NOT queued behind an in-flight `start()`:
 * it aborts the shared lifecycle `AbortSignal` immediately (synchronously,
 * outside the operation tail) so a `start()` blocked on a hung optional
 * probe unwinds promptly, and only THEN enqueues its own teardown onto the
 * same tail `start()`/`stop()` use -- see `dispose()`'s body.
 */
export class MindmapEngine {
  readonly jobStore: JobStore;
  readonly jobEngine: JobEngine;
  readonly scheduleStore: ScheduleStore;
  readonly coreScheduler: CoreScheduler;
  readonly indexStore: IndexStore;
  readonly backgroundScheduler: BackgroundScheduler | null;

  private readonly options: MindmapEngineOptions;
  private phase: MindmapEnginePhase = "idle";
  private opTail: Promise<void> = Promise.resolve();
  private lifecycleAbort = new AbortController();
  private lastPreflightReport: PreflightReportV1 | null = null;
  private readonly capabilityFaults: Map<string, string> = new Map();
  /** Set synchronously (before any `await`) the instant `dispose()` is called -- `start()` checks this after every one of its own `await`s so a `dispose()` racing an in-flight `start()` can never let a later step (preflight, `CoreScheduler.start()`, or the final `phase = "started"` assignment) run after disposal began (Checkpoint 9 requirement 8). */
  private disposeRequested = false;

  constructor(options: MindmapEngineOptions) {
    this.options = options;
    this.jobStore = new JobStore(options.fs, options.dataRoot);
    this.jobEngine = new JobEngine(this.jobStore, options.jobRunners ?? {}, undefined, (fault: JobEngineFault) => {
      this.capabilityFaults.set("JOB_STORE", fault.code);
      safelyNotify(() => options.onFault?.({ source: "job-engine", code: fault.code, atMs: fault.atMs }));
    });
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
  }

  getPhase(): MindmapEnginePhase {
    return this.phase;
  }

  getLastPreflightReport(): PreflightReportV1 | null {
    return this.lastPreflightReport;
  }

  /** Serializes every lifecycle operation through one tail -- `start()`/`stop()` never interleave with each other or with `dispose()`'s own final teardown step. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.opTail.then(fn, fn);
    this.opTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Stores only a closed, static fault code -- an `EngineError`'s own `.code` (already a closed `EngineErrorCode`) when the caught value is one, otherwise the single closed `UNKNOWN_FAULT_CODE` fallback. Never a constructor name, never a raw thrown message (Checkpoint 9 requirement 8). */
  private async safely(code: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.capabilityFaults.delete(code);
    } catch (error) {
      this.capabilityFaults.set(code, isEngineError(error) ? error.code : UNKNOWN_FAULT_CODE);
    }
  }

  private buildPreflightDefinitions(): PreflightCheckDefinition[] {
    const probes = this.options.probes ?? {};
    const fs = this.options.fs;
    const dataRoot = this.options.dataRoot;
    return [
      {
        code: "VAULT_ADAPTER",
        probe: async () => ({ status: "ok", message: "Vault adapter is configured." }),
      },
      {
        // Read-only (Checkpoint 9 requirement 2): reports which owned subdirectories already
        // exist via `exists()` probes only -- never creates them. Creation belongs solely to the
        // authoritative `start()` sequence below.
        code: "OWNED_DATA_PATHS",
        probe: async () => {
          const missing: string[] = [];
          for (const subdirectory of REQUIRED_SUBDIRECTORIES) {
            const present = await fs.exists(`${dataRoot}/${subdirectory}`);
            if (!present) missing.push(subdirectory);
          }
          if (missing.length === 0) {
            return { status: "ok", message: "Plugin-owned data paths are accessible." };
          }
          return { status: "degraded", message: "Some plugin-owned data paths do not exist yet.", context: { missingCount: missing.length } };
        },
      },
      {
        code: "JOB_STORE",
        probe: async () => {
          await this.jobStore.list();
          // A parseable, readable job store is NOT the same claim as "jobs can execute" -- no
          // production runner writes through this checkpoint (see `MindmapEngineOptions.jobRunners`'s
          // doc comment), so the message/context here are deliberately worded not to imply
          // operational readiness (Checkpoint 9 requirement 8: "JobEngine empty runners must not be
          // described as operational readiness").
          const runnersConfigured = Object.keys(this.options.jobRunners ?? {}).length > 0;
          const message = runnersConfigured ? "Job store loads and parses." : "Job store loads and parses; no execution runners are configured this checkpoint.";
          return { status: "ok", message, context: { runnersConfigured } };
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
        // Read-only: counts stale staging directories via `countStaleStaging()` (list-only) rather
        // than sweeping them via `cleanupStaleStaging()`. Cleanup belongs solely to `start()`.
        code: "INDEX_STORE",
        probe: async () => {
          const staleStaging = await this.indexStore.countStaleStaging();
          if (staleStaging === 0) {
            return { status: "ok", message: "Index store filesystem layer is reachable." };
          }
          return { status: "degraded", message: "Index store has stale staging directories pending cleanup.", context: { staleStaging } };
        },
      },
      {
        // Read-only: counts leftover temp files via `countStaleTempFiles()` (list-only) rather than
        // deleting them. Deletion belongs solely to `start()`'s `cleanupStaleTempFiles()` call.
        code: "TEMP_CLEANUP",
        probe: async () => {
          const jobTemp = await this.jobStore.countStaleTempFiles();
          const scheduleTemp = await this.scheduleStore.countStaleTempFiles();
          const staleTempCount = jobTemp + scheduleTemp;
          if (staleTempCount === 0) {
            return { status: "ok", message: "No stale temp files pending cleanup.", context: { jobTemp, scheduleTemp } };
          }
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

  /**
   * Startup recovery order (Checkpoint 9 requirement 1): stores/temp
   * cleanup -> recover jobs -> preflight -> scheduler -> (optional shadow
   * is never auto-run here; a caller invokes it explicitly). Every step is
   * independently fault-isolated via `safely()` -- an optional-capability
   * failure never prevents a later step, and `JobEngine.start()` (the
   * pump) is deliberately never called, so `CoreScheduler.start()`
   * submitting a catch-up job only ever persists a queued entry, never
   * executes it (see this module's class doc comment).
   *
   * Idempotent: calling while already started returns the last report
   * without repeating the sequence.
   */
  async start(): Promise<PreflightReportV1> {
    return this.enqueue(async () => {
      if (this.phase === "disposed" || this.disposeRequested) {
        return this.lastPreflightReport ?? emptyPreflightReport();
      }
      if (this.phase === "started" && this.lastPreflightReport) {
        return this.lastPreflightReport;
      }

      await this.safely("OWNED_DATA_PATHS", async () => {
        for (const subdirectory of REQUIRED_SUBDIRECTORIES) {
          await this.options.fs.mkdir(`${this.options.dataRoot}/${subdirectory}`);
        }
      });
      if (this.disposeRequested) return this.lastPreflightReport ?? emptyPreflightReport();

      await this.safely("JOB_STORE", () => this.jobStore.cleanupStaleTempFiles().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? emptyPreflightReport();

      await this.safely("INDEX_STORE", () => this.indexStore.cleanupStaleStaging().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? emptyPreflightReport();

      // Checkpoint 9 requirement 8: "Include ScheduleStore stale-temp cleanup in authoritative
      // cleanup" -- ScheduleStore's own leftover `AtomicStore` temp files were never previously
      // swept by `start()`, only reported (read-only) by the TEMP_CLEANUP preflight probe above.
      await this.safely("SCHEDULE_STORE", () => this.scheduleStore.cleanupStaleTempFiles().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? emptyPreflightReport();

      await this.safely("JOB_STORE", () => this.jobStore.recoverInterruptedJobs().then(() => undefined));
      if (this.disposeRequested) return this.lastPreflightReport ?? emptyPreflightReport();

      const report = await runPreflight(this.buildPreflightDefinitions(), {
        signal: this.lifecycleAbort.signal,
        defaultTimeoutMs: this.options.preflightTimeoutMs,
      });
      if (this.disposeRequested) return report;
      this.lastPreflightReport = report;

      await this.safely("SCHEDULE_STORE", () => this.coreScheduler.start());
      if (this.disposeRequested) return report;

      this.phase = "started";
      return report;
    });
  }

  /**
   * TRUE read-only inspection path (Checkpoint 9 requirement 1): runs only
   * the now-read-only preflight probes (`buildPreflightDefinitions()`)
   * plus, when supplied, a bounded read-only shadow comparison -- and
   * NOTHING else. Deliberately does NOT call `start()`, so it never:
   * creates `REQUIRED_SUBDIRECTORIES` (`fs.mkdir`), cleans up stale temp
   * files or staging directories, recovers interrupted jobs, or starts
   * `CoreScheduler` (which can itself submit a catch-up job). Does not
   * require -- and never reaches -- `phase === "started"`; callable at any
   * phase, including `"idle"` and (harmlessly) `"disposed"`, and never
   * mutates `phase`, `lastPreflightReport`, or `capabilityFaults`, so it
   * can be called any number of times without interfering with a real
   * `start()`/`stop()`/`dispose()` lifecycle running concurrently.
   */
  async inspectReadOnly(): Promise<PreflightReportV1> {
    return runPreflight(this.buildPreflightDefinitions(), {
      signal: this.lifecycleAbort.signal,
      defaultTimeoutMs: this.options.preflightTimeoutMs,
    });
  }

  /** Stops kicking new scheduled work; does not interrupt in-flight I/O. Idempotent. */
  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.phase !== "started") return;
      this.coreScheduler.stop();
      this.jobEngine.stop();
      this.phase = "idle";
    });
  }

  /**
   * Aborts every in-flight/pending probe immediately (before queuing
   * anything), then tears down every owned component exactly once.
   * Idempotent and safe to call multiple times or before `start()` ever
   * ran. No callback or state update from an aborted probe reaches this
   * engine after `dispose()` returns (requirement 8) -- `runPreflight`'s
   * own bounded-timeout race already converts an aborted probe into an
   * `"unavailable"` result rather than a hanging promise, and this
   * engine's `lastPreflightReport` is never written to again after
   * `phase` becomes `"disposed"`.
   */
  async dispose(): Promise<void> {
    this.disposeRequested = true;
    this.lifecycleAbort.abort();
    return this.enqueue(async () => {
      if (this.phase === "disposed") return;
      this.coreScheduler.dispose();
      this.jobEngine.dispose();
      this.phase = "disposed";
    });
  }

  /** Capability codes (a subset of `PREFLIGHT_CHECK_CODES`) that recorded a fault since the last successful probe of that capability -- distinct from `getLastPreflightReport()`, which is a point-in-time snapshot. */
  getCapabilityFaults(): ReadonlyMap<string, string> {
    return this.capabilityFaults;
  }
}

export { PREFLIGHT_CHECK_CODES };
