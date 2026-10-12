import type { SidebarRefreshTimers } from "./sidebarRefreshController";

/** Delays feedback for fast queries and preserves it across renders of one request. */
export class SidebarLoadingController {
  private request: string | null = null;
  private timer: unknown = null;
  private generation = 0;
  private visible = false;
  private closed = false;

  constructor(
    private readonly onVisibilityChange: (visible: boolean) => void,
    private readonly timers: SidebarRefreshTimers,
  ) {}

  update(request: string | null): void {
    if (this.closed || request === this.request) return;
    this.cancelTimer();
    this.request = request;
    this.setVisible(false);
    if (request === null) return;
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      if (this.closed || generation !== this.generation) return;
      this.timer = null;
      this.setVisible(true);
    }, 250);
  }

  close(): void {
    this.closed = true;
    this.request = null;
    this.cancelTimer();
    this.setVisible(false);
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.onVisibilityChange(visible);
  }
}
