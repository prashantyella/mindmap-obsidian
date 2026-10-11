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
  private lookupTimer: unknown | null = null;
  private noteTimer: unknown | null = null;
  private lookupGeneration = 0;
  private noteGeneration = 0;
  private closed = false;

  constructor(
    private readonly callbacks: { runLookup(): void; refreshNote(): void },
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
    if (this.noteTimer !== null) this.timers.clearTimeout(this.noteTimer);
    const generation = ++this.noteGeneration;
    this.noteTimer = this.timers.setTimeout(() => {
      this.noteTimer = null;
      if (!this.closed && generation === this.noteGeneration) this.callbacks.refreshNote();
    }, 1_000);
    return generation;
  }

  invalidateNoteRequest(): number {
    return ++this.noteGeneration;
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
    if (this.noteTimer !== null) this.timers.clearTimeout(this.noteTimer);
    this.noteTimer = null;
  }

  private cancelLookupTimer(): void {
    if (this.lookupTimer !== null) this.timers.clearTimeout(this.lookupTimer);
    this.lookupTimer = null;
  }
}
