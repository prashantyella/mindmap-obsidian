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
]);

export function assertAllowedPluginArgs(args: string[]): void {
  for (const arg of args) {
    if (!ALLOWED_PLUGIN_ARGS.has(arg)) {
      throw new Error(`Blocked unexpected Mindmap CLI argument: ${arg}`);
    }
  }
}
