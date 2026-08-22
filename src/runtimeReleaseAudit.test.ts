import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeRequirementsFingerprint } from "./runtimeDiscovery";
import { buildManagedProcessEnv } from "./runtimeSetup";
import { PYTHON_MACOS_DOWNLOAD_URL, RUNTIME_SETUP_CONFIRMATION_COPY, RuntimeReadinessCoordinator, type CoordinatorState, type RuntimeCoordinatorOptions } from "./runtimeSetupCoordinator";
import type { DiscoveryFs, ProcessInvoker } from "./runtimeDiscovery";
import type { SetupChildProcess, SetupFs, SetupSpawner } from "./runtimeSetup";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// (1) Requirements pin determinism, tied to the real shipped file.
// ---------------------------------------------------------------------------

void test("python/requirements.txt pins both direct managed-runtime dependencies to an exact version", () => {
  const requirements = readSource("python/requirements.txt");
  const lines = requirements.split(/\r?\n/).filter((line) => line.trim().length > 0);

  assert.ok(lines.includes("chromadb==1.4.0"), "chromadb must stay pinned to the tested embedded-client version");
  assert.ok(lines.includes("ruamel.yaml==0.19.1"), "ruamel.yaml must be pinned to the tested exact release");
  for (const line of lines) {
    assert.doesNotMatch(line, /(>=|<=|~=|!=|>|<)/, `${line} must be an exact pin, not a range`);
  }
});

void test("the real requirements.txt content produces a stable fingerprint usable for the managed runtime path", () => {
  const requirements = readSource("python/requirements.txt");
  const fingerprintA = computeRequirementsFingerprint(requirements);
  const fingerprintB = computeRequirementsFingerprint(requirements);

  assert.equal(fingerprintA, fingerprintB);
  assert.match(fingerprintA, /^[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------------------
// (5) Source audits: no shell, env allowlist/PIP_CONFIG_FILE, fixed download URL.
//
// These read the actual shipped .ts source as text and assert stable
// structural patterns (never a specific line number), rather than asserting
// against main.ts prose, which is exactly the kind of brittle text
// assertion this checkpoint's instructions call out to avoid.
// ---------------------------------------------------------------------------

void test("source audit: the only two real child-process spawn sites in the runtime modules are shell:false", () => {
  const discoverySource = readSource("src/runtimeDiscovery.ts");
  const setupSource = readSource("src/runtimeSetup.ts");

  assert.doesNotMatch(discoverySource, /shell:\s*true/);
  assert.doesNotMatch(setupSource, /shell:\s*true/);
  assert.match(discoverySource, /shell:\s*false/);
  assert.match(setupSource, /shell:\s*false/);

  // Guards against a future spawn/exec/execFile call site being added
  // without an explicit shell:false (Node's spawn/execFile default to no
  // shell already, but this keeps the invariant explicit and auditable).
  assert.doesNotMatch(discoverySource, /\bexecSync\(|\bexec\(/);
  assert.doesNotMatch(setupSource, /\bexecSync\(|\bexec\(/);
});

void test("source audit: buildManagedProcessEnv is a fixed allowlist that always sets PIP_CONFIG_FILE and never forwards PATH from the host", () => {
  const env = buildManagedProcessEnv({
    PATH: "/should/not/appear",
    HOME: "/Users/tester",
    EXA_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_API_KEY: "secret",
    PIP_INDEX_URL: "https://evil.example/simple",
    npm_config_registry: "https://evil.example",
  });

  assert.equal(env.PIP_CONFIG_FILE, "/dev/null");
  assert.equal(env.PIP_DISABLE_PIP_VERSION_CHECK, "1");
  assert.equal(env.PIP_NO_INPUT, "1");
  assert.notEqual(env.PATH, "/should/not/appear");
  assert.equal(env.EXA_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PIP_INDEX_URL, undefined);
  assert.equal(env.npm_config_registry, undefined);

  const setupSource = readSource("src/runtimeSetup.ts");
  assert.match(setupSource, /PIP_CONFIG_FILE\s*=\s*"\/dev\/null"/);
});

void test("source audit: the Python-download URL is the fixed official macOS installer page, referenced nowhere else as a different literal", () => {
  assert.equal(PYTHON_MACOS_DOWNLOAD_URL, "https://www.python.org/downloads/macos/");

  const coordinatorSource = readSource("src/runtimeSetupCoordinator.ts");
  const urlOccurrences = coordinatorSource.match(/https:\/\/www\.python\.org\/downloads\/macos\//g) ?? [];
  assert.ok(urlOccurrences.length >= 1);

  const otherPythonUrls = coordinatorSource.match(/https:\/\/(?!www\.python\.org\/downloads\/macos\/)[^\s"'`]*python\.org[^\s"'`]*/g) ?? [];
  assert.deepEqual(otherPythonUrls, [], "only one fixed python.org download URL should appear in the coordinator");
});

// ---------------------------------------------------------------------------
// (5) Setup confirmation copy: tested through the extracted pure seam, not main.ts text.
// ---------------------------------------------------------------------------

void test("RUNTIME_SETUP_CONFIRMATION_COPY discloses PyPI network access and the shared Application Support install location", () => {
  assert.match(RUNTIME_SETUP_CONFIRMATION_COPY.message, /PyPI/);
  assert.match(RUNTIME_SETUP_CONFIRMATION_COPY.message, /Application Support[/\\]Mindmap AI/);
  assert.match(RUNTIME_SETUP_CONFIRMATION_COPY.message, /network access/i);
  assert.equal(RUNTIME_SETUP_CONFIRMATION_COPY.confirmClass, "mod-cta");
  assert.ok(RUNTIME_SETUP_CONFIRMATION_COPY.title.length > 0);
  assert.ok(RUNTIME_SETUP_CONFIRMATION_COPY.confirmText.length > 0);
});

// ---------------------------------------------------------------------------
// (5) Public runtime-state invariants, exercised through the real coordinator.
// ---------------------------------------------------------------------------

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

function assertPublicStateInvariants(state: CoordinatorState): void {
  if (state.phase === "ready") {
    assert.equal(state.blocking, false, "ready must never be blocking");
    assert.equal(state.canSetup, false, "ready must not offer setup");
    assert.equal(state.canCancel, false, "ready must not offer cancel");
    assert.ok(state.interpreterPath, "ready must expose a concrete interpreter path");
  }
  if (state.phase === "not-applicable") {
    assert.equal(state.blocking, false, "not-applicable must never be blocking");
    assert.equal(state.canSetup, false);
    assert.equal(state.canCancel, false);
  }
  if (state.phase !== "ready" && state.phase !== "not-applicable") {
    assert.equal(state.blocking, true, `phase ${state.phase} must be blocking`);
  }
  if (state.canCancel) {
    assert.notEqual(state.phase, "ready", "ready must not be cancellable");
    assert.notEqual(state.phase, "not-applicable", "not-applicable must not be cancellable");
  }
  // canSetup and canCancel are never both true: setup is either offerable
  // (idle/failed) or already running (cancellable), never both at once.
  assert.ok(!(state.canSetup && state.canCancel), `phase ${state.phase} must not offer both setup and cancel simultaneously`);
}

void test("public runtime-state invariants hold across every phase reached during a full discovery + managed setup run", async () => {
  const REQUIREMENTS = "chromadb==1.4.0\nruamel.yaml==0.19.1\n";
  const APP_SUPPORT_ROOT = path.normalize("/Users/tester/Library/Application Support/Mindmap AI");
  const XCODE_PYTHON = "/usr/bin/python3";

  const stateHistory: CoordinatorState[] = [];
  const discoveryFs = new FakeDiscoveryFs(new Set([XCODE_PYTHON]));
  const setupFs = new FakeSetupFs();

  const invoke: ProcessInvoker = async (command) => {
    const packages = command.includes("staging") || command.includes("venv")
      ? { chromadb: "1.4.0", "ruamel.yaml": "0.19.1" }
      : { chromadb: null, "ruamel.yaml": null };
    return { stdout: `${JSON.stringify({ version: "3.12.4", venv: true, packages })}\n`, stderr: "", exitCode: 0 };
  };

  const spawner: SetupSpawner = () => {
    const child = new FakeChild();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };

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
    confirm: async () => true,
    persist: async () => undefined,
    verifyPreflight: async () => true,
    onStateChange: (state) => stateHistory.push(state),
  };

  const coordinator = new RuntimeReadinessCoordinator(options);
  const discovered = assertPublicStateInvariantsAndReturn(await coordinator.startDiscovery());
  assertPublicStateInvariants(discovered);
  const finalState = assertPublicStateInvariantsAndReturn(await coordinator.beginSetup());
  assertPublicStateInvariants(finalState);

  assert.ok(stateHistory.length > 0);
  for (const state of stateHistory) {
    assertPublicStateInvariants(state);
  }
  assert.equal(finalState.phase, "ready");
});

function assertPublicStateInvariantsAndReturn(state: CoordinatorState): CoordinatorState {
  assertPublicStateInvariants(state);
  return state;
}
