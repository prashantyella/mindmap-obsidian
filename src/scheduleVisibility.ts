import type { SchedulerMode } from "./settings";
import type { LaunchAgentHealth } from "./launchAgent";

export interface ScheduleVisibility {
  showInterval: boolean;
  showDailyTime: boolean;
  showWeeklyToggle: boolean;
  showWeeklyTime: boolean;
}

/** Mode selector is always shown; everything else is conditional on the selected mode alone. */
export function buildScheduleVisibility(mode: SchedulerMode, weeklyEnabled: boolean): ScheduleVisibility {
  return {
    showInterval: mode === "interval",
    showDailyTime: mode === "launchAgent",
    showWeeklyToggle: mode === "launchAgent",
    showWeeklyTime: mode === "launchAgent" && weeklyEnabled,
  };
}

const ACTIONABLE_SCHEDULER_HEALTH = new Set<LaunchAgentHealth>(["overdue", "failing"]);

/** A healthy/waiting LaunchAgent shows no recovery row at all; only overdue/failing is actionable. */
export function isSchedulerRecoveryActionable(mode: SchedulerMode, health: LaunchAgentHealth | null): boolean {
  return mode === "launchAgent" && health !== null && ACTIONABLE_SCHEDULER_HEALTH.has(health);
}
