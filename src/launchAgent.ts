export const DAILY_LAUNCH_AGENT_LABEL = "com.mindmap.daily";
export const WEEKLY_LAUNCH_AGENT_LABEL = "com.mindmap.weekly";

const LEGACY_LAUNCH_AGENT_LABELS = [DAILY_LAUNCH_AGENT_LABEL, WEEKLY_LAUNCH_AGENT_LABEL] as const;
const MAX_LEGACY_PLIST_BYTES = 64 * 1024;
const MAX_LAUNCHCTL_OUTPUT_BYTES = 256 * 1024;

export interface LegacyLaunchAgentCleanupFs {
  exists(path: string): Promise<boolean>;
  readBoundedWithIdentity(path: string, maxBytes: number): Promise<{ contents: string; identity: string } | null>;
  matchesIdentity(path: string, identity: string): Promise<boolean>;
  rename(fromPath: string, toPath: string): Promise<void>;
}

export interface LegacyLaunchAgentCleanupRunner {
  run(executablePath: string, argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
}

export interface LegacyLaunchAgentCleanupResult {
  label: typeof LEGACY_LAUNCH_AGENT_LABELS[number];
  status: "absent" | "retired" | "foreign" | "ambiguous";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Content ownership check for the two retired 0.2.x Python LaunchAgents. A matching filename alone is never sufficient. */
export function isOwnedLegacyPythonLaunchAgent(contents: string, label: string, pluginDir: string): boolean {
  const expectedLabel = `<key>Label</key>\n\t<string>${label}</string>`;
  const expectedConfig = `<string>${escapeXml(`${pluginDir}/python/config.json`)}</string>`;
  return contents.includes(expectedLabel)
    && contents.includes(expectedConfig)
    && contents.includes("<string>obsidian-plugin-launchagent</string>");
}

function validProcessResult(result: unknown): result is { code: number; stdout: string; stderr: string; timedOut?: boolean } {
  if (typeof result !== "object" || result === null) return false;
  const record = result as Record<string, unknown>;
  return typeof record.code === "number"
    && Number.isSafeInteger(record.code)
    && typeof record.stdout === "string"
    && Buffer.byteLength(record.stdout, "utf8") <= MAX_LAUNCHCTL_OUTPUT_BYTES
    && typeof record.stderr === "string"
    && Buffer.byteLength(record.stderr, "utf8") <= MAX_LAUNCHCTL_OUTPUT_BYTES
    && (record.timedOut === undefined || typeof record.timedOut === "boolean");
}

/**
 * Retires only exact, content-owned 0.2.x Python LaunchAgents for this
 * plugin directory. Each plist is unloaded first, then renamed beside its
 * original path to a non-`.plist` archive. Missing/foreign/ambiguous state
 * is fail-closed and never mutated.
 */
export async function retireLegacyPythonLaunchAgents(options: {
  fs: LegacyLaunchAgentCleanupFs;
  runner: LegacyLaunchAgentCleanupRunner;
  userHomeDir: string;
  pluginDir: string;
  uid: number;
  platform: NodeJS.Platform;
}): Promise<LegacyLaunchAgentCleanupResult[]> {
  if (options.platform !== "darwin" || !Number.isSafeInteger(options.uid) || options.uid < 0) return [];
  const launchAgentsDir = `${options.userHomeDir.replace(/\/+$/, "")}/Library/LaunchAgents`;
  const results: LegacyLaunchAgentCleanupResult[] = [];

  for (const label of LEGACY_LAUNCH_AGENT_LABELS) {
    const plistPath = `${launchAgentsDir}/${label}.plist`;
    const archivePath = `${plistPath}.retired-0.2.0`;
    let present: boolean;
    let archivePresent: boolean;
    try {
      present = await options.fs.exists(plistPath);
      archivePresent = await options.fs.exists(archivePath);
    } catch {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    if (!present) {
      results.push({ label, status: "absent" });
      continue;
    }
    if (archivePresent) {
      results.push({ label, status: "ambiguous" });
      continue;
    }

    let ownedFile: { contents: string; identity: string } | null;
    try {
      ownedFile = await options.fs.readBoundedWithIdentity(plistPath, MAX_LEGACY_PLIST_BYTES);
    } catch {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    if (ownedFile === null) {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    if (!isOwnedLegacyPythonLaunchAgent(ownedFile.contents, label, options.pluginDir)) {
      results.push({ label, status: "foreign" });
      continue;
    }

    let printResult: unknown;
    try {
      printResult = await options.runner.run("/bin/launchctl", ["print", `gui/${options.uid}/${label}`]);
    } catch {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    if (!validProcessResult(printResult) || printResult.timedOut === true) {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    const loaded = printResult.code === 0 && /^\s*state\s*=/im.test(printResult.stdout);
    const absent = printResult.code !== 0 && /could not find service|no such process/i.test(printResult.stderr);
    if (!loaded && !absent) {
      results.push({ label, status: "ambiguous" });
      continue;
    }
    if (loaded) {
      if (!await options.fs.matchesIdentity(plistPath, ownedFile.identity).catch(() => false)) {
        results.push({ label, status: "ambiguous" });
        continue;
      }
      let bootoutResult: unknown;
      try {
        bootoutResult = await options.runner.run("/bin/launchctl", ["bootout", `gui/${options.uid}/${label}`]);
      } catch {
        results.push({ label, status: "ambiguous" });
        continue;
      }
      if (!validProcessResult(bootoutResult) || bootoutResult.timedOut === true || bootoutResult.code !== 0) {
        results.push({ label, status: "ambiguous" });
        continue;
      }
    }
    try {
      if (!await options.fs.matchesIdentity(plistPath, ownedFile.identity)) {
        results.push({ label, status: "ambiguous" });
        continue;
      }
      await options.fs.rename(plistPath, archivePath);
      results.push({ label, status: "retired" });
    } catch {
      results.push({ label, status: "ambiguous" });
    }
  }
  return results;
}

export type LaunchAgentHealth = "waiting" | "healthy" | "running" | "overdue" | "failing" | "disabled";

/** A recovery affordance is useful only when scheduled work is overdue and work remains. */
export function shouldOfferLaunchAgentCatchUp(health: LaunchAgentHealth | null, pendingAll: number): boolean {
  return (health === "overdue" || health === "failing") && Number.isFinite(pendingAll) && pendingAll > 0;
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
