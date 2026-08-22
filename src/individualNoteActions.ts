import fs from "node:fs";
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

  const runtime = plugin.getResolvedRuntime();
  if (!runtime.valid) {
    return {
      path: activeFile.path,
      eligible: false,
      reason: runtime.messages.find((message) => message.level === "error")?.message ?? "Mindmap runtime is not ready.",
      code: "unsafe-path",
    };
  }

  try {
    const rawConfig = JSON.parse(await fs.promises.readFile(runtime.configPath, "utf8")) as Record<string, unknown>;
    const allScopeFolders = Array.isArray(rawConfig.notes_paths_all)
      ? rawConfig.notes_paths_all.map(String)
      : Array.isArray(rawConfig.notes_paths)
        ? rawConfig.notes_paths.map(String)
        : typeof rawConfig.notes_path === "string"
          ? [rawConfig.notes_path]
          : [];
    const text = await plugin.app.vault.cachedRead(activeFile);
    const configDir = plugin.app.vault.configDir;
    const runtimeFolder = path.join(configDir, "plugins", plugin.manifest.id);
    return assessActiveNote(activeFile.path, text, {
      allScopeFolders,
      minimumWords: Number(rawConfig.min_note_words ?? 30) || 0,
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
