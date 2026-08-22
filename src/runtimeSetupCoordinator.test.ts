import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { RuntimeReadinessCoordinator, shouldTriggerRuntimeReadyKickoff, type CoordinatorPhase, type CoordinatorState, type RuntimeCoordinatorOptions } from "./runtimeSetupCoordinator";
import { computeRequirementsFingerprint, getManagedInterpreterPath, type DiscoveryFs, type ProcessInvoker } from "./runtimeDiscovery";
import type { SetupChildProcess, SetupFs, SetupSpawner } from "./runtimeSetup";

const APP_SUPPORT_ROOT = path.normalize("/Users/tester/Library/Application Support/Mindmap AI");
const REQUIREMENTS = "chromadb==1.4.0\nruamel.yaml==0.19.1\n";
const FINGERPRINT = computeRequirementsFingerprint(REQUIREMENTS);
const MANAGED_INTERPRETER = getManagedInterpreterPath(APP_SUPPORT_ROOT, FINGERPRINT);

const XCODE_PYTHON = "/usr/bin/python3";
const FRAMEWORK_PYTHON = path.normalize("/Library/Frameworks/Python.framework/Versions/3.13/bin/python3");

function readyPayload() {
  return JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.19.1" } });
}

function bootstrapOnlyPayload() {
  return JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: null, "ruamel.yaml": null } });
}

class FakeDiscoveryFs implements DiscoveryFs {
  constructor(private readonly executable: Set<string>) {}
  existsSync(targetPath: string): boolean {
    return this.executable.has(path.normalize(targetPath));
  }
  statSync() {
    return { isFile: () => true, mode: 0o755 };
  }
}

class FakeSetupFs implements SetupFs {
  existing = new Set<string>();
  async existsSyncAsync() {
    return false;
  }
  existsSync(targetPath: string): boolean {
    return this.existing.has(path.normalize(targetPath));
  }
  async mkdir(targetPath: string): Promise<void> {
    this.existing.add(path.normalize(targetPath));
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    this.existing.delete(path.normalize(oldPath));
    this.existing.add(path.normalize(newPath));
  }
  async rm(targetPath: string): Promise<void> {
    this.existing.delete(path.normalize(targetPath));
  }
}

class FakeChild implements SetupChildProcess {
  readonly stdout = { on: () => undefined };
  readonly stderr = { on: () => undefined };
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();
  on(event: "error" | "close", listener: (value?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  kill(): void {
    this.emit("close", 0);
  }
  emit(event: "error" | "close", value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

interface Harness {
  coordinator: RuntimeReadinessCoordinator;
  persistCalls: string[];
  confirmCalls: number;
  stateHistory: CoordinatorState[];
  logLines: string[];
  spawnCalls: { command: string; args: string[] }[];
}

function makeCoordinator(overrides: Partial<RuntimeCoordinatorOptions> & { invokeResults?: (command: string) => { stdout: string; exitCode: number }; discoveryExecutable?: Iterable<string> } = {}): Harness {
  const persistCalls: string[] = [];
  const stateHistory: CoordinatorState[] = [];
  const logLines: string[] = [];
  const spawnCalls: { command: string; args: string[] }[] = [];
  let confirmCalls = 0;

  const invoke: ProcessInvoker = overrides.invoke ?? (async (command) => {
    const result = overrides.invokeResults?.(command) ?? { stdout: readyPayload(), exitCode: 0 };
    return { stdout: `${result.stdout}\n`, stderr: "", exitCode: result.exitCode };
  });

  const discoveryFs = overrides.discoveryFs ?? new FakeDiscoveryFs(new Set(overrides.discoveryExecutable ?? [FRAMEWORK_PYTHON]));
  const setupFs = overrides.setupFs ?? new FakeSetupFs();
  const spawner: SetupSpawner = overrides.spawner ?? ((command, args) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    // Simulate a successful subprocess exit so the happy-path job can progress
    // past venv creation and pip install without needing real process events.
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });

  const options: RuntimeCoordinatorOptions = {
    platform: "darwin",
    pythonCommandSetting: "python3",
    homeDir: "/Users/tester",
    pathEnv: "/usr/bin:/bin",
    arch: "arm64",
    appSupportRoot: APP_SUPPORT_ROOT,
    requirementsFileContents: REQUIREMENTS,
    requirementsFilePath: "/plugin/python/requirements.txt",
    scriptPath: "/plugin/python/mindmap.py",
    configPath: "/plugin/python/config.json",
    discoveryFs,
    invoke,
    setupFs,
    spawner,
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
    persist: async (interpreterPath: string) => {
      persistCalls.push(interpreterPath);
    },
    verifyPreflight: async () => true,
    onStateChange: (state) => stateHistory.push(state),
    log: (line) => logLines.push(line),
    ...overrides,
  };

  const coordinator = new RuntimeReadinessCoordinator(options);
  return {
    coordinator,
    persistCalls,
    get confirmCalls() {
      return confirmCalls;
    },
    stateHistory,
    logLines,
    spawnCalls,
  };
}

void test("non-macOS platform is not-applicable and never touches fs/network seams", async () => {
  const harness = makeCoordinator({ platform: "win32" });
  const state = await harness.coordinator.startDiscovery();
  assert.equal(state.phase, "not-applicable");
  assert.equal(state.blocking, false);
  assert.deepEqual(harness.persistCalls, []);
  assert.deepEqual(harness.spawnCalls, []);
});

void test("fresh default macOS settings auto-select an existing working Python and persist it", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  const state = await harness.coordinator.startDiscovery();
  assert.equal(state.phase, "ready");
  assert.equal(state.blocking, false);
  assert.equal(state.interpreterPath, FRAMEWORK_PYTHON);
  assert.deepEqual(harness.persistCalls, [FRAMEWORK_PYTHON]);
});

void test("Xcode Python with missing dependencies surfaces setup-required, not a failed processing run", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [XCODE_PYTHON],
    invokeResults: () => ({ stdout: bootstrapOnlyPayload(), exitCode: 0 }),
  });
  const state = await harness.coordinator.startDiscovery();
  assert.equal(state.phase, "setup-required");
  assert.equal(state.blocking, true);
  assert.equal(state.canSetup, true);
  assert.equal(state.interpreterPath, XCODE_PYTHON);
  assert.deepEqual(harness.persistCalls, []);
});

void test("the discovered bootstrap interpreter stays exposed on state.interpreterPath through confirming/creating/installing/verifying, for read-only use before setup finishes", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [XCODE_PYTHON],
    invokeResults: (command) => (command === MANAGED_INTERPRETER || command.includes("staging") ? { stdout: readyPayload(), exitCode: 0 } : { stdout: bootstrapOnlyPayload(), exitCode: 0 }),
  });

  await harness.coordinator.startDiscovery();
  await harness.coordinator.beginSetup();

  const intermediatePhases: CoordinatorState["phase"][] = ["confirming", "creating", "installing", "verifying"];
  for (const phase of intermediatePhases) {
    const stateAtPhase = harness.stateHistory.find((state) => state.phase === phase);
    assert.ok(stateAtPhase, `expected a state for phase ${phase}`);
    assert.equal(stateAtPhase?.interpreterPath, XCODE_PYTHON, `expected bootstrap interpreter exposed during ${phase}`);
  }
});

void test("no usable Python at all is unavailable, blocking, and cannot offer setup", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [] });
  const state = await harness.coordinator.startDiscovery();
  assert.equal(state.phase, "unavailable");
  assert.equal(state.blocking, true);
  assert.equal(state.canSetup, false);
});

void test("an explicit custom pythonCommand is validated only: never replaced, never offered managed setup", async () => {
  const harness = makeCoordinator({
    pythonCommandSetting: "/opt/custom/python3",
    discoveryFs: new FakeDiscoveryFs(new Set(["/opt/custom/python3", FRAMEWORK_PYTHON])),
    invokeResults: (command) => (command === "/opt/custom/python3" ? { stdout: bootstrapOnlyPayload(), exitCode: 0 } : { stdout: readyPayload(), exitCode: 0 }),
  });
  const state = await harness.coordinator.startDiscovery();
  assert.equal(state.phase, "not-applicable");
  assert.equal(state.blocking, false);
  assert.deepEqual(harness.persistCalls, []);

  const setupResult = await harness.coordinator.beginSetup();
  assert.equal(setupResult.phase, "not-applicable");
  assert.equal(harness.confirmCalls, 0);
});

void test("setup success installs, verifies via the runtime-specific verifier, persists, and becomes ready without restart", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [XCODE_PYTHON],
    invokeResults: (command) => (command === MANAGED_INTERPRETER || command.includes("staging") ? { stdout: readyPayload(), exitCode: 0 } : { stdout: bootstrapOnlyPayload(), exitCode: 0 }),
  });

  const discovered = await harness.coordinator.startDiscovery();
  assert.equal(discovered.phase, "setup-required");

  const finalState = await harness.coordinator.beginSetup();
  assert.equal(finalState.phase, "ready");
  assert.equal(finalState.blocking, false);
  assert.equal(harness.confirmCalls, 1);
  assert.ok(harness.persistCalls.includes(finalState.interpreterPath ?? ""));

  const phases = harness.stateHistory.map((state) => state.phase);
  assert.ok(phases.includes("confirming"));
  assert.ok(phases.includes("creating"));
  assert.ok(phases.includes("installing"));
  assert.ok(phases.includes("verifying"));
  assert.ok(phases.includes("ready"));
});

void test("the runtime-specific verifyPreflight downgrades an otherwise-passing install to unverified, without touching provider/scope logic", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [XCODE_PYTHON],
    invoke: async () => ({ stdout: `${readyPayload()}\n`, stderr: "", exitCode: 0 }),
    verifyPreflight: async () => false,
  });
  await harness.coordinator.startDiscovery();
  const result = await harness.coordinator.beginSetup();
  assert.notEqual(result.phase, "ready");
});

void test("cancel() during a running setup resolves cancelled and dispose() suppresses further state updates", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [XCODE_PYTHON],
    invokeResults: () => ({ stdout: bootstrapOnlyPayload(), exitCode: 0 }),
    spawner: () => {
      const child = new FakeChild();
      // Never resolve close/error on its own; cancel() must force settlement.
      child.kill = () => undefined;
      return child;
    },
  });
  await harness.coordinator.startDiscovery();
  const setupPromise = harness.coordinator.beginSetup();

  // Allow the job to reach a running phase, then cancel it.
  for (let i = 0; i < 50 && harness.stateHistory.every((state) => state.phase !== "creating"); i += 1) {
    await Promise.resolve();
  }
  harness.coordinator.cancel();
  const result = await setupPromise;
  assert.ok(result.phase === "cancelled" || result.phase === "confirming" || result.phase === "creating");

  const beforeDispose = harness.stateHistory.length;
  harness.coordinator.dispose();
  assert.equal(harness.stateHistory.length, beforeDispose);
});

void test("getState() returns a defensive copy that cannot corrupt coordinator state", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  await harness.coordinator.startDiscovery();
  const snapshot = harness.coordinator.getState();
  snapshot.phase = "failed";
  assert.equal(harness.coordinator.getState().phase, "ready");
});

// ---------------------------------------------------------------------------
// (D) startDiscovery must never reject, and dispose() must suppress
// persistence and ready/not-applicable state updates for an in-flight run.
// ---------------------------------------------------------------------------

void test("startDiscovery catches an unexpected exception from a misbehaving discovery seam and resolves to a safe unavailable state, never rejecting", async () => {
  class ThrowingDiscoveryFs implements DiscoveryFs {
    existsSync(): boolean {
      throw new Error("disk exploded: SECRET=abc123");
    }
    statSync() {
      return { isFile: () => true, mode: 0o755 };
    }
  }

  const harness = makeCoordinator({ discoveryFs: new ThrowingDiscoveryFs() });
  await assert.doesNotReject(async () => {
    const state = await harness.coordinator.startDiscovery();
    assert.equal(state.phase, "unavailable");
    assert.equal(state.blocking, true);
    assert.ok(!state.message.includes("SECRET"));
  });
});

void test("startDiscovery treats a synchronously throwing persist() the same as a rejected one: failed, not thrown", async () => {
  const harness = makeCoordinator({
    discoveryExecutable: [FRAMEWORK_PYTHON],
    persist: (() => {
      throw new Error("boom");
    }) as unknown as RuntimeCoordinatorOptions["persist"],
  });

  await assert.doesNotReject(async () => {
    const state = await harness.coordinator.startDiscovery();
    assert.equal(state.phase, "failed");
    assert.equal(state.canSetup, true);
  });
});

void test("beginSetup() after a persist failure with no bootstrap candidate re-runs discovery/persistence instead of silently no-op'ing", async () => {
  let persistAttempts = 0;
  const harness = makeCoordinator({
    discoveryExecutable: [FRAMEWORK_PYTHON],
    persist: async (interpreterPath: string) => {
      persistAttempts += 1;
      if (persistAttempts === 1) {
        throw new Error("boom");
      }
      harness.persistCalls.push(interpreterPath);
    },
  });

  const failedState = await harness.coordinator.startDiscovery();
  assert.equal(failedState.phase, "failed");
  assert.equal(failedState.canSetup, true);
  assert.equal(persistAttempts, 1);

  const retriedState = await harness.coordinator.beginSetup();

  assert.equal(persistAttempts, 2);
  assert.equal(harness.persistCalls.length, 1);
  assert.equal(retriedState.phase, "ready");
});

void test("retry() after a persist failure with no bootstrap candidate re-runs discovery the same as beginSetup()", async () => {
  let persistAttempts = 0;
  const harness = makeCoordinator({
    discoveryExecutable: [FRAMEWORK_PYTHON],
    persist: async (interpreterPath: string) => {
      persistAttempts += 1;
      if (persistAttempts === 1) {
        throw new Error("boom");
      }
      harness.persistCalls.push(interpreterPath);
    },
  });

  await harness.coordinator.startDiscovery();
  assert.equal(persistAttempts, 1);

  const retriedState = await harness.coordinator.retry();

  assert.equal(persistAttempts, 2);
  assert.equal(retriedState.phase, "ready");
});

void test("dispose() during an in-flight startDiscovery suppresses persistence and the ready state update", async () => {
  const release: { fn: (() => void) | null } = { fn: null };
  const invoke: ProcessInvoker = async () => {
    await new Promise<void>((resolve) => {
      release.fn = resolve;
    });
    return { stdout: `${readyPayload()}\n`, stderr: "", exitCode: 0 };
  };

  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON], invoke });
  const discoveryPromise = harness.coordinator.startDiscovery();

  // Let discovery reach the in-flight probe before disposing.
  for (let i = 0; i < 50 && !release.fn; i += 1) {
    await Promise.resolve();
  }
  assert.ok(release.fn, "expected discovery to reach the in-flight probe");

  harness.coordinator.dispose();
  release.fn?.();

  await discoveryPromise;
  assert.deepEqual(harness.persistCalls, []);
  assert.ok(!harness.stateHistory.some((state) => state.phase === "ready"));
});

// ---------------------------------------------------------------------------
// (G) Pure, Obsidian-free seam for the plugin's one-time ready/not-applicable kickoff.
// ---------------------------------------------------------------------------

void test("shouldTriggerRuntimeReadyKickoff fires exactly once for ready/not-applicable, never for other phases or once already kicked", () => {
  assert.equal(shouldTriggerRuntimeReadyKickoff("ready", false), true);
  assert.equal(shouldTriggerRuntimeReadyKickoff("not-applicable", false), true);
  assert.equal(shouldTriggerRuntimeReadyKickoff("ready", true), false);
  assert.equal(shouldTriggerRuntimeReadyKickoff("not-applicable", true), false);

  const otherPhases: CoordinatorPhase[] = ["discovering", "setup-required", "unavailable", "confirming", "creating", "installing", "verifying", "failed", "cancelled"];
  for (const phase of otherPhases) {
    assert.equal(shouldTriggerRuntimeReadyKickoff(phase, false), false, `expected false for phase ${phase}`);
  }
});

// ---------------------------------------------------------------------------
// (H) subscribe()/unsubscribe seam for live state fanout through cancellable phases.
// ---------------------------------------------------------------------------

void test("subscribe() receives every phase update alongside onStateChange, in order", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  const seen: CoordinatorPhase[] = [];
  const unsubscribe = harness.coordinator.subscribe((state) => seen.push(state.phase));

  await harness.coordinator.startDiscovery();

  assert.ok(seen.length > 0);
  assert.deepEqual(seen, harness.stateHistory.map((state) => state.phase));
  unsubscribe();
});

void test("unsubscribe() stops further delivery to that listener without affecting others", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  const a: CoordinatorPhase[] = [];
  const b: CoordinatorPhase[] = [];
  const unsubscribeA = harness.coordinator.subscribe((state) => a.push(state.phase));
  harness.coordinator.subscribe((state) => b.push(state.phase));

  unsubscribeA();
  await harness.coordinator.startDiscovery();

  assert.deepEqual(a, []);
  assert.ok(b.length > 0);
});

void test("multiple subscribers all receive fanout for the same state change", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  const counts = [0, 0, 0];
  harness.coordinator.subscribe(() => { counts[0] += 1; });
  harness.coordinator.subscribe(() => { counts[1] += 1; });
  harness.coordinator.subscribe(() => { counts[2] += 1; });

  await harness.coordinator.startDiscovery();

  assert.ok(counts[0] > 0);
  assert.equal(counts[0], counts[1]);
  assert.equal(counts[1], counts[2]);
});

void test("a throwing subscriber does not break other subscribers or coordinator state", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  let goodCalls = 0;
  harness.coordinator.subscribe(() => {
    throw new Error("bad subscriber");
  });
  harness.coordinator.subscribe(() => { goodCalls += 1; });

  const state = await harness.coordinator.startDiscovery();

  assert.equal(state.phase, "ready");
  assert.ok(goodCalls > 0);
});

void test("dispose() clears all subscribers so a torn-down view never leaks a listener", async () => {
  const harness = makeCoordinator({ discoveryExecutable: [FRAMEWORK_PYTHON] });
  const seen: CoordinatorPhase[] = [];
  harness.coordinator.subscribe((state) => seen.push(state.phase));

  harness.coordinator.dispose();
  seen.length = 0;
  await harness.coordinator.startDiscovery();

  assert.deepEqual(seen, []);
});
