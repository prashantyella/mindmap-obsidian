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
}

export function createObsidianVaultApi(vault: Vault): ReadingVault {
  const wrap = (raw: TAbstractFile | null): VaultEntry | null => raw ? { path: raw.path, raw } : null;
  return {
    get: (path) => wrap(vault.getAbstractFileByPath(path)),
    read: async (entry) => await vault.cachedRead(entry.raw as TFile),
    create: async (path, content) => wrap(await vault.create(path, content)) as VaultEntry,
    modify: async (entry, content) => await vault.modify(entry.raw as TFile, content),
    createFolder: async (path) => {
      await vault.createFolder(path);
    },
  };
}
