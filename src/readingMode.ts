import {
  annotationIsTooShort,
  type AppleBooksReaderPayload,
  validateAppleBooksReaderPayload,
} from "./readingTypes";

export const READING_POLL_MS = 60_000;
export const READING_DEBOUNCE_MS = 10_000;

export type ReadingMode = "standard" | "reading";
export type ReadingActivity = "disabled" | "setup" | "ready" | "syncing" | "processing" | "error";

export interface ReadingPreview {
  annotationCount: number;
  eligibleCount: number;
  tooShortCount: number;
}

export interface ReadingHealth {
  mode: ReadingMode;
  activity: ReadingActivity;
  annotationCount: number;
  eligibleCount: number;
  pendingCount: number;
  importedCount: number;
  unresearchableCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ReadingImportItem {
  annotationId: string;
  notePath: string;
  action: "created" | "updated" | "unchanged";
  eligible: boolean;
}

export interface ReadingImportResult {
  imported: ReadingImportItem[];
  failures: Array<{ annotationId?: string; stage: string; message: string }>;
  lastSyncAt: string | null;
  initialImport: boolean;
}

export interface ReadingModeClock {
  now(): number;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EnableOutcome {
  enabled: boolean;
  initialImport: boolean;
}

export interface ReadingModeDependencies {
  readPayload(): Promise<unknown>;
  readFingerprint(): Promise<string>;
  importPayload(payload: unknown): Promise<ReadingImportResult>;
  waitForManualResearch?(): Promise<void>;
  runAutomaticResearch?(imported: ReadingImportItem[]): Promise<void>;
  onAutomaticResearchError?(message: string): void;
  listPendingEligibleNotes(): Promise<string[]>;
  countUnresearchable(): Promise<number>;
  processNote(notePath: string): Promise<boolean>;
  markProcessed(notePath: string): Promise<void>;
  confirmSetup(preview: ReadingPreview): Promise<boolean>;
  onModeChange?(mode: ReadingMode): void | Promise<void>;
  onHealthChange?(health: ReadingHealth): void;
  clock?: ReadingModeClock;
  initiallyEnabled?: boolean;
}

const defaultClock: ReadingModeClock = {
  now: () => Date.now(),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ReadingModeController {
  private readonly deps: ReadingModeDependencies;
  private readonly clock: ReadingModeClock;
  private mode: ReadingMode;
  private health: ReadingHealth;
  private pollHandle: unknown = null;
  private debounceHandle: unknown = null;
  private syncPromise: Promise<void> | null = null;
  private syncRequested = false;
  private processingPromise: Promise<void> | null = null;
  private backlogPromise: Promise<void> | null = null;
  private lastFingerprint: string | null = null;
  private lastSyncWasInitialImport = false;

  constructor(deps: ReadingModeDependencies) {
    this.deps = deps;
    this.clock = deps.clock ?? defaultClock;
    this.mode = deps.initiallyEnabled ? "reading" : "standard";
    this.health = {
      mode: this.mode,
      activity: this.mode === "reading" ? "ready" : "disabled",
      annotationCount: 0,
      eligibleCount: 0,
      pendingCount: 0,
      importedCount: 0,
      unresearchableCount: 0,
      lastSyncAt: null,
      lastError: null,
    };
  }

  getHealth(): ReadingHealth {
    return { ...this.health };
  }

  getMode(): ReadingMode {
    return this.mode;
  }

  async start(): Promise<void> {
    if (this.mode !== "reading") {
      return;
    }
    await this.syncNow();
    this.armWatcher();
  }

  async enable(): Promise<EnableOutcome> {
    if (this.mode === "reading") {
      return { enabled: true, initialImport: false };
    }
    this.setHealth({ mode: "standard", activity: "setup", lastError: null });
    let preview: ReadingPreview;
    try {
      preview = await this.previewSetup();
    } catch (error) {
      this.setHealth({ activity: "error", lastError: errorMessage(error) });
      return { enabled: false, initialImport: false };
    }
    if (!(await this.deps.confirmSetup(preview))) {
      this.setHealth({ mode: "standard", activity: "disabled", lastError: null });
      return { enabled: false, initialImport: false };
    }
    this.mode = "reading";
    try {
      await this.deps.onModeChange?.("reading");
    } catch (error) {
      this.mode = "standard";
      this.setHealth({ mode: "standard", activity: "error", lastError: `Could not persist Reading Mode: ${errorMessage(error)}` });
      return { enabled: false, initialImport: false };
    }
    this.setHealth({ mode: "reading", activity: "ready", lastError: null });
    this.lastSyncWasInitialImport = false;
    await this.syncNow();
    this.armWatcher();
    return { enabled: true, initialImport: this.lastSyncWasInitialImport };
  }

  async disable(): Promise<void> {
    if (this.mode === "standard") {
      return;
    }
    const previousMode = this.mode;
    this.mode = "standard";
    this.stopTimers();
    this.syncRequested = false;
    this.lastFingerprint = null;
    try {
      await this.deps.onModeChange?.("standard");
    } catch (error) {
      this.mode = previousMode;
      this.armWatcher();
      this.setHealth({ mode: previousMode, activity: "error", lastError: `Could not persist Standard Mode: ${errorMessage(error)}` });
      return;
    }
    this.setHealth({ mode: "standard", activity: "disabled", lastError: null });
  }

  async dispose(): Promise<void> {
    this.stopTimers();
    this.syncRequested = false;
    this.mode = "standard";
    this.setHealth({ mode: "standard", activity: "disabled" });
  }

  async syncNow(): Promise<void> {
    if (this.mode !== "reading") {
      return;
    }
    while (this.backlogPromise) {
      await this.backlogPromise;
      if (this.mode !== "reading") {
        return;
      }
    }
    if (this.syncPromise) {
      this.syncRequested = true;
      return this.syncPromise;
    }
    this.syncPromise = this.performSync().finally(() => {
      this.syncPromise = null;
      if (this.syncRequested && this.mode === "reading") {
        this.syncRequested = false;
        void this.syncNow();
      }
    });
    return this.syncPromise;
  }

  requestSync(): void {
    if (this.mode !== "reading") {
      return;
    }
    if (this.syncPromise) {
      this.syncRequested = true;
      return;
    }
    if (this.debounceHandle !== null) {
      return;
    }
    this.debounceHandle = this.clock.setTimeout(() => {
      this.debounceHandle = null;
      void this.syncNow();
    }, READING_DEBOUNCE_MS);
  }

  private async previewSetup(): Promise<ReadingPreview> {
    const payload = validateAppleBooksReaderPayload(await this.deps.readPayload());
    const tooShortCount = payload.annotations.filter(annotationIsTooShort).length;
    return {
      annotationCount: payload.annotations.length,
      eligibleCount: payload.annotations.length - tooShortCount,
      tooShortCount,
    };
  }

  private async performSync(): Promise<void> {
    this.setHealth({ activity: "syncing", lastError: null });
    try {
      await this.deps.waitForManualResearch?.();
      if (this.mode !== "reading") return;
      const rawPayload = await this.deps.readPayload();
      const payload = validateAppleBooksReaderPayload(rawPayload) as AppleBooksReaderPayload;
      const tooShortCount = payload.annotations.filter(annotationIsTooShort).length;
      const result = await this.deps.importPayload(payload);
      if (this.mode !== "reading") {
        return;
      }
      this.lastSyncWasInitialImport = result.initialImport && result.failures.length === 0;
      const importError = result.failures[0]?.message ?? null;
      this.setHealth({
        activity: importError ? "error" : "ready",
        annotationCount: payload.annotations.length,
        eligibleCount: payload.annotations.length - tooShortCount,
        lastSyncAt: result.lastSyncAt,
        importedCount: this.health.importedCount + result.imported.filter((item) => item.action !== "unchanged").length,
        lastError: importError,
      });
      if (result.initialImport) {
        const pending = await this.deps.listPendingEligibleNotes();
        this.setHealth({ pendingCount: pending.length });
        if (this.mode === "reading") {
          this.lastFingerprint = await this.deps.readFingerprint();
        }
        return;
      }
      let automaticError: string | null = null;
      try {
        await this.deps.runAutomaticResearch?.(result.imported);
      } catch (error) {
        automaticError = `Automatic research paused: ${errorMessage(error)}`;
        this.deps.onAutomaticResearchError?.(automaticError);
      }
      await this.processImported(result.imported, importError ?? automaticError);
      if (this.mode === "reading") {
        this.lastFingerprint = await this.deps.readFingerprint();
      }
    } catch (error) {
      this.setHealth({ activity: "error", lastError: errorMessage(error) });
    }
  }

  async processBacklog(): Promise<void> {
    if (this.mode !== "reading") return;
    if (this.backlogPromise) return this.backlogPromise;

    const operation = (async () => {
      while (this.syncPromise) {
        await this.syncPromise;
        if (this.mode !== "reading") return;
      }
      while (this.processingPromise) {
        await this.processingPromise;
        if (this.mode !== "reading") return;
      }
      const pending = await this.deps.listPendingEligibleNotes();
      if (this.mode !== "reading") return;
      await this.processNotes(pending, null);
    })();
    const guarded = operation.finally(() => {
      if (this.backlogPromise === guarded) this.backlogPromise = null;
    });
    this.backlogPromise = guarded;
    return guarded;
  }

  private async processImported(imported: ReadingImportItem[], initialError: string | null): Promise<void> {
    const paths = imported
      .filter((item) => item.eligible && item.action !== "unchanged")
      .map((item) => item.notePath);
    return this.processNotes(paths, initialError);
  }

  private async processNotes(paths: string[], initialError: string | null): Promise<void> {
    if (this.processingPromise) {
      return this.processingPromise;
    }
    this.processingPromise = (async () => {
      if (this.mode !== "reading") {
        return;
      }
      this.setHealth({ activity: paths.length > 0 ? "processing" : this.health.activity, pendingCount: paths.length });
      let firstFailure: string | null = null;
      for (const notePath of paths) {
        if (this.mode !== "reading") {
          return;
        }
        try {
          const succeeded = await this.deps.processNote(notePath);
          if (this.mode !== "reading") {
            return;
          }
          if (succeeded) {
            await this.deps.markProcessed(notePath);
          } else if (!firstFailure) {
            firstFailure = `Reading note processing failed: ${notePath}`;
          }
        } catch (error) {
          if (!firstFailure) {
            firstFailure = errorMessage(error);
          }
        }
      }
      const remaining = await this.deps.listPendingEligibleNotes();
      if (this.mode !== "reading") return;
      const unresearchableCount = await this.deps.countUnresearchable();
      const actionableError = firstFailure ?? initialError;
      this.setHealth({
        activity: actionableError ? "error" : "ready",
        pendingCount: remaining.length,
        unresearchableCount,
        lastError: actionableError,
      });
    })().finally(() => {
      this.processingPromise = null;
    });
    return this.processingPromise;
  }

  private armWatcher(): void {
    if (this.pollHandle !== null || this.mode !== "reading") {
      return;
    }
    this.pollHandle = this.clock.setInterval(() => {
      void this.pollDatabase();
    }, READING_POLL_MS);
  }

  private async pollDatabase(): Promise<void> {
    if (this.mode !== "reading") {
      return;
    }
    try {
      const fingerprint = await this.deps.readFingerprint();
      if (this.lastFingerprint === null) {
        this.lastFingerprint = fingerprint;
        return;
      }
      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint;
        this.requestSync();
      }
    } catch (error) {
      this.setHealth({ activity: "error", lastError: errorMessage(error) });
    }
  }

  private stopTimers(): void {
    if (this.pollHandle !== null) {
      this.clock.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.debounceHandle !== null) {
      this.clock.clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
  }

  private setHealth(patch: Partial<ReadingHealth>): void {
    this.health = { ...this.health, ...patch, mode: patch.mode ?? this.mode };
    this.deps.onHealthChange?.(this.getHealth());
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Reading Mode error.";
}
