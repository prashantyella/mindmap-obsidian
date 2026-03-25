const LEGACY_PLUGIN_VAULT_ROOT = "../..";
const CURRENT_PLUGIN_VAULT_ROOT = "../../../../";
const PLUGIN_PATH_PREFIX = ".obsidian/plugins/mindmap-ai/";

export interface RuntimeConfigMigrationFs {
  existsSync(targetPath: string): boolean;
  readFile(targetPath: string, encoding: BufferEncoding): Promise<string>;
  writeFile(targetPath: string, content: string, encoding: BufferEncoding): Promise<void>;
}

export interface RuntimeConfigMigrationResult {
  migrated: boolean;
  message: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPluginManagedPath(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PLUGIN_PATH_PREFIX);
}

function canMigrate(config: Record<string, unknown>): boolean {
  if (config.vault_root !== LEGACY_PLUGIN_VAULT_ROOT) {
    return false;
  }

  return isPluginManagedPath(config.db_path)
    && isPluginManagedPath(config.state_path)
    && isPluginManagedPath(config.log_path);
}

export async function migrateLegacyPluginVaultRoot(
  configPath: string,
  fileSystem: RuntimeConfigMigrationFs,
): Promise<RuntimeConfigMigrationResult> {
  if (!fileSystem.existsSync(configPath)) {
    return { migrated: false, message: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fileSystem.readFile(configPath, "utf8"));
  } catch {
    return { migrated: false, message: null };
  }

  if (!isRecord(parsed) || !canMigrate(parsed)) {
    return { migrated: false, message: null };
  }

  const next = { ...parsed, vault_root: CURRENT_PLUGIN_VAULT_ROOT };
  try {
    await fileSystem.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown filesystem error.";
    return {
      migrated: false,
      message: `Mindmap could not auto-migrate config.json vault_root. ${detail} Update vault_root to "../../../../" in plugin config manually.`,
    };
  }

  return {
    migrated: true,
    message: `Mindmap updated config.json vault_root from "${LEGACY_PLUGIN_VAULT_ROOT}" to "${CURRENT_PLUGIN_VAULT_ROOT}" for plugin installs.`,
  };
}

