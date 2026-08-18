import fs from "node:fs/promises";
import path from "node:path";

import {
  createEmptyReadingState,
  parseReadingState,
  type ReadingState,
} from "./readingTypes";

export interface ReadingStateFileSystem {
  mkdir(directory: string, options: { recursive: boolean }): Promise<void>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  writeFile(filePath: string, content: string, encoding: "utf8"): Promise<void>;
  rename(sourcePath: string, targetPath: string): Promise<void>;
  unlink?(filePath: string): Promise<void>;
}

export interface ReadingStateStore {
  load(): Promise<ReadingState>;
  save(state: ReadingState): Promise<void>;
}

const defaultFileSystem: ReadingStateFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: async (filePath, encoding) => await fs.readFile(filePath, encoding),
  writeFile: async (filePath, content, encoding) => await fs.writeFile(filePath, content, encoding),
  rename: async (sourcePath, targetPath) => await fs.rename(sourcePath, targetPath),
  unlink: async (filePath) => await fs.unlink(filePath),
};

export function serializeReadingState(state: ReadingState): string {
  return `${JSON.stringify(parseReadingState(state), null, 2)}\n`;
}

export function createReadingStateStore(
  statePath: string,
  fileSystem: ReadingStateFileSystem = defaultFileSystem,
): ReadingStateStore {
  const temporaryPath = `${statePath}.tmp`;
  return {
    async load(): Promise<ReadingState> {
      try {
        const raw = await fileSystem.readFile(statePath, "utf8");
        return parseReadingState(JSON.parse(raw) as unknown);
      } catch (error) {
        if (isMissingFile(error)) {
          return createEmptyReadingState();
        }
        throw error;
      }
    },
    async save(state: ReadingState): Promise<void> {
      const serialized = serializeReadingState(state);
      await fileSystem.mkdir(path.dirname(statePath), { recursive: true });
      let renamed = false;
      try {
        await fileSystem.writeFile(temporaryPath, serialized, "utf8");
        await fileSystem.rename(temporaryPath, statePath);
        renamed = true;
      } finally {
        if (!renamed && fileSystem.unlink) {
          try {
            await fileSystem.unlink(temporaryPath);
          } catch {
            // Preserve the original failure; the target state was not replaced.
          }
        }
      }
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
