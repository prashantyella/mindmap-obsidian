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

export interface ReadingStateMutation<T> {
  state: ReadingState;
  result: T;
}

export interface ReadingStateStore {
  load(): Promise<ReadingState>;
  save(state: ReadingState): Promise<void>;
  /**
   * Runs `fn` against a freshly loaded state and persists whatever `fn`
   * left behind, queued behind every other in-flight mutate() call on this
   * store. This is the only way to avoid losing concurrent updates: two
   * bare load()/save() pairs from different call sites can race, each
   * overwriting the other's change, because save() replaces the whole file.
   */
  mutate<T>(fn: (state: ReadingState) => T | Promise<T>): Promise<ReadingStateMutation<T>>;
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
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ReadingState> {
    try {
      const raw = await fileSystem.readFile(statePath, "utf8");
      return parseReadingState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissingFile(error)) {
        return createEmptyReadingState();
      }
      throw error;
    }
  }

  async function writeState(state: ReadingState): Promise<void> {
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
  }

  // Serializes every write against `temporaryPath` (shared with mutate())
  // behind one queue, so a bare save() can't race a concurrent mutate() and
  // lose either side's update.
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const turn = queue.then(work);
    // A failed turn must not wedge the queue for the next caller; the
    // rejection itself is still delivered to whoever awaited `turn`.
    queue = turn.catch(() => undefined);
    return turn;
  }

  function save(state: ReadingState): Promise<void> {
    return enqueue(() => writeState(state));
  }

  function mutate<T>(fn: (state: ReadingState) => T | Promise<T>): Promise<ReadingStateMutation<T>> {
    return enqueue(async () => {
      const state = await load();
      const result = await fn(state);
      await writeState(state);
      return { state, result };
    });
  }

  return { load, save, mutate };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}
