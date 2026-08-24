export interface ScopeSelection {
  currentPaths: string[];
  allPaths: string[];
}

export interface VaultFolderOption {
  value: string;
  label: string;
}

function normalizeFolderPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/\\/g, "/");
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

export function isScopeSetupComplete(selection: ScopeSelection): boolean {
  return selection.currentPaths.length > 0 && selection.allPaths.length > 0;
}

/** Validates and normalizes a proposed scope selection -- throws if either scope would end up empty. Never touches a file; the caller persists the result into plugin settings. */
export function validateScopeSelection(selection: ScopeSelection): ScopeSelection {
  const currentPaths = normalizeScopePaths(selection.currentPaths);
  const allPaths = normalizeScopePaths(selection.allPaths);
  if (currentPaths.length === 0 || allPaths.length === 0) {
    throw new Error("Select at least one folder for both current and all scopes.");
  }
  return { currentPaths, allPaths };
}
