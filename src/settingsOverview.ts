export type OverviewAction = "openMindmap" | "runChecks";

export interface OverviewInput {
  productionEngineAvailable: boolean;
  scopeComplete: boolean;
  preflightOk: boolean | null;
}

export interface OverviewState {
  ready: boolean;
  message: string;
  actions: OverviewAction[];
}

/**
 * One compact, pure readiness summary for the settings Overview row.
 * Every message here is a fixed, curated string -- never a forwarded
 * guidance/error string from scope or provider config resolution.
 */
export function buildOverviewState(input: OverviewInput): OverviewState {
  if (!input.productionEngineAvailable) {
    return {
      ready: false,
      message: "The Mindmap TypeScript engine is not available. Open Troubleshooting for details.",
      actions: ["openMindmap", "runChecks"],
    };
  }
  if (!input.scopeComplete) {
    return {
      ready: false,
      message: "Scope setup needs attention. Open the Scope section to fix it.",
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
