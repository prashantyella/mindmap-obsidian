/**
 * `configDir` is the real, possibly-user-renamed Obsidian configuration
 * folder (Vault#configDir), threaded in by every call site that has
 * plugin/app context. It is required (not optional/defaulted) so a caller
 * can never silently skip this check by omission.
 */
export function assertSafeNoteArgument(value: string, configDir: string): void {
  const raw = value.replace(/\\/g, "/");
  if (!value.trim() || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.startsWith("//")) {
    throw new Error("Blocked unsafe individual note path: paths must be vault-relative.");
  }
  if (raw.split("/").includes("..")) {
    throw new Error("Blocked unsafe individual note path: traversal is not allowed.");
  }
  // Collapse "." segments (e.g. a leading "./") before the runtime-internals
  // and extension checks below, so "./.obsidian/plugins/..." is recognized
  // as the same target as ".obsidian/plugins/..." -- matching how
  // src/individualNote.ts's normalizePath treats a leading "./".
  const normalized = raw.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
  const normalizedConfigDir = configDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalizedConfigDir && (normalized === normalizedConfigDir || normalized.startsWith(`${normalizedConfigDir}/`))) {
    throw new Error("Blocked unsafe individual note path: plugin/runtime internals are not notes.");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Blocked unsafe individual note path: the target must be a Markdown file.");
  }
}
