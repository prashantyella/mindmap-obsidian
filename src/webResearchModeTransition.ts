export type PersistedWebResearchMode = "off" | "manual" | "automatic-reading";
export type WebResearchModeActivity = "off" | "ready" | "deriving" | "searching" | "writing" | "error";

export interface WebResearchModeSnapshot {
  mode: PersistedWebResearchMode;
  activity: WebResearchModeActivity;
  lastError: string | null;
}

export type WebResearchModeChangeResult = "changed" | "unchanged" | "busy" | "cancelled" | "save-failed";

export function prerequisiteFailureState(previous: WebResearchModeSnapshot, message: string): {
  snapshot: WebResearchModeSnapshot;
  exposeInStatus: boolean;
} {
  if (previous.mode !== "off") return { snapshot: previous, exposeInStatus: false };
  return { snapshot: { ...previous, activity: "error", lastError: message }, exposeInStatus: true };
}

/** Serializes consent/preflight/save so an unsaved transient mode can never start a competing change. */
export class WebResearchModeTransition {
  private changing = false;

  async change(options: {
    target: PersistedWebResearchMode;
    snapshot(): WebResearchModeSnapshot;
    prepare(previous: WebResearchModeSnapshot): Promise<boolean>;
    apply(next: WebResearchModeSnapshot): void;
    persist(): Promise<void>;
  }): Promise<WebResearchModeChangeResult> {
    if (this.changing) return "busy";
    this.changing = true;
    try {
      const previous = options.snapshot();
      if (options.target === previous.mode) return "unchanged";
      if (!(await options.prepare(previous))) return "cancelled";

      options.apply({
        mode: options.target,
        activity: options.target === "off" ? "off" : "ready",
        lastError: null,
      });
      try {
        await options.persist();
      } catch {
        options.apply(previous);
        return "save-failed";
      }
      return "changed";
    } finally {
      this.changing = false;
    }
  }
}
