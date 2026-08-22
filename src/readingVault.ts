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
 * "obsidian" is imported dynamically here (rather than as a normal
 * top-level value import) so this module stays free of any real runtime
 * dependency on the types-only "obsidian" package at load time --
 * createObsidianVaultApi() is only ever called from main.ts in practice,
 * never from a test importing this module for its types/fakes, so the
 * dynamic import only actually resolves inside the real Obsidian runtime.
 */
async function asFile(entry: VaultEntry): Promise<TFile> {
  const { TFile: TFileClass } = await import("obsidian");
  if (!(entry.raw instanceof TFileClass)) {
    throw new Error(`Expected a file at ${entry.path}, but it is not a TFile.`);
  }
  return entry.raw;
}

export function createObsidianVaultApi(vault: Vault): ReadingVault {
  const wrap = (raw: TAbstractFile | null): VaultEntry | null => raw ? { path: raw.path, raw } : null;
  return {
    get: (path) => wrap(vault.getAbstractFileByPath(path)),
    read: async (entry) => await vault.cachedRead(await asFile(entry)),
    create: async (path, content) => wrap(await vault.create(path, content)) as VaultEntry,
    modify: async (entry, content) => await vault.modify(await asFile(entry), content),
    createFolder: async (path) => {
      await vault.createFolder(path);
    },
    rename: async (entry, newPath) => {
      await vault.rename(await asFile(entry), newPath);
    },
  };
}
