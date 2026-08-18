import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import {
  buildConfiguredLaunchAgentSpecs,
  classifyLaunchAgentHealth,
  parseLaunchctlPrintOutput,
  shouldOfferLaunchAgentCatchUp,
  type LaunchAgentHealth,
  type LaunchAgentLaunchctlStatus,
  type LaunchAgentSpec,
} from "./launchAgent";
import { formatTimestamp, isLaunchAgentSchedulerEnabled } from "./scheduler";
import type { RuntimeCommand } from "./pathResolver";
import type { PendingSnapshot } from "./pendingScan";
import { getRunProfile } from "./runProfiles";
import type { SchedulerMode } from "./settings";

export interface PluginLaunchAgentSettings {
  launchAgentDailyHour: number;
  launchAgentDailyMinute: number;
  launchAgentWeeklyEnabled: boolean;
  launchAgentWeeklyHour: number;
  launchAgentWeeklyMinute: number;
}

export function getLaunchAgentWorkingDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, "Library", "Application Support", "Mindmap");
}

export function getLaunchAgentLogDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, "Library", "Logs", "Mindmap");
}

export async function ensureLaunchAgentDirectories(specs: LaunchAgentSpec[], homeDirectory: string): Promise<void> {
  const directories = new Set([
    getLaunchAgentWorkingDirectory(homeDirectory),
    getLaunchAgentLogDirectory(homeDirectory),
    ...specs.flatMap((spec) => [path.dirname(spec.stdoutPath), path.dirname(spec.stderrPath)]),
  ]);
  for (const directory of directories) {
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(directory, 0o700);
  }
}

export function buildPluginLaunchAgentSpecs(options: {
  command: RuntimeCommand;
  settings: PluginLaunchAgentSettings;
  plistDirectory: string;
  pathEnvironment: string;
  homeDirectory?: string;
}): LaunchAgentSpec[] {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const logDirectory = getLaunchAgentLogDirectory(homeDirectory);
  return buildConfiguredLaunchAgentSpecs({
    command: options.command,
    plistDirectory: options.plistDirectory,
    logDirectory,
    workingDirectory: getLaunchAgentWorkingDirectory(homeDirectory),
    pathEnvironment: options.pathEnvironment,
    daily: {
      hour: options.settings.launchAgentDailyHour,
      minute: options.settings.launchAgentDailyMinute,
    },
    weeklyEnabled: options.settings.launchAgentWeeklyEnabled,
    weekly: {
      hour: options.settings.launchAgentWeeklyHour,
      minute: options.settings.launchAgentWeeklyMinute,
    },
    dailyArgs: getRunProfile("all").args,
    weeklyArgs: getRunProfile("refreshAll").args,
  });
}

export function getLaunchAgentsDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, "Library", "LaunchAgents");
}

export function getLaunchAgentPlistPath(homeDirectory: string, label: string): string {
  return path.join(getLaunchAgentsDirectory(homeDirectory), `${label}.plist`);
}

export async function isLaunchAgentLoaded(label: string): Promise<boolean> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    execFile("/bin/launchctl", ["print", `gui/${uid}/${label}`], { maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolve(isLaunchctlResultLoaded(error, String(stdout ?? ""), String(stderr ?? "")));
    });
  });
}

export function isLaunchctlResultLoaded(error: Error | null, stdout: string, stderr: string): boolean {
  return error === null && parseLaunchctlPrintOutput(stdout, stderr).loaded;
}

export interface LaunchAgentCatchUpStatus {
  available: boolean;
  message: string;
}

export function buildLaunchAgentCatchUpStatus(
  mode: SchedulerMode,
  health: LaunchAgentHealth | null,
  pending: PendingSnapshot,
): LaunchAgentCatchUpStatus {
  const pendingAll = pending.available ? pending.all.total : 0;
  const available = isLaunchAgentSchedulerEnabled(mode) && shouldOfferLaunchAgentCatchUp(health, pendingAll);
  return {
    available,
    message: available
      ? `The LaunchAgent is ${health}; ${pendingAll} all-scope note${pendingAll === 1 ? "" : "s"} remain pending.`
      : "Catch-up is offered only when the scheduled agent is overdue or failing and all-scope notes are pending.",
  };
}

export interface LaunchAgentObservation {
  label: string;
  launchctl: LaunchAgentLaunchctlStatus;
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
}

export interface LaunchAgentDetail {
  label: string;
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
  lastExitCode: number | null;
}

export interface LaunchAgentHealthSummary {
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
  lastExitCode: number | null;
  message: string;
  details: LaunchAgentDetail[];
}

/** A log mtime is a heartbeat only after the corresponding agent exited successfully. */
export function getSuccessfulRunAt(lastExitCode: number | null, mtimeMs: number | null): number | null {
  return lastExitCode === 0 && mtimeMs !== null && Number.isFinite(mtimeMs) ? mtimeMs : null;
}

export function aggregateLaunchAgentHealth(observations: LaunchAgentObservation[]): LaunchAgentHealthSummary {
  const healthPriority: LaunchAgentHealth[] = ["failing", "overdue", "running", "waiting", "healthy", "disabled"];
  const health = healthPriority.find((candidate) => observations.some((observation) => observation.health === candidate))
    ?? "disabled";
  const lastSuccessfulRunAt = observations.reduce<number | null>(
    (latest, observation) => observation.lastSuccessfulRunAt !== null
      ? Math.max(latest ?? 0, observation.lastSuccessfulRunAt)
      : latest,
    null,
  );
  const failingExit = observations.find((observation) => observation.launchctl.lastExitCode !== null && observation.launchctl.lastExitCode !== 0);
  const lastExitCode = failingExit?.launchctl.lastExitCode ?? observations[0]?.launchctl.lastExitCode ?? null;
  const message = observations
    .map((observation) => {
      const loaded = observation.launchctl.loaded ? "loaded" : "not loaded";
      const exit = observation.launchctl.lastExitCode === null ? "exit unknown" : `exit ${observation.launchctl.lastExitCode}`;
      return `${observation.label}: ${observation.health}, ${loaded}, ${exit}, last success ${formatTimestamp(observation.lastSuccessfulRunAt)}`;
    })
    .join("; ");

  return {
    health,
    lastSuccessfulRunAt,
    lastExitCode,
    message,
    details: observations.map((observation) => ({
      label: observation.label,
      health: observation.health,
      lastSuccessfulRunAt: observation.lastSuccessfulRunAt,
      lastExitCode: observation.launchctl.lastExitCode,
    })),
  };
}

async function readLaunchAgentObservation(
  spec: LaunchAgentSpec,
  uid: number,
): Promise<LaunchAgentObservation> {
  const launchctl = await new Promise<LaunchAgentLaunchctlStatus>((resolve) => {
    execFile(
      "/bin/launchctl",
      ["print", `gui/${uid}/${spec.label}`],
      { maxBuffer: 256 * 1024 },
      (_error, stdout, stderr) => resolve(parseLaunchctlPrintOutput(String(stdout ?? ""), String(stderr ?? ""))),
    );
  });
  let mtimeMs: number | null = null;
  try {
    mtimeMs = (await fs.promises.stat(spec.stdoutPath)).mtimeMs;
  } catch {
    // A missing log means the agent has not recorded a successful run yet.
  }
  let plistMtimeMs: number | null = null;
  try {
    plistMtimeMs = (await fs.promises.stat(spec.plistPath)).mtimeMs;
  } catch {
    // A missing plist is reported as a failing/unloaded agent above.
  }
  const lastSuccessfulRunAt = getSuccessfulRunAt(launchctl.lastExitCode, mtimeMs);

  return {
    label: spec.label,
    launchctl,
    health: classifyLaunchAgentHealth({
      launchctl,
      schedule: spec.startCalendarInterval,
      lastSuccessfulRunAt,
      reconciledAt: plistMtimeMs,
    }),
    lastSuccessfulRunAt,
  };
}

export async function readLaunchAgentHealth(
  specs: LaunchAgentSpec[],
  uid: number,
): Promise<LaunchAgentHealthSummary> {
  return aggregateLaunchAgentHealth(await Promise.all(specs.map((spec) => readLaunchAgentObservation(spec, uid))));
}

export async function readLaunchAgentHealthSafely(
  specs: LaunchAgentSpec[],
  uid: number,
): Promise<LaunchAgentHealthSummary> {
  try {
    return await readLaunchAgentHealth(specs, uid);
  } catch (error) {
    return {
      health: "failing",
      lastSuccessfulRunAt: null,
      lastExitCode: null,
      message: `Health check failed: ${error instanceof Error ? error.message : "LaunchAgent health check failed."}`,
      details: [],
    };
  }
}

export function refreshLaunchAgentHealth(
  specs: LaunchAgentSpec[],
  uid: number,
  onSummary: (summary: LaunchAgentHealthSummary) => void,
): Promise<void> {
  return readLaunchAgentHealthSafely(specs, uid).then(onSummary);
}
