import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Supported runtime contract
// ---------------------------------------------------------------------------

export const SUPPORTED_PYTHON_VERSIONS = ["3.11", "3.12", "3.13"] as const;
export type SupportedPythonMinor = (typeof SUPPORTED_PYTHON_VERSIONS)[number];

export interface RequiredPackageSpec {
  distName: string;
  importName: string;
  constraint: { type: "min"; version: string } | { type: "exact"; version: string };
}

export const REQUIRED_PACKAGES: RequiredPackageSpec[] = [
  { distName: "chromadb", importName: "chromadb", constraint: { type: "exact", version: "1.4.0" } },
  { distName: "ruamel.yaml", importName: "ruamel.yaml", constraint: { type: "exact", version: "0.19.1" } },
];

const RUNTIME_CONTRACT_VERSION = "1";
const MANAGED_APP_SUPPORT_DIR_NAME = "Mindmap AI";
const FINGERPRINT_LENGTH = 16;

// ---------------------------------------------------------------------------
// Requirements fingerprint and managed runtime paths
// ---------------------------------------------------------------------------

export function computeRequirementsFingerprint(requirementsFileContents: string): string {
  const digestInput = [
    RUNTIME_CONTRACT_VERSION,
    SUPPORTED_PYTHON_VERSIONS.join(","),
    requirementsFileContents.trim(),
  ].join("\n");
  return crypto.createHash("sha256").update(digestInput, "utf8").digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export function getDefaultAppSupportRoot(homeDir: string): string {
  return path.join(homeDir, "Library", "Application Support", MANAGED_APP_SUPPORT_DIR_NAME);
}

export function getManagedRuntimeRoot(appSupportRoot: string): string {
  return path.join(appSupportRoot, "runtime");
}

export function getManagedRuntimeDir(appSupportRoot: string, fingerprint: string): string {
  return path.join(getManagedRuntimeRoot(appSupportRoot), fingerprint);
}

export function getManagedVenvDir(appSupportRoot: string, fingerprint: string): string {
  return path.join(getManagedRuntimeDir(appSupportRoot, fingerprint), "venv");
}

export function getManagedStagingDir(appSupportRoot: string, fingerprint: string): string {
  return path.join(getManagedRuntimeRoot(appSupportRoot), `${fingerprint}.staging`);
}

export function getManagedInterpreterPath(appSupportRoot: string, fingerprint: string): string {
  return path.join(getManagedVenvDir(appSupportRoot, fingerprint), "bin", "python3");
}

/** True only for paths that are the managed runtime root or a descendant of it. */
export function isWithinManagedRuntimeRoot(appSupportRoot: string, targetPath: string): boolean {
  const root = path.normalize(getManagedRuntimeRoot(appSupportRoot));
  const normalizedTarget = path.normalize(targetPath);
  const relative = path.relative(root, normalizedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Candidate generation (macOS)
// ---------------------------------------------------------------------------

export type MacArch = "arm64" | "x64";

export interface DiscoveryEnv {
  homeDir: string;
  pathEnv: string;
  arch: MacArch;
  appSupportRoot?: string;
  requirementsFileContents: string;
}

export type CandidateSource = "managed" | "framework" | "homebrew" | "path" | "xcode";

export interface RuntimeCandidate {
  path: string;
  source: CandidateSource;
}

function frameworkCandidates(): RuntimeCandidate[] {
  return [...SUPPORTED_PYTHON_VERSIONS]
    .sort()
    .reverse()
    .map((version) => ({
      path: path.join("/Library/Frameworks/Python.framework/Versions", version, "bin", "python3"),
      source: "framework" as const,
    }));
}

function homebrewCandidates(arch: MacArch): RuntimeCandidate[] {
  const roots = arch === "arm64" ? ["/opt/homebrew", "/usr/local"] : ["/usr/local", "/opt/homebrew"];
  const versions = [...SUPPORTED_PYTHON_VERSIONS].sort().reverse();
  const candidates: RuntimeCandidate[] = [];
  for (const root of roots) {
    for (const version of versions) {
      candidates.push({ path: path.join(root, "bin", `python3.${version.split(".")[1]}`), source: "homebrew" });
    }
  }
  return candidates;
}

/** Only absolute PATH directories are trusted; relative, empty, and "." entries are ignored. */
function absolutePathDirs(pathEnv: string): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed || !path.isAbsolute(trimmed)) continue;
    const normalized = path.normalize(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(normalized);
  }
  return dirs;
}

function pathEnvCandidates(pathEnv: string): RuntimeCandidate[] {
  return absolutePathDirs(pathEnv).map((dir) => ({ path: path.join(dir, "python3"), source: "path" as const }));
}

/**
 * Deterministic macOS discovery order: the fingerprinted managed runtime,
 * then Framework installs, then Homebrew (native arch first), then PATH
 * results, then the Xcode/system interpreter as a bootstrap-only fallback.
 */
export function generateMacCandidates(env: DiscoveryEnv): RuntimeCandidate[] {
  const appSupportRoot = env.appSupportRoot ?? getDefaultAppSupportRoot(env.homeDir);
  const fingerprint = computeRequirementsFingerprint(env.requirementsFileContents);

  return [
    { path: getManagedInterpreterPath(appSupportRoot, fingerprint), source: "managed" },
    ...frameworkCandidates(),
    ...homebrewCandidates(env.arch),
    ...pathEnvCandidates(env.pathEnv),
    { path: "/usr/bin/python3", source: "xcode" },
  ];
}

// ---------------------------------------------------------------------------
// Normalization, dedup, and safe file validation
// ---------------------------------------------------------------------------

export interface DiscoveryFsStat {
  isFile(): boolean;
  mode: number;
}

export interface DiscoveryFs {
  existsSync(targetPath: string): boolean;
  statSync(targetPath: string): DiscoveryFsStat;
  realpathSync?(targetPath: string): string;
}

function isExecutableFile(fs: DiscoveryFs, targetPath: string): boolean {
  if (!fs.existsSync(targetPath)) return false;
  let stat: DiscoveryFsStat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  return (stat.mode & 0o111) !== 0;
}

/** Real node:fs-backed adapter: executable-file checks plus realpath-based dedup. Not wired into main.ts in this checkpoint. */
export function createNodeDiscoveryFs(): DiscoveryFs {
  return {
    existsSync: (targetPath) => fs.existsSync(targetPath),
    statSync: (targetPath) => {
      const stat = fs.statSync(targetPath);
      return { isFile: () => stat.isFile(), mode: stat.mode };
    },
    realpathSync: (targetPath) => fs.realpathSync(targetPath),
  };
}

/** Normalizes, deduplicates by real path when available, and drops anything that is not a safe executable file. */
export function normalizeCandidates(candidates: RuntimeCandidate[], fs: DiscoveryFs): RuntimeCandidate[] {
  const seenIdentities = new Set<string>();
  const result: RuntimeCandidate[] = [];

  for (const candidate of candidates) {
    const normalizedPath = path.normalize(candidate.path);
    if (!isExecutableFile(fs, normalizedPath)) continue;

    let identity = normalizedPath;
    if (fs.realpathSync) {
      try {
        identity = fs.realpathSync(normalizedPath);
      } catch {
        identity = normalizedPath;
      }
    }

    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    result.push({ path: normalizedPath, source: candidate.source });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

function parseVersionParts(version: string): number[] {
  return version.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

export function compareVersions(a: string, b: string): number {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const valueA = partsA[index] ?? 0;
    const valueB = partsB[index] ?? 0;
    if (valueA !== valueB) return valueA < valueB ? -1 : 1;
  }
  return 0;
}

function isSupportedPythonVersion(version: string): boolean {
  const [major, minor] = version.split(".");
  return SUPPORTED_PYTHON_VERSIONS.includes(`${major}.${minor}` as SupportedPythonMinor);
}

function packageSatisfies(spec: RequiredPackageSpec, foundVersion: string | null): boolean {
  if (!foundVersion) return false;
  return spec.constraint.type === "exact"
    ? compareVersions(foundVersion, spec.constraint.version) === 0
    : compareVersions(foundVersion, spec.constraint.version) >= 0;
}

// ---------------------------------------------------------------------------
// Injectable argument-array interpreter probe
// ---------------------------------------------------------------------------

export interface ProcessInvocationResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: { code?: string; message: string };
}

/** Runs `command` with `args` only — never through a shell, never with an interpolated string. */
export type ProcessInvoker = (command: string, args: string[]) => Promise<ProcessInvocationResult>;

export type InterpreterClassification = "ready" | "bootstrap-only" | "incompatible" | "unavailable";

export interface PackageProbeOutcome {
  distName: string;
  found: boolean;
  version: string | null;
  satisfies: boolean;
}

export interface InterpreterProbeResult {
  path: string;
  source: CandidateSource;
  classification: InterpreterClassification;
  pythonVersion?: string;
  venvAvailable?: boolean;
  packages: PackageProbeOutcome[];
  preflightOk?: boolean;
  diagnostics: string[];
}

const MAX_DIAGNOSTIC_LENGTH = 500;

/**
 * Bounds a diagnostic message. Callers must only pass safe, plugin-constructed
 * text here (error codes, exit statuses, phase names) — never raw stderr or
 * `Error#message` from a probed interpreter, which may echo environment
 * values or other sensitive process state back to the caller.
 */
function boundDiagnostic(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_DIAGNOSTIC_LENGTH
    ? `${singleLine.slice(0, MAX_DIAGNOSTIC_LENGTH)}… (truncated)`
    : singleLine;
}

function buildProbeScript(): string {
  const packagesJson = JSON.stringify(REQUIRED_PACKAGES.map((spec) => [spec.distName, spec.importName]));
  return [
    "import json, importlib, sys",
    `packages = json.loads(${JSON.stringify(packagesJson)})`,
    'result = {"version": "%d.%d.%d" % tuple(sys.version_info[:3]), "packages": {}, "venv": False}',
    "try:",
    "    import ensurepip, venv",
    '    result["venv"] = True',
    "except Exception:",
    '    result["venv"] = False',
    "for dist, imp in packages:",
    "    try:",
    "        mod = importlib.import_module(imp)",
    '        result["packages"][dist] = getattr(mod, "__version__", None)',
    "    except Exception:",
    '        result["packages"][dist] = None',
    "print(json.dumps(result))",
  ].join("\n");
}

const PROBE_SCRIPT = buildProbeScript();

interface RawProbePayload {
  version: string;
  venv: boolean;
  packages: Record<string, string | null>;
}

const NUMERIC_PYTHON_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRawProbePayload(value: unknown): value is RawProbePayload {
  if (!isPlainObject(value)) return false;

  if (typeof value.version !== "string" || !NUMERIC_PYTHON_VERSION_PATTERN.test(value.version)) return false;
  if (typeof value.venv !== "boolean") return false;
  if (!isPlainObject(value.packages)) return false;

  for (const packageVersion of Object.values(value.packages)) {
    if (packageVersion !== null && typeof packageVersion !== "string") return false;
  }

  return true;
}

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BUFFER_BYTES = 1_000_000;

/**
 * Real process invoker: argument-array `execFile` only, never a shell and
 * never an interpolated command string.
 */
export function createNodeProcessInvoker(): ProcessInvoker {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES, shell: false },
        (error, stdout, stderr) => {
          if (error) {
            const errnoCode = (error as NodeJS.ErrnoException).code;
            if (typeof errnoCode === "string") {
              resolve({ stdout, stderr, exitCode: null, error: { code: errnoCode, message: error.message } });
              return;
            }
            resolve({ stdout, stderr, exitCode: typeof errnoCode === "number" ? errnoCode : 1 });
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    });
}

/**
 * Verifies the given interpreter against Mindmap's own structured preflight
 * checks (bundled script + current config), not general readiness or scope
 * checks. Left unset in this checkpoint; checkpoint 3 must supply an
 * implementation that runs the runtime-specific checks described in the
 * design doc rather than reusing broader onboarding/config-scope readiness
 * logic.
 */
export type PreflightVerifier = (interpreterPath: string) => Promise<boolean>;

export interface ProbeOptions {
  invoke: ProcessInvoker;
  requiredPackages?: RequiredPackageSpec[];
  verifyPreflight?: PreflightVerifier;
}

export async function probeInterpreter(
  candidate: RuntimeCandidate,
  options: ProbeOptions,
): Promise<InterpreterProbeResult> {
  const requiredPackages = options.requiredPackages ?? REQUIRED_PACKAGES;
  const diagnostics: string[] = [];

  const invocation = await options.invoke(candidate.path, ["-c", PROBE_SCRIPT]);

  if (invocation.error) {
    diagnostics.push(boundDiagnostic(`Interpreter could not be started (${invocation.error.code ?? "spawn error"}).`));
    return { path: candidate.path, source: candidate.source, classification: "unavailable", packages: [], diagnostics };
  }

  if (invocation.exitCode !== 0) {
    diagnostics.push(boundDiagnostic(`Interpreter probe exited with status ${String(invocation.exitCode)}.`));
    return { path: candidate.path, source: candidate.source, classification: "unavailable", packages: [], diagnostics };
  }

  const lastLine = invocation.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();

  let payload: unknown;
  try {
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    payload = null;
  }

  if (!isRawProbePayload(payload)) {
    diagnostics.push(boundDiagnostic("Interpreter did not produce structured probe output."));
    return { path: candidate.path, source: candidate.source, classification: "unavailable", packages: [], diagnostics };
  }

  const packages: PackageProbeOutcome[] = requiredPackages.map((spec) => {
    const foundVersion = payload.packages[spec.distName] ?? null;
    return {
      distName: spec.distName,
      found: foundVersion !== null,
      version: foundVersion,
      satisfies: packageSatisfies(spec, foundVersion),
    };
  });

  if (!isSupportedPythonVersion(payload.version)) {
    diagnostics.push(`Unsupported Python version ${payload.version}.`);
    return {
      path: candidate.path,
      source: candidate.source,
      classification: "incompatible",
      pythonVersion: payload.version,
      venvAvailable: payload.venv,
      packages,
      diagnostics,
    };
  }

  const allPackagesSatisfy = packages.every((outcome) => outcome.satisfies);

  if (!allPackagesSatisfy) {
    if (!payload.venv) {
      diagnostics.push("Supported Python version found but venv/ensurepip is unavailable.");
      return {
        path: candidate.path,
        source: candidate.source,
        classification: "incompatible",
        pythonVersion: payload.version,
        venvAvailable: payload.venv,
        packages,
        diagnostics,
      };
    }
    diagnostics.push("Required Mindmap packages are missing or outdated; usable as a bootstrap interpreter.");
    return {
      path: candidate.path,
      source: candidate.source,
      classification: "bootstrap-only",
      pythonVersion: payload.version,
      venvAvailable: payload.venv,
      packages,
      diagnostics,
    };
  }

  let preflightOk: boolean | undefined;
  if (options.verifyPreflight) {
    try {
      preflightOk = await options.verifyPreflight(candidate.path);
    } catch {
      diagnostics.push("Mindmap preflight verification threw an unexpected error.");
      preflightOk = false;
    }
  }

  if (preflightOk === false) {
    if (!payload.venv) {
      diagnostics.push("Required packages satisfy versions but Mindmap preflight failed and venv/ensurepip is unavailable.");
      return {
        path: candidate.path,
        source: candidate.source,
        classification: "incompatible",
        pythonVersion: payload.version,
        venvAvailable: payload.venv,
        packages,
        preflightOk,
        diagnostics,
      };
    }
    diagnostics.push("Required packages satisfy versions but Mindmap preflight failed.");
    return {
      path: candidate.path,
      source: candidate.source,
      classification: "bootstrap-only",
      pythonVersion: payload.version,
      venvAvailable: payload.venv,
      packages,
      preflightOk,
      diagnostics,
    };
  }

  return {
    path: candidate.path,
    source: candidate.source,
    classification: "ready",
    pythonVersion: payload.version,
    venvAvailable: payload.venv,
    packages,
    preflightOk,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Discovery + selection
// ---------------------------------------------------------------------------

export interface DiscoveryOptions {
  pythonCommandSetting: string;
  env: DiscoveryEnv;
  fs: DiscoveryFs;
  invoke: ProcessInvoker;
  verifyPreflight?: PreflightVerifier;
}

export interface DiscoveryResult {
  outcome: "ready" | "bootstrap-required" | "unavailable";
  selected?: InterpreterProbeResult;
  bestBootstrap?: InterpreterProbeResult;
  probed: InterpreterProbeResult[];
  customInterpreterPreserved: boolean;
}

const DEFAULT_PYTHON_COMMAND = "python3";

function isExplicitCustomCommand(pythonCommandSetting: string): boolean {
  const trimmed = pythonCommandSetting.trim();
  return trimmed.length > 0 && trimmed !== DEFAULT_PYTHON_COMMAND;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes(path.sep);
}

/**
 * Resolves an explicit custom `pythonCommand` setting to candidate files
 * without touching Framework/Homebrew/managed/Xcode discovery. A direct path
 * (containing a separator) is validated alone. A bare command name (e.g.
 * `python3.12`) is resolved only against absolute PATH directories — never
 * against unrelated auto-discovery locations.
 */
function resolveExplicitCandidates(trimmedCommand: string, env: DiscoveryEnv, discoveryFs: DiscoveryFs): RuntimeCandidate[] {
  if (hasPathSeparator(trimmedCommand)) {
    return normalizeCandidates([{ path: trimmedCommand, source: "path" }], discoveryFs);
  }

  const candidates = absolutePathDirs(env.pathEnv).map((dir) => ({ path: path.join(dir, trimmedCommand), source: "path" as const }));
  return normalizeCandidates(candidates, discoveryFs);
}

interface CandidateProbeOutcome {
  outcome: "ready" | "bootstrap-required" | "unavailable";
  selected?: InterpreterProbeResult;
  bestBootstrap?: InterpreterProbeResult;
  probed: InterpreterProbeResult[];
}

async function probeCandidatesInOrder(candidates: RuntimeCandidate[], probeOptions: ProbeOptions): Promise<CandidateProbeOutcome> {
  const probed: InterpreterProbeResult[] = [];
  let bestBootstrap: InterpreterProbeResult | undefined;

  for (const candidate of candidates) {
    const result = await probeInterpreter(candidate, probeOptions);
    probed.push(result);

    if (result.classification === "ready") {
      return { outcome: "ready", selected: result, bestBootstrap, probed };
    }

    if (result.classification === "bootstrap-only" && !bestBootstrap) {
      bestBootstrap = result;
    }
  }

  return { outcome: bestBootstrap ? "bootstrap-required" : "unavailable", bestBootstrap, probed };
}

export async function discoverRuntime(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const probeOptions: ProbeOptions = { invoke: options.invoke, verifyPreflight: options.verifyPreflight };

  if (isExplicitCustomCommand(options.pythonCommandSetting)) {
    const trimmed = options.pythonCommandSetting.trim();
    const candidates = resolveExplicitCandidates(trimmed, options.env, options.fs);
    if (candidates.length === 0) {
      return { outcome: "unavailable", probed: [], customInterpreterPreserved: true };
    }
    const result = await probeCandidatesInOrder(candidates, probeOptions);
    return { ...result, customInterpreterPreserved: true };
  }

  const candidates = normalizeCandidates(generateMacCandidates(options.env), options.fs);
  const result = await probeCandidatesInOrder(candidates, probeOptions);
  return { ...result, customInterpreterPreserved: false };
}
