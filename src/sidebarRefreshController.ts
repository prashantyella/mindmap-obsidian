export interface SidebarRefreshTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: SidebarRefreshTimers = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/** Owns sidebar debounce and request generations without owning any DOM. */
export class SidebarRefreshController {
  private lookupTimer: unknown = null;
  private noteTimer: unknown = null;
  private indexTimer: unknown = null;
  private lookupGeneration = 0;
  private noteGeneration = 0;
  private noteTimerGeneration = 0;
  private closed = false;

  constructor(
    private readonly callbacks: { runLookup(): void; refreshNote(): void; refreshIndex?(): void },
    private readonly timers: SidebarRefreshTimers = browserTimers,
  ) {}

  scheduleLookup(): number {
    this.cancelLookupTimer();
    const generation = ++this.lookupGeneration;
    this.lookupTimer = this.timers.setTimeout(() => {
      this.lookupTimer = null;
      if (!this.closed && generation === this.lookupGeneration) this.callbacks.runLookup();
    }, 350);
    return generation;
  }

  invalidateLookup(): number {
    this.cancelLookupTimer();
    return ++this.lookupGeneration;
  }

  scheduleNoteRefresh(): number {
    this.cancelNoteTimer();
    const generation = this.noteTimerGeneration;
    this.noteTimer = this.timers.setTimeout(() => {
      if (this.closed || generation !== this.noteTimerGeneration) return;
      this.noteTimer = null;
      this.callbacks.refreshNote();
    }, 1_000);
    return this.noteGeneration;
  }

  invalidateNoteRequest(): number {
    this.cancelNoteTimer();
    return ++this.noteGeneration;
  }

  scheduleIndexRefresh(): void {
    if (this.indexTimer !== null) this.timers.clearTimeout(this.indexTimer);
    this.indexTimer = this.timers.setTimeout(() => {
      this.indexTimer = null;
      if (!this.closed) this.callbacks.refreshIndex?.();
    }, 1_000);
  }

  isCurrentLookup(generation: number): boolean {
    return !this.closed && generation === this.lookupGeneration;
  }

  isCurrentNote(generation: number): boolean {
    return !this.closed && generation === this.noteGeneration;
  }

  close(): void {
    this.closed = true;
    this.invalidateLookup();
    this.invalidateNoteRequest();
    if (this.indexTimer !== null) this.timers.clearTimeout(this.indexTimer);
    this.indexTimer = null;
  }

  private cancelLookupTimer(): void {
    if (this.lookupTimer !== null) this.timers.clearTimeout(this.lookupTimer);
    this.lookupTimer = null;
  }

  private cancelNoteTimer(): void {
    this.noteTimerGeneration += 1;
    if (this.noteTimer !== null) this.timers.clearTimeout(this.noteTimer);
    this.noteTimer = null;
  }
}
