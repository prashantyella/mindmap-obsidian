import type { SchedulerMode } from "./settings";

export const MIN_SCHEDULER_INTERVAL_MINUTES = 5;

export interface SchedulerConfig {
  mode: SchedulerMode;
  intervalMinutes: number;
}

export interface SchedulerStatus {
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt: number | null;
}

export type SchedulerAction = "run" | "skip-disabled" | "skip-running";

export function normalizeSchedulerInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SCHEDULER_INTERVAL_MINUTES;
  }

  return Math.max(MIN_SCHEDULER_INTERVAL_MINUTES, Math.round(value));
}

export function isSchedulerEnabled(mode: SchedulerMode): boolean {
  return mode === "interval";
}

export function computeNextRunAt(config: SchedulerConfig, now: number): number | null {
  if (!isSchedulerEnabled(config.mode)) {
    return null;
  }

  return now + normalizeSchedulerInterval(config.intervalMinutes) * 60_000;
}

export function getSchedulerAction(config: SchedulerConfig, isRunning: boolean): SchedulerAction {
  if (!isSchedulerEnabled(config.mode)) {
    return "skip-disabled";
  }

  if (isRunning) {
    return "skip-running";
  }

  return "run";
}

export function buildSchedulerStatus(config: SchedulerConfig, nextRunAt: number | null): SchedulerStatus {
  return {
    enabled: isSchedulerEnabled(config.mode),
    intervalMinutes: normalizeSchedulerInterval(config.intervalMinutes),
    nextRunAt: isSchedulerEnabled(config.mode) ? nextRunAt : null,
  };
}

export function formatTimestamp(timestamp: number | null): string {
  if (timestamp === null) {
    return "Not scheduled";
  }

  return new Date(timestamp).toLocaleString();
}
