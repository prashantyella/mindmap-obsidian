export type RunScope = "current" | "all" | "note" | "metadataAll" | "refreshAll" | "rebuildAll";

export interface RunConfirmation {
  title: string;
  message: string;
  confirmText: string;
  confirmClass?: string;
}

export interface RunProfile {
  label: string;
  confirmation?: RunConfirmation;
}

const RUN_PROFILES: Record<Exclude<RunScope, "note">, RunProfile> = {
  current: {
    label: "current scope",
  },
  all: {
    label: "all scopes",
  },
  metadataAll: {
    label: "all scopes metadata refresh",
    confirmation: {
      title: "Run metadata refresh?",
      message: "This rewrites summaries, tags, concepts, and related-note metadata for every all-scope note without rebuilding the vector index.",
      confirmText: "Run metadata refresh",
      confirmClass: "mod-cta",
    },
  },
  refreshAll: {
    label: "all scopes full refresh",
    confirmation: {
      title: "Run full refresh?",
      message: "This regenerates metadata for every all-scope note using the current model and prompt settings.",
      confirmText: "Run full refresh",
      confirmClass: "mod-cta",
    },
  },
  rebuildAll: {
    label: "all scopes full rebuild",
    confirmation: {
      title: "Run full rebuild?",
      message: "This rebuilds the local vector index from the committed generation, then refreshes every all-scope note.",
      confirmText: "Run full rebuild",
      confirmClass: "mod-warning",
    },
  },
};

export function getRunProfile(scope: RunScope, notePath?: string): RunProfile {
  if (scope === "note") {
    if (!notePath) {
      throw new Error("An individual note path is required.");
    }
    return {
      label: `individual note ${notePath}`,
    };
  }
  return RUN_PROFILES[scope];
}
