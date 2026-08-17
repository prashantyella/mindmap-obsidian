import path from "node:path";

import type { RuntimeCommand } from "./pathResolver";

export const DAILY_LAUNCH_AGENT_LABEL = "com.mindmap.daily";
export const WEEKLY_LAUNCH_AGENT_LABEL = "com.mindmap.weekly";

export interface ClockTime {
  hour: number;
  minute: number;
}

export interface CalendarInterval extends ClockTime {
  weekday?: number;
}

export interface LaunchAgentLaunchctlStatus {
  loaded: boolean;
  state: string | null;
  lastExitCode: number | null;
}

export type LaunchAgentHealth = "healthy" | "stale" | "failing";

export interface LaunchAgentHealthInput {
  launchctl: LaunchAgentLaunchctlStatus;
  schedule: CalendarInterval | CalendarInterval[];
  lastSuccessfulRunAt: number | null;
  now?: number;
  graceMinutes?: number;
}

export const DEFAULT_LAUNCH_AGENT_GRACE_MINUTES = 15;

export interface LaunchAgentSpec {
  label: string;
  plistPath: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  startCalendarInterval: CalendarInterval | CalendarInterval[];
  environmentVariables: Record<string, string>;
}

export function normalizeHour(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(23, Math.max(0, Math.round(value)));
}

export function normalizeMinute(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(59, Math.max(0, Math.round(value)));
}

export function normalizeClockTime(time: ClockTime): ClockTime {
  return {
    hour: normalizeHour(time.hour),
    minute: normalizeMinute(time.minute),
  };
}

/** Extract the small, useful subset of `launchctl print` output. */
export function parseLaunchctlPrintOutput(output: string, errorOutput = ""): LaunchAgentLaunchctlStatus {
  const text = `${output}\n${errorOutput}`.trim();
  const stateMatch = text.match(/^\s*state\s*=\s*(.+?)\s*$/im);
  const exitMatch = text.match(/^\s*last exit code\s*=\s*(-?\d+)\s*$/im);
  const notLoaded = /could not find service|service not found|unknown service|no such process/i.test(text);

  return {
    loaded: text.length > 0 && !notLoaded,
    state: stateMatch?.[1] ?? null,
    lastExitCode: exitMatch ? Number(exitMatch[1]) : null,
  };
}

function launchAgentWeekday(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function isMatchingWeekday(interval: CalendarInterval, date: Date): boolean {
  return interval.weekday === undefined || interval.weekday === launchAgentWeekday(date);
}

function mostRecentOccurrenceForInterval(interval: CalendarInterval, now: number): number | null {
  if (interval.weekday !== undefined && (interval.weekday < 1 || interval.weekday > 7)) {
    return null;
  }

  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) {
    return null;
  }

  const day = new Date(current);
  day.setHours(0, 0, 0, 0);
  for (let daysAgo = 0; daysAgo <= 7; daysAgo += 1) {
    const candidate = new Date(day);
    candidate.setDate(day.getDate() - daysAgo);
    if (!isMatchingWeekday(interval, candidate)) {
      continue;
    }

    candidate.setHours(normalizeHour(interval.hour), normalizeMinute(interval.minute), 0, 0);
    if (candidate.getTime() <= now) {
      return candidate.getTime();
    }
  }

  return null;
}

/** Return the latest scheduled opportunity at or before `now` in local time. */
export function getMostRecentScheduledOccurrence(
  schedule: CalendarInterval | CalendarInterval[],
  now: number,
): number | null {
  const intervals = Array.isArray(schedule) ? schedule : [schedule];
  const occurrences = intervals
    .map((interval) => mostRecentOccurrenceForInterval(interval, now))
    .filter((occurrence): occurrence is number => occurrence !== null);
  return occurrences.length > 0 ? Math.max(...occurrences) : null;
}

/** Classify a read-only LaunchAgent snapshot against its existing run-log heartbeat. */
export function classifyLaunchAgentHealth(input: LaunchAgentHealthInput): LaunchAgentHealth {
  if (!input.launchctl.loaded || (input.launchctl.lastExitCode !== null && input.launchctl.lastExitCode !== 0)) {
    return "failing";
  }

  if (input.launchctl.state?.toLowerCase() === "running") {
    return "healthy";
  }

  const now = input.now ?? Date.now();
  const expectedAt = getMostRecentScheduledOccurrence(input.schedule, now);
  if (expectedAt === null) {
    return "stale";
  }

  const graceMinutes = Number.isFinite(input.graceMinutes)
    ? Math.max(0, input.graceMinutes ?? DEFAULT_LAUNCH_AGENT_GRACE_MINUTES)
    : DEFAULT_LAUNCH_AGENT_GRACE_MINUTES;
  const heartbeat = input.lastSuccessfulRunAt;
  if (heartbeat !== null && Number.isFinite(heartbeat) && heartbeat >= expectedAt) {
    return "healthy";
  }

  return now <= expectedAt + graceMinutes * 60_000 ? "healthy" : "stale";
}

export function formatClockTime(time: ClockTime): string {
  const normalized = normalizeClockTime(time);
  return `${String(normalized.hour).padStart(2, "0")}:${String(normalized.minute).padStart(2, "0")}`;
}

export function buildDailyCalendarIntervals(time: ClockTime): CalendarInterval[] {
  const normalized = normalizeClockTime(time);
  return [1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    hour: normalized.hour,
    minute: normalized.minute,
  }));
}

export function buildWeeklyCalendarInterval(time: ClockTime): CalendarInterval {
  const normalized = normalizeClockTime(time);
  return {
    weekday: 7,
    hour: normalized.hour,
    minute: normalized.minute,
  };
}

export function buildLaunchAgentProgramArguments(command: RuntimeCommand, extraArgs: string[]): string[] {
  const commandHasPath = path.isAbsolute(command.command) || command.command.includes("/") || command.command.includes("\\");
  const launcher = commandHasPath ? [command.command] : ["/usr/bin/env", command.command];
  return [...launcher, ...command.args, ...extraArgs];
}

export function buildLaunchAgentSpec(options: {
  label: string;
  plistPath: string;
  command: RuntimeCommand;
  extraArgs: string[];
  stdoutPath: string;
  stderrPath: string;
  startCalendarInterval: CalendarInterval | CalendarInterval[];
  pathEnvironment: string;
}): LaunchAgentSpec {
  return {
    label: options.label,
    plistPath: options.plistPath,
    programArguments: buildLaunchAgentProgramArguments(options.command, options.extraArgs),
    workingDirectory: options.command.cwd,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
    startCalendarInterval: options.startCalendarInterval,
    environmentVariables: {
      PATH: options.pathEnvironment,
      MINDMAP_RUN_SOURCE: "obsidian-plugin-launchagent",
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plistString(value: string, indent: string): string {
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function plistInteger(value: number, indent: string): string {
  return `${indent}<integer>${value}</integer>`;
}

function plistKey(key: string, indent: string): string {
  return `${indent}<key>${escapeXml(key)}</key>`;
}

function renderStringArray(values: string[], indent: string): string {
  const innerIndent = `${indent}\t`;
  return [
    `${indent}<array>`,
    ...values.map((value) => plistString(value, innerIndent)),
    `${indent}</array>`,
  ].join("\n");
}

function renderStringDict(values: Record<string, string>, indent: string): string {
  const innerIndent = `${indent}\t`;
  const lines = [`${indent}<dict>`];
  for (const key of Object.keys(values).sort()) {
    lines.push(plistKey(key, innerIndent));
    lines.push(plistString(values[key], innerIndent));
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

function renderCalendarInterval(interval: CalendarInterval, indent: string): string {
  const lines = [`${indent}<dict>`];
  const innerIndent = `${indent}\t`;
  lines.push(plistKey("Hour", innerIndent));
  lines.push(plistInteger(normalizeHour(interval.hour), innerIndent));
  lines.push(plistKey("Minute", innerIndent));
  lines.push(plistInteger(normalizeMinute(interval.minute), innerIndent));
  if (interval.weekday !== undefined) {
    lines.push(plistKey("Weekday", innerIndent));
    lines.push(plistInteger(interval.weekday, innerIndent));
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

function renderCalendarIntervals(intervals: CalendarInterval | CalendarInterval[], indent: string): string {
  if (!Array.isArray(intervals)) {
    return renderCalendarInterval(intervals, indent);
  }

  const innerIndent = `${indent}\t`;
  return [
    `${indent}<array>`,
    ...intervals.map((interval) => renderCalendarInterval(interval, innerIndent)),
    `${indent}</array>`,
  ].join("\n");
}

export function buildLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const indent = "\t";
  const valueIndent = "\t";
  const lines = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    plistKey("Label", indent),
    plistString(spec.label, valueIndent),
    plistKey("ProgramArguments", indent),
    renderStringArray(spec.programArguments, valueIndent),
    plistKey("WorkingDirectory", indent),
    plistString(spec.workingDirectory, valueIndent),
    plistKey("StandardOutPath", indent),
    plistString(spec.stdoutPath, valueIndent),
    plistKey("StandardErrorPath", indent),
    plistString(spec.stderrPath, valueIndent),
    plistKey("EnvironmentVariables", indent),
    renderStringDict(spec.environmentVariables, valueIndent),
    plistKey("StartCalendarInterval", indent),
    renderCalendarIntervals(spec.startCalendarInterval, valueIndent),
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}
