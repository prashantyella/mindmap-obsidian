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
  });
}

export function buildMindmapStatusBarActions(plugin: MindmapPlugin): StatusBarMenuActions {
  return {
    runCurrent: () => plugin.runMindmap("manual", "current"),
    runAll: () => plugin.runMindmap("manual", "all"),
    runPreflight: async () => { await plugin.runPreflight("manual"); },
    openNote: (notePath) => plugin.app.workspace.openLinkText(notePath, "", false),
    openMindmap: () => plugin.openMindmapView(),
    openSettings: () => {
      const appWithSettings = plugin.app as App & { setting?: { open(): void; openTabById?(id: string): void } };
      appWithSettings.setting?.open();
      appWithSettings.setting?.openTabById?.(plugin.manifest.id);
    },
  };
}

export async function openMindmapStatusMenu(plugin: MindmapPlugin, event?: MouseEvent | KeyboardEvent): Promise<void> {
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
