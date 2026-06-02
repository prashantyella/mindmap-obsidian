import type { WorkspaceLeaf } from "obsidian";

export function buildMindmapLocalGraphState(pluginId: string, filePath: string): Record<string, unknown> {
  return {
    pluginId,
    file: filePath,
    options: {
      "collapse-filter": true,
      search: "",
      localJumps: 1,
      localBacklinks: true,
      localForelinks: true,
      localInterlinks: false,
      showTags: false,
      showAttachments: false,
      hideUnresolved: false,
      "collapse-color-groups": true,
      colorGroups: [],
      "collapse-display": true,
      showArrow: false,
      textFadeMultiplier: 0,
      nodeSizeMultiplier: 1,
      lineSizeMultiplier: 1,
      "collapse-forces": true,
      centerStrength: 0.52,
      repelStrength: 10,
      linkStrength: 1,
      linkDistance: 250,
      scale: 1,
      close: false,
    },
  };
}

export function isMindmapLocalGraphLeaf(
  leaf: WorkspaceLeaf,
  currentLeaf: WorkspaceLeaf | null,
  pluginId: string,
): boolean {
  if (leaf === currentLeaf) {
    return true;
  }

  const state = leaf.getViewState().state;
  return typeof state === "object"
    && state !== null
    && (state as Record<string, unknown>).pluginId === pluginId;
}
