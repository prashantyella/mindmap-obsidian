import test from "node:test";
import assert from "node:assert/strict";

import { migrateLegacyPluginVaultRoot, type RuntimeConfigMigrationFs } from "./runtimeConfigMigration";

class MemoryFs implements RuntimeConfigMigrationFs {
  readonly files = new Map<string, string>();
  failWrites = false;

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.files.set(filePath, content);
    }
  }

  existsSync(targetPath: string): boolean {
    return this.files.has(targetPath);
  }

  async readFile(targetPath: string, _encoding: BufferEncoding): Promise<string> {
    const value = this.files.get(targetPath);
    if (value === undefined) {
      throw new Error("missing file");
    }
    return value;
  }

  async writeFile(targetPath: string, content: string, _encoding: BufferEncoding): Promise<void> {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.files.set(targetPath, content);
  }
}

function baseConfig(vaultRoot: string): string {
  return JSON.stringify({
    vault_root: vaultRoot,
    db_path: ".obsidian/plugins/mindmap-ai/data/chroma",
    state_path: ".obsidian/plugins/mindmap-ai/data/state.json",
    log_path: ".obsidian/plugins/mindmap-ai/logs/last-run.txt",
    notes_paths_current: [],
    notes_paths_all: [],
  });
}

test("migrateLegacyPluginVaultRoot updates legacy plugin vault_root value", async () => {
  const configPath = "/vault/.obsidian/plugins/mindmap-ai/python/config.json";
  const fs = new MemoryFs({
    [configPath]: baseConfig("../.."),
  });

  const result = await migrateLegacyPluginVaultRoot(configPath, fs);
  const updated = JSON.parse(fs.files.get(configPath) ?? "{}") as Record<string, unknown>;

  assert.equal(result.migrated, true);
  assert.match(result.message ?? "", /updated config\.json vault_root/i);
  assert.equal(updated.vault_root, "../../../../");
});

test("migrateLegacyPluginVaultRoot skips non-plugin-managed configs", async () => {
  const configPath = "/vault/.obsidian/plugins/mindmap-ai/python/config.json";
  const fs = new MemoryFs({
    [configPath]: JSON.stringify({
      vault_root: "../..",
      db_path: "Scripts/_Mindmap/_chroma",
      state_path: "Scripts/_Mindmap/_state.json",
      log_path: "Scripts/_Mindmap/_logs/last-run.txt",
    }),
  });

  const result = await migrateLegacyPluginVaultRoot(configPath, fs);
  const updated = JSON.parse(fs.files.get(configPath) ?? "{}") as Record<string, unknown>;

  assert.equal(result.migrated, false);
  assert.equal(result.message, null);
  assert.equal(updated.vault_root, "../..");
});

test("migrateLegacyPluginVaultRoot returns warning when write fails", async () => {
  const configPath = "/vault/.obsidian/plugins/mindmap-ai/python/config.json";
  const fs = new MemoryFs({
    [configPath]: baseConfig("../.."),
  });
  fs.failWrites = true;

  const result = await migrateLegacyPluginVaultRoot(configPath, fs);

  assert.equal(result.migrated, false);
  assert.match(result.message ?? "", /could not auto-migrate/i);
});

