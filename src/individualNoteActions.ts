import path from "node:path";

import type MindmapPlugin from "./main";
import { assessActiveNote, NO_ACTIVE_NOTE, type ActiveNoteEligibility } from "./individualNote";

export async function resolveActiveNoteEligibility(plugin: MindmapPlugin): Promise<ActiveNoteEligibility> {
  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile) {
    return NO_ACTIVE_NOTE;
  }
  if (activeFile.extension.toLowerCase() !== "md") {
    return {
      path: activeFile.path,
      eligible: false,
      reason: "The active file is not a Markdown note.",
      code: "not-markdown",
    };
  }

  try {
    const text = await plugin.app.vault.cachedRead(activeFile);
    const configDir = plugin.app.vault.configDir;
    const runtimeFolder = path.join(configDir, "plugins", plugin.manifest.id);
    return assessActiveNote(activeFile.path, text, {
      allScopeFolders: plugin.settings.scopeAllPaths,
      minimumWords: plugin.settings.minimumWords,
      runtimeFolder,
      configDir,
    });
  } catch (error) {
    return {
      path: activeFile.path,
      eligible: false,
      reason: error instanceof Error ? `Could not inspect the active note: ${error.message}` : "Could not inspect the active note.",
      code: "unsafe-path",
    };
  }
}
