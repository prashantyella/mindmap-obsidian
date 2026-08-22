import type { PreflightResult } from "./diagnostics";
import type { LaunchAgentHealth } from "./launchAgent";

export interface SchedulerSummaryState {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastMessage: string;
  launchAgentMessage: string;
  launchAgentPaths: string[];
  launchAgentHealth: LaunchAgentHealth | null;
  launchAgentLastSuccessfulRunAt: number | null;
  launchAgentLastExitCode: number | null;
  pendingAllCount: number | null;
}

export interface DiagnosticsSummaryState {
  inProgress: boolean;
  lastRunAt: number | null;
  result: PreflightResult | null;
}
