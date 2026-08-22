import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareVersions,
  computeRequirementsFingerprint,
  createNodeDiscoveryFs,
  discoverRuntime,
  generateMacCandidates,
  getManagedInterpreterPath,
  getManagedStagingDir,
  getManagedVenvDir,
  isWithinManagedRuntimeRoot,
  normalizeCandidates,
  probeInterpreter,
  type DiscoveryEnv,
  type DiscoveryFs,
  type ProcessInvocationResult,
  type ProcessInvoker,
  type RuntimeCandidate,
} from "./runtimeDiscovery";

const REQUIREMENTS = "chromadb==1.4.0\nruamel.yaml>=0.18.10\n";

function makeEnv(overrides: Partial<DiscoveryEnv> = {}): DiscoveryEnv {
  return {
    homeDir: "/Users/tester",
    pathEnv: "/usr/bin:/bin",
    arch: "arm64",
    appSupportRoot: "/Users/tester/Library/Application Support/Mindmap AI",
    requirementsFileContents: REQUIREMENTS,
    ...overrides,
  };
}

class FakeFs implements DiscoveryFs {
  constructor(private readonly executableFiles: Set<string>, private readonly realpaths: Map<string, string> = new Map()) {}

  existsSync(targetPath: string): boolean {
    return this.executableFiles.has(path.normalize(targetPath));
  }

  statSync(targetPath: string) {
    if (!this.existsSync(targetPath)) {
      throw new Error(`Missing path in FakeFs: ${targetPath}`);
    }
    return { isFile: () => true, mode: 0o755 };
  }

  realpathSync(targetPath: string): string {
    const normalized = path.normalize(targetPath);
    return this.realpaths.get(normalized) ?? normalized;
  }
}

function readyInvoker(version = "3.12.4"): ProcessInvoker {
  return async () => ({
    stdout: JSON.stringify({ version, venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }),
    stderr: "",
    exitCode: 0,
  });
}

void test("generateMacCandidates orders managed, framework, homebrew (arch-first), PATH, then xcode", () => {
  const armCandidates = generateMacCandidates(makeEnv({ arch: "arm64" }));
  assert.equal(armCandidates[0].source, "managed");
  assert.equal(armCandidates[armCandidates.length - 1].source, "xcode");
  assert.equal(armCandidates[armCandidates.length - 1].path, "/usr/bin/python3");

  const frameworkStart = armCandidates.findIndex((candidate) => candidate.source === "framework");
  assert.equal(armCandidates[frameworkStart].path, path.join("/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"));

  const homebrewStart = armCandidates.findIndex((candidate) => candidate.source === "homebrew");
  assert.ok(armCandidates[homebrewStart].path.startsWith("/opt/homebrew"));

  const x64Candidates = generateMacCandidates(makeEnv({ arch: "x64" }));
  const x64HomebrewStart = x64Candidates.findIndex((candidate) => candidate.source === "homebrew");
  assert.ok(x64Candidates[x64HomebrewStart].path.startsWith("/usr/local"));
});

void test("generateMacCandidates is deterministic across repeated calls", () => {
  const env = makeEnv();
  const first = generateMacCandidates(env).map((candidate) => candidate.path);
  const second = generateMacCandidates(env).map((candidate) => candidate.path);
  assert.deepEqual(first, second);
});

void test("generateMacCandidates ignores relative, empty, and '.' PATH entries", () => {
  const candidates = generateMacCandidates(makeEnv({ pathEnv: "relative/bin::.:/usr/bin:./also-relative:/bin" }));
  const pathSourced = candidates.filter((candidate) => candidate.source === "path").map((candidate) => candidate.path);
  assert.deepEqual(pathSourced, [path.join("/usr/bin", "python3"), path.join("/bin", "python3")]);
});

void test("normalizeCandidates drops missing files and dedups by realpath", () => {
  const fs = new FakeFs(
    new Set(["/opt/homebrew/bin/python3.13", "/usr/local/bin/python3.13"]),
    new Map([[path.normalize("/usr/local/bin/python3.13"), path.normalize("/opt/homebrew/bin/python3.13")]]),
  );

  const candidates: RuntimeCandidate[] = [
    { path: "/opt/homebrew/bin/python3.13", source: "homebrew" },
    { path: "/usr/local/bin/python3.13", source: "homebrew" },
    { path: "/does/not/exist", source: "homebrew" },
  ];

  const result = normalizeCandidates(candidates, fs);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, path.normalize("/opt/homebrew/bin/python3.13"));
});

void test("normalizeCandidates rejects non-executable files", () => {
  class NonExecFs implements DiscoveryFs {
    existsSync(): boolean {
      return true;
    }
    statSync() {
      return { isFile: () => true, mode: 0o644 };
    }
  }

  const result = normalizeCandidates([{ path: "/usr/bin/python3", source: "xcode" }], new NonExecFs());
  assert.equal(result.length, 0);
});

void test("computeRequirementsFingerprint is stable and changes with requirements", () => {
  const a = computeRequirementsFingerprint(REQUIREMENTS);
  const b = computeRequirementsFingerprint(REQUIREMENTS);
  const c = computeRequirementsFingerprint(`${REQUIREMENTS}\nsomething-else==1.0.0`);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

void test("managed runtime path helpers stay under the application support root", () => {
  const root = "/Users/tester/Library/Application Support/Mindmap AI";
  const fingerprint = computeRequirementsFingerprint(REQUIREMENTS);
  const venvDir = getManagedVenvDir(root, fingerprint);
  const stagingDir = getManagedStagingDir(root, fingerprint);
  const interpreterPath = getManagedInterpreterPath(root, fingerprint);

  assert.ok(isWithinManagedRuntimeRoot(root, venvDir));
  assert.ok(isWithinManagedRuntimeRoot(root, stagingDir));
  assert.ok(isWithinManagedRuntimeRoot(root, interpreterPath));
  assert.ok(!isWithinManagedRuntimeRoot(root, "/etc/passwd"));
  assert.equal(interpreterPath, path.join(venvDir, "bin", "python3"));
});

void test("compareVersions orders dotted numeric versions", () => {
  assert.equal(compareVersions("0.18.10", "0.18.10"), 0);
  assert.equal(compareVersions("0.18.12", "0.18.10"), 1);
  assert.equal(compareVersions("0.9.0", "0.18.0"), -1);
});

void test("probeInterpreter classifies ready when version and package constraints are satisfied", async () => {
  const result = await probeInterpreter(
    { path: "/opt/homebrew/bin/python3.12", source: "homebrew" },
    { invoke: readyInvoker() },
  );
  assert.equal(result.classification, "ready");
  assert.equal(result.pythonVersion, "3.12.4");
  assert.ok(result.packages.every((pkg) => pkg.satisfies));
});

void test("probeInterpreter classifies bootstrap-only when packages are missing but venv works", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: null, "ruamel.yaml": null } }),
    stderr: "",
    exitCode: 0,
  });

  const result = await probeInterpreter({ path: "/usr/bin/python3", source: "xcode" }, { invoke });
  assert.equal(result.classification, "bootstrap-only");
  assert.ok(result.packages.every((pkg) => !pkg.satisfies));
});

void test("probeInterpreter classifies incompatible when venv/ensurepip is unavailable", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.12.4", venv: false, packages: { chromadb: null, "ruamel.yaml": null } }),
    stderr: "",
    exitCode: 0,
  });

  const result = await probeInterpreter({ path: "/usr/bin/python3", source: "xcode" }, { invoke });
  assert.equal(result.classification, "incompatible");
});

void test("probeInterpreter classifies incompatible for unsupported Python versions", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.9.6", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }),
    stderr: "",
    exitCode: 0,
  });

  const result = await probeInterpreter({ path: "/usr/bin/python3", source: "xcode" }, { invoke });
  assert.equal(result.classification, "incompatible");
  assert.equal(result.pythonVersion, "3.9.6");
});

void test("probeInterpreter never leaks raw error.message into diagnostics on spawn error", async () => {
  const secret = "SECRET_TOKEN=abc123";
  const invoke: ProcessInvoker = async (): Promise<ProcessInvocationResult> => ({
    stdout: "",
    stderr: "",
    exitCode: null,
    error: { code: "ENOENT", message: `spawn /no/such/python ENOENT with ${secret} in env dump `.repeat(20) },
  });

  const result = await probeInterpreter({ path: "/no/such/python", source: "path" }, { invoke });
  assert.equal(result.classification, "unavailable");
  assert.equal(result.diagnostics.length, 1);
  assert.ok(result.diagnostics[0].length <= 520);
  assert.ok(!result.diagnostics[0].includes(secret));
  assert.ok(result.diagnostics[0].includes("ENOENT"));
});

void test("probeInterpreter never leaks raw stderr into diagnostics on non-zero exit or malformed output", async () => {
  const secret = "SECRET_TOKEN=abc123";

  const nonZeroExit = await probeInterpreter(
    { path: "/usr/bin/python3", source: "xcode" },
    { invoke: async () => ({ stdout: "", stderr: `boom: ${secret}`, exitCode: 1 }) },
  );
  assert.equal(nonZeroExit.classification, "unavailable");
  assert.ok(!nonZeroExit.diagnostics.join(" ").includes(secret));

  const malformedOutput = await probeInterpreter(
    { path: "/usr/bin/python3", source: "xcode" },
    { invoke: async () => ({ stdout: "not json", stderr: `traceback: ${secret}`, exitCode: 0 }) },
  );
  assert.equal(malformedOutput.classification, "unavailable");
  assert.ok(!malformedOutput.diagnostics.join(" ").includes(secret));
});

void test("probeInterpreter downgrades to bootstrap-only when Mindmap preflight verification fails but venv is available", async () => {
  const result = await probeInterpreter(
    { path: "/opt/homebrew/bin/python3.12", source: "homebrew" },
    { invoke: readyInvoker(), verifyPreflight: async () => false },
  );
  assert.equal(result.classification, "bootstrap-only");
  assert.equal(result.preflightOk, false);
});

void test("probeInterpreter classifies incompatible when preflight fails and venv/ensurepip is unavailable", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.12.4", venv: false, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }),
    stderr: "",
    exitCode: 0,
  });

  const result = await probeInterpreter(
    { path: "/opt/homebrew/bin/python3.12", source: "homebrew" },
    { invoke, verifyPreflight: async () => false },
  );
  assert.equal(result.classification, "incompatible");
  assert.equal(result.preflightOk, false);
});

void test("probeInterpreter rejects malformed probe payloads (non-numeric version, non-string/null package values)", async () => {
  const badVersion = await probeInterpreter(
    { path: "/usr/bin/python3", source: "xcode" },
    { invoke: async () => ({ stdout: JSON.stringify({ version: "3.12", venv: true, packages: {} }), stderr: "", exitCode: 0 }) },
  );
  assert.equal(badVersion.classification, "unavailable");

  const badPackageValue = await probeInterpreter(
    { path: "/usr/bin/python3", source: "xcode" },
    { invoke: async () => ({ stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: 42 } }), stderr: "", exitCode: 0 }) },
  );
  assert.equal(badPackageValue.classification, "unavailable");
});

void test("discoverRuntime never invokes a shell: only command + argv reach the invoker", async () => {
  const seenCalls: { command: string; args: string[] }[] = [];
  const invoke: ProcessInvoker = async (command, args) => {
    seenCalls.push({ command, args });
    return { stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }), stderr: "", exitCode: 0 };
  };

  const fs = new FakeFs(new Set(["/opt/homebrew/bin/python3.13"]));
  await discoverRuntime({
    pythonCommandSetting: "python3",
    env: makeEnv(),
    fs,
    invoke,
  });

  assert.ok(seenCalls.length > 0);
  for (const call of seenCalls) {
    assert.ok(!call.command.includes(" "));
    assert.ok(Array.isArray(call.args));
    assert.ok(call.args.every((arg) => typeof arg === "string"));
  }
});

void test("discoverRuntime selects the first ready candidate and stops probing further candidates", async () => {
  const probedPaths: string[] = [];
  const invoke: ProcessInvoker = async (command) => {
    probedPaths.push(command);
    if (command === "/opt/homebrew/bin/python3.13") {
      return { stdout: JSON.stringify({ version: "3.13.0", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }), stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: null, "ruamel.yaml": null } }), stderr: "", exitCode: 0 };
  };

  const fs = new FakeFs(new Set(["/opt/homebrew/bin/python3.13"]));
  const result = await discoverRuntime({ pythonCommandSetting: "", env: makeEnv(), fs, invoke });

  assert.equal(result.outcome, "ready");
  assert.equal(result.selected?.path, "/opt/homebrew/bin/python3.13");
  assert.equal(probedPaths.length, 1);
});

void test("discoverRuntime returns best bootstrap candidate when nothing is fully ready", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: null, "ruamel.yaml": null } }),
    stderr: "",
    exitCode: 0,
  });

  const fs = new FakeFs(new Set(["/usr/bin/python3"]));
  const result = await discoverRuntime({ pythonCommandSetting: "python3", env: makeEnv(), fs, invoke });

  assert.equal(result.outcome, "bootstrap-required");
  assert.equal(result.bestBootstrap?.path, "/usr/bin/python3");
});

void test("discoverRuntime preserves an explicit custom interpreter and never falls back to auto discovery", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.9.1", venv: true, packages: { chromadb: null, "ruamel.yaml": null } }),
    stderr: "",
    exitCode: 0,
  });

  const fs = new FakeFs(new Set(["/opt/custom/python3", "/opt/homebrew/bin/python3.13"]));
  const result = await discoverRuntime({
    pythonCommandSetting: "/opt/custom/python3",
    env: makeEnv(),
    fs,
    invoke,
  });

  assert.equal(result.customInterpreterPreserved, true);
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.probed.length, 1);
  assert.equal(result.probed[0].path, path.normalize("/opt/custom/python3"));
});

void test("discoverRuntime resolves a bare explicit custom command only against absolute PATH directories", async () => {
  const probedPaths: string[] = [];
  const invoke: ProcessInvoker = async (command) => {
    probedPaths.push(command);
    return { stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }), stderr: "", exitCode: 0 };
  };

  // Also present at a Homebrew-style location that auto-discovery would otherwise probe;
  // resolution must stay confined to PATH dirs and never wander into that candidate.
  const fs = new FakeFs(new Set(["/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12"]));
  const result = await discoverRuntime({
    pythonCommandSetting: "python3.12",
    env: makeEnv({ pathEnv: "relative/bin:/usr/local/bin:/opt/homebrew/bin" }),
    fs,
    invoke,
  });

  assert.equal(result.customInterpreterPreserved, true);
  assert.equal(result.outcome, "ready");
  assert.equal(result.selected?.path, path.normalize("/usr/local/bin/python3.12"));
  assert.deepEqual(probedPaths, [path.normalize("/usr/local/bin/python3.12")]);
});

void test("discoverRuntime reports unavailable for a bare explicit custom command with no PATH match", async () => {
  const invoke: ProcessInvoker = async () => ({
    stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }),
    stderr: "",
    exitCode: 0,
  });

  const fs = new FakeFs(new Set(["/opt/homebrew/bin/python3.12"]));
  const result = await discoverRuntime({
    pythonCommandSetting: "python3.12",
    env: makeEnv({ pathEnv: "/usr/bin:/bin" }),
    fs,
    invoke,
  });

  assert.equal(result.customInterpreterPreserved, true);
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.probed.length, 0);
});

void test("discoverRuntime treats blank and default python3 settings as automatic discovery", async () => {
  const invoke = readyInvoker();
  const fs = new FakeFs(new Set(["/opt/homebrew/bin/python3.13"]));

  const blank = await discoverRuntime({ pythonCommandSetting: "", env: makeEnv(), fs, invoke });
  const defaulted = await discoverRuntime({ pythonCommandSetting: "python3", env: makeEnv(), fs, invoke });

  assert.equal(blank.customInterpreterPreserved, false);
  assert.equal(defaulted.customInterpreterPreserved, false);
  assert.equal(blank.selected?.path, "/opt/homebrew/bin/python3.13");
  assert.equal(defaulted.selected?.path, "/opt/homebrew/bin/python3.13");
});

void test("discoverRuntime reuses an already-verified shared managed runtime as the top candidate", async () => {
  const fingerprint = computeRequirementsFingerprint(REQUIREMENTS);
  const managedPath = getManagedInterpreterPath("/Users/tester/Library/Application Support/Mindmap AI", fingerprint);
  const probedPaths: string[] = [];

  const invoke: ProcessInvoker = async (command) => {
    probedPaths.push(command);
    return { stdout: JSON.stringify({ version: "3.12.4", venv: true, packages: { chromadb: "1.4.0", "ruamel.yaml": "0.18.12" } }), stderr: "", exitCode: 0 };
  };

  const fs = new FakeFs(new Set([managedPath]));
  const result = await discoverRuntime({
    pythonCommandSetting: "",
    env: makeEnv({ homeDir: "/Users/second-vault-user" }),
    fs,
    invoke,
  });

  assert.equal(result.outcome, "ready");
  assert.equal(result.selected?.path, path.normalize(managedPath));
  assert.deepEqual(probedPaths, [path.normalize(managedPath)]);
});

void test("createNodeDiscoveryFs reports real files as executable and unknown paths as absent", () => {
  const thisFile = fileURLToPath(import.meta.url);
  const realFs = createNodeDiscoveryFs();
  assert.equal(realFs.existsSync("/no/such/mindmap-runtime-discovery-fixture"), false);
  assert.equal(realFs.existsSync(thisFile), true);
  const stat = realFs.statSync(thisFile);
  assert.equal(stat.isFile(), true);
  assert.equal(typeof realFs.realpathSync?.(thisFile), "string");
});
