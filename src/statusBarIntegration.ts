import type { App } from "obsidian";

import type MindmapPlugin from "./main";
import { openStatusBarMenu } from "./statusBarMenu";
import { buildStatusBarMenuState, type StatusBarMenuActions, type StatusBarMenuState } from "./statusBarState";
import type { EngineActivitySnapshot } from "./jobs/jobActivity";

export interface StatusBarInternalState {
  running: boolean;
  runStatus: string | null;
  activity: EngineActivitySnapshot | null;
  preflightInProgress: boolean;
  preflightOk: boolean | null;
  schedulerHealth: StatusBarMenuState["schedulerHealth"];
  schedulerDetails: StatusBarMenuState["schedulerDetails"];
}

/** Item 3: `MigrationMessageCode`-shaped codes ("DISCOVERING_NOTES", "BUILDING_INDEX", ...) rendered as plain human-readable text ("discovering notes", "building index", ...) for the status bar menu -- never the raw enum code shown verbatim to a user. */
function formatMigrationMessage(messageCode: string): string {
  return messageCode.toLowerCase().replace(/_/g, " ");
}

export function buildMindmapStatusBarState(plugin: MindmapPlugin, internal: StatusBarInternalState): StatusBarMenuState {
  const migrationStatus = plugin.getCachedProductionMigrationStatus();
  return buildStatusBarMenuState({
    migration: migrationStatus
      ? {
        phase: migrationStatus.phase,
        message: formatMigrationMessage(migrationStatus.messageCode),
        discoveredCount: migrationStatus.discoveredCount,
        processedCount: migrationStatus.processedCount,
        canStart: migrationStatus.canStart,
        canRetry: migrationStatus.canRetry,
        canCancel: migrationStatus.canCancel,
      }
      : undefined,
    pending: plugin.getPendingSnapshot(),
    running: internal.running,
    runStatus: internal.runStatus,
    activity: internal.activity,
    preflightInProgress: internal.preflightInProgress,
    preflightOk: internal.preflightOk,
    scopeReady: plugin.getScopeSetupStatus().complete,
    schedulerMode: plugin.settings.schedulerMode,
    schedulerHealth: internal.schedulerHealth,
    schedulerDetails: internal.schedulerDetails,
    schedulerEnabled: plugin.settings.schedulerMode === "launchAgent" && process.platform === "darwin",
    weeklyEnabled: plugin.settings.launchAgentWeeklyEnabled,
    semanticState: plugin.productionEngine !== null ? "ready" : "off",
    activeNote: plugin.getActiveNoteEligibility(),
    readingMode: plugin.getReadingHealth().mode,
    readingActivity: plugin.getReadingHealth().activity,
    readingLastSyncAt: plugin.getReadingHealth().lastSyncAt,
    readingPending: plugin.getReadingHealth().pendingCount,
    readingImported: plugin.getReadingHealth().importedCount,
    readingUnresearchable: plugin.getReadingHealth().unresearchableCount,
    readingError: plugin.getReadingHealth().lastError,
    webResearchMode: plugin.getWebResearchStatus().mode,
    webResearchActivity: plugin.getWebResearchStatus().activity,
    webResearchError: plugin.getWebResearchStatus().lastError,
    automaticResearchAttempted: plugin.getWebResearchStatus().automatic.attempted,
    automaticResearchPauseReason: plugin.getWebResearchStatus().automatic.pauseReason,
    automaticResearchLastError: plugin.getWebResearchStatus().automatic.lastError,
    automaticResearchLastErrorAt: plugin.getWebResearchStatus().automatic.lastErrorAt,
  });
}

export function buildMindmapStatusBarActions(plugin: MindmapPlugin): StatusBarMenuActions {
  return {
    pauseProcessing: async () => { await plugin.productionEngine?.pauseProcessing(); },
    resumeProcessing: async () => { await plugin.productionEngine?.resumeProcessing(); },
    runCurrent: async () => { await plugin.runMindmap("manual", "current"); },
    runActiveNote: () => plugin.runActiveNote(),
    runAll: async () => { await plugin.runMindmap("manual", "all"); },
    processPendingNote: (notePath) => plugin.processPendingNote(notePath),
    runPreflight: async () => { await plugin.runPreflight("manual"); },
    openNote: (notePath) => plugin.app.workspace.openLinkText(notePath, "", false),
    openMindmap: () => plugin.openMindmapView(),
    openSettings: () => {
      const appWithSettings = plugin.app as App & { setting?: { open(): void; openTabById?(id: string): void } };
      appWithSettings.setting?.open();
      appWithSettings.setting?.openTabById?.(plugin.manifest.id);
    },
    selectStandardMode: async () => { await plugin.selectReadingMode("standard"); },
    selectReadingMode: async () => { await plugin.selectReadingMode("reading"); },
    syncReadingMode: async () => { await plugin.syncReadingMode(); },
    processReadingBacklog: async () => { await plugin.processReadingBacklog(); },
    toggleWebResearchMode: async () => { await plugin.toggleWebResearchMode(); },
    researchSelectedText: async () => { await plugin.researchSelectedText(); },
    researchActiveNote: async () => { await plugin.researchActiveNote(); },
    researchAndReprocessActiveNote: async () => { await plugin.researchActiveNote(true); },
    toggleAutomaticReadingResearch: async () => { await plugin.toggleAutomaticReadingResearch(); },
    retryAutomaticResearch: async () => { await plugin.retryAutomaticResearch(); },
    startMigration: async () => { await plugin.startProductionMigration(); },
    retryMigration: async () => { await plugin.retryProductionMigration(); },
    cancelMigration: async () => { await plugin.cancelProductionMigration(); },
  };
}

export async function openMindmapStatusMenu(plugin: MindmapPlugin, event?: MouseEvent | KeyboardEvent): Promise<void> {
  await plugin.refreshActiveNoteEligibility();
  await plugin.refreshLaunchAgentHealth();
  await plugin.refreshCachedMigrationStatus();
  if (!plugin.statusBarEl) {
    return;
  }
  openStatusBarMenu(
    plugin.statusBarEl,
    buildMindmapStatusBarState(plugin, plugin.getStatusBarInternalState()),
    buildMindmapStatusBarActions(plugin),
    event,
  );
}
