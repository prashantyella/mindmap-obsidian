import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  RuntimeSetupController,
  buildManagedProcessEnv,
  buildStaleBackupDir,
  createNodeSetupSpawner,
  type ManagedProcessOutcome,
  type RuntimeSetupOptions,
  type RuntimeSetupState,
  type SetupChildProcess,
  type SetupFs,
  type SetupSpawner,
  type SetupTimer,
} from "./runtimeSetup";
import { computeRequirementsFingerprint, getManagedInterpreterPath, getManagedRuntimeDir, getManagedStagingDir, isWithinManagedRuntimeRoot, type InterpreterProbeResult } from "./runtimeDiscovery";

const APP_SUPPORT_ROOT = path.normalize("/Users/tester/Library/Application Support/Mindmap AI");
const REQUIREMENTS = "chromadb==1.4.0\nruamel.yaml==0.19.1\n";
const REQUIREMENTS_PATH = "/plugin/python/requirements.txt";
const BOOTSTRAP_PYTHON = "/usr/bin/python3";
const FINGERPRINT = computeRequirementsFingerprint(REQUIREMENTS);
const FINAL_DIR = getManagedRuntimeDir(APP_SUPPORT_ROOT, FINGERPRINT);
const FINAL_INTERPRETER = getManagedInterpreterPath(APP_SUPPORT_ROOT, FINGERPRINT);
const STAGING_DIR = getManagedStagingDir(APP_SUPPORT_ROOT, FINGERPRINT);

function readyProbeResult(interpreterPath: string): InterpreterProbeResult {
  return {
    path: interpreterPath,
    source: "managed",
    classification: "ready",
    pythonVersion: "3.12.4",
    venvAvailable: true,
    packages: [],
    preflightOk: true,
    diagnostics: [],
  };
}

function notReadyProbeResult(interpreterPath: string, classification: InterpreterProbeResult["classification"] = "bootstrap-only"): InterpreterProbeResult {
  return { path: interpreterPath, source: "managed", classification, packages: [], diagnostics: [] };
}

class FakeStream {
  private readonly listeners: Array<(chunk: unknown) => void> = [];
  on(_event: "data", listener: (chunk: unknown) => void): void {
    this.listeners.push(listener);
  }
  emit(chunk: string): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

class FakeChild implements SetupChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = false;
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();
  on(event: "error" | "close", listener: (value?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  kill(): void {
    this.killed = true;
  }
  emit(event: "error" | "close", value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

class FakeTimer implements SetupTimer {
  private handles = new Map<number, () => void>();
  private nextId = 1;
  cleared: number[] = [];
  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.handles.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.cleared.push(handle as number);
    this.handles.delete(handle as number);
  }
  fireAll(): void {
    for (const callback of [...this.handles.values()]) callback();
  }
}

interface SpawnCall {
  command: string;
  args: string[];
}

class FakeFs implements SetupFs {
  existing: Set<string>;
  calls: { kind: "mkdir" | "rename" | "rm"; from: string; to?: string }[] = [];
  failMkdir = false;
  failRename: ((from: string, to: string) => boolean) | null = null;
  failRm = false;

  constructor(existing: Iterable<string> = []) {
    this.existing = new Set([...existing].map((p) => path.normalize(p)));
  }

  existsSync(targetPath: string): boolean {
    return this.existing.has(path.normalize(targetPath));
  }

  async mkdir(targetPath: string): Promise<void> {
    this.calls.push({ kind: "mkdir", from: targetPath });
    if (this.failMkdir) throw new Error("mkdir failed");
    this.existing.add(path.normalize(targetPath));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.calls.push({ kind: "rename", from: oldPath, to: newPath });
    if (this.failRename?.(oldPath, newPath)) throw new Error("rename failed");
    this.existing.delete(path.normalize(oldPath));
    this.existing.add(path.normalize(newPath));
  }

  async rm(targetPath: string): Promise<void> {
    this.calls.push({ kind: "rm", from: targetPath });
    if (this.failRm) throw new Error("rm failed");
    this.existing.delete(path.normalize(targetPath));
  }
}

interface Harness {
  fs: FakeFs;
  timer: FakeTimer;
  spawnCalls: SpawnCall[];
  children: FakeChild[];
  confirmCalls: number;
  persistCalls: string[];
  probeCalls: string[];
  stateHistory: RuntimeSetupState[];
  controller: RuntimeSetupController;
  respondToStep(index: number, event: "close" | "error", value?: unknown): void;
}

interface MakeControllerOverrides extends Partial<RuntimeSetupOptions> {
  existingFs?: Iterable<string>;
  confirmResult?: boolean;
  probeResults?: (interpreterPath: string) => InterpreterProbeResult;
  persistShouldFail?: boolean;
  failRename?: (from: string, to: string) => boolean;
}

function makeController(overrides: MakeControllerOverrides = {}): Harness {
  const fs = new FakeFs(overrides.existingFs ?? []);
  fs.failRename = overrides.failRename ?? null;
  const timer = new FakeTimer();
  const spawnCalls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let confirmCalls = 0;
  const persistCalls: string[] = [];
  const probeCalls: string[] = [];
  const stateHistory: RuntimeSetupState[] = [];

  const spawner: SetupSpawner = (command, args) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };

  const options: RuntimeSetupOptions = {
    bootstrapInterpreterPath: BOOTSTRAP_PYTHON,
    appSupportRoot: APP_SUPPORT_ROOT,
    requirementsFileContents: REQUIREMENTS,
    requirementsFilePath: REQUIREMENTS_PATH,
    fs,
    spawner,
    timer,
    confirm: async () => {
      confirmCalls += 1;
      return overrides.confirmResult ?? true;
    },
    persist: async (interpreterPath: string) => {
      persistCalls.push(interpreterPath);
      if (overrides.persistShouldFail) throw new Error("persist failed");
    },
    probe: async (interpreterPath: string) => {
      probeCalls.push(interpreterPath);
      return overrides.probeResults ? overrides.probeResults(interpreterPath) : readyProbeResult(interpreterPath);
    },
    onStateChange: (state) => stateHistory.push(state),
    ...overrides,
  };

  const controller = new RuntimeSetupController(options);

  return {
    fs,
    timer,
    spawnCalls,
    children,
    get confirmCalls() {
      return confirmCalls;
    },
    persistCalls,
    probeCalls,
    stateHistory,
    controller,
    respondToStep(index, event, value) {
      children[index]?.emit(event, value);
    },
  } as Harness;
}

const MAX_POLL_TICKS = 200;

/**
 * The controller's job runs through several real `await` boundaries
 * (confirm(), fs.mkdir() inside resetStagingDir(), etc.) before it reaches
 * each spawn call, so a fixed number of `Promise.resolve()` ticks is
 * fragile. Poll microtask-by-microtask instead of guessing a tick count.
 */
async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let i = 0; i < MAX_POLL_TICKS; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

async function waitForChildCount(harness: Harness, count: number): Promise<void> {
  await waitFor(() => harness.children.length >= count, `${count} spawned child process(es) (saw ${harness.children.length})`);
}

async function waitForConfirmCount(harness: Harness, count: number): Promise<void> {
  await waitFor(() => harness.confirmCalls >= count, `confirm() called ${count} time(s) (saw ${harness.confirmCalls})`);
}

void test("happy path: confirm -> venv -> pip -> verify -> promote -> persist, with correct argv and phase order", async () => {
  const harness = makeController();
  const runPromise = harness.controller.start();

  await waitForConfirmCount(harness, 1);
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0); // venv
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0); // pip

  const finalState = await runPromise;

  assert.equal(finalState.phase, "ready");
  assert.equal(finalState.interpreterPath, FINAL_INTERPRETER);

  assert.equal(harness.spawnCalls.length, 2);
  assert.equal(harness.spawnCalls[0].command, BOOTSTRAP_PYTHON);
  assert.deepEqual(harness.spawnCalls[0].args, ["-m", "venv", path.join(STAGING_DIR, "venv")]);
  assert.equal(harness.spawnCalls[1].command, path.join(STAGING_DIR, "venv", "bin", "python3"));
  assert.deepEqual(harness.spawnCalls[1].args, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", REQUIREMENTS_PATH]);

  const phases = harness.stateHistory.map((state) => state.phase);
  assert.deepEqual(phases, ["confirming", "creating", "installing", "verifying", "ready"]);

  assert.deepEqual(harness.persistCalls, [FINAL_INTERPRETER]);
  assert.ok(harness.probeCalls.includes(path.join(STAGING_DIR, "venv", "bin", "python3")));

  const renameCalls = harness.fs.calls.filter((call) => call.kind === "rename");
  assert.deepEqual(renameCalls, [{ kind: "rename", from: STAGING_DIR, to: FINAL_DIR }]);
});

void test("consent decline: confirm() returns false and no filesystem/network work happens", async () => {
  const harness = makeController({ confirmResult: false });
  const finalState = await harness.controller.start();

  assert.equal(finalState.phase, "setup-required");
  assert.equal(finalState.canRetry, true);
  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.fs.calls.length, 0);
  assert.deepEqual(harness.persistCalls, []);
});

void test("reuse: an already-verified final runtime is persisted and returned ready without spawning or confirming", async () => {
  const harness = makeController({ existingFs: [FINAL_INTERPRETER] });
  const finalState = await harness.controller.start();

  assert.equal(finalState.phase, "ready");
  assert.equal(finalState.interpreterPath, FINAL_INTERPRETER);
  assert.equal(harness.confirmCalls, 0);
  assert.equal(harness.spawnCalls.length, 0);
  assert.deepEqual(harness.persistCalls, [FINAL_INTERPRETER]);
});

void test("job coalescing: concurrent start() calls share one job and confirm() runs once", async () => {
  const harness = makeController();
  const first = harness.controller.start();
  const second = harness.controller.start();

  await waitForConfirmCount(harness, 1);
  assert.equal(harness.confirmCalls, 1);

  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.phase, "ready");
  assert.equal(secondResult.phase, "ready");
  assert.equal(harness.spawnCalls.length, 2);
});

void test("venv creation failure fails the job, preserves staging for the next attempt, and reports a safe message", async () => {
  const harness = makeController();
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);

  harness.respondToStep(0, "error", { code: "ENOENT", message: "spawn python3 ENOENT with SECRET=abc" });
  const finalState = await runPromise;

  assert.equal(finalState.phase, "failed");
  assert.equal(finalState.canRetry, true);
  assert.ok(!finalState.message.includes("SECRET"));
  assert.ok(finalState.message.includes("ENOENT"));

  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  assert.deepEqual(rmCalls, []);
});

void test("pip install failure fails the job with a bounded exit-code message and never promotes staging", async () => {
  const harness = makeController();
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 1);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");
  assert.match(finalState.message, /status 1/);
  const renameCalls = harness.fs.calls.filter((call) => call.kind === "rename");
  assert.deepEqual(renameCalls, []);
});

void test("verification failure fails the job and never promotes staging to final", async () => {
  const harness = makeController({ probeResults: (interpreterPath) => notReadyProbeResult(interpreterPath, "incompatible") });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");
  const renameCalls = harness.fs.calls.filter((call) => call.kind === "rename");
  assert.deepEqual(renameCalls, []);
});

void test("promotion (rename) failure fails the job and never touches app-support root or final directly with rm", async () => {
  const harness = makeController({
    failRename: (from) => from === STAGING_DIR,
  });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");
  assert.deepEqual(harness.persistCalls, []);
  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  for (const call of rmCalls) {
    assert.equal(call.from, STAGING_DIR);
  }
});

void test("persist failure after a verified install rolls back to failed while the runtime stays promoted for rediscovery", async () => {
  const harness = makeController({ persistShouldFail: true });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");
  assert.equal(finalState.interpreterPath, undefined);
  assert.ok(harness.fs.calls.some((call) => call.kind === "rename" && call.from === STAGING_DIR && call.to === FINAL_DIR));
});

void test("timeout during pip install kills the child, times out cleanly, and reports failed", async () => {
  const harness = makeController({ installTimeoutMs: 5_000 });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);

  harness.timer.fireAll();
  const finalState = await runPromise;

  assert.equal(finalState.phase, "failed");
  assert.match(finalState.message, /timed out/);
  assert.equal(harness.children[1].killed, true);
});

void test("cancel during installing kills the child, removes only the exact staging directory, and suppresses later callbacks", async () => {
  const harness = makeController({ existingFs: [] });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);

  harness.controller.cancel();
  assert.equal(harness.children[1].killed, true);

  // A late close callback must not push the job past "cancelled".
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "cancelled");
  assert.deepEqual(harness.persistCalls, []);

  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  assert.ok(rmCalls.length >= 1);
  for (const call of rmCalls) {
    assert.equal(call.from, STAGING_DIR);
  }

  const historyAfterCancel = harness.stateHistory.slice(harness.stateHistory.findIndex((state) => state.phase === "cancelled") + 1);
  assert.deepEqual(historyAfterCancel, []);
});

void test("dispose during confirming cancels the job and suppresses all further state updates", async () => {
  const harness = makeController();
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  const historyBeforeDispose = [...harness.stateHistory];

  harness.controller.dispose();

  const finalState = await runPromise;
  assert.equal(finalState.phase, "cancelled");
  assert.deepEqual(harness.stateHistory, historyBeforeDispose);
  assert.deepEqual(harness.persistCalls, []);
  assert.equal(harness.spawnCalls.length, 0);
});

void test("start() after dispose() is a no-op that resolves with the current state without running a job", async () => {
  const harness = makeController();
  harness.controller.dispose();
  const state = await harness.controller.start();
  assert.equal(state.phase, "setup-required");
  assert.equal(harness.confirmCalls, 0);
  assert.equal(harness.spawnCalls.length, 0);
});

void test("stale leftover staging directory from a prior crash is removed and recreated before use", async () => {
  const harness = makeController({ existingFs: [STAGING_DIR, path.join(STAGING_DIR, "venv")] });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);
  await runPromise;

  const stagingCalls = harness.fs.calls.filter((call) => call.from === STAGING_DIR);
  assert.ok(stagingCalls.some((call) => call.kind === "rm"));
  assert.ok(stagingCalls.some((call) => call.kind === "mkdir"));
  assert.ok(stagingCalls.findIndex((call) => call.kind === "rm") < stagingCalls.findIndex((call) => call.kind === "mkdir"));
});

void test("corrupt existing final runtime is never blindly deleted: it is renamed aside, never rm'd, before promotion", async () => {
  const harness = makeController({
    existingFs: [FINAL_DIR, FINAL_INTERPRETER],
    probeResults: (interpreterPath) => (interpreterPath === FINAL_INTERPRETER ? notReadyProbeResult(interpreterPath, "incompatible") : readyProbeResult(interpreterPath)),
  });
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  assert.equal(harness.confirmCalls, 1);

  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "ready");

  const renameCalls = harness.fs.calls.filter((call) => call.kind === "rename");
  assert.equal(renameCalls.length, 2);
  assert.equal(renameCalls[0].from, FINAL_DIR);
  assert.match(renameCalls[0].to ?? "", /\.stale-\d+$/);
  assert.equal(renameCalls[1].from, STAGING_DIR);
  assert.equal(renameCalls[1].to, FINAL_DIR);

  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  for (const call of rmCalls) {
    assert.notEqual(call.from, FINAL_DIR);
  }
});

void test("no secret, env, or note content ever reaches state.message or log output", async () => {
  const secret = "SECRET_TOKEN=abc123 note-content=my private journal entry";
  const logLines: string[] = [];
  const harness = makeController({ log: (line) => logLines.push(line) });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);

  harness.respondToStep(0, "error", { code: "EACCES", message: `permission denied: ${secret}` });
  const finalState = await runPromise;

  assert.equal(finalState.phase, "failed");
  assert.ok(!finalState.message.includes(secret));
  for (const line of logLines) {
    assert.ok(!line.includes(secret));
  }
});

void test("staging path guard: the controller only ever rm/mkdirs the exact fingerprinted staging directory", async () => {
  const harness = makeController({ existingFs: [STAGING_DIR] });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);
  await runPromise;

  for (const call of harness.fs.calls) {
    if (call.kind === "rm" || call.kind === "mkdir") {
      assert.equal(call.from, STAGING_DIR, `unexpected ${call.kind} target: ${call.from}`);
    }
  }
});

void test("a managed process outcome type check compiles for all five kinds", () => {
  const outcomes: ManagedProcessOutcome[] = [{ kind: "ok" }, { kind: "exit-error", exitCode: 1 }, { kind: "spawn-error", code: "ENOENT" }, { kind: "timeout" }, { kind: "cancelled" }];
  assert.equal(outcomes.length, 5);
});

// ---------------------------------------------------------------------------
// (1) Managed process environment is an explicit allowlist, never the host's.
// ---------------------------------------------------------------------------

void test("buildManagedProcessEnv keeps only the allowlisted keys and never forwards credentials", () => {
  const env = buildManagedProcessEnv({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    LANG: "en_US.UTF-8",
    EXA_API_KEY: "secret-exa",
    OPENAI_API_KEY: "secret-openai",
    ANTHROPIC_API_KEY: "secret-anthropic",
    PIP_INDEX_URL: "https://evil.example/simple",
    PIP_EXTRA_INDEX_URL: "https://evil.example/simple",
    NODE_OPTIONS: "--require=/tmp/evil.js",
    npm_config_registry: "https://evil.example",
  });

  assert.deepEqual(env, {
    HOME: "/Users/tester",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  });
});

void test("buildManagedProcessEnv falls back to a safe default PATH when none is set", () => {
  const env = buildManagedProcessEnv({ EXA_API_KEY: "secret" });
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(env.PIP_CONFIG_FILE, "/dev/null");
  assert.equal(env.EXA_API_KEY, undefined);
});

void test("createNodeSetupSpawner passes only the allowlisted env, argv, and shell:false to the injected spawn function", () => {
  const calls: { command: string; args: string[]; options: { shell: boolean; env: Record<string, string> } }[] = [];
  const fakeSpawn = (command: string, args: string[], options: { stdio: unknown; shell: boolean; env: Record<string, string> }) => {
    calls.push({ command, args, options });
    return new FakeChild();
  };

  const spawner = createNodeSetupSpawner(
    { PATH: "/usr/bin", HOME: "/Users/tester", EXA_API_KEY: "secret", PIP_INDEX_URL: "https://evil.example" },
    fakeSpawn,
  );
  spawner("/usr/bin/python3", ["-m", "venv", "/tmp/staging/venv"]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/python3");
  assert.deepEqual(calls[0].args, ["-m", "venv", "/tmp/staging/venv"]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, {
    HOME: "/Users/tester",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  });
});

// ---------------------------------------------------------------------------
// (2) cancel()/dispose() settle the in-flight process without needing a real close/error event.
// ---------------------------------------------------------------------------

void test("cancel() during installing settles the pending pip process and resolves cancelled with no manual close/error emitted", async () => {
  const harness = makeController({ existingFs: [] });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);

  harness.controller.cancel();
  assert.equal(harness.children[1].killed, true);

  // No close/error is ever emitted on children[1]; only the forced settle should unblock this.
  const finalState = await runPromise;
  assert.equal(finalState.phase, "cancelled");
  assert.deepEqual(harness.persistCalls, []);

  const historyLength = harness.stateHistory.length;
  // A late close arriving afterward must be a no-op: no new state transitions.
  harness.respondToStep(1, "close", 0);
  assert.equal(harness.stateHistory.length, historyLength);
});

void test("dispose() during installing settles the pending process and stops the job without a real close/error", async () => {
  const harness = makeController();
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);

  harness.controller.dispose();
  assert.equal(harness.children[1].killed, true);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "cancelled");
});

// ---------------------------------------------------------------------------
// (3) confirm()/probe() rejections and synchronous spawner throws never reject start().
// ---------------------------------------------------------------------------

void test("confirm() rejection is caught and reported as a fixed failed state, never a rejected start()", async () => {
  const harness = makeController({ confirm: async () => { throw new Error("network stack exploded: SECRET=abc"); } });
  const finalState = await harness.controller.start();
  assert.equal(finalState.phase, "failed");
  assert.ok(!finalState.message.includes("SECRET"));
  assert.equal(harness.spawnCalls.length, 0);
});

void test("a synchronously throwing spawner is treated as a spawn failure, not a rejected start()", async () => {
  const harness = makeController({
    spawner: () => {
      throw Object.assign(new Error("boom SECRET=abc"), { code: "EPERM" });
    },
  });
  const finalState = await harness.controller.start();
  assert.equal(finalState.phase, "failed");
  assert.ok(finalState.message.includes("EPERM"));
  assert.ok(!finalState.message.includes("SECRET"));
});

void test("probe() rejection during final-runtime reuse is caught and reported as failed, never a rejected start()", async () => {
  const harness = makeController({
    existingFs: [FINAL_INTERPRETER],
    probe: async () => { throw new Error("probe exploded: SECRET=abc"); },
  });
  const finalState = await harness.controller.start();
  assert.equal(finalState.phase, "failed");
  assert.ok(!finalState.message.includes("SECRET"));
  assert.deepEqual(harness.persistCalls, []);
});

void test("probe() rejection during staging verification is caught and reported as failed, never a rejected start()", async () => {
  let callCount = 0;
  const harness = makeController({
    probe: async (interpreterPath: string) => {
      callCount += 1;
      throw new Error(`verification blew up for ${interpreterPath}: SECRET=abc`);
    },
  });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");
  assert.ok(!finalState.message.includes("SECRET"));
  assert.ok(callCount >= 1);
});

// ---------------------------------------------------------------------------
// (4) log/onStateChange callback exceptions never corrupt installer state; state is copied defensively.
// ---------------------------------------------------------------------------

void test("a throwing onStateChange listener does not break the job or leak into start()'s resolution", async () => {
  const harness = makeController({
    onStateChange: () => {
      throw new Error("consumer UI bug");
    },
  });
  const runPromise = harness.controller.start();
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "ready");
});

void test("a throwing log handler does not break the job", async () => {
  const harness = makeController({
    existingFs: [FINAL_INTERPRETER],
    log: () => {
      throw new Error("consumer logging bug");
    },
  });
  const finalState = await harness.controller.start();
  assert.equal(finalState.phase, "ready");
});

void test("getState() and resolved states are defensive copies: external mutation cannot corrupt internal state", async () => {
  const harness = makeController({ existingFs: [FINAL_INTERPRETER] });
  const finalState = await harness.controller.start();

  const mutable = harness.controller.getState();
  mutable.phase = "failed";
  mutable.message = "tampered";

  assert.equal(harness.controller.getState().phase, "ready");
  assert.notEqual(harness.controller.getState().message, "tampered");
  assert.equal(finalState.phase, "ready");
});

// ---------------------------------------------------------------------------
// (5) Injected now() clock for stale-backup naming, validated against the managed runtime root.
// ---------------------------------------------------------------------------

void test("buildStaleBackupDir names the backup deterministically from the given timestamp", () => {
  const backupDir = buildStaleBackupDir(APP_SUPPORT_ROOT, FINAL_DIR, 1_700_000_000_000);
  assert.equal(backupDir, `${FINAL_DIR}.stale-1700000000000`);
  assert.ok(backupDir && isWithinManagedRuntimeRoot(APP_SUPPORT_ROOT, backupDir));
});

void test("buildStaleBackupDir refuses a backup path that would fall outside the managed runtime root", () => {
  const backupDir = buildStaleBackupDir(APP_SUPPORT_ROOT, "/etc/passwd", 1_700_000_000_000);
  assert.equal(backupDir, null);
});

void test("promotion uses the injected now() clock for the stale-backup name", async () => {
  const harness = makeController({
    existingFs: [FINAL_DIR, FINAL_INTERPRETER],
    probeResults: (interpreterPath) => (interpreterPath === FINAL_INTERPRETER ? notReadyProbeResult(interpreterPath, "incompatible") : readyProbeResult(interpreterPath)),
    now: () => 1_234_567_890,
  });
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "ready");

  const renameCalls = harness.fs.calls.filter((call) => call.kind === "rename");
  assert.equal(renameCalls[0].to, `${FINAL_DIR}.stale-1234567890`);
});

void test("promotion removes only the exact validated stale backup after a successful promote", async () => {
  const harness = makeController({
    existingFs: [FINAL_DIR, FINAL_INTERPRETER],
    probeResults: (interpreterPath) => (interpreterPath === FINAL_INTERPRETER ? notReadyProbeResult(interpreterPath, "incompatible") : readyProbeResult(interpreterPath)),
    now: () => 1_234_567_890,
  });
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "ready");

  const expectedBackupDir = `${FINAL_DIR}.stale-1234567890`;
  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  assert.deepEqual(rmCalls, [{ kind: "rm", from: expectedBackupDir }]);
});

void test("a failed stale-backup cleanup after successful promotion does not fail the install", async () => {
  const harness = makeController({
    existingFs: [FINAL_DIR, FINAL_INTERPRETER],
    probeResults: (interpreterPath) => (interpreterPath === FINAL_INTERPRETER ? notReadyProbeResult(interpreterPath, "incompatible") : readyProbeResult(interpreterPath)),
  });
  harness.fs.failRm = true;
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "ready");
});

void test("no stale-backup deletion is attempted unless promotion actually succeeded", async () => {
  const harness = makeController({
    existingFs: [FINAL_DIR, FINAL_INTERPRETER],
    probeResults: (interpreterPath) => (interpreterPath === FINAL_INTERPRETER ? notReadyProbeResult(interpreterPath, "incompatible") : readyProbeResult(interpreterPath)),
  });
  harness.fs.failRename = (from, to) => from === STAGING_DIR && to === FINAL_DIR;
  const runPromise = harness.controller.start();
  await waitForConfirmCount(harness, 1);
  await waitForChildCount(harness, 1);
  harness.respondToStep(0, "close", 0);
  await waitForChildCount(harness, 2);
  harness.respondToStep(1, "close", 0);

  const finalState = await runPromise;
  assert.equal(finalState.phase, "failed");

  const rmCalls = harness.fs.calls.filter((call) => call.kind === "rm");
  assert.deepEqual(rmCalls, []);
});
