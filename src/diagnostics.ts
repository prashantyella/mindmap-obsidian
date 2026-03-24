export type PreflightStatus = "ok" | "error";

export interface PreflightCheck {
  code: string;
  label: string;
  status: PreflightStatus;
  message: string;
  guidance?: string;
  context?: Record<string, unknown>;
}

export interface PreflightResult {
  ok: boolean;
  summary: string;
  checks: PreflightCheck[];
  configPath?: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
}

interface PreflightPayload {
  ok: boolean;
  summary: string;
  checks: PreflightCheck[];
  config_path?: string;
}

function isPreflightCheck(value: unknown): value is PreflightCheck {
  if (!value || typeof value !== "object") {
    return false;
  }

  const check = value as Record<string, unknown>;
  return typeof check.code === "string"
    && typeof check.label === "string"
    && (check.status === "ok" || check.status === "error")
    && typeof check.message === "string";
}

function isPreflightPayload(value: unknown): value is PreflightPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return typeof payload.ok === "boolean"
    && typeof payload.summary === "string"
    && Array.isArray(payload.checks)
    && payload.checks.every(isPreflightCheck)
    && (payload.config_path === undefined || typeof payload.config_path === "string");
}

function findJsonPayload(stdout: string): PreflightPayload | null {
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isPreflightPayload(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function buildFallbackCheck(code: string, message: string, guidance?: string): PreflightCheck {
  return {
    code,
    label: "Preflight execution",
    status: "error",
    message,
    guidance,
  };
}

export function parsePreflightOutput(stdout: string, stderr: string, exitCode: number): PreflightResult {
  const payload = findJsonPayload(stdout);
  if (!payload) {
    const message = stderr.trim() || stdout.trim() || "Mindmap preflight did not produce structured output.";
    return {
      ok: false,
      summary: message,
      checks: [buildFallbackCheck("PREFLIGHT_OUTPUT_INVALID", message, "Review the Python stderr output and rerun preflight.")],
      rawStdout: stdout,
      rawStderr: stderr,
      exitCode,
    };
  }

  return {
    ok: payload.ok,
    summary: payload.summary,
    checks: payload.checks,
    configPath: payload.config_path,
    rawStdout: stdout,
    rawStderr: stderr,
    exitCode,
  };
}

export function buildSpawnFailureResult(error: NodeJS.ErrnoException, command: string): PreflightResult {
  const missingExecutable = error.code === "ENOENT";
  const message = missingExecutable
    ? `Python executable not found: ${command}`
    : `Failed to start Python preflight: ${error.message}`;
  const guidance = missingExecutable
    ? "Install Python or update the Python command setting to a valid executable."
    : "Review the Python command setting and local execution permissions.";

  return {
    ok: false,
    summary: message,
    checks: [buildFallbackCheck(missingExecutable ? "PYTHON_EXECUTABLE_MISSING" : "PYTHON_EXECUTION_FAILED", message, guidance)],
    rawStdout: "",
    rawStderr: error.message,
    exitCode: -1,
  };
}

export function formatPreflightNotice(result: PreflightResult): string {
  if (result.ok) {
    return result.summary;
  }

  const failingCheck = result.checks.find((check) => check.status === "error");
  if (!failingCheck) {
    return result.summary;
  }

  return failingCheck.guidance
    ? `${failingCheck.message} ${failingCheck.guidance}`
    : failingCheck.message;
}
