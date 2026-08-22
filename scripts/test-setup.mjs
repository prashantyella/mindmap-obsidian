// Production source uses `window.setTimeout`/`window.clearTimeout`/etc.
// (the official Obsidian plugin guideline: obsidianmd/prefer-window-timers,
// needed for popout-window correctness inside the real app). The Node test
// runner has no DOM, so `window` is undefined there; this preload aliases it
// to globalThis so those same calls resolve to Node's real timer functions
// with correct `this` binding, without changing any production code path.
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
