import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimePreflightVerifier, evaluateRuntimePreflight } from "./runtimeVerifier";
import type { ProcessInvoker } from "./runtimeDiscovery";

function runtimeOkChecks() {
  return [
    { code: "PYTHON_RUNTIME_OK", status: "ok" as const },
    { code: "DEPENDENCY_RUAMEL_OK", status: "ok" as const },
    { code: "DEPENDENCY_CHROMADB_OK", status: "ok" as const },
    { code: "CONFIG_OK", status: "ok" as const },
  ];
}

function fullCheck(code: string, status: "ok" | "error" | "skipped") {
  return { code, label: code, status, message: `${code}: ${status}` };
}

void test("evaluateRuntimePreflight is true when every runtime-specific check is ok", () => {
  assert.equal(evaluateRuntimePreflight(runtimeOkChecks()), true);
});

void test("evaluateRuntimePreflight ignores provider/model/scope check codes entirely", () => {
  const checks = [
    ...runtimeOkChecks(),
    { code: "CONFIG_FIELDS_MISSING", status: "error" as const },
    { code: "LLM_PROVIDER_UNREACHABLE", status: "error" as const },
    { code: "OLLAMA_MODEL_MISSING", status: "error" as const },
    { code: "APPLE_BOOKS_ACCESS_DENIED", status: "error" as const },
  ];
  assert.equal(evaluateRuntimePreflight(checks), true);
});

void test("evaluateRuntimePreflight is false when a runtime-specific check fails", () => {
  const missingDep = [
    { code: "PYTHON_RUNTIME_OK", status: "ok" as const },
    { code: "DEPENDENCY_RUAMEL_OK", status: "ok" as const },
    { code: "DEPENDENCY_CHROMADB_MISSING", status: "error" as const },
    { code: "CONFIG_OK", status: "ok" as const },
  ];
  assert.equal(evaluateRuntimePreflight(missingDep), false);

  const badConfig = [
    { code: "PYTHON_RUNTIME_OK", status: "ok" as const },
    { code: "DEPENDENCY_RUAMEL_OK", status: "ok" as const },
    { code: "DEPENDENCY_CHROMADB_OK", status: "ok" as const },
    { code: "CONFIG_INVALID", status: "error" as const },
  ];
  assert.equal(evaluateRuntimePreflight(badConfig), false);
});

void test("evaluateRuntimePreflight is false when no runtime-specific checks are present at all", () => {
  assert.equal(evaluateRuntimePreflight([{ code: "PREFLIGHT_OUTPUT_INVALID", status: "error" }]), false);
  assert.equal(evaluateRuntimePreflight([]), false);
});

void test("evaluateRuntimePreflight requires the complete four-group set: a partial-but-all-ok result is not ready", () => {
  // A truncated/malformed preflight run that only ever reported the interpreter
  // check must never be treated as ready just because everything present is ok.
  assert.equal(evaluateRuntimePreflight([{ code: "PYTHON_RUNTIME_OK", status: "ok" }]), false);
  assert.equal(
    evaluateRuntimePreflight([
      { code: "PYTHON_RUNTIME_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_OK", status: "ok" },
    ]),
    false,
  );
  assert.equal(
    evaluateRuntimePreflight([
      { code: "PYTHON_RUNTIME_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_OK", status: "ok" },
      { code: "DEPENDENCY_CHROMADB_OK", status: "ok" },
    ]),
    false,
  );
});

void test("evaluateRuntimePreflight rejects conflicting codes within the same group even when the ok code is also present", () => {
  assert.equal(
    evaluateRuntimePreflight([
      { code: "PYTHON_RUNTIME_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_MISSING", status: "error" },
      { code: "DEPENDENCY_CHROMADB_OK", status: "ok" },
      { code: "CONFIG_OK", status: "ok" },
    ]),
    false,
  );
});

void test("evaluateRuntimePreflight rejects a duplicated success code within the same group", () => {
  assert.equal(
    evaluateRuntimePreflight([
      { code: "PYTHON_RUNTIME_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_OK", status: "ok" },
      { code: "DEPENDENCY_CHROMADB_OK", status: "ok" },
      { code: "CONFIG_OK", status: "ok" },
    ]),
    false,
  );
});

void test("evaluateRuntimePreflight requires each group's own ok code, not just an 'ok' status on some unrelated code", () => {
  // Two "ok" entries under the same group's failure code (a malformed/spoofed
  // payload) must not satisfy the group.
  assert.equal(
    evaluateRuntimePreflight([
      { code: "PYTHON_RUNTIME_OK", status: "ok" },
      { code: "DEPENDENCY_RUAMEL_MISSING", status: "ok" },
      { code: "DEPENDENCY_CHROMADB_OK", status: "ok" },
      { code: "CONFIG_OK", status: "ok" },
    ]),
    false,
  );
});

void test("buildRuntimePreflightVerifier passes argv only (script, --config, configPath, --runtime-preflight) and parses structured output", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const payload = { ok: true, summary: "ready", checks: runtimeOkChecks().map((check) => fullCheck(check.code, check.status)) };
  const invoke: ProcessInvoker = async (command, args) => {
    calls.push({ command, args });
    return { stdout: `${JSON.stringify(payload)}\n`, stderr: "", exitCode: 0 };
  };

  const verify = buildRuntimePreflightVerifier({ scriptPath: "/plugin/python/mindmap.py", configPath: "/plugin/python/config.json", invoke });
  const result = await verify("/usr/bin/python3");

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/bin/python3");
  assert.deepEqual(calls[0].args, ["/plugin/python/mindmap.py", "--config", "/plugin/python/config.json", "--runtime-preflight"]);
});

void test("buildRuntimePreflightVerifier is false (never throws) on a runtime-check failure even when provider checks are also present", async () => {
  const payload = {
    ok: false,
    summary: "not ready",
    checks: [
      fullCheck("PYTHON_RUNTIME_OK", "ok"),
      fullCheck("DEPENDENCY_RUAMEL_OK", "ok"),
      fullCheck("DEPENDENCY_CHROMADB_MISSING", "error"),
      fullCheck("CONFIG_OK", "ok"),
      fullCheck("CONFIG_FIELDS_MISSING", "error"),
    ],
  };
  const invoke: ProcessInvoker = async () => ({ stdout: `${JSON.stringify(payload)}\n`, stderr: "", exitCode: 1 });
  const verify = buildRuntimePreflightVerifier({ scriptPath: "/plugin/python/mindmap.py", configPath: "/plugin/python/config.json", invoke });
  assert.equal(await verify("/usr/bin/python3"), false);
});

void test("buildRuntimePreflightVerifier is false, never throws, on spawn error or malformed output", async () => {
  const spawnFails: ProcessInvoker = async () => ({ stdout: "", stderr: "", exitCode: null, error: { code: "ENOENT", message: "boom" } });
  const verifySpawnFail = buildRuntimePreflightVerifier({ scriptPath: "/a", configPath: "/b", invoke: spawnFails });
  assert.equal(await verifySpawnFail("/usr/bin/python3"), false);

  const throwsInvoke: ProcessInvoker = async () => { throw new Error("boom"); };
  const verifyThrows = buildRuntimePreflightVerifier({ scriptPath: "/a", configPath: "/b", invoke: throwsInvoke });
  await assert.doesNotReject(async () => {
    assert.equal(await verifyThrows("/usr/bin/python3"), false);
  });

  const malformed: ProcessInvoker = async () => ({ stdout: "not json", stderr: "", exitCode: 0 });
  const verifyMalformed = buildRuntimePreflightVerifier({ scriptPath: "/a", configPath: "/b", invoke: malformed });
  assert.equal(await verifyMalformed("/usr/bin/python3"), false);
});
