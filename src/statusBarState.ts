import type { IconName } from "obsidian";

import { DAILY_LAUNCH_AGENT_LABEL, WEEKLY_LAUNCH_AGENT_LABEL, type LaunchAgentHealth } from "./launchAgent";
import type { ActiveNoteEligibility } from "./individualNote";
import type { ReadingActivity, ReadingMode } from "./readingMode";
import type { AutomaticPauseReason } from "./automaticResearchPolicy";

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
  activeNote: ActiveNoteEligibility;
  readingMode: ReadingMode;
  readingActivity: ReadingActivity;
  readingLastSyncAt: string | null;
  readingPending: number;
  readingImported: number;
  readingError: string | null;
  webResearchMode: "off" | "manual" | "automatic-reading";
  webResearchActivity: string;
  webResearchError: string | null;
  automaticResearchAttempted: number;
  automaticResearchPauseReason: AutomaticPauseReason;
  automaticResearchLastError: string | null;
  automaticResearchLastErrorAt: string | null;
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
  activeNote: ActiveNoteEligibility;
  readingMode: ReadingMode;
  readingActivity: ReadingActivity;
  readingLastSyncAt: string | null;
  readingPending: number;
  readingImported: number;
  readingError: string | null;
  webResearchMode: "off" | "manual" | "automatic-reading";
  webResearchActivity: string;
  webResearchError: string | null;
  automaticResearchAttempted: number;
  automaticResearchPauseReason: AutomaticPauseReason;
  automaticResearchLastError: string | null;
  automaticResearchLastErrorAt: string | null;
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
    activeNote: input.activeNote,
    readingMode: input.readingMode,
    readingActivity: input.readingActivity,
    readingLastSyncAt: input.readingLastSyncAt,
    readingPending: input.readingPending,
    readingImported: input.readingImported,
    readingError: input.readingError,
    webResearchMode: input.webResearchMode,
    webResearchActivity: input.webResearchActivity,
    webResearchError: input.webResearchError,
    automaticResearchAttempted: input.automaticResearchAttempted,
    automaticResearchPauseReason: input.automaticResearchPauseReason,
    automaticResearchLastError: input.automaticResearchLastError,
    automaticResearchLastErrorAt: input.automaticResearchLastErrorAt,
  };
}

export interface StatusBarMenuActions {
  runCurrent(): void | Promise<void>;
  runActiveNote(): void | Promise<void>;
  runAll(): void | Promise<void>;
  processPendingNote(path: string): void | Promise<void>;
  runPreflight(): void | Promise<void>;
  openNote(path: string): void | Promise<void>;
  openMindmap(): void | Promise<void>;
  openSettings(): void;
  toggleReadingMode(): void | Promise<void>;
  syncReadingMode(): void | Promise<void>;
  toggleWebResearchMode(): void | Promise<void>;
  researchSelectedText(): void | Promise<void>;
  researchActiveNote(): void | Promise<void>;
  researchAndReprocessActiveNote(): void | Promise<void>;
  toggleAutomaticReadingResearch(): void | Promise<void>;
  retryAutomaticResearch(): void | Promise<void>;
}

export interface StatusBarPresentation {
  label: string;
  ariaLabel: string;
  title: string;
  icon: IconName;
  running: boolean;
  busy: boolean;
  animateIcon: boolean;
  actionable: boolean;
}

const ACTIONABLE_HEALTH = new Set<LaunchAgentHealth>(["overdue", "failing"]);

function healthLabel(health: LaunchAgentHealth): string {
  return health[0].toUpperCase() + health.slice(1);
}

export function buildStatusBarPresentation(state: StatusBarMenuState): StatusBarPresentation {
  const schedulerActionable = state.schedulerHealth !== null && ACTIONABLE_HEALTH.has(state.schedulerHealth);
  const readingActionable = state.readingMode === "reading" && (state.readingActivity === "error" || Boolean(state.readingError));
  const automaticPaused = state.webResearchMode === "automatic-reading" && state.automaticResearchPauseReason !== null;
  const webResearchActionable = state.webResearchActivity === "error" || Boolean(state.webResearchError) || automaticPaused;
  const researchBusy = ["deriving", "searching", "writing"].includes(state.webResearchActivity);
  const busy = state.running || state.readingActivity === "syncing" || state.readingActivity === "processing" || researchBusy;
  const actionable = state.preflightOk === false || !state.scopeReady || schedulerActionable || readingActionable || webResearchActionable;
  const label = state.readingMode === "reading"
    ? state.readingActivity === "syncing" || state.readingActivity === "processing"
      ? `Reading · ${state.readingActivity}`
      : `Reading · ${state.readingPending}`
    : researchBusy
    ? `Research · ${state.webResearchActivity}`
    : state.running
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
  const status = state.running ? state.runStatus ?? "running" : attention;
  const ariaLabel = readingActionable
    ? `Mindmap Reading Mode: ${state.readingError ?? state.readingActivity}. ${state.readingPending} eligible notes pending. Activate to open the Mindmap menu.`
    : webResearchActionable
      ? `Mindmap Web Research: ${state.webResearchError ?? (automaticPaused ? `Automatic research paused: ${state.automaticResearchPauseReason}.` : state.webResearchActivity)} Activate to open the Mindmap menu.`
      : researchBusy
        ? `Mindmap Web Research: ${state.webResearchActivity}. Activate to open the Mindmap menu.`
      : state.readingMode === "reading"
        ? `Mindmap Reading Mode: ${state.readingActivity}. ${state.readingPending} eligible notes pending. Activate to open the Mindmap menu.`
        : `Mindmap standard mode: ${status}. ${state.pendingAvailable ? `${state.currentPending} current-scope pending, ${state.allPending} all-scope pending.` : "Pending scan unavailable."} Activate to open the Mindmap menu.`;
  const icon = readingActionable || webResearchActionable ? "triangle-alert" : busy ? "loader-circle" : state.readingMode === "reading" ? "book-open" : actionable ? "triangle-alert" : "orbit";
  return {
    label,
    ariaLabel,
    title: ariaLabel,
    icon,
    running: busy,
    busy,
    animateIcon: icon === "loader-circle",
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
  const researchBusy = ["deriving", "searching", "writing"].includes(state.webResearchActivity);
  const automaticActive = state.webResearchMode === "automatic-reading";
  const automaticTransientPause = automaticActive && state.automaticResearchPauseReason !== null && state.automaticResearchPauseReason !== "daily-limit";
  const automaticPausedCopy = state.automaticResearchPauseReason === "daily-limit"
    ? "Automatic research daily limit reached; resumes after local midnight."
    : state.automaticResearchPauseReason
      ? `Automatic research paused: ${state.automaticResearchPauseReason}.`
      : state.readingMode !== "reading"
        ? "Automatic research is waiting for Reading Mode."
        : null;
  const automaticError = state.automaticResearchLastError ?? state.webResearchError;
  const modeLabel = state.webResearchMode === "automatic-reading" ? "Automatic for Reading" : state.webResearchMode === "manual" ? "Manual" : "Off";
  const items: StatusBarMenuItemDescriptor[] = [
    { title: "Mode", label: true },
    { title: "Standard Mode", icon: "orbit", checked: state.readingMode === "standard", disabled: state.readingMode === "standard" },
    { title: "Reading Mode (experimental)", icon: "book-open", checked: state.readingMode === "reading", action: "toggleReadingMode" },
    { title: "Queue", label: true },
    {
      title: state.running
        ? "Run active note (Mindmap is already running.)"
        : state.activeNote.eligible
        ? "Run Mindmap for active note"
        : `Run active note (${state.activeNote.reason})`,
      icon: "file-play",
      disabled: state.running || researchBusy || !state.scopeReady || !state.activeNote.eligible,
      action: state.running || !state.activeNote.eligible ? undefined : "runActiveNote",
    },
    {
      title: state.running ? `Run active${state.runStatus ? `: ${state.runStatus}` : ""}` : "Run current scope",
      icon: state.running ? "loader-circle" : "play",
      disabled: state.running || researchBusy || !state.scopeReady,
      action: state.running ? undefined : "runCurrent",
    },
    {
      title: state.pendingAvailable ? `Process all pending notes (${state.allPending})` : "Process all pending notes (unavailable)",
      icon: "list-checks",
      disabled: state.running || researchBusy || !state.scopeReady || !state.pendingAvailable || state.allPending === 0,
      action: "runAll",
    },
    {
      title: state.pendingAvailable ? `Current scope: ${state.currentPending} pending` : "Pending scan unavailable",
      disabled: true,
    },
    ...state.pendingPaths.flatMap((path) => [
      { title: `Process ${path}`, icon: "file-play" as IconName, path, disabled: state.running || researchBusy || !state.scopeReady, action: "processPendingNote" as const },
      { title: `Open ${path}`, icon: "file-text" as IconName, path, action: "openNote" as const },
    ]),
    { title: "Reading", label: true },
    state.readingMode === "reading"
      ? { title: `Reading Mode: ${state.readingActivity}`, icon: "book-open", disabled: true }
      : { title: "Reading Mode is off (experimental)", icon: "book-open", disabled: true },
    ...(state.readingMode === "reading" ? [
      { title: "Sync Reading Mode now", icon: "refresh-cw" as IconName, action: "syncReadingMode" as const, disabled: state.readingActivity === "syncing" || state.readingActivity === "processing" },
      { title: `Reading pending: ${state.readingPending}`, disabled: true },
      { title: state.readingLastSyncAt ? `Reading last sync: ${state.readingLastSyncAt}` : "Reading has not synced yet", disabled: true },
      ...(state.readingError ? [{ title: `Reading error: ${state.readingError}`, icon: "triangle-alert" as IconName, disabled: true }] : []),
    ] : []),
    { title: "Web Research", label: true },
    { title: `Research mode: ${modeLabel}`, icon: "globe-2", disabled: true },
    automaticActive
      ? { title: "Manual research is included with Automatic for Reading", icon: "check" as IconName, disabled: true }
      : { title: "Use Manual research", icon: "globe-2", checked: state.webResearchMode === "manual", action: "toggleWebResearchMode", disabled: researchBusy },
    { title: automaticActive ? "Pause Automatic for Reading" : "Enable Automatic for Reading", icon: "sparkles" as IconName, checked: automaticActive, action: "toggleAutomaticReadingResearch", disabled: researchBusy || (!automaticActive && state.readingMode !== "reading") },
    ...(automaticActive ? [
      { title: `Automatic research: ${state.automaticResearchAttempted}/10 today · max 5/sync`, disabled: true },
      ...(automaticPausedCopy ? [{ title: automaticPausedCopy, icon: state.automaticResearchPauseReason ? "triangle-alert" as IconName : "clock-3" as IconName, disabled: true }] : []),
      ...(automaticError ? [{ title: `Automatic research: ${automaticError}`, icon: "triangle-alert" as IconName, disabled: true }] : []),
      ...(state.automaticResearchLastErrorAt ? [{ title: `Automatic research last error: ${state.automaticResearchLastErrorAt}`, disabled: true }] : []),
      ...(automaticTransientPause ? [{ title: "Retry automatic research", icon: "refresh-cw" as IconName, action: "retryAutomaticResearch" as const, disabled: researchBusy || state.readingMode !== "reading" }] : []),
    ] : []),
    ...(state.webResearchMode !== "off" ? [
      { title: "Research selected text", icon: "search" as IconName, action: "researchSelectedText" as const, disabled: state.running || ["deriving", "searching", "writing"].includes(state.webResearchActivity) },
      { title: "Research active note", icon: "file-search" as IconName, action: "researchActiveNote" as const, disabled: state.running || ["deriving", "searching", "writing"].includes(state.webResearchActivity) },
      { title: "Research and reprocess active note", icon: "sparkles" as IconName, action: "researchAndReprocessActiveNote" as const, disabled: state.running || ["deriving", "searching", "writing"].includes(state.webResearchActivity) },
      ...(state.webResearchMode === "manual" && researchBusy ? [{ title: `Research: ${state.webResearchActivity}`, disabled: true }] : []),
      ...(state.webResearchMode === "manual" && state.webResearchError ? [{ title: `Research error: ${state.webResearchError}`, icon: "triangle-alert" as IconName, disabled: true }] : []),
    ] : [{ title: state.webResearchError ? `Web Research error: ${state.webResearchError}` : "Web Research is not enabled", icon: state.webResearchError ? "triangle-alert" as IconName : "globe-2" as IconName, disabled: true }]),
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
