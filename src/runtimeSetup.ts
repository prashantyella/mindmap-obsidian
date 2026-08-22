import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  computeRequirementsFingerprint,
  getManagedInterpreterPath,
  getManagedRuntimeDir,
  getManagedStagingDir,
  isWithinManagedRuntimeRoot,
  type InterpreterProbeResult,
} from "./runtimeDiscovery";

// ---------------------------------------------------------------------------
// Public state model
// ---------------------------------------------------------------------------

export type RuntimeSetupPhase =
  | "discovering"
  | "setup-required"
  | "confirming"
  | "creating"
  | "installing"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled";

export interface RuntimeSetupState {
  phase: RuntimeSetupPhase;
  interpreterPath?: string;
  message: string;
  canRetry: boolean;
  canCancel: boolean;
}

function initialState(): RuntimeSetupState {
  return { phase: "setup-required", message: "Mindmap runtime setup has not started.", canRetry: true, canCancel: false };
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface SetupFs {
  existsSync(targetPath: string): boolean;
  mkdir(targetPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Recursive, force-remove. Callers must validate the exact path before calling. */
  rm(targetPath: string): Promise<void>;
}

export function createNodeSetupFs(): SetupFs {
  return {
    existsSync: (targetPath) => fs.existsSync(targetPath),
    mkdir: async (targetPath) => {
      await fs.promises.mkdir(targetPath, { recursive: true });
    },
    rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
    rm: (targetPath) => fs.promises.rm(targetPath, { recursive: true, force: true }),
  };
}

export interface SetupProcessStream {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

export interface SetupChildProcess {
  stdout: SetupProcessStream;
  stderr: SetupProcessStream;
  on(event: "error" | "close", listener: (value?: unknown) => void): void;
  kill(): void;
}

/** Argument-array only, never a shell. */
export type SetupSpawner = (command: string, args: string[]) => SetupChildProcess;

/**
 * Minimal env for macOS `python -m venv` / `pip install`: a safe PATH,
 * HOME (pip/venv use it for cache), and locale. PATH is fixed rather than
 * inherited, and pip configuration is explicitly disabled so user-level
 * index credentials cannot leak into setup. This is an allowlist, not a
 * blocklist: provider keys and other ambient credentials are never forwarded.
 */
const ALLOWED_ENV_KEYS = ["HOME", "LANG", "LC_ALL", "TMPDIR"] as const;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function buildManagedProcessEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = sourceEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  env.PATH = FALLBACK_PATH;
  env.PIP_CONFIG_FILE = "/dev/null";
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.PIP_NO_INPUT = "1";
  return env;
}

type NodeSpawnFn = (command: string, args: string[], options: { stdio: unknown; shell: boolean; env: Record<string, string> }) => unknown;

export function createNodeSetupSpawner(sourceEnv: NodeJS.ProcessEnv = process.env, spawnFn: NodeSpawnFn = spawn as unknown as NodeSpawnFn): SetupSpawner {
  const env = buildManagedProcessEnv(sourceEnv);
  return (command, args) => spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env }) as SetupChildProcess;
}

export interface SetupTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

// See appleBooksReaderProcess.ts: Electron's renderer setTimeout/clearTimeout
// throw "Illegal invocation" unless invoked with `this === window`, so the
// global timers are wrapped rather than passed as bare object properties.
function createDefaultTimer(): SetupTimer {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export type SetupConfirm = () => Promise<boolean>;
export type SetupPersist = (interpreterPath: string) => Promise<void>;
export type SetupProbe = (interpreterPath: string) => Promise<InterpreterProbeResult>;
export type SetupLog = (line: string) => void;
export type SetupStateListener = (state: RuntimeSetupState) => void;

export interface RuntimeSetupOptions {
  /** A bootstrap-capable interpreter selected by checkpoint-1 discovery (supported version + venv/ensurepip). */
  bootstrapInterpreterPath: string;
  appSupportRoot: string;
  requirementsFileContents: string;
  requirementsFilePath: string;
  fs: SetupFs;
  spawner: SetupSpawner;
  confirm: SetupConfirm;
  persist: SetupPersist;
  /** Verifies an interpreter using checkpoint-1's probe + Mindmap-specific structured preflight. */
  probe: SetupProbe;
  timer?: SetupTimer;
  log?: SetupLog;
  onStateChange?: SetupStateListener;
  venvTimeoutMs?: number;
  installTimeoutMs?: number;
  /** Clock used to name the stale-runtime backup directory during promotion. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_VENV_TIMEOUT_MS = 60_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Bounded process execution
// ---------------------------------------------------------------------------

export type ManagedProcessOutcome =
  | { kind: "ok" }
  | { kind: "exit-error"; exitCode: number | null }
  | { kind: "spawn-error"; code: string }
  | { kind: "timeout" }
  | { kind: "cancelled" };

function isStagingRoot(appSupportRoot: string, fingerprint: string, targetPath: string): boolean {
  const expected = getManagedStagingDir(appSupportRoot, fingerprint);
  return path.normalize(targetPath) === path.normalize(expected) && isWithinManagedRuntimeRoot(appSupportRoot, targetPath);
}

/** Returns the stale-backup path for `finalDir`, or null if it would fall outside the managed runtime root. */
export function buildStaleBackupDir(appSupportRoot: string, finalDir: string, timestamp: number): string | null {
  const candidate = `${finalDir}.stale-${timestamp}`;
  return isWithinManagedRuntimeRoot(appSupportRoot, candidate) ? candidate : null;
}

/**
 * Runs one managed setup job at a time (`start()` coalesces concurrent calls
 * into the in-flight job's promise). All child processes are started via
 * argument-array `SetupSpawner` calls only — no shell, no interpolated
 * command strings. Diagnostics surfaced through `state.message` and `log`
 * are always plugin-constructed (phase name, exit code, spawn error code,
 * timeout) and never include raw stdout/stderr from a child process, which
 * may otherwise echo environment values back into settings or logs.
 */
export class RuntimeSetupController {
  private readonly appSupportRoot: string;
  private readonly fingerprint: string;
  private readonly finalDir: string;
  private readonly finalInterpreter: string;
  private readonly stagingDir: string;
  private readonly timer: SetupTimer;
  private readonly now: () => number;

  private state: RuntimeSetupState = initialState();
  private activeJob: Promise<RuntimeSetupState> | null = null;
  private cancelRequested = false;
  private disposed = false;
  private currentChild: SetupChildProcess | null = null;
  private currentProcessSettle: ((outcome: ManagedProcessOutcome) => void) | null = null;

  constructor(private readonly options: RuntimeSetupOptions) {
    this.appSupportRoot = options.appSupportRoot;
    this.fingerprint = computeRequirementsFingerprint(options.requirementsFileContents);
    this.finalDir = getManagedRuntimeDir(this.appSupportRoot, this.fingerprint);
    this.finalInterpreter = getManagedInterpreterPath(this.appSupportRoot, this.fingerprint);
    this.stagingDir = getManagedStagingDir(this.appSupportRoot, this.fingerprint);
    this.timer = options.timer ?? createDefaultTimer();
    this.now = options.now ?? Date.now;
  }

  getState(): RuntimeSetupState {
    return { ...this.state };
  }

  /** Coalesces concurrent calls: a job already in flight is returned as-is. */
  start(): Promise<RuntimeSetupState> {
    if (this.disposed) return Promise.resolve({ ...this.state });
    if (this.activeJob) return this.activeJob;

    this.cancelRequested = false;
    const job = this.runJob().finally(() => {
      if (this.activeJob === job) this.activeJob = null;
    });
    this.activeJob = job;
    return job;
  }

  /** Alias for `start()` used after a failed run once `state.canRetry` is true. */
  retry(): Promise<RuntimeSetupState> {
    return this.start();
  }

  /**
   * Terminates the owned child process, if any, and marks the run for
   * cancellation. Also force-settles any in-flight managed process
   * immediately: a killed child is not guaranteed to ever emit `close` or
   * `error` (or to emit it promptly), so `start()` must not depend on that
   * to resolve.
   */
  cancel(): void {
    this.cancelRequested = true;
    this.currentChild?.kill();
    this.currentProcessSettle?.({ kind: "cancelled" });
  }

  /** Plugin unload: cancels any in-flight run and suppresses all further state updates. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private log(line: string): void {
    try {
      this.options.log?.(`[runtime-setup] ${line}`);
    } catch {
      // A broken consumer log handler must never break the installer.
    }
  }

  private applyState(next: RuntimeSetupState): RuntimeSetupState {
    const snapshot = { ...next };
    this.state = snapshot;
    if (!this.disposed) {
      try {
        this.options.onStateChange?.({ ...snapshot });
      } catch {
        // A broken consumer state-change handler must never corrupt installer state.
      }
    }
    return { ...snapshot };
  }

  private setState(patch: Partial<RuntimeSetupState>): RuntimeSetupState {
    return this.applyState({ ...this.state, ...patch });
  }

  private isCancelled(): boolean {
    return this.cancelRequested || this.disposed;
  }

  private finishCancelled(): RuntimeSetupState {
    this.log("phase=cancelled");
    return this.applyState({ phase: "cancelled", message: "Mindmap runtime setup was cancelled.", canRetry: true, canCancel: false });
  }

  private finishFailed(message: string): RuntimeSetupState {
    this.log(`phase=failed message=${message}`);
    return this.applyState({ phase: "failed", message, canRetry: true, canCancel: false });
  }

  private finishReady(interpreterPath: string, message: string): RuntimeSetupState {
    this.log("phase=ready");
    return this.applyState({ phase: "ready", interpreterPath, message, canRetry: false, canCancel: false });
  }

  private async resetStagingDir(): Promise<boolean> {
    if (!isStagingRoot(this.appSupportRoot, this.fingerprint, this.stagingDir)) return false;
    try {
      if (this.options.fs.existsSync(this.stagingDir)) {
        await this.options.fs.rm(this.stagingDir);
      }
      await this.options.fs.mkdir(this.stagingDir);
      return true;
    } catch {
      return false;
    }
  }

  private async removeStagingDirBestEffort(): Promise<void> {
    if (!isStagingRoot(this.appSupportRoot, this.fingerprint, this.stagingDir)) return;
    try {
      if (this.options.fs.existsSync(this.stagingDir)) {
        await this.options.fs.rm(this.stagingDir);
      }
    } catch {
      // Best effort only; cleanup failures must never mask the original error.
    }
  }

  private runManagedProcess(command: string, args: string[], timeoutMs: number): Promise<ManagedProcessOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle: unknown = null;

      const finish = (outcome: ManagedProcessOutcome) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== null) this.timer.clearTimeout(timeoutHandle);
        if (this.currentChild === child) this.currentChild = null;
        if (this.currentProcessSettle === finish) this.currentProcessSettle = null;
        resolve(outcome);
      };

      this.currentProcessSettle = finish;

      // A synchronously throwing spawner (e.g. an injected fake, or a real
      // spawn() failure surfaced synchronously) must resolve like any other
      // spawn failure, never reject this promise and crash the run.
      let child: SetupChildProcess;
      try {
        child = this.options.spawner(command, args);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        finish({ kind: "spawn-error", code: typeof code === "string" ? code : "spawn-error" });
        return;
      }
      this.currentChild = child;

      // Output is intentionally never captured into logs or state: it may
      // otherwise echo environment values, secrets, or note content back
      // through diagnostics.
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", () => undefined);

      child.on("error", (error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        finish({ kind: "spawn-error", code: typeof code === "string" ? code : "spawn-error" });
      });

      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : null;
        finish(exitCode === 0 ? { kind: "ok" } : { kind: "exit-error", exitCode });
      });

      timeoutHandle = this.timer.setTimeout(() => {
        child.kill();
        finish({ kind: "timeout" });
      }, timeoutMs);
    });
  }

  private describeOutcome(phaseLabel: string, outcome: ManagedProcessOutcome): string {
    switch (outcome.kind) {
      case "spawn-error":
        return `${phaseLabel} could not start (${outcome.code}).`;
      case "timeout":
        return `${phaseLabel} timed out.`;
      case "exit-error":
        return `${phaseLabel} exited with status ${String(outcome.exitCode)}.`;
      case "cancelled":
        return `${phaseLabel} was cancelled.`;
      default:
        return `${phaseLabel} succeeded.`;
    }
  }

  /** Renames `finalDir` out of the way (if present) so promotion never overwrites onto a non-empty directory or deletes it. */
  private async promoteStagingToFinal(): Promise<{ ok: boolean; message?: string }> {
    let staleBackupDir: string | null = null;

    if (this.options.fs.existsSync(this.finalDir)) {
      const candidateBackupDir = buildStaleBackupDir(this.appSupportRoot, this.finalDir, this.now());
      if (!candidateBackupDir) {
        return { ok: false, message: "Refused to move the existing Mindmap runtime aside: the computed backup path was outside the managed runtime root." };
      }
      staleBackupDir = candidateBackupDir;
      try {
        await this.options.fs.rename(this.finalDir, staleBackupDir);
      } catch {
        return { ok: false, message: "Could not move the existing Mindmap runtime aside before installing the new one." };
      }
    }

    try {
      await this.options.fs.rename(this.stagingDir, this.finalDir);
    } catch {
      if (staleBackupDir) {
        try {
          await this.options.fs.rename(staleBackupDir, this.finalDir);
        } catch {
          // Best effort only; the previous runtime remains under the backup name for recovery.
        }
      }
      return { ok: false, message: "Could not activate the newly installed Mindmap runtime." };
    }

    return { ok: true };
  }

  private async reuseExistingFinalRuntimeIfReady(): Promise<RuntimeSetupState | null> {
    if (!this.options.fs.existsSync(this.finalInterpreter)) return null;

    let probeResult: InterpreterProbeResult;
    try {
      probeResult = await this.options.probe(this.finalInterpreter);
    } catch {
      if (this.isCancelled()) return this.finishCancelled();
      return this.finishFailed("Could not verify the existing Mindmap runtime.");
    }
    if (this.isCancelled()) return this.finishCancelled();
    if (probeResult.classification !== "ready") return null;

    try {
      await this.options.persist(this.finalInterpreter);
    } catch {
      return this.finishFailed("The existing Mindmap runtime is verified, but saving it as the active interpreter failed. It remains available for rediscovery.");
    }
    if (this.isCancelled()) return this.finishCancelled();

    return this.finishReady(this.finalInterpreter, "Existing verified Mindmap runtime reused. No network access was needed.");
  }

  private async runJob(): Promise<RuntimeSetupState> {
    this.log(`phase=discovering fingerprint=${this.fingerprint}`);

    const reused = await this.reuseExistingFinalRuntimeIfReady();
    if (reused) return reused;
    if (this.isCancelled()) return this.finishCancelled();

    this.setState({ phase: "confirming", message: "Waiting for confirmation before downloading the Mindmap runtime.", canRetry: false, canCancel: true });
    let confirmed: boolean;
    try {
      confirmed = await this.options.confirm();
    } catch {
      if (this.isCancelled()) return this.finishCancelled();
      return this.finishFailed("Could not get confirmation before installing the Mindmap runtime.");
    }
    if (this.isCancelled()) return this.finishCancelled();
    if (!confirmed) {
      return this.applyState({ phase: "setup-required", message: "Mindmap runtime setup requires explicit confirmation before network access.", canRetry: true, canCancel: false });
    }

    this.setState({ phase: "creating", message: "Preparing a private Mindmap runtime environment.", canRetry: false, canCancel: true });
    const stagingReady = await this.resetStagingDir();
    if (this.isCancelled()) {
      await this.removeStagingDirBestEffort();
      return this.finishCancelled();
    }
    if (!stagingReady) {
      return this.finishFailed("Could not prepare a private staging location for the Mindmap runtime.");
    }

    const stagingVenvDir = path.join(this.stagingDir, "venv");
    const venvOutcome = await this.runManagedProcess(this.options.bootstrapInterpreterPath, ["-m", "venv", stagingVenvDir], this.options.venvTimeoutMs ?? DEFAULT_VENV_TIMEOUT_MS);
    if (this.isCancelled()) {
      await this.removeStagingDirBestEffort();
      return this.finishCancelled();
    }
    if (venvOutcome.kind !== "ok") {
      return this.finishFailed(this.describeOutcome("Creating the Mindmap runtime environment", venvOutcome));
    }

    this.setState({ phase: "installing", message: "Installing pinned Mindmap packages. This may take several minutes.", canRetry: false, canCancel: true });
    const stagingInterpreter = path.join(stagingVenvDir, "bin", "python3");
    const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", this.options.requirementsFilePath];
    const pipOutcome = await this.runManagedProcess(stagingInterpreter, pipArgs, this.options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS);
    if (this.isCancelled()) {
      await this.removeStagingDirBestEffort();
      return this.finishCancelled();
    }
    if (pipOutcome.kind !== "ok") {
      return this.finishFailed(this.describeOutcome("Installing Mindmap packages", pipOutcome));
    }

    this.setState({ phase: "verifying", message: "Verifying the new Mindmap runtime.", canRetry: false, canCancel: true });
    let verifyResult: InterpreterProbeResult;
    try {
      verifyResult = await this.options.probe(stagingInterpreter);
    } catch {
      if (this.isCancelled()) {
        await this.removeStagingDirBestEffort();
        return this.finishCancelled();
      }
      return this.finishFailed("The newly installed Mindmap runtime could not be verified.");
    }
    if (this.isCancelled()) {
      await this.removeStagingDirBestEffort();
      return this.finishCancelled();
    }
    if (verifyResult.classification !== "ready") {
      return this.finishFailed("The newly installed Mindmap runtime did not pass verification.");
    }

    const promotion = await this.promoteStagingToFinal();
    if (this.isCancelled() && promotion.ok) {
      // The verified runtime is now the final, discoverable environment; leave
      // it in place for rediscovery rather than deleting a good install.
      return this.finishCancelled();
    }
    if (!promotion.ok) {
      return this.finishFailed(promotion.message ?? "Could not finish installing the Mindmap runtime.");
    }

    try {
      await this.options.persist(this.finalInterpreter);
    } catch {
      return this.finishFailed("The Mindmap runtime installed and verified successfully, but saving it as the active interpreter failed. It remains available for rediscovery.");
    }
    if (this.isCancelled()) return this.finishCancelled();

    return this.finishReady(this.finalInterpreter, "Mindmap runtime is ready.");
  }
}
