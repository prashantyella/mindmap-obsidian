export interface ScopeSelection {
  currentPaths: string[];
  allPaths: string[];
}

export interface VaultFolderOption {
  value: string;
  label: string;
}

function normalizeFolderPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "/" || trimmed === ".") {
    return ".";
  }

  const normalized = trimmed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

  if (!normalized || normalized.split("/").some((segment) => segment === "..")) {
    return null;
  }

  return normalized;
}

function shouldSkipInternalFolder(value: string, configDir: string): boolean {
  if (!value) {
    return true;
  }
  if (value === "." || value === "/") {
    return false;
  }
  return value === configDir || value.startsWith(`${configDir}/`);
}

export function normalizeScopePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawPath of paths) {
    const value = normalizeFolderPath(rawPath);
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized.sort((left, right) => {
    if (left === ".") {
      return -1;
    }
    if (right === ".") {
      return 1;
    }
    return left.localeCompare(right);
  });
}

export function listVaultFolderOptions(folderPaths: string[], configDir: string): VaultFolderOption[] {
  const values = normalizeScopePaths([".", ...folderPaths]).filter((value) => !shouldSkipInternalFolder(value, configDir));
  return values.map((value) => ({
    value,
    label: value === "." ? "Vault root" : value,
  }));
}

function parseConfigObject(rawConfig: string): Record<string, unknown> {
  const parsed = JSON.parse(rawConfig) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Mindmap config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function getArrayField(config: Record<string, unknown>, field: string): string[] {
  const value = config[field];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function readScopeSelection(rawConfig: string): ScopeSelection {
  const config = parseConfigObject(rawConfig);
  return {
    currentPaths: normalizeScopePaths(getArrayField(config, "notes_paths_current")),
    allPaths: normalizeScopePaths(getArrayField(config, "notes_paths_all")),
  };
}

export function isScopeSetupComplete(selection: ScopeSelection): boolean {
  return selection.currentPaths.length > 0 && selection.allPaths.length > 0;
}

export function updateScopeSelection(rawConfig: string, selection: ScopeSelection): string {
  const config = parseConfigObject(rawConfig);
  const currentPaths = normalizeScopePaths(selection.currentPaths);
  const allPaths = normalizeScopePaths(selection.allPaths);

  if (currentPaths.length === 0 || allPaths.length === 0) {
    throw new Error("Select at least one folder for both current and all scopes.");
  }

  config.notes_paths = [...currentPaths];
  config.notes_paths_current = [...currentPaths];
  config.notes_paths_all = [...allPaths];

  return `${JSON.stringify(config, null, 2)}\n`;
}
