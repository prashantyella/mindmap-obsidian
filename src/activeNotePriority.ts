import type { SidebarRefreshTimers } from "./sidebarRefreshController";

/** Coalesces edits; priority applies only to the latest saved active note after idle. */
export class ActiveNotePriority {
  private path: string | null = null;
  private timer: unknown = null;
  private request: AbortController | null = null;
  private generation = 0;
  private closed = false;

  constructor(
    private readonly callbacks: { clear(): void; isSaved(path: string): boolean; prioritize(path: string, signal: AbortSignal): Promise<void> },
    private readonly timers: SidebarRefreshTimers,
  ) {}

  select(path: string | null): void {
    if (this.closed || path === this.path) return;
    this.path = path;
    this.edited(path);
  }

  edited(path: string | null): void {
    if (this.closed || path !== this.path) return;
    this.cancel();
    this.callbacks.clear();
    if (path === null) return;
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => this.dispatch(path, generation), 2_000);
  }

  close(): void { this.closed = true; this.cancel(); this.callbacks.clear(); }

  private cancel(): void {
    this.generation++;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.request?.abort();
    this.request = null;
  }

  private dispatch(path: string, generation: number): void {
    if (this.closed || generation !== this.generation || path !== this.path) return;
    this.timer = null;
    if (!this.callbacks.isSaved(path)) {
      this.timer = this.timers.setTimeout(() => this.dispatch(path, generation), 500);
      return;
    }
    const controller = new AbortController();
    this.request = controller;
    void this.callbacks.prioritize(path, controller.signal).catch(() => undefined).finally(() => {
      if (this.request === controller) this.request = null;
    });
  }
}
