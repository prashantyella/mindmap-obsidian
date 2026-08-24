import test from "node:test";
import assert from "node:assert/strict";

import type { IntervalRegistrar } from "../scheduling/coreScheduler";
import { EngineError } from "../engine/errors";
import type { MigrationStatusV1 } from "./migrationContract";
import { MigrationDriver } from "./migrationDriver";

function status(phase: MigrationStatusV1["phase"]): MigrationStatusV1 {
  return {
    schemaVersion: 1,
    phase,
    messageCode: "PLANNING",
    indexDependentFeaturesBlocked: phase !== "complete",
    discoveredCount: 0,
    processedCount: 0,
    failedCount: 0,
    canStart: phase === "not-started" || phase === "cancelled" || phase === "failed" || phase === "complete",
    canRetry: phase === "failed",
    canCancel: phase !== "activate" && phase !== "complete" && phase !== "cancelled" && phase !== "failed",
    updatedAtIso: new Date(0).toISOString(),
  };
}

/** Deterministic registrar -- tests drive ticks explicitly rather than depending on real timers, mirroring `coreScheduler.test.ts`'s own `ManualRegistrar`. */
class ManualRegistrar implements IntervalRegistrar {
  registered: { callback: () => void; intervalMs: number }[] = [];
  cancelled: unknown[] = [];
  registerInterval(callback: () => void, intervalMs: number): unknown {
    const handle = { callback, intervalMs };
    this.registered.push(handle);
    return handle;
  }
  cancelInterval(handle: unknown): void {
    this.cancelled.push(handle);
  }
  fireAll(): void {
    for (const handle of [...this.registered]) {
      if (!this.cancelled.includes(handle)) handle.callback();
    }
  }
}

/** A controllable fake `MigrationRunner.reconcile()` -- each call resolves an externally-held deferred so a test can observe exactly how many reconcile passes ran and control when each one settles. */
function deferredRunner() {
  let calls = 0;
  const pending: { resolve: (status: MigrationStatusV1) => void; reject: (error: unknown) => void }[] = [];
  return {
    calls: () => calls,
    runner: {
      reconcile(): Promise<MigrationStatusV1> {
        calls += 1;
        return new Promise<MigrationStatusV1>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      },
    },
    settleNext(next: MigrationStatusV1): void {
      const entry = pending.shift();
      if (!entry) throw new Error("no pending reconcile() call to settle");
      entry.resolve(next);
    },
    rejectNext(error: unknown): void {
      const entry = pending.shift();
      if (!entry) throw new Error("no pending reconcile() call to settle");
      entry.reject(error);
    },
    pendingCount: () => pending.length,
  };
}

void test("start() registers exactly one interval and performs one immediate reconcile", async () => {
  const registrar = new ManualRegistrar();
  const { runner, calls, settleNext } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar, intervalMs: 5_000 });
  driver.start();
  assert.equal(registrar.registered.length, 1);
  assert.equal(calls(), 1);
  settleNext(status("complete"));
  await Promise.resolve();
  await Promise.resolve();
});

void test("start() is idempotent -- calling twice registers only one interval", () => {
  const registrar = new ManualRegistrar();
  const { runner } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start();
  driver.start();
  assert.equal(registrar.registered.length, 1);
});

void test("single-flight: a kick arriving while a reconcile is already in-flight never starts a second concurrent reconcile call", async () => {
  const registrar = new ManualRegistrar();
  const { runner, calls } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start(); // first reconcile in flight
  assert.equal(calls(), 1);
  driver.notifyProgress(); // must NOT start a second concurrent reconcile
  driver.notifyProgress();
  registrar.fireAll(); // interval tick also must not start a second concurrent reconcile
  assert.equal(calls(), 1, "no second reconcile() call may begin while one is still pending");
});

void test("lost-wakeup safety: a kick that arrives while reconcile is in-flight is never dropped -- it causes exactly one more pass once the first settles", async () => {
  const registrar = new ManualRegistrar();
  const { runner, calls, settleNext } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start();
  assert.equal(calls(), 1);
  driver.notifyProgress(); // arrives mid-flight -- must not be silently dropped
  settleNext(status("build")); // first pass settles, non-terminal
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls(), 2, "the kick that arrived mid-flight must trigger exactly one more reconcile pass");
  settleNext(status("build"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls(), 2, "with no further kick requested, the loop must stop after settling on a non-terminal phase rather than spinning forever");
});

void test("stops re-kicking itself once reconcile reports a terminal phase, with no further kick pending", async () => {
  const registrar = new ManualRegistrar();
  const { runner, calls, settleNext } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start();
  settleNext(status("complete"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls(), 1);
  registrar.fireAll(); // interval tick after terminal phase: reconcile() is cheap/idempotent on a terminal state, still invoked
  assert.equal(calls(), 2);
});

void test("restart-safety: a fresh MigrationDriver instance calling start() again reconciles from whatever the runner itself reports, with no in-memory state carried over", async () => {
  const registrar = new ManualRegistrar();
  const { runner, settleNext } = deferredRunner();
  const first = new MigrationDriver({ runner, registrar });
  first.start();
  settleNext(status("build"));
  await Promise.resolve();
  await Promise.resolve();
  first.dispose();

  const { runner: runner2, calls: calls2, settleNext: settleNext2 } = deferredRunner();
  const second = new MigrationDriver({ runner: runner2, registrar });
  second.start();
  assert.equal(calls2(), 1, "a fresh driver instance always reconciles on its own first start(), independent of any prior instance");
  settleNext2(status("complete"));
  await Promise.resolve();
});

void test("stop() cancels the interval and prevents further scheduled kicks; a later start() re-registers", () => {
  const registrar = new ManualRegistrar();
  const { runner, calls, settleNext } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start();
  settleNext(status("complete"));
  driver.stop();
  assert.equal(registrar.cancelled.length, 1);
  registrar.fireAll(); // stale handle -- must be a no-op
  assert.equal(calls(), 1);
  driver.start();
  assert.equal(registrar.registered.length, 2);
});

void test("dispose() prevents any further reconcile even if notifyProgress() is called afterward", async () => {
  const registrar = new ManualRegistrar();
  const { runner, calls, settleNext } = deferredRunner();
  const driver = new MigrationDriver({ runner, registrar });
  driver.start();
  settleNext(status("complete"));
  await Promise.resolve();
  driver.dispose();
  driver.notifyProgress();
  driver.start(); // disposed -- must refuse to resume
  assert.equal(calls(), 1);
});

void test("a throwing reconcile() reports a closed EngineErrorCode via onFault, never a raw error message, and stops that pass's loop", async () => {
  const registrar = new ManualRegistrar();
  const { runner, settleNext, rejectNext } = deferredRunner();
  const faults: string[] = [];
  const driver = new MigrationDriver({ runner, registrar, onFault: (code) => faults.push(code) });
  driver.start();
  rejectNext(new EngineError("MIGRATION_STATE_CORRUPT", "some sensitive path or message that must never leak"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(faults, ["MIGRATION_STATE_CORRUPT"]);
  for (const message of faults) {
    assert.ok(!message.includes("sensitive"), "onFault must only ever receive the closed EngineErrorCode, never the raw message");
  }
  void settleNext; // unused in this test's fault path
});

void test("a throwing onFault observer never escapes the driver", async () => {
  const registrar = new ManualRegistrar();
  const { runner, rejectNext } = deferredRunner();
  const driver = new MigrationDriver({
    runner,
    registrar,
    onFault: () => {
      throw new Error("boom");
    },
  });
  driver.start();
  rejectNext(new Error("underlying failure"));
  await Promise.resolve();
  await Promise.resolve();
});

void test("intervalMs is validated against a sane bound", () => {
  const registrar = new ManualRegistrar();
  const { runner } = deferredRunner();
  assert.throws(() => new MigrationDriver({ runner, registrar, intervalMs: 0 }), RangeError);
  assert.throws(() => new MigrationDriver({ runner, registrar, intervalMs: 100 * 60 * 60_000 }), RangeError);
});
