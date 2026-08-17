import { TFile, type EventRef, type TAbstractFile, type Vault } from "obsidian";

export function registerVaultRefreshEvents(
  vault: Vault,
  registerEvent: (event: EventRef) => void,
  requestRefresh: (reason: string, paths?: string[]) => void,
): void {
  const markDirty = (file: TAbstractFile | null, oldPath?: string) => {
    const paths: string[] = [];
    if (oldPath?.endsWith(".md")) {
      paths.push(oldPath);
    }
    if (file instanceof TFile && file.extension === "md") {
      paths.push(file.path);
    }
    if (paths.length > 0) {
      requestRefresh("vault file changed", paths);
    }
  };

  registerEvent(vault.on("create", (file) => markDirty(file)));
  registerEvent(vault.on("modify", (file) => markDirty(file)));
  registerEvent(vault.on("delete", (file) => markDirty(file)));
  registerEvent(vault.on("rename", (file, oldPath) => markDirty(file, oldPath)));
}
