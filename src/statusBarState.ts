import type { IconName } from "obsidian";

import { DAILY_LAUNCH_AGENT_LABEL, WEEKLY_LAUNCH_AGENT_LABEL, type LaunchAgentHealth } from "./launchAgent";
import type { ActiveNoteEligibility } from "./individualNote";
import type { ReadingActivity, ReadingMode } from "./readingMode";
import type { AutomaticPauseReason } from "./automaticResearchPolicy";
import type { EngineActivitySnapshot } from "./jobs/jobActivity";

export interface StatusBarSchedulerDetail {
  label: string;
  health: LaunchAgentHealth;
  lastSuccessfulRunAt: number | null;
}

/** Checkpoint 10B item 3: the TypeScript engine's migration status, surfaced through the SAME existing status bar menu (never a new UI surface) -- `undefined` when the production engine itself is unavailable. */
export interface StatusBarMigrationState {
  phase: string;
  message: string;
  discoveredCount: number;
  processedCount: number;
  canStart: boolean;
  canRetry: boolean;
  canCancel: boolean;
}

export interface StatusBarMenuState {
  migration?: StatusBarMigrationState;
  pendingAvailable: boolean;
  currentPending: number;
  allPending: number;
  pendingPaths: string[];
  running: boolean;
  runStatus: string | null;
  activity?: EngineActivitySnapshot | null;
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
  readingUnresearchable: number;
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
  migration?: StatusBarMigrationState;
  pending: {
    available: boolean;
    current: { total: number; items: string[] };
    all: { total: number; items: string[] };
  };
  running: boolean;
  runStatus: string | null;
  activity?: EngineActivitySnapshot | null;
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
  readingUnresearchable: number;
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
    migration: input.migration,
    pendingAvailable: input.pending.available,
    currentPending: input.pending.current.total,
    allPending: input.pending.all.total,
    pendingPaths: [...new Set([...input.pending.current.items, ...input.pending.all.items])].slice(0, 5),
    running: input.running,
    runStatus: input.runStatus,
    activity: input.activity ?? null,
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
    readingUnresearchable: input.readingUnresearchable,
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
  selectStandardMode(): void | Promise<void>;
  selectReadingMode(): void | Promise<void>;
  syncReadingMode(): void | Promise<void>;
  processReadingBacklog(): void | Promise<void>;
  toggleWebResearchMode(): void | Promise<void>;
  researchSelectedText(): void | Promise<void>;
  researchActiveNote(): void | Promise<void>;
  researchAndReprocessActiveNote(): void | Promise<void>;
  toggleAutomaticReadingResearch(): void | Promise<void>;
  retryAutomaticResearch(): void | Promise<void>;
  startMigration(): void | Promise<void>;
  retryMigration(): void | Promise<void>;
  cancelMigration(): void | Promise<void>;
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
function batchFailureSummary(batch: NonNullable<EngineActivitySnapshot["latestFailureBatch"]>): string {
  return batch.status === "completed-with-failures" ? `${batch.failed} failed` : batch.status === "failed" ? "root failed" : "cancelled";
}

export function buildStatusBarPresentation(state: StatusBarMenuState): StatusBarPresentation {
  const activity = state.activity;
  const schedulerActionable = state.schedulerHealth !== null && ACTIONABLE_HEALTH.has(state.schedulerHealth);
  const readingActionable = state.readingMode === "reading" && (state.readingActivity === "error" || Boolean(state.readingError));
  const automaticPaused = state.webResearchMode === "automatic-reading" && state.automaticResearchPauseReason !== null;
  const webResearchActionable = state.webResearchActivity === "error" || Boolean(state.webResearchError) || automaticPaused;
  const researchBusy = ["deriving", "searching", "writing"].includes(state.webResearchActivity);
  const busy = state.running || activity?.state === "running" || state.readingActivity === "syncing" || state.readingActivity === "processing" || researchBusy;
  const readingBusy = state.readingMode === "reading" && (state.readingActivity === "syncing" || state.readingActivity === "processing");
  const activeEngineWork = Boolean(activity?.batch) || Boolean(activity && (activity.queuedCount > 0 || activity.activeCount > 0));
  const visibleLatestFailure = Boolean(activity?.latestFailureBatch) && !readingBusy && !researchBusy && !activeEngineWork && activity?.state !== "faulted" && activity?.state !== "paused";
  const engineBusy = activeEngineWork && !readingBusy && !researchBusy;
  const engineAlert = activity?.state === "faulted" || activity?.state === "paused" || visibleLatestFailure;
  const actionable = state.preflightOk === false || !state.scopeReady || schedulerActionable || readingActionable || webResearchActionable || engineAlert;
  const label = activity?.state === "faulted" ? "Mindmap · fault"
    : activity?.state === "paused" ? "Mindmap · paused"
    : readingBusy
    ? state.readingActivity === "syncing" || state.readingActivity === "processing"
      ? `Reading · ${state.readingActivity}`
      : `Reading · ${state.readingPending}`
    : researchBusy
    ? `Research · ${state.webResearchActivity}`
    : activity?.batch?.total === undefined && activity?.batch ? "Mindmap · preparing"
    : activity?.batch?.total !== undefined ? `Mindmap · ${activity.batch.processed}/${activity.batch.total}`
    : activity && activity.queuedCount > 0 ? `Mindmap · ${activity.queuedCount} queued`
    : visibleLatestFailure && activity?.latestFailureBatch ? `Mindmap · ${batchFailureSummary(activity.latestFailureBatch)}`
    : state.running
    ? `Mindmap · ${state.runStatus ?? "running"}`
      : state.readingMode === "reading"
        ? `Reading · ${state.readingPending}`
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
  const status = activity?.state === "faulted" ? "fault" : activity?.state === "paused" ? "paused" : visibleLatestFailure && activity?.latestFailureBatch ? batchFailureSummary(activity.latestFailureBatch) : state.running ? state.runStatus ?? "running" : attention;
  const engineDetail = activity ? `${activity.current?.phase ?? "idle"}${activity.current?.path ? `, ${activity.current.path}` : ""}, ${activity.queuedCount} queued${visibleLatestFailure && activity.latestFailureBatch ? `, ${batchFailureSummary(activity.latestFailureBatch)}` : ""}` : "";
  const ariaLabel = engineAlert
    ? `Mindmap engine ${status}. ${engineDetail}. Activate to open the Mindmap menu.`
    : engineBusy
      ? `Mindmap engine ${activity?.batch?.total !== undefined ? `${activity.batch.processed}/${activity.batch.total}` : activity?.batch ? "preparing" : `${activity?.queuedCount ?? 0} queued`}. ${engineDetail}. Activate to open the Mindmap menu.`
    : readingActionable
    ? `Mindmap Reading Mode: ${state.readingError ?? state.readingActivity}. ${state.readingPending} eligible notes pending. Activate to open the Mindmap menu.`
    : webResearchActionable
      ? `Mindmap Web Research: ${state.webResearchError ?? (automaticPaused ? `Automatic research paused: ${state.automaticResearchPauseReason}.` : state.webResearchActivity)} Activate to open the Mindmap menu.`
      : researchBusy
        ? `Mindmap Web Research: ${state.webResearchActivity}. Activate to open the Mindmap menu.`
      : state.readingMode === "reading"
        ? `Mindmap Reading Mode: ${state.readingActivity}. ${state.readingPending} eligible notes pending. Activate to open the Mindmap menu.`
        : `Mindmap standard mode: ${status}. ${state.pendingAvailable ? `${state.currentPending} current-scope pending, ${state.allPending} all-scope pending.` : "Pending scan unavailable."} Activate to open the Mindmap menu.`;
  const icon = engineAlert || readingActionable || webResearchActionable ? "triangle-alert" : busy ? "loader-circle" : state.readingMode === "reading" ? "book-open" : actionable ? "triangle-alert" : "orbit";
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

/**
 * At most one row: the highest-priority recoverable issue. Healthy states
 * never add a row here.
 */
function buildTopRecoveryRow(state: StatusBarMenuState): StatusBarMenuItemDescriptor | null {
  if (state.preflightOk === false) {
    return {
      title: "Run preflight (failed)",
      icon: "triangle-alert",
      action: "runPreflight",
      disabled: false,
    };
  }
  const readingActionable = state.readingMode === "reading" && (state.readingActivity === "error" || Boolean(state.readingError));
  if (readingActionable) {
    const readingBusy = state.readingActivity === "syncing" || state.readingActivity === "processing";
    return {
      title: `Reading error: ${state.readingError ?? state.readingActivity}`,
      icon: "triangle-alert",
      action: readingBusy ? undefined : "syncReadingMode",
      disabled: readingBusy,
    };
  }
  // Automatic-mode pauses/errors are represented entirely within the
  // Research group (usage/pause/retry); the top row only ever speaks for
  // manual or off Web Research, so the two never say the same thing twice.
  const manualWebResearchActionable = state.webResearchMode !== "automatic-reading"
    && (state.webResearchActivity === "error" || Boolean(state.webResearchError));
  if (manualWebResearchActionable) {
    const title = state.webResearchError ? `Web Research error: ${state.webResearchError}` : `Web Research: ${state.webResearchActivity}`;
    return { title, icon: "triangle-alert", action: "openSettings" };
  }
  if (state.schedulerHealth !== null && ACTIONABLE_HEALTH.has(state.schedulerHealth)) {
    return { title: `Scheduler ${state.schedulerHealth}`, icon: "triangle-alert", action: "openSettings" };
  }
  return null;
}

export function buildStatusBarMenuItems(state: StatusBarMenuState): StatusBarMenuItemDescriptor[] {
  const bulkBlocked = state.activity?.bulkBlocked ?? state.running;
  const researchBusy = ["deriving", "searching", "writing"].includes(state.webResearchActivity);
  const readingBusy = state.readingMode === "reading" && (state.readingActivity === "syncing" || state.readingActivity === "processing");
  const activeEngineWork = Boolean(state.activity?.batch) || Boolean(state.activity && (state.activity.queuedCount > 0 || state.activity.activeCount > 0));
  const visibleLatestFailure = Boolean(state.activity?.latestFailureBatch) && !readingBusy && !researchBusy && !activeEngineWork && state.activity?.state !== "faulted" && state.activity?.state !== "paused";
  const automaticActive = state.webResearchMode === "automatic-reading";
  const automaticTransientPause = automaticActive && state.automaticResearchPauseReason !== null && state.automaticResearchPauseReason !== "daily-limit";
  const automaticPausedCopy = state.automaticResearchPauseReason === "daily-limit"
    ? "Automatic research daily limit reached; resumes after local midnight."
    : state.automaticResearchPauseReason
      ? `Automatic research paused: ${state.automaticResearchPauseReason}.`
      : state.readingMode !== "reading"
        ? "Automatic research is waiting for Reading Mode."
        : null;

  const topRecoveryRow = buildTopRecoveryRow(state);

  // Item 3 (Checkpoint 10B): shown only once a migration record actually exists for this vault
  // (`state.migration` is `undefined` when the production engine itself is unavailable). A
  // terminal "complete"/"cancelled" state with nothing left to retry shows status only, no action
  // row -- Start/Retry/Cancel appear exactly when `canStart`/`canRetry`/`canCancel` say so.
  const migration = state.migration;
  const migrationItems: StatusBarMenuItemDescriptor[] = migration
    ? [
      { title: "Mindmap engine (TypeScript)", label: true },
      { title: `Migration: ${migration.message} (${migration.processedCount}/${migration.discoveredCount})`, icon: "database", disabled: true },
      ...(migration.canStart ? [{ title: "Start migration", icon: "play" as IconName, action: "startMigration" as const }] : []),
      ...(migration.canRetry ? [{ title: "Retry migration", icon: "refresh-cw" as IconName, action: "retryMigration" as const }] : []),
      ...(migration.canCancel ? [{ title: "Cancel migration", icon: "x" as IconName, action: "cancelMigration" as const }] : []),
    ]
    : [];

  const items: StatusBarMenuItemDescriptor[] = [
    ...migrationItems,
    ...(topRecoveryRow ? [topRecoveryRow] : []),
    ...(state.activity && (state.activity.state !== "idle" || visibleLatestFailure) ? [{
      title: `Engine: ${state.activity.current?.phase ?? state.activity.state}${state.activity.current?.path ? ` · ${state.activity.current.path}` : ""} · ${state.activity.queuedCount} queued${visibleLatestFailure && state.activity.latestFailureBatch ? ` · ${batchFailureSummary(state.activity.latestFailureBatch)}` : ""}`,
      icon: "info" as IconName,
      disabled: true,
    }] : []),
    { title: "Mode", label: true },
    {
      title: "Standard Mode",
      icon: "orbit",
      checked: state.readingMode === "standard",
      disabled: state.readingMode === "standard",
      action: state.readingMode === "standard" ? undefined : "selectStandardMode",
    },
    {
      title: "Reading Mode (experimental)",
      icon: "book-open",
      checked: state.readingMode === "reading",
      disabled: state.readingMode === "reading",
      action: state.readingMode === "reading" ? undefined : "selectReadingMode",
    },
    { title: "Run", label: true },
    ...(state.activeNote.eligible ? [{
      title: "Run Mindmap for active note",
      icon: "file-play" as IconName,
      disabled: researchBusy || !state.scopeReady,
      action: "runActiveNote" as const,
    }] : []),
    {
      title: state.running ? `Run current scope${state.runStatus ? `: ${state.runStatus}` : ""}` : "Run current scope",
      icon: state.running ? "loader-circle" : "play",
      disabled: bulkBlocked || researchBusy || !state.scopeReady,
      action: bulkBlocked ? undefined : "runCurrent",
    },
    ...(state.pendingAvailable && state.allPending > 0 ? [{
      title: `Process pending notes (${state.allPending})`,
      icon: "list-checks" as IconName,
      disabled: bulkBlocked || researchBusy || !state.scopeReady,
      action: "runAll" as const,
    }] : []),
    ...(state.readingMode === "reading" ? [
      { title: "Reading", label: true },
      { title: "Sync Reading now", icon: "refresh-cw" as IconName, action: "syncReadingMode" as const, disabled: state.readingActivity === "syncing" || state.readingActivity === "processing" },
      ...(state.readingPending > 0 ? [{
        title: `Process Reading backlog (${state.readingPending})`,
        icon: "list-checks" as IconName,
        action: "processReadingBacklog" as const,
        disabled: bulkBlocked || state.readingActivity === "syncing" || state.readingActivity === "processing" || researchBusy,
      }] : []),
    ] : []),
    { title: "Research", label: true },
    {
      title: "Manual research",
      icon: "globe-2",
      checked: state.webResearchMode === "manual" || automaticActive,
      disabled: researchBusy || automaticActive,
      action: automaticActive ? undefined : "toggleWebResearchMode",
    },
    {
      title: "Automatic for Reading",
      icon: "sparkles",
      checked: automaticActive,
      action: "toggleAutomaticReadingResearch",
      disabled: researchBusy || (!automaticActive && state.readingMode !== "reading"),
    },
    // Automatic-mode pauses/errors are only ever represented here, never
    // repeated in the top recovery row, so an actionable automatic issue
    // (a pause reason, or a plain activity error/lastError) must all route
    // through this one gate.
    ...(automaticActive && (automaticPausedCopy !== null || state.webResearchActivity === "error" || Boolean(state.automaticResearchLastError)) ? [
      { title: `Automatic research: ${state.automaticResearchAttempted}/10 today · max 5/sync`, disabled: true },
      ...(automaticPausedCopy ? [{ title: automaticPausedCopy, icon: "triangle-alert" as IconName, disabled: true }] : []),
      ...(state.automaticResearchLastError ? [{ title: `Automatic research: ${state.automaticResearchLastError}`, icon: "triangle-alert" as IconName, disabled: true }] : []),
      ...(automaticTransientPause ? [{ title: "Retry automatic research", icon: "refresh-cw" as IconName, action: "retryAutomaticResearch" as const, disabled: researchBusy || state.readingMode !== "reading" }] : []),
    ] : []),
    { title: "Navigation", label: true },
    { title: "Open Mindmap", icon: "orbit", action: "openMindmap" },
    { title: "Open settings", icon: "settings", action: "openSettings" },
  ];
  return items;
}

export { ACTIONABLE_HEALTH };
