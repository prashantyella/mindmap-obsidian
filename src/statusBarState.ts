import type { IconName } from "obsidian";

import { DAILY_LAUNCH_AGENT_LABEL, WEEKLY_LAUNCH_AGENT_LABEL, type LaunchAgentHealth } from "./launchAgent";

export interface StatusBarSchedulerDetail {
  label: string;
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
}

export interface StatusBarMenuState {
  pendingAvailable: boolean;
  currentPending: number;
  allPending: number;
  pendingPaths: string[];
  running: boolean;
  runStatus: string | null;
  preflightInProgress: boolean;
  preflightOk: boolean | null;
  scopeReady: boolean;
  schedulerMode: string;
  schedulerHealth: LaunchAgentHealth | null;
  schedulerDetails: StatusBarSchedulerDetail[];
  semanticState: string;
}

export interface StatusBarStateInput {
  pending: {
    available: boolean;
    current: { total: number; items: string[] };
    all: { total: number; items: string[] };
  };
  running: boolean;
  runStatus: string | null;
  preflightInProgress: boolean;
  preflightOk: boolean | null;
  scopeReady: boolean;
  schedulerMode: string;
  schedulerHealth: LaunchAgentHealth | null;
  schedulerDetails: StatusBarSchedulerDetail[];
  schedulerEnabled: boolean;
  weeklyEnabled: boolean;
  semanticState: string;
}

export interface StatusSummaryInput {
  ready: boolean;
  pendingAvailable: boolean;
  currentPending: number;
  allPending: number;
  preflightInProgress: boolean;
  preflightOk: boolean | null;
  schedulerMode: string;
  schedulerDetails: StatusBarSchedulerDetail[];
}

export function buildStatusSummary(input: StatusSummaryInput): string {
  const readiness = input.ready ? "ready" : "not ready";
  const pending = input.pendingAvailable
    ? `${input.currentPending} current / ${input.allPending} all-scope pending`
    : "pending unavailable";
  const preflight = input.preflightInProgress
    ? "running"
    : input.preflightOk === null
      ? "not run"
      : input.preflightOk
        ? "ready"
        : "failed";
  const scheduler = input.schedulerMode === "launchAgent"
    ? input.schedulerDetails.map((detail) => `${detail.label}: ${detail.health}`).join(", ")
    : input.schedulerMode === "interval"
      ? "Interval: enabled"
      : "Daily: disabled, Weekly: disabled";
  return `Mindmap status: Readiness: ${readiness}. Pending: ${pending}. Preflight: ${preflight}. Scheduler: ${scheduler}.`;
}

export function buildStatusBarMenuState(input: StatusBarStateInput): StatusBarMenuState {
  const details = new Map(input.schedulerDetails.map((detail) => [detail.label, detail]));
  const schedulerDetail = (label: string, title: string, enabled: boolean): StatusBarSchedulerDetail => ({
    label: title,
    health: enabled ? details.get(label)?.health ?? "waiting" : "disabled",
    lastSuccessfulRunAt: details.get(label)?.lastSuccessfulRunAt ?? null,
  });
  return {
    pendingAvailable: input.pending.available,
    currentPending: input.pending.current.total,
    allPending: input.pending.all.total,
    pendingPaths: [...new Set([...input.pending.current.items, ...input.pending.all.items])].slice(0, 5),
    running: input.running,
    runStatus: input.runStatus,
    preflightInProgress: input.preflightInProgress,
    preflightOk: input.preflightOk,
    scopeReady: input.scopeReady,
    schedulerMode: input.schedulerMode,
    schedulerHealth: input.schedulerHealth,
    schedulerDetails: [
      schedulerDetail(DAILY_LAUNCH_AGENT_LABEL, "Daily", input.schedulerEnabled),
      schedulerDetail(WEEKLY_LAUNCH_AGENT_LABEL, "Weekly", input.schedulerEnabled && input.weeklyEnabled),
    ],
    semanticState: input.semanticState,
  };
}

export interface StatusBarMenuActions {
  runCurrent(): void | Promise<void>;
  runAll(): void | Promise<void>;
  runPreflight(): void | Promise<void>;
  openNote(path: string): void | Promise<void>;
  openMindmap(): void | Promise<void>;
  openSettings(): void;
}

export interface StatusBarPresentation {
  label: string;
  ariaLabel: string;
  title: string;
  icon: IconName;
  running: boolean;
  actionable: boolean;
}

const ACTIONABLE_HEALTH = new Set<LaunchAgentHealth>(["overdue", "failing"]);

function healthLabel(health: LaunchAgentHealth): string {
  return health[0].toUpperCase() + health.slice(1);
}

export function buildStatusBarPresentation(state: StatusBarMenuState): StatusBarPresentation {
  const schedulerActionable = state.schedulerHealth !== null && ACTIONABLE_HEALTH.has(state.schedulerHealth);
  const actionable = state.preflightOk === false || !state.scopeReady || schedulerActionable;
  const label = state.running
    ? "Mindmap · running"
    : state.preflightInProgress
      ? "Mindmap · checking"
      : state.pendingAvailable
        ? `Mindmap · ${state.currentPending}`
        : "Mindmap · —";
  const attention = state.preflightOk === false
    ? "preflight failed"
    : !state.scopeReady
      ? "scope setup required"
      : schedulerActionable
        ? `scheduler ${state.schedulerHealth}`
        : state.currentPending > 0
          ? `${state.currentPending} pending note${state.currentPending === 1 ? "" : "s"}`
          : "ready";
  const status = state.running && state.runStatus ? state.runStatus : attention;
  const ariaLabel = `Mindmap standard mode: ${status}. ${state.pendingAvailable ? `${state.currentPending} current-scope pending, ${state.allPending} all-scope pending.` : "Pending scan unavailable."} Activate to open the Mindmap menu.`;
  return {
    label,
    ariaLabel,
    title: ariaLabel,
    icon: state.running ? "loader-circle" : actionable ? "triangle-alert" : "orbit",
    running: state.running,
    actionable,
  };
}

export interface StatusBarMenuItemDescriptor {
  title: string;
  icon?: IconName;
  disabled?: boolean;
  checked?: boolean;
  action?: keyof StatusBarMenuActions;
  path?: string;
  label?: boolean;
}

export function buildStatusBarMenuItems(state: StatusBarMenuState): StatusBarMenuItemDescriptor[] {
  const items: StatusBarMenuItemDescriptor[] = [
    { title: "Mode", label: true },
    { title: "Standard Mode", icon: "orbit", checked: true },
    { title: "Queue", label: true },
    {
      title: state.running ? `Run active${state.runStatus ? `: ${state.runStatus}` : ""}` : "Run current scope",
      icon: state.running ? "loader-circle" : "play",
      disabled: state.running || !state.scopeReady,
      action: state.running ? undefined : "runCurrent",
    },
    {
      title: state.pendingAvailable ? `Process all pending notes (${state.allPending})` : "Process all pending notes (unavailable)",
      icon: "list-checks",
      disabled: state.running || !state.scopeReady || !state.pendingAvailable || state.allPending === 0,
      action: "runAll",
    },
    {
      title: state.pendingAvailable ? `Current scope: ${state.currentPending} pending` : "Pending scan unavailable",
      disabled: true,
    },
    ...state.pendingPaths.map((path) => ({ title: `Open ${path}`, icon: "file-text" as IconName, path, action: "openNote" as const })),
    { title: "Reading", label: true },
    { title: "Reading Mode is not enabled", icon: "book-open", disabled: true },
    { title: "Web Research", label: true },
    { title: "Web Research is off in Standard Mode", icon: "globe-2", disabled: true },
    { title: "Health", label: true },
    {
      title: state.preflightInProgress ? "Preflight is running" : state.preflightOk === false ? "Run preflight (failed)" : "Run preflight checks",
      icon: state.preflightOk === false ? "triangle-alert" : "shield-check",
      disabled: state.preflightInProgress,
      action: "runPreflight",
    },
    { title: `Scheduler: ${state.schedulerMode}`, disabled: true },
    ...state.schedulerDetails.map((detail) => ({
      title: `${detail.label}: ${healthLabel(detail.health)}`,
      icon: ACTIONABLE_HEALTH.has(detail.health) ? "triangle-alert" as IconName : "clock-3" as IconName,
      disabled: true,
    })),
    { title: `Semantic environment: ${state.semanticState}`, disabled: true },
    { title: "Open Mindmap", icon: "orbit", action: "openMindmap" },
    { title: "Open settings", icon: "settings", action: "openSettings" },
  ];
  return items;
}

export { ACTIONABLE_HEALTH };
