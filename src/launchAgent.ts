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
