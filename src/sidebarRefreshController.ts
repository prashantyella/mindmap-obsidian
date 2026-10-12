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
  private indexTimerGeneration = 0;
  private typingTimer: unknown = null;
  private typingGeneration = 0;
  private typing = false;
  private notePending = false;
  private indexPending = false;
  private lookupGeneration = 0;
  private noteGeneration = 0;
  private noteTimerGeneration = 0;
  private closed = false;

  constructor(
    private readonly callbacks: { runLookup(): void; refreshNote(): void; refreshIndex?(): void; typingEnded?(): void },
    private readonly timers: SidebarRefreshTimers = browserTimers,
  ) {}

  scheduleLookup(): number {
    if (this.closed) return this.lookupGeneration;
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
    if (this.closed) return this.noteGeneration;
    if (this.typing) { this.notePending = true; return this.noteGeneration; }
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
    if (this.closed) return;
    if (this.typing) { this.indexPending = true; return; }
    // Bounded coalescing, not a trailing debounce: continuous commits must not starve refreshes.
    if (this.indexTimer !== null) return;
    const generation = ++this.indexTimerGeneration;
    this.indexTimer = this.timers.setTimeout(() => {
      if (this.closed || generation !== this.indexTimerGeneration) return;
      this.indexTimer = null;
      this.callbacks.refreshIndex?.();
    }, 1_000);
  }

  recordTyping(): void {
    if (this.closed) return;
    this.typing = true;
    this.notePending = true;
    this.cancelNoteTimer();
    if (this.indexTimer !== null) this.indexPending = true;
    this.cancelIndexTimer();
    if (this.typingTimer !== null) this.timers.clearTimeout(this.typingTimer);
    const generation = ++this.typingGeneration;
    this.typingTimer = this.timers.setTimeout(() => {
      if (this.closed || generation !== this.typingGeneration) return;
      this.typingTimer = null;
      this.typing = false;
      const indexPending = this.indexPending;
      const notePending = this.notePending;
      this.indexPending = this.notePending = false;
      if (indexPending) this.callbacks.refreshIndex?.();
      else if (notePending) this.callbacks.refreshNote();
      this.callbacks.typingEnded?.();
    }, 2_000);
  }

  isTyping(): boolean { return this.typing; }

  resetTyping(): void {
    this.typingGeneration += 1;
    if (this.typingTimer !== null) this.timers.clearTimeout(this.typingTimer);
    this.typingTimer = null;
    this.typing = false;
    this.indexPending = this.notePending = false;
    this.cancelIndexTimer();
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
    this.resetTyping();
  }

  private cancelIndexTimer(): void {
    this.indexTimerGeneration += 1;
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
