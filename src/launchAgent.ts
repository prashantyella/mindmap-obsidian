export const DAILY_LAUNCH_AGENT_LABEL = "com.mindmap.daily";
export const WEEKLY_LAUNCH_AGENT_LABEL = "com.mindmap.weekly";

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
