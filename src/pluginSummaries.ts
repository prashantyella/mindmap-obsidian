import type { PreflightResult } from "./diagnostics";
import type { ScopeSetupStatus } from "./pluginConfig";
import type { PendingSnapshot } from "./pendingScan";
import {
  buildSchedulerStatus,
  formatTimestamp,
  isLaunchAgentSchedulerEnabled,
  type SchedulerConfig,
} from "./scheduler";

export interface SchedulerSummaryState {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastMessage: string;
  launchAgentMessage: string;
  launchAgentPaths: string[];
}

export interface DiagnosticsSummaryState {
  inProgress: boolean;
  lastRunAt: number | null;
  result: PreflightResult | null;
}

export function buildSchedulerSummary(
  config: SchedulerConfig,
  state: SchedulerSummaryState,
  currentProcessActive: boolean,
  dailyLabel: string,
  weeklyLabel: string,
): DocumentFragment {
  const status = buildSchedulerStatus(config, state.nextRunAt);
  const fragment = document.createDocumentFragment();
  fragment.appendText(`Mode: ${config.mode}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Internal scheduler enabled: ${status.enabled ? "Yes" : "No"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Interval: ${status.intervalMinutes} minutes`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`LaunchAgent scheduler enabled: ${isLaunchAgentSchedulerEnabled(config.mode) ? "Yes" : "No"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(dailyLabel);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(weeklyLabel);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Next run: ${formatTimestamp(status.nextRunAt)}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Last result: ${state.lastMessage}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`LaunchAgent status: ${state.launchAgentMessage}`);
  if (state.launchAgentPaths.length > 0) {
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`LaunchAgent files: ${state.launchAgentPaths.join(", ")}`);
  }
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Active run: ${currentProcessActive ? "Yes" : "No"}`);
  if (state.lastRunAt !== null) {
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Last run at: ${formatTimestamp(state.lastRunAt)}`);
  }
  return fragment;
}

export function buildPendingSummary(snapshot: PendingSnapshot): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!snapshot.available) {
    fragment.appendText(`Pending scan unavailable: ${snapshot.reason}`);
    return fragment;
  }

  fragment.appendText(`Current scope: ${snapshot.current.total} pending`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`All scopes: ${snapshot.all.total} pending`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Top current items: ${snapshot.current.items.join(", ") || "None"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Top all items: ${snapshot.all.items.join(", ") || "None"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(
    `Last scan: ${snapshot.metrics.durationMs}ms, listed ${snapshot.metrics.filesListed}, rescanned ${snapshot.metrics.filesScanned}, updated ${snapshot.metrics.filesUpdated}`,
  );
  return fragment;
}

export function buildScopeSetupSummary(status: ScopeSetupStatus): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.appendText(`Configured: ${status.complete ? "Yes" : "No"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Config: ${status.configPath ?? "Unavailable"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Current scope: ${status.currentPaths.join(", ") || "None"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`All scopes: ${status.allPaths.join(", ") || "None"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(status.guidance);
  return fragment;
}

export function buildDiagnosticsSummary(
  diagnosticsState: DiagnosticsSummaryState,
  recentLogLines: string[],
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const { result, inProgress, lastRunAt } = diagnosticsState;

  fragment.appendText(`Preflight running: ${inProgress ? "Yes" : "No"}`);
  fragment.appendChild(document.createElement("br"));
  fragment.appendText(`Last preflight: ${formatTimestamp(lastRunAt)}`);

  if (!result) {
    fragment.appendChild(document.createElement("br"));
    fragment.appendText("No preflight result recorded yet.");
  } else {
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Status: ${result.ok ? "Ready" : "Not ready"}`);
    fragment.appendChild(document.createElement("br"));
    fragment.appendText(`Summary: ${result.summary}`);
    for (const check of result.checks) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(`[${check.status}] ${check.label}: ${check.message}`);
      if (check.guidance) {
        fragment.appendChild(document.createElement("br"));
        fragment.appendText(`Guidance: ${check.guidance}`);
      }
    }
  }

  const recent = recentLogLines.slice(-6);
  if (recent.length > 0) {
    fragment.appendChild(document.createElement("br"));
    fragment.appendText("Recent diagnostics:");
    for (const line of recent) {
      fragment.appendChild(document.createElement("br"));
      fragment.appendText(line);
    }
  }

  return fragment;
}
