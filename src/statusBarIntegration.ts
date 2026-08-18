import type { App } from "obsidian";

import type MindmapPlugin from "./main";
import { openStatusBarMenu } from "./statusBarMenu";
import { buildStatusBarMenuState, type StatusBarMenuActions, type StatusBarMenuState } from "./statusBarState";

export interface StatusBarInternalState {
  running: boolean;
  runStatus: string | null;
  preflightInProgress: boolean;
  preflightOk: boolean | null;
  schedulerHealth: StatusBarMenuState["schedulerHealth"];
  schedulerDetails: StatusBarMenuState["schedulerDetails"];
}

export function buildMindmapStatusBarState(plugin: MindmapPlugin, internal: StatusBarInternalState): StatusBarMenuState {
  return buildStatusBarMenuState({
    pending: plugin.getPendingSnapshot(),
    running: internal.running,
    runStatus: internal.runStatus,
    preflightInProgress: internal.preflightInProgress,
    preflightOk: internal.preflightOk,
    scopeReady: plugin.getScopeSetupStatus().complete,
    schedulerMode: plugin.settings.schedulerMode,
    schedulerHealth: internal.schedulerHealth,
    schedulerDetails: internal.schedulerDetails,
    schedulerEnabled: plugin.settings.schedulerMode === "launchAgent" && process.platform === "darwin",
    weeklyEnabled: plugin.settings.launchAgentWeeklyEnabled,
    semanticState: plugin.getSemanticStatus().state,
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
    toggleReadingMode: async () => { await plugin.toggleReadingMode(); },
    syncReadingMode: async () => { await plugin.syncReadingMode(); },
    toggleWebResearchMode: async () => { await plugin.toggleWebResearchMode(); },
    researchSelectedText: async () => { await plugin.researchSelectedText(); },
    researchActiveNote: async () => { await plugin.researchActiveNote(); },
    researchAndReprocessActiveNote: async () => { await plugin.researchActiveNote(true); },
    toggleAutomaticReadingResearch: async () => { await plugin.toggleAutomaticReadingResearch(); },
    retryAutomaticResearch: async () => { await plugin.retryAutomaticResearch(); },
  };
}

export async function openMindmapStatusMenu(plugin: MindmapPlugin, event?: MouseEvent | KeyboardEvent): Promise<void> {
  await plugin.refreshActiveNoteEligibility();
  await plugin.refreshLaunchAgentHealth();
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
