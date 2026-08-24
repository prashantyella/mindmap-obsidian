import type { PreflightResult } from "./diagnostics";

export const MAX_REPORT_LOG_LINES = 20;
export const MAX_FIELD_CHARS = 500;
export const MAX_CHECKS = 20;
export const MAX_CONTEXT_DEPTH = 4;
export const MAX_CONTEXT_ARRAY_ITEMS = 10;
export const MAX_REPORT_CHARS = 8000;

const TRUNCATION_MARKER = "…[truncated]";
const LIST_TRUNCATION_MARKER = (omitted: number): string => `…[+${omitted} more, truncated]`;

const SENSITIVE_KEY_PATTERN = /key|token|secret|password|authorization/i;
const SENSITIVE_INLINE_PATTERN = /((?:api[-_]?key|token|secret|password|authorization)\s*[:=]\s*)(\S+)/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)(\S+)/gi;

/** Bounds a single free-form string field so one malicious/huge value cannot blow out the whole report. */
export function truncateField(value: string, max: number = MAX_FIELD_CHARS): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}${TRUNCATION_MARKER}`;
}

/** Best-effort redaction of secret-shaped substrings inside free-form text (e.g. an unexpected error message that happened to echo a header or config value). */
export function redactSecrets(line: string): string {
  return line
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`)
    .replace(SENSITIVE_INLINE_PATTERN, (_match, prefix: string) => `${prefix}[redacted]`);
}

/** Truncated and redacted in one pass -- the default treatment for every free-form field going into the report. */
function sanitizeField(value: string, max: number = MAX_FIELD_CHARS): string {
  return truncateField(redactSecrets(value), max);
}

/** Strips userinfo credentials and redacts sensitive query parameter values from a URL; falls back to a regex-based best effort if the value doesn't parse as a URL. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return truncateField(url.toString());
  } catch {
    return sanitizeField(rawUrl.replace(/\/\/[^/@\s]+@/, "//[redacted]@"));
  }
}

function truncateList<T>(items: T[], max: number): { items: T[]; omittedCount: number } {
  if (items.length <= max) {
    return { items, omittedCount: 0 };
  }
  return { items: items.slice(0, max), omittedCount: items.length - max };
}

/** Recursively redacts sensitive keys and bounds depth/array size/string length at every level, so nested context objects can never leak a secret or blow out the report. */
function redactContextValue(value: unknown, depth: number): unknown {
  if (depth > MAX_CONTEXT_DEPTH) {
    return "[truncated: max depth]";
  }
  if (typeof value === "string") {
    return sanitizeField(value);
  }
  if (Array.isArray(value)) {
    const { items, omittedCount } = truncateList(value, MAX_CONTEXT_ARRAY_ITEMS);
    const mapped = items.map((entry) => redactContextValue(entry, depth + 1));
    return omittedCount > 0 ? [...mapped, LIST_TRUNCATION_MARKER(omittedCount)] : mapped;
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : redactContextValue(entryValue, depth + 1);
    }
    return redacted;
  }
  return value;
}

function redactContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return redactContextValue(context, 0) as Record<string, unknown>;
}

export interface DiagnosticsReportEngine {
  available: boolean;
}

export interface DiagnosticsReportProvider {
  embedBaseUrl: string;
  embedModel: string;
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
}

export interface DiagnosticsReportPreflight {
  inProgress: boolean;
  lastRunAt: number | null;
  result: PreflightResult | null;
}

export interface DiagnosticsReportScheduler {
  mode: string;
  launchAgentHealth: string | null;
  nextRunAt: number | null;
  lastMessage: string;
}

export interface DiagnosticsReportInput {
  generatedAt: string;
  engine: DiagnosticsReportEngine;
  provider: DiagnosticsReportProvider;
  preflight: DiagnosticsReportPreflight;
  scheduler: DiagnosticsReportScheduler;
  recentLogLines: string[];
}

function formatTimestamp(value: number | null): string {
  return value === null ? "never" : new Date(value).toISOString();
}

/** One-line summary of the latest preflight result, safe to render inline in Troubleshooting by default. */
export function buildDiagnosticsOneLine(preflight: DiagnosticsReportPreflight): string {
  if (preflight.inProgress) {
    return "Preflight is running.";
  }
  if (!preflight.result) {
    return "Preflight has not run yet.";
  }
  return preflight.result.ok
    ? `Ready as of ${formatTimestamp(preflight.lastRunAt)}.`
    : `Not ready: ${truncateField(preflight.result.summary, 200)}`;
}

/**
 * A bounded, redacted, plain-text technical report for on-demand Copy
 * diagnostics. Never called from the default render path -- only built
 * when the user explicitly clicks Copy diagnostics.
 *
 * Every free-form input is sanitized before it reaches the report: runtime
 * messages, the provider base URL, the preflight summary/check
 * label/message/guidance/context (recursively), the scheduler's last
 * message, and recent log lines are all truncated per-field and redacted
 * of anything key/token/secret/password/authorization-shaped or a
 * Bearer-style token; the provider API key is reported only as set/not-set,
 * never its value. Lists (checks, runtime messages, log lines) are bounded
 * with an explicit truncation marker when they exceed their cap, and the
 * whole assembled report carries a final total-size cap as a last-resort
 * safety net, also with an explicit truncation marker.
 */
export function buildDiagnosticsReport(input: DiagnosticsReportInput): string {
  const lines: string[] = [];
  lines.push("Mindmap diagnostics report");
  lines.push(`Generated: ${input.generatedAt}`);
  lines.push("");

  lines.push("Engine");
  lines.push(`  Available: ${input.engine.available ? "yes" : "no"}`);
  lines.push("");

  lines.push("Provider");
  lines.push(`  Embedding base URL: ${redactUrl(input.provider.embedBaseUrl)}`);
  lines.push(`  Embedding model: ${sanitizeField(input.provider.embedModel, 200)}`);
  lines.push(`  Metadata base URL: ${redactUrl(input.provider.llmBaseUrl)}`);
  lines.push(`  Metadata model: ${sanitizeField(input.provider.llmModel, 200)}`);
  lines.push(`  Max tokens: ${input.provider.llmMaxTokens}`);
  lines.push("");

  lines.push("Preflight");
  lines.push(`  In progress: ${input.preflight.inProgress ? "yes" : "no"}`);
  lines.push(`  Last run: ${formatTimestamp(input.preflight.lastRunAt)}`);
  if (!input.preflight.result) {
    lines.push("  No preflight result recorded yet.");
  } else {
    lines.push(`  Status: ${input.preflight.result.ok ? "ready" : "not ready"}`);
    lines.push(`  Summary: ${sanitizeField(input.preflight.result.summary)}`);
    const { items: checks, omittedCount: omittedChecks } = truncateList(input.preflight.result.checks, MAX_CHECKS);
    for (const check of checks) {
      lines.push(`  [${check.status}] ${sanitizeField(check.label, 200)}: ${sanitizeField(check.message)}`);
      if (check.guidance) {
        lines.push(`    Guidance: ${sanitizeField(check.guidance)}`);
      }
      const redactedContext = redactContext(check.context);
      if (redactedContext && Object.keys(redactedContext).length > 0) {
        lines.push(`    Context: ${JSON.stringify(redactedContext)}`);
      }
    }
    if (omittedChecks > 0) {
      lines.push(`  ${LIST_TRUNCATION_MARKER(omittedChecks)}`);
    }
  }
  lines.push("");

  lines.push("Scheduler");
  lines.push(`  Mode: ${input.scheduler.mode}`);
  lines.push(`  LaunchAgent health: ${input.scheduler.launchAgentHealth ?? "n/a"}`);
  lines.push(`  Next run: ${formatTimestamp(input.scheduler.nextRunAt)}`);
  lines.push(`  Last result: ${sanitizeField(input.scheduler.lastMessage)}`);
  lines.push("");

  // Log lines keep the most recent N (slice from the end), unlike checks/
  // messages above which keep the first N -- the newest log lines are the
  // ones relevant to a just-reproduced problem.
  const omittedLogLines = Math.max(0, input.recentLogLines.length - MAX_REPORT_LOG_LINES);
  const boundedLines = input.recentLogLines.slice(-MAX_REPORT_LOG_LINES);
  const sanitizedLogLines = boundedLines.map((line) => sanitizeField(line));
  lines.push(`Recent log (last ${sanitizedLogLines.length} of ${input.recentLogLines.length})`);
  if (sanitizedLogLines.length === 0) {
    lines.push("  (none)");
  } else {
    for (const line of sanitizedLogLines) {
      lines.push(`  ${line}`);
    }
  }
  if (omittedLogLines > 0) {
    lines.push(`  ${LIST_TRUNCATION_MARKER(omittedLogLines)}`);
  }

  const report = lines.join("\n");
  if (report.length <= MAX_REPORT_CHARS) {
    return report;
  }
  return `${report.slice(0, MAX_REPORT_CHARS)}\n${TRUNCATION_MARKER} (report exceeded ${MAX_REPORT_CHARS} characters)`;
}
