import type { IntervalRegistrar } from "../scheduling/coreScheduler";
import { isEngineError } from "../engine/errors";
import { isTerminalMigrationPhase, type MigrationStatusV1 } from "./migrationContract";

export interface MigrationDriverJobSubmitter {
  reconcile(): Promise<MigrationStatusV1>;
}

export interface MigrationDriverOptions {
  runner: MigrationDriverJobSubmitter;
  registrar: IntervalRegistrar;
  intervalMs?: number;
  /** Best-effort, never allowed to throw out of this module -- observability only, mirrors every other fault callback in this codebase (`JobEngineFault`/`SchedulerFault`). */
  onFault?: (code: string) => void;
}

const DEFAULT_MIGRATION_DRIVER_INTERVAL_MS = 2_000;
const MIN_MIGRATION_DRIVER_INTERVAL_MS = 100;
const MAX_MIGRATION_DRIVER_INTERVAL_MS = 60 * 60_000;

function safelyNotifyFault(onFault: ((code: string) => void) | undefined, code: string): void {
  try {
    onFault?.(code);
  } catch {
    // A throwing observer cannot leak past this boundary.
  }
}

/**
 * Checkpoint 10A review blocker item 6: the automatic, lost-wakeup-safe,
 * single-flight, restart-safe driver that repeatedly advances an in-flight
 * migration by calling `MigrationRunner.reconcile()` -- mirrors
 * `JobEngine`'s own `kick()`/`pumping`/`kickRequested` pattern exactly
 * (see `jobEngine.ts`): a `kick()` call arriving while a reconcile is
 * already in-flight is never dropped, because `kickRequested` is set
 * BEFORE checking whether a pump is already running, and the pump loop
 * itself rechecks that flag right before it would otherwise exit.
 *
 * Restart-safe because `reconcile()` itself always starts from persisted
 * `MigrationStore` state -- a fresh `MigrationDriver` instance (e.g. after
 * a crash/reload) calling `start()` again picks up exactly where a prior
 * instance left off, with zero in-memory assumptions carried over.
 *
 * Registers ONE interval (via the injected `IntervalRegistrar` -- the
 * SAME seam `CoreScheduler` itself is built over) as a scheduled kick
 * source, so migration keeps advancing even with no other trigger. The
 * loop stops re-kicking itself once `reconcile()` reports a terminal
 * phase -- see `pumpLoop` -- but the registered interval itself is left
 * running (idempotent no-op ticks) until `stop()`/`dispose()`; a LATER
 * `retry()` on the underlying runner (e.g. after `"failed"`) resumes
 * genuine progress on the very next tick with no re-`start()` needed.
 */
export class MigrationDriver {
  private readonly runner: MigrationDriverJobSubmitter;
  private readonly registrar: IntervalRegistrar;
  private readonly intervalMs: number;
  private readonly onFault?: (code: string) => void;

  private running = false;
  private disposed = false;
  private intervalHandle: unknown = null;
  private pumping: Promise<void> | null = null;
  private kickRequested = false;

  constructor(options: MigrationDriverOptions) {
    this.runner = options.runner;
    this.registrar = options.registrar;
    const requested = options.intervalMs ?? DEFAULT_MIGRATION_DRIVER_INTERVAL_MS;
    if (!Number.isFinite(requested) || requested < MIN_MIGRATION_DRIVER_INTERVAL_MS || requested > MAX_MIGRATION_DRIVER_INTERVAL_MS) {
      throw new RangeError(`intervalMs must be in [${MIN_MIGRATION_DRIVER_INTERVAL_MS}, ${MAX_MIGRATION_DRIVER_INTERVAL_MS}].`);
    }
    this.intervalMs = requested;
    this.onFault = options.onFault;
  }

  /** Idempotent. Registers the interval tick source and performs one immediate kick so a caller never waits a full interval for the first reconcile. */
  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.intervalHandle = this.registrar.registerInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }

  /** Cancels the interval registration; does not interrupt an in-flight reconcile. Idempotent. Safe to `start()` again afterward. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.intervalHandle !== null) {
      const handle = this.intervalHandle;
      this.intervalHandle = null;
      this.registrar.cancelInterval(handle);
    }
  }

  /** `stop()` plus a permanent refusal of any further work. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
  }

  /**
   * External kick source (item 6: "pump may advance migration") -- a
   * caller (e.g. `ProductionEngine`, after observing job-store activity
   * that might unblock migration's `build`/`verify`/`activate` phases)
   * calls this to request an immediate reconcile pass rather than waiting
   * for the next interval tick. Shares the exact same lost-wakeup-safe
   * entry point as the interval-driven kick, so neither source can race
   * the other into a torn/overlapping reconcile.
   */
  notifyProgress(): void {
    this.kick();
  }

  private kick(): void {
    if (!this.running || this.disposed) return;
    this.kickRequested = true;
    if (this.pumping) return;
    this.pumping = this.pumpLoop().finally(() => {
      this.pumping = null;
    });
  }

  private async pumpLoop(): Promise<void> {
    for (;;) {
      this.kickRequested = false;
      if (!this.running || this.disposed) return;
      let status: MigrationStatusV1;
      try {
        status = await this.runner.reconcile();
      } catch (error) {
        safelyNotifyFault(this.onFault, isEngineError(error) ? error.code : "UNKNOWN_MIGRATION_DRIVER_FAULT");
        return;
      }
      if (this.kickRequested) continue;
      if (isTerminalMigrationPhase(status.phase)) return;
      return;
    }
  }
}
