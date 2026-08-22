import {
  discoverRuntime,
  probeInterpreter,
  type DiscoveryEnv,
  type DiscoveryFs,
  type InterpreterProbeResult,
  type PreflightVerifier,
  type ProcessInvoker,
} from "./runtimeDiscovery";
import {
  RuntimeSetupController,
  type RuntimeSetupOptions,
  type RuntimeSetupState,
  type SetupConfirm,
  type SetupFs,
  type SetupLog,
  type SetupPersist,
  type SetupSpawner,
  type SetupTimer,
} from "./runtimeSetup";

// ---------------------------------------------------------------------------
// Public state model
// ---------------------------------------------------------------------------

export type CoordinatorPhase =
  | "not-applicable"
  | "discovering"
  | "ready"
  | "setup-required"
  | "unavailable"
  | "confirming"
  | "creating"
  | "installing"
  | "verifying"
  | "failed"
  | "cancelled";

export interface CoordinatorState {
  phase: CoordinatorPhase;
  message: string;
  /**
   * The best interpreter known so far: the fully verified path once ready,
   * or — while setup-required/confirming/creating/installing/verifying —
   * the bootstrap-capable interpreter discovery found. Read-only workflows
   * (Apple Books preview/import) may use this even while `blocking` is
   * true; anything that needs the full package set must still check
   * `blocking`/phase === "ready".
   */
  interpreterPath: string | null;
  canSetup: boolean;
  canCancel: boolean;
  /** True while manual/scheduled processing, semantic startup, automatic Reading processing, and LaunchAgent installation must stay gated. */
  blocking: boolean;
}

function initialState(): CoordinatorState {
  return { phase: "discovering", message: "Checking for a compatible Mindmap runtime.", interpreterPath: null, canSetup: false, canCancel: false, blocking: true };
}

function readyState(interpreterPath: string, message: string): CoordinatorState {
  return { phase: "ready", message, interpreterPath, canSetup: false, canCancel: false, blocking: false };
}

function notApplicableState(message: string): CoordinatorState {
  return { phase: "not-applicable", message, interpreterPath: null, canSetup: false, canCancel: false, blocking: false };
}

/** Fixed download page for the plugin's "no compatible Python found" guidance. */
export const PYTHON_MACOS_DOWNLOAD_URL = "https://www.python.org/downloads/macos/";

/**
 * Pure decision for the plugin's one-time "runtime just became usable"
 * kickoff (the old unconditional startup preflight/semantic-start calls,
 * plus a syncScheduler() re-sync now that blocking has cleared). Extracted
 * so it is directly testable without instantiating the Obsidian plugin:
 * true only the first time phase reaches "ready" or "not-applicable" after
 * construction, false for every other phase and every later call.
 */
export function shouldTriggerRuntimeReadyKickoff(phase: CoordinatorPhase, alreadyKicked: boolean): boolean {
  return !alreadyKicked && (phase === "ready" || phase === "not-applicable");
}

// Mirrors runtimeSetup.ts's RuntimeSetupPhase onto CoordinatorPhase 1:1 for the phases they share.
const SETUP_PHASE_TO_COORDINATOR_PHASE: Record<RuntimeSetupState["phase"], CoordinatorPhase> = {
  discovering: "discovering",
  "setup-required": "setup-required",
  confirming: "confirming",
  creating: "creating",
  installing: "installing",
  verifying: "verifying",
  ready: "ready",
  failed: "failed",
  cancelled: "cancelled",
};

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface RuntimeCoordinatorOptions {
  /** `process.platform`. Only "darwin" runs automated discovery/setup; every other value preserves the existing manual-override behavior untouched. */
  platform: string;
  pythonCommandSetting: string;
  homeDir: string;
  pathEnv: string;
  arch: "arm64" | "x64";
  appSupportRoot: string;
  requirementsFileContents: string;
  requirementsFilePath: string;
  /** Bundled script/config paths used both for the runtime-specific verifier and for the managed installer's pip target. */
  scriptPath: string;
  configPath: string;
  discoveryFs: DiscoveryFs;
  invoke: ProcessInvoker;
  setupFs: SetupFs;
  spawner: SetupSpawner;
  confirm: SetupConfirm;
  persist: SetupPersist;
  verifyPreflight: PreflightVerifier;
  onStateChange?: (state: CoordinatorState) => void;
  log?: SetupLog;
  timer?: SetupTimer;
  now?: () => number;
  venvTimeoutMs?: number;
  installTimeoutMs?: number;
}

/**
 * Bridges checkpoint-1 discovery and checkpoint-2's RuntimeSetupController
 * into one Obsidian-free, injectable coordinator. Owns exactly the
 * decisions the plugin needs: whether processing must stay gated, whether a
 * managed setup can be offered, and how to drive that setup end to end.
 */
export class RuntimeReadinessCoordinator {
  private state: CoordinatorState = initialState();
  private controller: RuntimeSetupController | null = null;
  private bootstrapInterpreterPath: string | null = null;
  private disposed = false;

  constructor(private readonly options: RuntimeCoordinatorOptions) {}

  getState(): CoordinatorState {
    return { ...this.state };
  }

  private setState(next: CoordinatorState): CoordinatorState {
    if (this.disposed) return { ...this.state };
    this.state = next;
    try {
      this.options.onStateChange?.({ ...next });
    } catch {
      // A broken consumer state-change handler must never corrupt coordinator state.
    }
    return { ...next };
  }

  private log(line: string): void {
    try {
      this.options.log?.(`[runtime-coordinator] ${line}`);
    } catch {
      // A broken consumer log handler must never break discovery/setup.
    }
  }

  /**
   * Bridges a RuntimeSetupState onto CoordinatorState, falling back to the
   * discovered bootstrap interpreter (not yet fully ready) when the setup
   * controller hasn't reported one of its own yet — so read-only Apple
   * Books preview/import can keep using a real interpreter throughout
   * confirming/creating/installing/verifying, not just once ready.
   */
  private fromSetupState(state: RuntimeSetupState): CoordinatorState {
    return {
      phase: SETUP_PHASE_TO_COORDINATOR_PHASE[state.phase],
      message: state.message,
      interpreterPath: state.interpreterPath ?? this.bootstrapInterpreterPath,
      canSetup: state.canRetry,
      canCancel: state.canCancel,
      blocking: state.phase !== "ready",
    };
  }

  /**
   * Runs discovery exactly once. Must complete (or the plugin must treat
   * the state as still "discovering"/blocking) before the caller starts
   * the old preflight/semantic/scheduler startup work, so that work never
   * races a still-blank interpreter.
   */
  async startDiscovery(): Promise<CoordinatorState> {
    if (this.options.platform !== "darwin") {
      return this.setState(notApplicableState("Automated runtime setup runs on macOS only; the configured Python command is used as-is."));
    }

    this.setState(initialState());

    try {
      const env: DiscoveryEnv = {
        homeDir: this.options.homeDir,
        pathEnv: this.options.pathEnv,
        arch: this.options.arch,
        appSupportRoot: this.options.appSupportRoot,
        requirementsFileContents: this.options.requirementsFileContents,
      };

      const result = await discoverRuntime({
        pythonCommandSetting: this.options.pythonCommandSetting,
        env,
        fs: this.options.discoveryFs,
        invoke: this.options.invoke,
        verifyPreflight: this.options.verifyPreflight,
      });

      if (this.disposed) return this.getState();

      if (result.customInterpreterPreserved) {
        // An explicit custom pythonCommand is validated only, never replaced
        // or offered managed setup — the legacy resolveRuntime()/preflight
        // path continues to govern readiness for it.
        return this.setState(notApplicableState("Using the configured custom Python command; automated setup is not offered for explicit overrides."));
      }

      if (result.outcome === "ready" && result.selected) {
        try {
          await this.options.persist(result.selected.path);
        } catch {
          if (this.disposed) return this.getState();
          return this.setState({
            phase: "failed",
            message: "Found a working Mindmap runtime, but saving it failed. It will be rediscovered on next load.",
            interpreterPath: result.selected.path,
            canSetup: true,
            canCancel: false,
            blocking: true,
          });
        }
        if (this.disposed) return this.getState();
        return this.setState(readyState(result.selected.path, "Mindmap runtime is ready."));
      }

      if (result.outcome === "bootstrap-required" && result.bestBootstrap) {
        this.bootstrapInterpreterPath = result.bestBootstrap.path;
        return this.setState({
          phase: "setup-required",
          message: "A compatible Python was found, but Mindmap's packages are not installed yet.",
          interpreterPath: result.bestBootstrap.path,
          canSetup: true,
          canCancel: false,
          blocking: true,
        });
      }

      return this.setState({
        phase: "unavailable",
        message: "No compatible Python 3.11-3.13 was found. Install Python from python.org, then reopen Mindmap settings.",
        interpreterPath: null,
        canSetup: false,
        canCancel: false,
        blocking: true,
      });
    } catch {
      // An unexpected exception anywhere in discovery (a misbehaving
      // injected fs/invoke/persist seam, for example) must never reject
      // this promise and take onload() down with it — fall back to a
      // fixed, safe, still-blocking state instead.
      this.log("startDiscovery failed unexpectedly; falling back to unavailable.");
      if (this.disposed) return this.getState();
      return this.setState({
        phase: "unavailable",
        message: "Mindmap runtime discovery failed unexpectedly. Reopen Mindmap settings to retry, or set an explicit Python path under Advanced settings.",
        interpreterPath: null,
        canSetup: false,
        canCancel: false,
        blocking: true,
      });
    }
  }

  /** Lazily creates the managed installer and starts it. Requires a bootstrap candidate from a prior `startDiscovery()` call. */
  async beginSetup(): Promise<CoordinatorState> {
    if (this.disposed) return this.getState();
    if (!this.bootstrapInterpreterPath) {
      return this.getState();
    }

    if (!this.controller) {
      const setupOptions: RuntimeSetupOptions = {
        bootstrapInterpreterPath: this.bootstrapInterpreterPath,
        appSupportRoot: this.options.appSupportRoot,
        requirementsFileContents: this.options.requirementsFileContents,
        requirementsFilePath: this.options.requirementsFilePath,
        fs: this.options.setupFs,
        spawner: this.options.spawner,
        confirm: this.options.confirm,
        persist: this.options.persist,
        probe: (interpreterPath: string): Promise<InterpreterProbeResult> =>
          probeInterpreter(
            { path: interpreterPath, source: "managed" },
            { invoke: this.options.invoke, verifyPreflight: this.options.verifyPreflight },
          ),
        timer: this.options.timer,
        log: this.options.log,
        onStateChange: (setupState) => this.setState(this.fromSetupState(setupState)),
        venvTimeoutMs: this.options.venvTimeoutMs,
        installTimeoutMs: this.options.installTimeoutMs,
        now: this.options.now,
      };
      this.controller = new RuntimeSetupController(setupOptions);
    }

    const result = await this.controller.start();
    if (this.disposed) return this.getState();
    return this.setState(this.fromSetupState(result));
  }

  /** Alias for `beginSetup()`, used once `state.canSetup` is true after a failed/cancelled run. */
  retry(): Promise<CoordinatorState> {
    return this.beginSetup();
  }

  cancel(): void {
    this.controller?.cancel();
  }

  /** Plugin unload: cancels any in-flight discovery/setup and suppresses all further state updates. */
  dispose(): void {
    this.controller?.dispose();
    this.disposed = true;
  }
}
