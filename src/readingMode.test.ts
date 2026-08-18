import test from "node:test";
import assert from "node:assert/strict";

import { ReadingModeController, READING_DEBOUNCE_MS, READING_POLL_MS, type ReadingModeClock, type ReadingPreview } from "./readingMode";

const payload = {
  version: 1,
  status: "success" as const,
  count: 2,
  diagnostics: [],
  annotations: [
    { annotation_id: "one", quote: "one two three four five six seven eight", book_title: "Book", created_at: "2026-08-17T00:00:00Z" },
    { annotation_id: "two", quote: "one two", book_title: "Book", created_at: "2026-08-17T00:00:00Z" },
  ],
};

class FakeClock implements ReadingModeClock {
  nowValue = 0;
  nextId = 1;
  intervals = new Map<number, () => void>();
  timeouts = new Map<number, { callback: () => void; due: number }>();

  now(): number { return this.nowValue; }
  setInterval(callback: () => void): number {
    const id = this.nextId++;
    this.intervals.set(id, callback);
    return id;
  }
  clearInterval(handle: unknown): void { this.intervals.delete(handle as number); }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, due: this.nowValue + delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timeouts.delete(handle as number); }
  async advance(delayMs: number): Promise<void> {
    this.nowValue += delayMs;
    const due = [...this.timeouts.entries()].filter(([, timer]) => timer.due <= this.nowValue);
    for (const [id, timer] of due) {
      this.timeouts.delete(id);
      timer.callback();
    }
    await Promise.resolve();
    await Promise.resolve();
  }
  poll(): void { for (const callback of this.intervals.values()) callback(); }
}

function deps(clock: FakeClock, overrides: Partial<ConstructorParameters<typeof ReadingModeController>[0]> = {}) {
  let fingerprint = "one";
  let fingerprintReads = 0;
  let confirmations = 0;
  const events: string[] = [];
  let imports = 0;
  const options: ConstructorParameters<typeof ReadingModeController>[0] = {
    clock,
    readPayload: async () => payload,
    readFingerprint: async () => { fingerprintReads += 1; return fingerprint; },
    importPayload: async () => {
      imports += 1;
      events.push(`import-${imports}`);
      return {
        imported: [{ annotationId: "one", notePath: "Books/one.md", action: "created" as const, eligible: true }],
        failures: [],
        lastSyncAt: "2026-08-17T01:00:00Z",
      };
    },
    listPendingEligibleNotes: async () => [],
    processNote: async (notePath) => { events.push(`process-${notePath}`); return true; },
    markProcessed: async (notePath) => { events.push(`mark-${notePath}`); },
    confirmSetup: async (_preview: ReadingPreview) => { confirmations += 1; return true; },
    ...overrides,
  };
  return {
    options,
    events,
    setFingerprint: (value: string) => { fingerprint = value; },
    getImports: () => imports,
    getFingerprintReads: () => fingerprintReads,
    getConfirmations: () => confirmations,
  };
}

test("cancelling first-use confirmation does not enable or import", async () => {
  const clock = new FakeClock();
  const setup = deps(clock, { confirmSetup: async () => false });
  const controller = new ReadingModeController(setup.options);

  assert.equal(await controller.enable(), false);
  assert.equal(controller.getMode(), "standard");
  assert.equal(setup.getImports(), 0);
  assert.equal(controller.getHealth().activity, "disabled");
});

test("confirmed enable previews, immediately syncs, and processes eligible notes sequentially", async () => {
  const clock = new FakeClock();
  let preview: ReadingPreview | null = null;
  let confirmationCalls = 0;
  const setup = deps(clock, { confirmSetup: async (value) => { preview = value; confirmationCalls += 1; return true; } });
  const controller = new ReadingModeController(setup.options);

  assert.equal(await controller.enable(), true);
  assert.deepEqual(preview, { annotationCount: 2, eligibleCount: 1, tooShortCount: 1 });
  assert.deepEqual(setup.events, ["import-1", "process-Books/one.md", "mark-Books/one.md"]);
  assert.equal(confirmationCalls, 1);
  assert.equal(controller.getHealth().pendingCount, 0);
  assert.equal(clock.intervals.size, 1);
});

test("automatic hook failures are reported without blocking local Reading processing", async () => {
  const clock = new FakeClock();
  const automaticErrors: string[] = [];
  const setup = deps(clock, {
    runAutomaticResearch: async () => { throw new Error("policy store unavailable"); },
    onAutomaticResearchError: (message) => automaticErrors.push(message),
  });
  const controller = new ReadingModeController(setup.options);

  await controller.enable();

  assert.deepEqual(setup.events, ["import-1", "process-Books/one.md", "mark-Books/one.md"]);
  assert.deepEqual(automaticErrors, ["Automatic research paused: policy store unavailable"]);
  assert.equal(controller.getHealth().activity, "error");
  assert.match(controller.getHealth().lastError ?? "", /Automatic research paused/);
});

test("Reading sync waits for an existing manual research operation before importing and processing", async () => {
  const clock = new FakeClock();
  const order: string[] = [];
  const deferred = { release: () => {} };
  const manual = new Promise<void>((resolve) => { deferred.release = resolve; });
  const setup = deps(clock, {
    initiallyEnabled: true,
    waitForManualResearch: async () => { order.push("wait"); await manual; },
    importPayload: async () => { order.push("import"); return { imported: [{ annotationId: "one", notePath: "Books/one.md", action: "created", eligible: true }], failures: [], lastSyncAt: "now" }; },
    processNote: async (notePath) => { order.push(`process-${notePath}`); return true; },
  });
  const controller = new ReadingModeController(setup.options);
  const enabling = controller.start();
  await Promise.resolve();
  assert.deepEqual(order, ["wait"]);
  deferred.release();
  await enabling;
  assert.deepEqual(order, ["wait", "import", "process-Books/one.md"]);
});

test("a reader timeout/error releases sync state so a later Reading sync can recover", async () => {
  const clock = new FakeClock();
  let reads = 0;
  const setup = deps(clock, {
    initiallyEnabled: true,
    readPayload: async () => {
      reads += 1;
      if (reads === 1) throw new Error("Apple Books reader timed out after 60 seconds.");
      return payload;
    },
  });
  const controller = new ReadingModeController(setup.options);
  await controller.start();
  assert.equal(controller.getHealth().activity, "error");
  await controller.syncNow();
  assert.equal(setup.getImports(), 1);
  assert.equal(controller.getHealth().activity, "ready");
});

test("duplicate database triggers coalesce through one debounce and one follow-up sync", async () => {
  const clock = new FakeClock();
  const setup = deps(clock);
  const controller = new ReadingModeController(setup.options);
  await controller.enable();
  const before = setup.getImports();

  setup.setFingerprint("two");
  clock.poll();
  clock.poll();
  controller.requestSync();
  controller.requestSync();
  assert.equal(clock.timeouts.size, 1);
  await clock.advance(READING_DEBOUNCE_MS);

  assert.equal(setup.getImports(), before + 1);
});

test("initial and manual syncs establish the fingerprint baseline without a redundant poll sync", async () => {
  const clock = new FakeClock();
  const setup = deps(clock);
  const controller = new ReadingModeController(setup.options);
  await controller.enable();
  assert.equal(setup.getFingerprintReads(), 1);

  setup.setFingerprint("changed");
  await controller.syncNow();
  assert.equal(setup.getFingerprintReads(), 2);
  const importsAfterManualSync = setup.getImports();
  clock.poll();
  await clock.advance(READING_DEBOUNCE_MS);
  assert.equal(setup.getImports(), importsAfterManualSync);
});

test("reload starts one sync and disable/unload clears watcher and debounce timers", async () => {
  const clock = new FakeClock();
  const setup = deps(clock, { initiallyEnabled: true });
  const controller = new ReadingModeController(setup.options);
  await controller.start();
  assert.equal(setup.getImports(), 1);
  assert.equal(clock.intervals.size, 1);

  controller.requestSync();
  assert.equal(clock.timeouts.size, 1);
  await controller.disable();
  assert.equal(controller.getMode(), "standard");
  assert.equal(clock.intervals.size, 0);
  assert.equal(clock.timeouts.size, 0);

  await controller.dispose();
  assert.equal(controller.getHealth().activity, "disabled");
  assert.equal(READING_POLL_MS, 60_000);
});

test("processing failure remains pending and does not mark the note processed", async () => {
  const clock = new FakeClock();
  const marked: string[] = [];
  const setup = deps(clock, {
    listPendingEligibleNotes: async () => ["Books/retry.md"],
    processNote: async () => false,
    markProcessed: async (notePath) => { marked.push(notePath); },
  });
  const controller = new ReadingModeController(setup.options);

  await controller.enable();

  assert.deepEqual(marked, []);
  assert.equal(controller.getHealth().activity, "error");
  assert.equal(controller.getHealth().pendingCount, 1);
  assert.match(controller.getHealth().lastError ?? "", /failed/);
});

test("Reading sync sequences automatic research before note processing", async () => {
  const clock = new FakeClock();
  const order: string[] = [];
  const setup = deps(clock, {
    runAutomaticResearch: async () => { order.push("research"); },
    processNote: async () => { order.push("process"); return true; },
  });
  const controller = new ReadingModeController(setup.options);
  await controller.enable();
  assert.deepEqual(order, ["research", "process"]);
});

test("disabling during an in-flight note process prevents markProcessed", async () => {
  const clock = new FakeClock();
  let releaseProcess: (() => void) | undefined;
  const setup = deps(clock, {
    processNote: async () => await new Promise<boolean>((resolve) => { releaseProcess = () => resolve(true); }),
  });
  const controller = new ReadingModeController(setup.options);
  const enablePromise = controller.enable();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await controller.disable();
  releaseProcess?.();
  await enablePromise;

  assert.equal(setup.events.includes("mark-Books/one.md"), false);
  assert.equal(controller.getMode(), "standard");
});

test("disabling while pending notes load cannot leave Standard Mode processing", async () => {
  const clock = new FakeClock();
  let releasePending: (() => void) | undefined;
  const setup = deps(clock, {
    listPendingEligibleNotes: async () => await new Promise<string[]>((resolve) => { releasePending = () => resolve(["Books/late.md"]); }),
  });
  const controller = new ReadingModeController(setup.options);
  const enablePromise = controller.enable();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await controller.disable();
  releasePending?.();
  await enablePromise;

  assert.equal(controller.getMode(), "standard");
  assert.equal(controller.getHealth().activity, "disabled");
  assert.equal(setup.events.some((event) => event.includes("Books/late.md")), false);
});

test("partial import failures remain actionable after pending processing", async () => {
  const clock = new FakeClock();
  const setup = deps(clock, {
    importPayload: async () => ({ imported: [], failures: [{ stage: "note", message: "one note failed" }], lastSyncAt: "before" }),
  });
  const controller = new ReadingModeController(setup.options);

  await controller.enable();

  assert.equal(controller.getHealth().activity, "error");
  assert.equal(controller.getHealth().lastError, "one note failed");
});

test("mode persistence failure restores controller mode and reports an actionable error", async () => {
  const clock = new FakeClock();
  const setup = deps(clock, { onModeChange: async () => { throw new Error("settings write failed"); } });
  const controller = new ReadingModeController(setup.options);

  assert.equal(await controller.enable(), false);
  assert.equal(controller.getMode(), "standard");
  assert.equal(controller.getHealth().activity, "error");
  assert.match(controller.getHealth().lastError ?? "", /Could not persist Reading Mode/);
});
