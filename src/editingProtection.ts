import type { EventRef, MarkdownView, TFile, Vault, Workspace } from "obsidian";

export interface EditorSnapshot {
  path: string;
  focused: boolean;
  unsaved: boolean;
  content?: string;
}

export interface EditingProtectionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: EditingProtectionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export class EditingProtection {
  private readonly editedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly protectedPaths = new Set<string>();
  private readonly savedContent = new Map<string, string>();
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly snapshots: () => readonly EditorSnapshot[],
    private readonly clock: EditingProtectionClock = realClock,
    private readonly idleMs = 2_000,
  ) {}

  recordEdit(path: string): void {
    if (this.disposed || path.length === 0) return;
    this.editedAt.set(path, this.clock.now());
    this.scheduleNextTransition();
  }

  isProtected(path: string, savedContent?: string): boolean {
    if (this.disposed) return false;
    if (savedContent !== undefined) this.savedContent.set(path, savedContent);
    const lastEdit = this.editedAt.get(path);
    const protectedNow = (lastEdit !== undefined && this.clock.now() - lastEdit < this.idleMs)
      || this.snapshots().some((snapshot) => snapshot.path === path && this.snapshotProtected(snapshot));
    if (protectedNow) this.protectedPaths.add(path);
    else this.savedContent.delete(path);
    return protectedNow;
  }

  private snapshotProtected(snapshot: EditorSnapshot): boolean {
    const saved = this.savedContent.get(snapshot.path);
    return snapshot.focused || snapshot.unsaved
      || (saved !== undefined && snapshot.content !== undefined && snapshot.content !== saved);
  }

  recordSaved(path: string, content: string): void {
    if (this.disposed || !this.savedContent.has(path)) return;
    this.savedContent.set(path, content);
    this.refresh();
  }

  needsSavedContent(path: string): boolean {
    return !this.disposed && this.savedContent.has(path);
  }

  subscribeSafeTransition(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Call when focus/save/rename state changes; wakes work only if at least one path became safe. */
  refresh(): void {
    if (this.disposed) return;
    this.pruneAndNotify();
    this.scheduleNextTransition();
  }

  rename(oldPath: string, newPath: string): void {
    const edited = this.editedAt.get(oldPath);
    if (edited !== undefined) {
      this.editedAt.delete(oldPath);
      this.editedAt.set(newPath, edited);
    }
    const saved = this.savedContent.get(oldPath);
    if (saved !== undefined) {
      this.savedContent.delete(oldPath);
      this.savedContent.set(newPath, saved);
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.editedAt.clear();
    this.protectedPaths.clear();
    this.savedContent.clear();
    this.listeners.clear();
  }

  private pruneAndNotify(): void {
    const now = this.clock.now();
    for (const [path, edited] of this.editedAt) {
      if (now - edited >= this.idleMs) this.editedAt.delete(path);
    }
    let becameSafe = false;
    const snapshots = this.snapshots();
    for (const path of [...this.protectedPaths]) {
      const edited = this.editedAt.get(path);
      const stillProtected = (edited !== undefined && now - edited < this.idleMs)
        || snapshots.some((snapshot) => snapshot.path === path && this.snapshotProtected(snapshot));
      if (!stillProtected) {
        this.protectedPaths.delete(path);
        this.savedContent.delete(path);
        becameSafe = true;
      }
    }
    if (becameSafe) for (const listener of this.listeners) listener();
  }

  private scheduleNextTransition(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    const next = Math.min(...[...this.editedAt.values()].map((edited) => edited + this.idleMs));
    if (!Number.isFinite(next)) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pruneAndNotify();
      this.scheduleNextTransition();
    }, Math.max(0, next - this.clock.now()));
  }
}

export function createWorkspaceEditingProtection(workspace: Workspace, vault: Vault): { protection: EditingProtection; dispose(): void } {
  const snapshots = (): EditorSnapshot[] => workspace.getLeavesOfType("markdown").flatMap((leaf) => {
    const view = leaf.view as MarkdownView;
    if (!view.file || !view.editor || !view.containerEl) return [];
    if (view.getMode?.() === "preview") return [];
    const file = view.file;
    if (!file) return [];
    const activeElement = view.containerEl.ownerDocument.activeElement;
    return [{
      path: file.path,
      focused: activeElement !== null && view.containerEl.contains(activeElement),
      unsaved: view.editor.getValue() !== view.data,
      content: view.editor.getValue(),
    }];
  });
  const protection = new EditingProtection(snapshots);
  const documentCleanups = new Map<Document, () => void>();
  const observeDocuments = (): void => {
    for (const leaf of workspace.getLeavesOfType("markdown")) {
      const doc = leaf.view.containerEl.ownerDocument;
      if (documentCleanups.has(doc)) continue;
      const ownerWindow = doc.defaultView ?? window;
      let focusTimer: number | null = null;
      const onFocusChange = (): void => {
        if (focusTimer !== null) ownerWindow.clearTimeout(focusTimer);
        focusTimer = ownerWindow.setTimeout(() => {
          focusTimer = null;
          protection.refresh();
        }, 0);
      };
      doc.addEventListener("focusin", onFocusChange, true);
      doc.addEventListener("focusout", onFocusChange, true);
      documentCleanups.set(doc, () => {
        if (focusTimer !== null) ownerWindow.clearTimeout(focusTimer);
        doc.removeEventListener("focusin", onFocusChange, true);
        doc.removeEventListener("focusout", onFocusChange, true);
      });
    }
  };
  observeDocuments();
  const workspaceRefs: EventRef[] = [
    workspace.on("editor-change", (_editor, info) => { if (info.file) protection.recordEdit(info.file.path); }),
    workspace.on("active-leaf-change", () => protection.refresh()),
    workspace.on("file-open", () => protection.refresh()),
    workspace.on("layout-change", () => { observeDocuments(); protection.refresh(); }),
  ];
  const vaultRefs: EventRef[] = [
    vault.on("modify", (file) => {
      protection.refresh();
      if ((file as TFile).extension !== "md" || !protection.needsSavedContent(file.path)) return;
      void vault.read(file as TFile)
        .then((content) => protection.recordSaved(file.path, content))
        .catch(() => undefined);
    }),
    vault.on("rename", (file, oldPath) => protection.rename(oldPath, file.path)),
  ];
  return {
    protection,
    dispose: () => {
      for (const ref of workspaceRefs) workspace.offref(ref);
      for (const ref of vaultRefs) vault.offref(ref);
      for (const cleanup of documentCleanups.values()) cleanup();
      protection.dispose();
    },
  };
}
