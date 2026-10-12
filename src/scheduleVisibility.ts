import type { SchedulerMode } from "./settings";
import type { LaunchAgentHealth } from "./launchAgent";

export interface ScheduleVisibility {
  showInterval: boolean;
  showDailyTime: boolean;
  showWeeklyToggle: boolean;
  showWeeklyTime: boolean;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTimeOfDay(value: string): TimeOfDay | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
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
