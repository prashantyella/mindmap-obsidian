import path from "node:path";

export const REQUIRED_RUNTIME_ASSET_NAMES = [
  "mindmap.py",
  "requirements.txt",
  "config.template.json",
] as const;

export type RuntimeAssetName = typeof REQUIRED_RUNTIME_ASSET_NAMES[number];
export type BundledRuntimeAssets = Record<RuntimeAssetName, string>;

export interface RuntimeAssetFs {
  existsSync(targetPath: string): boolean;
  mkdir(targetPath: string, options: { recursive: boolean }): Promise<void>;
  writeFile(targetPath: string, content: string, encoding: BufferEncoding): Promise<void>;
}

export interface RuntimeProvisionResult {
  ok: boolean;
  runtimeDir: string;
  recovered: string[];
  configCreated: boolean;
  message: string;
}

const CONFIG_FILENAME = "config.json";

export async function ensureBundledRuntimeAssets(
  runtimeDir: string,
  bundledAssets: BundledRuntimeAssets,
  fileSystem: RuntimeAssetFs,
): Promise<RuntimeProvisionResult> {
  try {
    await fileSystem.mkdir(runtimeDir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      runtimeDir,
      recovered: [],
      configCreated: false,
      message: `Mindmap could not prepare its runtime directory. ${toErrorMessage(error)} Open the plugin folder permissions or reinstall the plugin.`,
    };
  }

  const recovered: string[] = [];
  for (const assetName of REQUIRED_RUNTIME_ASSET_NAMES) {
    const targetPath = path.join(runtimeDir, assetName);
    if (fileSystem.existsSync(targetPath)) {
      continue;
    }

    const assetContent = bundledAssets[assetName];
    if (typeof assetContent !== "string") {
      return {
        ok: false,
        runtimeDir,
        recovered,
        configCreated: false,
        message: `Bundled runtime asset is missing: ${assetName}. Reinstall or update the plugin, then reopen Obsidian.`,
      };
    }

    try {
      await fileSystem.writeFile(targetPath, assetContent, "utf8");
    } catch (error) {
      return {
        ok: false,
        runtimeDir,
        recovered,
        configCreated: false,
        message: `Mindmap could not restore ${assetName}. ${toErrorMessage(error)} Reinstall the plugin or restore write access to the plugin folder.`,
      };
    }
    recovered.push(assetName);
  }

  const configPath = path.join(runtimeDir, CONFIG_FILENAME);
  let configCreated = false;
  if (!fileSystem.existsSync(configPath)) {
    try {
      await fileSystem.writeFile(configPath, bundledAssets["config.template.json"], "utf8");
    } catch (error) {
      return {
        ok: false,
        runtimeDir,
        recovered,
        configCreated: false,
        message: `Mindmap could not create ${CONFIG_FILENAME}. ${toErrorMessage(error)} Reinstall the plugin or restore write access to the plugin folder.`,
      };
    }
    configCreated = true;
  }

  if (recovered.length === 0 && !configCreated) {
    return {
      ok: true,
      runtimeDir,
      recovered,
      configCreated,
      message: "Mindmap runtime assets verified.",
    };
  }

  const repaired = [...recovered, ...(configCreated ? [CONFIG_FILENAME] : [])].join(", ");
  return {
    ok: true,
    runtimeDir,
    recovered,
    configCreated,
    message: `Mindmap restored runtime assets: ${repaired}.`,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown filesystem error.";
}
