import fs from "node:fs";
import path from "node:path";
import type { MindmapSettings, RuntimeField } from "./settings";

export interface RuntimeContext {
  vaultRoot: string;
  configDir: string;
  pluginDir: string;
}

export interface RuntimeCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface ValidationMessage {
  field: RuntimeField | "runtime";
  level: "error" | "info";
  message: string;
}

export type TrustLevel = "trusted" | "caution" | "blocked";

export interface RuntimeTrustState {
  level: TrustLevel;
  interpreter: string;
  script: string;
  config: string;
  reasons: string[];
}

export interface ResolvedRuntime {
  command: RuntimeCommand;
  scriptPath: string;
  configPath: string;
  usedDefaults: Record<RuntimeField, boolean>;
  messages: ValidationMessage[];
  trust: RuntimeTrustState;
  valid: boolean;
}

export interface PathFs {
  existsSync(targetPath: string): boolean;
  statSync(targetPath: string): { isFile(): boolean; isDirectory(): boolean };
}

const nodeFs: PathFs = fs;
const SAFE_PATH_COMMAND_PATTERN = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_COMMAND_CHARS_PATTERN = /["'`;&|<>\n\r]/;

function normalizePath(targetPath: string): string {
  return path.normalize(targetPath);
}

function isWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasPathSegment(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function asVaultRelativePath(rawPath: string, vaultRoot: string): string {
  return normalizePath(path.resolve(vaultRoot, rawPath));
}

function validateExistingFile(targetPath: string, field: RuntimeField, messages: ValidationMessage[], pathFs: PathFs): void {
  if (!pathFs.existsSync(targetPath)) {
    messages.push({
      field,
      level: "error",
      message: `${field} does not exist: ${targetPath}`,
    });
    return;
  }

  const stat = pathFs.statSync(targetPath);
  if (!stat.isFile()) {
    messages.push({
      field,
      level: "error",
      message: `${field} must point to a file: ${targetPath}`,
    });
  }
}

function isPluginManagedPath(targetPath: string, context: RuntimeContext): boolean {
  return isWithin(getPluginRuntimeDir(context), targetPath);
}

function resolveVaultBoundFile(
  rawPath: string,
  field: Exclude<RuntimeField, "pythonCommand">,
  context: RuntimeContext,
  defaults: string[],
  pathFs: PathFs,
  messages: ValidationMessage[],
): { path: string; usedDefault: boolean } {
  const trimmed = rawPath.trim();

  if (!trimmed) {
    const defaultPath = defaults.find((candidate) => pathFs.existsSync(candidate)) ?? defaults[0];
    validateExistingFile(defaultPath, field, messages, pathFs);
    return { path: defaultPath, usedDefault: true };
  }

  if (path.isAbsolute(trimmed)) {
    messages.push({
      field,
      level: "error",
      message: `${field} must be vault-relative or left blank for the bundled default. Absolute paths are not allowed here.`,
    });
    return { path: normalizePath(trimmed), usedDefault: false };
  }

  const resolvedPath = asVaultRelativePath(trimmed, context.vaultRoot);
  if (!isWithin(context.vaultRoot, resolvedPath)) {
    messages.push({
      field,
      level: "error",
      message: `${field} must stay inside the current vault. Remove any '..' traversal or use the bundled default.`,
    });
    return { path: resolvedPath, usedDefault: false };
  }

  validateExistingFile(resolvedPath, field, messages, pathFs);
  return { path: resolvedPath, usedDefault: false };
}

function resolvePythonCommand(
  rawValue: string,
  context: RuntimeContext,
  pathFs: PathFs,
  messages: ValidationMessage[],
): { command: string; usedDefault: boolean } {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    messages.push({
      field: "pythonCommand",
      level: "info",
      message: "pythonCommand is blank. Falling back to 'python3' from PATH.",
    });
    return { command: "python3", usedDefault: true };
  }

  if (FORBIDDEN_COMMAND_CHARS_PATTERN.test(trimmed)) {
    messages.push({
      field: "pythonCommand",
      level: "error",
      message: "pythonCommand contains blocked shell metacharacters. Enter a bare PATH command such as python3 or a direct file path only.",
    });
    return { command: trimmed, usedDefault: false };
  }

  if (!path.isAbsolute(trimmed) && !hasPathSegment(trimmed)) {
    if (!SAFE_PATH_COMMAND_PATTERN.test(trimmed)) {
      messages.push({
        field: "pythonCommand",
        level: "error",
        message: "pythonCommand must be a single executable name when resolved from PATH. Spaces and compound commands are blocked.",
      });
      return { command: trimmed, usedDefault: false };
    }
    messages.push({
      field: "pythonCommand",
      level: "info",
      message: `pythonCommand will be resolved from PATH as '${trimmed}'.`,
    });
    return { command: trimmed, usedDefault: false };
  }

  const resolvedPath = path.isAbsolute(trimmed)
    ? normalizePath(trimmed)
    : asVaultRelativePath(trimmed, context.vaultRoot);

  if (!path.isAbsolute(trimmed) && !isWithin(context.vaultRoot, resolvedPath)) {
    messages.push({
      field: "pythonCommand",
      level: "error",
      message: "pythonCommand must stay inside the vault when using a relative executable path.",
    });
    return { command: resolvedPath, usedDefault: false };
  }

  validateExistingFile(resolvedPath, "pythonCommand", messages, pathFs);
  return { command: resolvedPath, usedDefault: false };
}

function buildTrustState(
  settings: MindmapSettings,
  context: RuntimeContext,
  scriptPath: string,
  configPath: string,
  valid: boolean,
): RuntimeTrustState {
  const reasons: string[] = [];
  const interpreter = !settings.pythonCommand.trim()
    ? "trusted: PATH command default (python3)"
    : !path.isAbsolute(settings.pythonCommand) && !hasPathSegment(settings.pythonCommand)
      ? `trusted: PATH command (${settings.pythonCommand.trim()})`
      : "caution: direct Python executable path";

  const script = isPluginManagedPath(scriptPath, context)
    ? "trusted: bundled plugin runtime"
    : "caution: custom vault file";

  const config = isPluginManagedPath(configPath, context)
    ? "trusted: bundled plugin config"
    : "caution: custom vault config";

  if (interpreter.startsWith("caution")) {
    reasons.push("Python will execute through a direct file path. Verify the interpreter location before running.");
  }
  if (script.startsWith("caution")) {
    reasons.push("Mindmap script uses a custom vault file instead of the bundled runtime.");
  }
  if (config.startsWith("caution")) {
    reasons.push("Mindmap config uses a custom vault file instead of the bundled default.");
  }

  return {
    level: valid ? (reasons.length > 0 ? "caution" : "trusted") : "blocked",
    interpreter,
    script,
    config,
    reasons,
  };
}

export function getPluginRuntimeDir(context: RuntimeContext): string {
  return path.join(context.pluginDir, "python");
}

export function getDefaultRuntimePaths(context: RuntimeContext): { scriptPath: string; configPaths: string[] } {
  const runtimeDir = getPluginRuntimeDir(context);
  return {
    scriptPath: path.join(runtimeDir, "mindmap.py"),
    configPaths: [
      path.join(runtimeDir, "config.json"),
      path.join(runtimeDir, "config.template.json"),
    ],
  };
}

export function resolveRuntime(
  settings: MindmapSettings,
  context: RuntimeContext,
  pathFs: PathFs = nodeFs,
): ResolvedRuntime {
  const messages: ValidationMessage[] = [];
  const defaults = getDefaultRuntimePaths(context);
  const python = resolvePythonCommand(settings.pythonCommand, context, pathFs, messages);
  const script = resolveVaultBoundFile(settings.scriptPath, "scriptPath", context, [defaults.scriptPath], pathFs, messages);
  const config = resolveVaultBoundFile(settings.configPath, "configPath", context, defaults.configPaths, pathFs, messages);

  if (script.usedDefault) {
    messages.push({
      field: "scriptPath",
      level: "info",
      message: `Using bundled scriptPath default: ${script.path}`,
    });
  }

  if (config.usedDefault) {
    messages.push({
      field: "configPath",
      level: "info",
      message: `Using bundled configPath default: ${config.path}`,
    });
  }

  const valid = !messages.some((message) => message.level === "error");
  const trust = buildTrustState(settings, context, script.path, config.path, valid);
  if (trust.level === "caution") {
    for (const reason of trust.reasons) {
      messages.push({
        field: "runtime",
        level: "info",
        message: reason,
      });
    }
  }
  if (!valid) {
    messages.push({
      field: "runtime",
      level: "error",
      message: "Mindmap runtime is not ready. Fix the path errors above or reset fields back to the bundled defaults.",
    });
  }

  return {
    command: {
      command: python.command,
      args: [script.path, "--config", config.path],
      cwd: path.dirname(script.path),
    },
    scriptPath: script.path,
    configPath: config.path,
    usedDefaults: {
      pythonCommand: python.usedDefault,
      scriptPath: script.usedDefault,
      configPath: config.usedDefault,
    },
    messages,
    trust,
    valid,
  };
}

export function formatCommandPreview(runtime: ResolvedRuntime, extraArgs: string[] = []): string {
  const commandParts = [runtime.command.command, ...runtime.command.args, ...extraArgs];
  return commandParts.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}
