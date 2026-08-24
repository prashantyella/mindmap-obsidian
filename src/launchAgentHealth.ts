import { shouldOfferLaunchAgentCatchUp, type LaunchAgentHealth } from "./launchAgent";
import { isLaunchAgentSchedulerEnabled } from "./scheduler";
import type { PendingSnapshot } from "./pendingScan";
import type { SchedulerMode } from "./settings";

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

export interface LaunchAgentDetail {
  label: string;
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
  lastExitCode: number | null;
}
