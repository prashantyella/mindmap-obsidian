export const ALLOWED_PLUGIN_ARGS = new Set([
  "--preflight",
  "--current",
  "--all",
  "--apply",
  "--refresh-all",
  "--preview",
  "--apply-preview",
  "--rebuild",
  "--quiet",
  "--index",
  "--tag",
  "--note",
  "--include-reading-pending",
]);

const READING_PENDING_INCOMPATIBLE_FLAGS = new Set([
  "--current",
  "--note",
  "--refresh-all",
  "--rebuild",
  "--preview",
  "--apply-preview",
]);

const NOTE_INCOMPATIBLE_FLAGS = new Set([
  "--current",
  "--all",
  "--refresh-all",
  "--rebuild",
  "--apply-preview",
  "--limit",
]);

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

export function assertAllowedPluginArgs(args: string[], configDir: string): void {
  let noteSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--note" || arg.startsWith("--note=")) {
      if (noteSeen) {
        throw new Error("Blocked unexpected Mindmap CLI argument: --note may be provided only once.");
      }
      const inline = arg.startsWith("--note=");
      const value = inline ? arg.slice("--note=".length) : args[index + 1];
      if (!value || (!inline && value.startsWith("--"))) {
        throw new Error("Blocked unexpected Mindmap CLI argument: --note requires one path value.");
      }
      assertSafeNoteArgument(value, configDir);
      noteSeen = true;
      if (!inline) index += 1;
      continue;
    }
    if (noteSeen && NOTE_INCOMPATIBLE_FLAGS.has(arg)) {
      throw new Error(`Blocked incompatible Mindmap CLI arguments: --note cannot be combined with ${arg}.`);
    }
    if (!ALLOWED_PLUGIN_ARGS.has(arg)) {
      throw new Error(`Blocked unexpected Mindmap CLI argument: ${arg}`);
    }
  }

  if (noteSeen) {
    const conflict = args.find((arg) => NOTE_INCOMPATIBLE_FLAGS.has(arg));
    if (conflict) {
      throw new Error(`Blocked incompatible Mindmap CLI arguments: --note cannot be combined with ${conflict}.`);
    }
  }

  if (args.includes("--include-reading-pending")) {
    if (!args.includes("--all")) {
      throw new Error("Blocked incompatible Mindmap CLI arguments: --include-reading-pending requires --all.");
    }
    if (!args.includes("--apply")) {
      throw new Error("Blocked incompatible Mindmap CLI arguments: --include-reading-pending requires --apply.");
    }
    const conflict = args.find((arg) => READING_PENDING_INCOMPATIBLE_FLAGS.has(arg));
    if (conflict) {
      throw new Error(`Blocked incompatible Mindmap CLI arguments: --include-reading-pending cannot be combined with ${conflict}.`);
    }
  }
}
