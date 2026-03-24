import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { formatCommandPreview, resolveRuntime, type PathFs, type RuntimeContext } from "./pathResolver";
import { DEFAULT_SETTINGS } from "./settings";

class FakeFs implements PathFs {
  constructor(private readonly files: Set<string>) {}

  existsSync(targetPath: string): boolean {
    return this.files.has(path.normalize(targetPath));
  }

  statSync(targetPath: string): { isFile(): boolean; isDirectory(): boolean } {
    if (!this.existsSync(targetPath)) {
      throw new Error(`Missing path in FakeFs: ${targetPath}`);
    }

    return {
      isFile: () => true,
      isDirectory: () => false,
    };
  }
}

function createContext(): RuntimeContext {
  return {
    vaultRoot: path.normalize("/vault"),
    pluginDir: path.normalize("/vault/.obsidian/plugins/mindmap-obsidian"),
  };
}

test("resolveRuntime uses bundled defaults when settings are blank", () => {
  const context = createContext();
  const fakeFs = new FakeFs(
    new Set([
      path.join(context.pluginDir, "python", "mindmap.py"),
      path.join(context.pluginDir, "python", "config.template.json"),
    ]),
  );

  const runtime = resolveRuntime(DEFAULT_SETTINGS, context, fakeFs);

  assert.equal(runtime.valid, true);
  assert.equal(runtime.command.command, "python3");
  assert.equal(runtime.scriptPath, path.join(context.pluginDir, "python", "mindmap.py"));
  assert.equal(runtime.configPath, path.join(context.pluginDir, "python", "config.template.json"));
  assert.equal(runtime.usedDefaults.scriptPath, true);
  assert.equal(runtime.trust.level, "trusted");
  assert.match(formatCommandPreview(runtime, ["--current"]), /python3/);
});

test("resolveRuntime accepts vault-relative overrides inside the vault", () => {
  const context = createContext();
  const fakeFs = new FakeFs(
    new Set([
      "/vault/.obsidian/plugins/mindmap-obsidian/python/mindmap.py",
      "/vault/.obsidian/plugins/mindmap-obsidian/python/config.template.json",
      "/vault/tools/python/bin/python",
      "/vault/custom/mindmap.py",
      "/vault/custom/config.json",
    ]),
  );

  const runtime = resolveRuntime(
    {
      pythonCommand: "tools/python/bin/python",
      scriptPath: "custom/mindmap.py",
      configPath: "custom/config.json",
    },
    context,
    fakeFs,
  );

  assert.equal(runtime.valid, true);
  assert.equal(runtime.command.command, path.normalize("/vault/tools/python/bin/python"));
  assert.equal(runtime.scriptPath, path.normalize("/vault/custom/mindmap.py"));
  assert.equal(runtime.configPath, path.normalize("/vault/custom/config.json"));
  assert.equal(runtime.trust.level, "caution");
});

test("resolveRuntime rejects traversal outside the vault", () => {
  const context = createContext();
  const fakeFs = new FakeFs(new Set());

  const runtime = resolveRuntime(
    {
      pythonCommand: "python3",
      scriptPath: "../../outside.py",
      configPath: "../outside-config.json",
    },
    context,
    fakeFs,
  );

  assert.equal(runtime.valid, false);
  assert(runtime.messages.some((message) => message.field === "scriptPath" && message.level === "error"));
  assert(runtime.messages.some((message) => message.field === "configPath" && message.level === "error"));
});

test("resolveRuntime rejects absolute script and config paths", () => {
  const context = createContext();
  const fakeFs = new FakeFs(new Set());

  const runtime = resolveRuntime(
    {
      pythonCommand: "/opt/python3",
      scriptPath: "/tmp/mindmap.py",
      configPath: "/tmp/config.json",
    },
    context,
    fakeFs,
  );

  assert.equal(runtime.valid, false);
  assert(runtime.messages.some((message) => message.field === "scriptPath" && message.message.includes("Absolute paths are not allowed")));
  assert(runtime.messages.some((message) => message.field === "configPath" && message.message.includes("Absolute paths are not allowed")));
});

test("resolveRuntime rejects python commands with shell metacharacters", () => {
  const context = createContext();
  const fakeFs = new FakeFs(
    new Set([
      path.join(context.pluginDir, "python", "mindmap.py"),
      path.join(context.pluginDir, "python", "config.template.json"),
    ]),
  );

  const runtime = resolveRuntime(
    {
      pythonCommand: "python3; rm -rf /",
      scriptPath: "",
      configPath: "",
    },
    context,
    fakeFs,
  );

  assert.equal(runtime.valid, false);
  assert(runtime.messages.some((message) => message.field === "pythonCommand" && message.message.includes("blocked shell metacharacters")));
});

test("resolveRuntime rejects compound python commands with spaces", () => {
  const context = createContext();
  const fakeFs = new FakeFs(
    new Set([
      path.join(context.pluginDir, "python", "mindmap.py"),
      path.join(context.pluginDir, "python", "config.template.json"),
    ]),
  );

  const runtime = resolveRuntime(
    {
      pythonCommand: "python3 -c",
      scriptPath: "",
      configPath: "",
    },
    context,
    fakeFs,
  );

  assert.equal(runtime.valid, false);
  assert(runtime.messages.some((message) => message.field === "pythonCommand" && message.message.includes("single executable name")));
});
