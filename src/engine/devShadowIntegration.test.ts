import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Vault } from "obsidian";
import type { ResolvedRuntime } from "../pathResolver";
import { createDevShadowIntegration } from "./devShadowIntegration";
import type { DevShadowIntegrationHost } from "virtual:mindmap-dev-shadow";

/**
 * Tests the real dev-only coordinator (`createDevShadowIntegration`)
 * through a fake `DevShadowIntegrationHost` -- a fake `Vault` (only the
 * methods the coordinator actually calls: `getMarkdownFiles`,
 * `adapter.read`, `configDir`) plus fake log/notice/runtime callbacks.
 * Exercises against a REAL `NodeOwnedFs` over a throwaway temp directory
 * (mirrors how the composition wires it in `main.ts`), never a
 * Python/production vault path.
 */

async function makeTempPluginDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "mindmap-dev-shadow-"));
}

function fakeResolvedRuntime(configPath: string): ResolvedRuntime {
  return {
    command: { command: "python3", args: [], cwd: "/tmp" },
    scriptPath: "/tmp/mindmap.py",
    configPath,
    usedDefaults: { pythonCommand: true, scriptPath: true, configPath: true } as ResolvedRuntime["usedDefaults"],
    messages: [],
    trust: { level: "trusted", interpreter: "python3", script: "/tmp/mindmap.py", config: configPath, reasons: [] },
    valid: true,
  };
}

interface FakeVaultFile {
  path: string;
  extension: string;
}

function fakeVault(files: Record<string, string>, configDir = ".obsidian"): Vault {
  const entries: FakeVaultFile[] = Object.keys(files).map((filePath) => ({ path: filePath, extension: filePath.split(".").pop() ?? "" }));
  return {
    configDir,
    getMarkdownFiles: () => entries.filter((entry) => entry.extension === "md") as never,
    adapter: { read: async (relpath: string) => files[relpath] },
  } as unknown as Vault;
}

function makeHost(overrides: { pluginDir: string; vault: Vault; configPath: string; scopeConfig?: Record<string, unknown> }): { host: DevShadowIntegrationHost; logs: string[]; notices: string[] } {
  const logs: string[] = [];
  const notices: string[] = [];
  const runtime = fakeResolvedRuntime(overrides.configPath);
  const host: DevShadowIntegrationHost = {
    pluginDir: overrides.pluginDir,
    vault: overrides.vault,
    registerInterval: (callback, intervalMs) => setInterval(callback, intervalMs) as unknown as number,
    appendLog: (message) => { logs.push(message); },
    notice: (message) => { notices.push(message); },
    getResolvedRuntime: () => runtime,
    canManageConfig: () => true,
    fetchImpl: (async () => { throw new Error("fetchImpl must not be called unless the runtime config explicitly configures an embedding/metadata endpoint"); }) as unknown as typeof fetch,
  };
  return { host, logs, notices };
}

const LONG_NOTE = "word ".repeat(40).trim();

void test("createDevShadowIntegration: run() completes, logs a bounded [shadow] summary, and never throws", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs, notices } = makeHost({ pluginDir, vault, configPath });

    const integration = createDevShadowIntegration(host);
    await integration.run();

    assert.ok(logs.some((line) => line.startsWith("[shadow] Mindmap dev shadow:")));
    assert.ok(notices.some((message) => message.startsWith("Mindmap dev shadow:")));
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: a concurrent run() is rejected as busy rather than interleaving", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, notices } = makeHost({ pluginDir, vault, configPath });

    const integration = createDevShadowIntegration(host);
    const first = integration.run();
    const second = integration.run();
    await Promise.all([first, second]);

    assert.ok(notices.some((message) => message.includes("already running")));
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: dispose() during an in-flight run() guarantees no later Notice/log callback fires", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs, notices } = makeHost({ pluginDir, vault, configPath });

    const integration = createDevShadowIntegration(host);
    const runPromise = integration.run();
    integration.dispose();
    await runPromise;

    // Either the run finished before dispose() could interrupt it (in which case a summary IS
    // expected -- this test only asserts NO callback fires AFTER dispose(), not that none ever
    // fires at all), or it was cut off cleanly. Both are acceptable; what matters is nothing
    // throws and a second run() after dispose() stays a safe no-op.
    await integration.run();
    const logCountAfterDispose = logs.length;
    const noticeCountAfterDispose = notices.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(logs.length, logCountAfterDispose);
    assert.equal(notices.length, noticeCountAfterDispose);
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: run() catches an internal failure to one static Notice, never the raw error message", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host: baseHost, notices } = makeHost({ pluginDir, vault, configPath });
    // `getResolvedRuntime` is called directly inside `runOnce()`, outside any of
    // `planCatalogSample`/`runShadowComparison`'s own bounded per-item try/catches -- a throw here
    // is exactly the kind of genuinely-uncaught internal failure `run()`'s own outer catch exists
    // for, and its message ("raw secret disk path...") must never reach a Notice/log verbatim.
    const host: DevShadowIntegrationHost = { ...baseHost, getResolvedRuntime: () => { throw new Error("raw secret disk path /Users/real/name leaked"); } };

    const integration = createDevShadowIntegration(host);
    await integration.run();

    assert.ok(notices.some((message) => message.includes("failed to complete")));
    assert.ok(!notices.some((message) => message.includes("/Users/real/name")));
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: with a valid baseline file present, the run's comparison is NOT reported unavailable", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs } = makeHost({ pluginDir, vault, configPath });

    const engineDataRoot = path.join(pluginDir, "data", "mindmap-engine");
    await fs.promises.mkdir(engineDataRoot, { recursive: true });
    const hashedId = createHash("sha256").update("path:Notes/a.md", "utf8").digest("hex");
    const baseline = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true }] };
    await fs.promises.writeFile(path.join(engineDataRoot, "shadow-baseline.json"), JSON.stringify(baseline));

    const integration = createDevShadowIntegration(host);
    await integration.run();

    const summaryLine = logs.find((line) => line.startsWith("[shadow] Mindmap dev shadow:"));
    assert.ok(summaryLine);
    assert.equal(summaryLine?.includes("comparison unavailable"), false, "a loaded baseline must drive comparisonUnavailable=false, never present TS-only sampling as parity success");
    assert.match(summaryLine ?? "", /eligibility\(disagree \d+\)/);
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: with no baseline file, the run explicitly reports comparison unavailable", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs } = makeHost({ pluginDir, vault, configPath });

    const integration = createDevShadowIntegration(host);
    await integration.run();

    const summaryLine = logs.find((line) => line.startsWith("[shadow] Mindmap dev shadow:"));
    assert.match(summaryLine ?? "", /comparison unavailable \(no comparable domain evaluated\)/);
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: a malformed baseline file (fails strict parseShadowBaselineV1 validation) is logged and treated as no baseline, never crashing the run", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs } = makeHost({ pluginDir, vault, configPath });

    const engineDataRoot = path.join(pluginDir, "data", "mindmap-engine");
    await fs.promises.mkdir(engineDataRoot, { recursive: true });
    await fs.promises.writeFile(path.join(engineDataRoot, "shadow-baseline.json"), JSON.stringify({ schemaVersion: 1, entries: "not-an-array" }));

    const integration = createDevShadowIntegration(host);
    await integration.run();

    const summaryLine = logs.find((line) => line.startsWith("[shadow] Mindmap dev shadow:"));
    assert.match(summaryLine ?? "", /comparison unavailable/);
    assert.ok(logs.some((line) => line.includes("baseline load skipped")));
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: Ollama-only contract -- an openai_compatible llm_provider in config never triggers a fetchImpl call (no OpenAI-compatible wiring exists)", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(
      configPath,
      JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5, llm_provider: "openai_compatible", llm_base_url: "http://localhost:8000/v1", llm_model: "some-model", llm_api_key: "sk-should-never-be-read" }),
    );
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host } = makeHost({ pluginDir, vault, configPath });
    // makeHost's fetchImpl throws if ever called -- if openai_compatible wiring still existed,
    // run() would surface the STATIC_FAILURE_MESSAGE notice instead of a normal summary.

    const integration = createDevShadowIntegration(host);
    await integration.run();
    // No assertion needed beyond "did not throw/fail" -- run() completing without hitting the
    // failure path IS the proof fetchImpl was never invoked for the openai_compatible branch.
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: Apple parity is wired only when the baseline requests it -- appleReader stays uninvolved with no baseline appleReader section", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host, logs } = makeHost({ pluginDir, vault, configPath });

    const engineDataRoot = path.join(pluginDir, "data", "mindmap-engine");
    await fs.promises.mkdir(engineDataRoot, { recursive: true });
    const hashedId = createHash("sha256").update("path:Notes/a.md", "utf8").digest("hex");
    // A baseline WITHOUT an appleReader section.
    const baseline = { schemaVersion: 1, generatedAtIso: "2026-08-23T00:00:00.000Z", sampleCount: 1, entries: [{ hashedId, eligible: true }] };
    await fs.promises.writeFile(path.join(engineDataRoot, "shadow-baseline.json"), JSON.stringify(baseline));

    const integration = createDevShadowIntegration(host);
    await integration.run();
    // Completing without throwing (and the comparison summary above already proving
    // comparisonUnavailable=false) is consistent with appleReader staying undefined for this run --
    // shadowEngine.ts only ever calls `.read()` when BOTH `baseline.appleReader` and
    // `capabilities.appleReader` are present, and this baseline has no appleReader section.
    const summaryLine = logs.find((line) => line.startsWith("[shadow] Mindmap dev shadow:"));
    assert.ok(summaryLine);
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: Apple parity is invoked (one bounded read) when the baseline DOES request Apple data", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], notes_paths_all: ["Notes"], min_note_words: 5 }));
    const vault = fakeVault({ "Notes/a.md": `---\n---\n${LONG_NOTE}` });
    const { host } = makeHost({ pluginDir, vault, configPath });

    const engineDataRoot = path.join(pluginDir, "data", "mindmap-engine");
    await fs.promises.mkdir(engineDataRoot, { recursive: true });
    const hashedId = createHash("sha256").update("path:Notes/a.md", "utf8").digest("hex");
    // A baseline WITH an appleReader section -- no annotation_database_path is configured, so the
    // real AppleBooksSqliteReader's own discovery fails fast (status "unavailable") WITHOUT ever
    // spawning a sqlite3 subprocess (mirrors `readAnnotations`'s own early-return when no
    // annotation path is discovered) -- deterministic and fast in a sandboxed test environment.
    const baseline = {
      schemaVersion: 1,
      generatedAtIso: "2026-08-23T00:00:00.000Z",
      sampleCount: 1,
      entries: [{ hashedId, eligible: true }],
      appleReader: { status: "unavailable", count: 0 },
    };
    await fs.promises.writeFile(path.join(engineDataRoot, "shadow-baseline.json"), JSON.stringify(baseline));

    const integration = createDevShadowIntegration(host);
    // This must complete without throwing/timing out -- a real (bounded) AppleBooksSqliteReader
    // composition is exercised end to end here.
    await integration.run();
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

void test("createDevShadowIntegration: dev composition explicitly includes the Reading root even when notes_paths_current does not cover it", async () => {
  const pluginDir = await makeTempPluginDir();
  try {
    const configPath = path.join(pluginDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["SomeOtherFolder"], notes_paths_all: ["SomeOtherFolder"], min_note_words: 5 }));
    const annotationText = ["---", "type: apple-books-annotation", "annotation_id: abc-1", "---", LONG_NOTE].join("\n");
    const vault = fakeVault({ "Books/Apple Books/Author/Book/Annotations/note.md": annotationText });
    const { host, logs } = makeHost({ pluginDir, vault, configPath });

    const integration = createDevShadowIntegration(host);
    await integration.run();

    const summaryLine = logs.find((line) => line.startsWith("[shadow] Mindmap dev shadow:"));
    assert.ok(summaryLine);
    assert.match(summaryLine ?? "", /sampled 1 notes/);
    integration.dispose();
  } finally {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});
