import type { TAbstractFile, TFile, Vault } from "obsidian";

export interface VaultEntry {
  path: string;
  raw: unknown;
}

export interface ReadingVault {
  get(path: string): VaultEntry | null;
  read(entry: VaultEntry): Promise<string>;
  create(path: string, content: string): Promise<VaultEntry>;
  modify(entry: VaultEntry, content: string): Promise<void>;
  createFolder(path: string): Promise<void>;
  rename(entry: VaultEntry, newPath: string): Promise<void>;
}

/**
 * Every ReadingVault caller only ever reads/modifies/renames a file entry
 * (never a folder); this turns a wrong-shaped entry into a clear error
 * instead of an unchecked cast.
 *
 * "obsidian" is loaded lazily via `require` (rather than a normal top-level
 * value import, or a dynamic `import()`) so this module stays free of any
 * real runtime dependency on the types-only "obsidian" package at load
 * time -- createObsidianVaultApi() is only ever called from main.ts in
 * practice, never from a test importing this module for its types/fakes,
 * so this call only actually resolves inside the real Obsidian runtime.
 * `require`, not `import()`: esbuild preserves a dynamic `import()` of an
 * external bare specifier verbatim in the CommonJS bundle, and Obsidian's
 * CommonJS plugin loader can't resolve that form for "obsidian".
 */
function asFile(entry: VaultEntry): TFile {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately lazy/CJS (see doc comment above), not a static dependency on the runtime "obsidian" module.
  const { TFile: TFileClass } = require("obsidian") as { TFile: typeof TFile };
  if (!(entry.raw instanceof TFileClass)) {
    throw new Error(`Expected a file at ${entry.path}, but it is not a TFile.`);
  }
  return entry.raw;
}

export function createObsidianVaultApi(vault: Vault): ReadingVault {
  const wrap = (raw: TAbstractFile | null): VaultEntry | null => raw ? { path: raw.path, raw } : null;
  return {
    get: (path) => wrap(vault.getAbstractFileByPath(path)),
    read: async (entry) => await vault.cachedRead(asFile(entry)),
    create: async (path, content) => wrap(await vault.create(path, content)) as VaultEntry,
    modify: async (entry, content) => await vault.modify(asFile(entry), content),
    createFolder: async (path) => {
      await vault.createFolder(path);
    },
    rename: async (entry, newPath) => {
      await vault.rename(asFile(entry), newPath);
    },
  };
}
