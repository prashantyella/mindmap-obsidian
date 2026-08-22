export type OverviewAction = "openMindmap" | "runChecks" | "setupRuntime" | "cancelSetup" | "openPythonDownload";

export interface OverviewRuntimeSetup {
  phase: string;
  message: string;
  canSetup: boolean;
  canCancel: boolean;
}

export interface OverviewInput {
  runtimeValid: boolean;
  runtimeSetup: OverviewRuntimeSetup | null;
  scopeCanManage: boolean;
  providerCanManage: boolean;
  preflightOk: boolean | null;
}

export interface OverviewState {
  ready: boolean;
  message: string;
  actions: OverviewAction[];
}

const RUNTIME_SETUP_HEALTHY_PHASES = new Set(["not-applicable", "ready"]);

/**
 * One compact, pure readiness summary for the settings Overview row.
 *
 * Every message here is a fixed, curated string (or the runtime-setup
 * coordinator's own already-curated progress message) rather than a
 * forwarded guidance/error string from scope or provider config resolution
 * -- those can legitimately embed a resolved vault-relative or absolute
 * path (e.g. "scriptPath does not exist: /Users/.../mindmap.py", or an
 * fs ENOENT message), which Overview must never render.
 */
export function buildOverviewState(input: OverviewInput): OverviewState {
  const setup = input.runtimeSetup;
  if (setup && !RUNTIME_SETUP_HEALTHY_PHASES.has(setup.phase)) {
    const actions: OverviewAction[] = ["openMindmap"];
    if (setup.canSetup) actions.push("setupRuntime");
    if (setup.canCancel) actions.push("cancelSetup");
    // "unavailable" (no compatible Python found) leaves canSetup/canCancel
    // both false -- without this, the user would be stranded with no
    // recovery action at all beyond Open Mindmap.
    if (setup.phase === "unavailable") actions.push("openPythonDownload");
    return { ready: false, message: setup.message, actions };
  }

  if (!input.runtimeValid) {
    return {
      ready: false,
      message: "Mindmap runtime needs attention. Open Troubleshooting for details.",
      actions: ["openMindmap", "runChecks"],
    };
  }
  if (!input.scopeCanManage) {
    return {
      ready: false,
      message: "Scope setup needs attention. Open the Scope section to fix it.",
      actions: ["openMindmap"],
    };
  }
  if (!input.providerCanManage) {
    return {
      ready: false,
      message: "Local AI provider setup needs attention. Open the Local AI section to fix it.",
      actions: ["openMindmap"],
    };
  }
  if (input.preflightOk === null) {
    return {
      ready: false,
      message: "Run checks to finish setup.",
      actions: ["openMindmap", "runChecks"],
    };
  }
  if (input.preflightOk === false) {
    return {
      ready: false,
      message: "Preflight checks failed. Run checks to see details.",
      actions: ["openMindmap", "runChecks"],
    };
  }

  return { ready: true, message: "Ready.", actions: ["openMindmap"] };
}
