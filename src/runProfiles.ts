export type RunScope = "current" | "all" | "refreshAll" | "rebuildAll";

export interface RunProfile {
  args: string[];
  label: string;
}

const RUN_PROFILES: Record<RunScope, RunProfile> = {
  current: {
    args: ["--current", "--apply"],
    label: "current scope",
  },
  all: {
    args: ["--all", "--apply"],
    label: "all scopes",
  },
  refreshAll: {
    args: ["--all", "--refresh-all", "--apply"],
    label: "all scopes full refresh",
  },
  rebuildAll: {
    args: ["--all", "--refresh-all", "--rebuild", "--apply"],
    label: "all scopes full rebuild",
  },
};

export function getRunProfile(scope: RunScope): RunProfile {
  return RUN_PROFILES[scope];
}
