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
 * The real TFile constructor is injected by main.ts. A dynamic
 * `import("obsidian")` cannot be used here because Obsidian exposes that
 * package to the plugin bundle as an external CommonJS dependency, not as
 * a browser-resolvable dynamic module specifier.
 */
function asFile(entry: VaultEntry, TFileClass: abstract new (...args: never[]) => TFile): TFile {
  if (!(entry.raw instanceof TFileClass)) {
    throw new Error(`Expected a file at ${entry.path}, but it is not a TFile.`);
  }
  return entry.raw;
}

export function createObsidianVaultApi(vault: Vault, TFileClass: abstract new (...args: never[]) => TFile): ReadingVault {
  const wrap = (raw: TAbstractFile | null): VaultEntry | null => raw ? { path: raw.path, raw } : null;
  return {
    get: (path) => wrap(vault.getAbstractFileByPath(path)),
    read: async (entry) => await vault.cachedRead(asFile(entry, TFileClass)),
    create: async (path, content) => wrap(await vault.create(path, content)) as VaultEntry,
    modify: async (entry, content) => await vault.modify(asFile(entry, TFileClass), content),
    createFolder: async (path) => {
      await vault.createFolder(path);
    },
    rename: async (entry, newPath) => {
      await vault.rename(asFile(entry, TFileClass), newPath);
    },
  };
}
