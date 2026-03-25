export type RunScope = "current" | "all";

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
};

export function getRunProfile(scope: RunScope): RunProfile {
  return RUN_PROFILES[scope];
}
