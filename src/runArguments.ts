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
]);

const NOTE_INCOMPATIBLE_FLAGS = new Set([
  "--current",
  "--all",
  "--refresh-all",
  "--rebuild",
  "--apply-preview",
  "--limit",
]);

export function assertSafeNoteArgument(value: string): void {
  const normalized = value.replace(/\\/g, "/");
  if (!value.trim() || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    throw new Error("Blocked unsafe individual note path: paths must be vault-relative.");
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("Blocked unsafe individual note path: traversal is not allowed.");
  }
  if (normalized.split("/").includes(".obsidian")) {
    throw new Error("Blocked unsafe individual note path: plugin/runtime internals are not notes.");
  }
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new Error("Blocked unsafe individual note path: the target must be a Markdown file.");
  }
}

export function assertAllowedPluginArgs(args: string[]): void {
  let noteSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--note") {
      if (noteSeen) {
        throw new Error("Blocked unexpected Mindmap CLI argument: --note may be provided only once.");
      }
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Blocked unexpected Mindmap CLI argument: --note requires one path value.");
      }
      assertSafeNoteArgument(value);
      noteSeen = true;
      index += 1;
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
}
