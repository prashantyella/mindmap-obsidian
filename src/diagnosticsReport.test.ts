import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiagnosticsOneLine,
  buildDiagnosticsReport,
  MAX_CHECKS,
  MAX_CONTEXT_DEPTH,
  MAX_FIELD_CHARS,
  MAX_REPORT_CHARS,
  MAX_REPORT_LOG_LINES,
  MAX_RUNTIME_MESSAGES,
  redactSecrets,
  redactUrl,
  truncateField,
  type DiagnosticsReportInput,
} from "./diagnosticsReport";

function reportInput(overrides: Partial<DiagnosticsReportInput> = {}): DiagnosticsReportInput {
  return {
    generatedAt: "2026-08-22T00:00:00.000Z",
    runtime: {
      command: "python3",
      args: ["mindmap.py", "--current", "--apply"],
      scriptPath: "/Users/tester/vault/.obsidian/plugins/mindmap-ai/python/mindmap.py",
      configPath: "/Users/tester/vault/.obsidian/plugins/mindmap-ai/python/config.json",
      valid: true,
      trustLevel: "trusted",
      trustInterpreter: "bundled",
      trustScript: "bundled",
      trustConfig: "bundled",
      messages: [],
    },
    provider: {
      canManage: true,
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1:8b",
      hasApiKey: false,
      maxTokens: 1024,
      enableThinking: true,
    },
    preflight: { inProgress: false, lastRunAt: null, result: null },
    scheduler: { mode: "manual", launchAgentHealth: null, nextRunAt: null, lastMessage: "Manual mode." },
    recentLogLines: [],
    ...overrides,
  };
}

void test("one-line diagnostics summary covers running/never-run/ready/failed without full detail", () => {
  assert.equal(buildDiagnosticsOneLine({ inProgress: true, lastRunAt: null, result: null }), "Preflight is running.");
  assert.equal(buildDiagnosticsOneLine({ inProgress: false, lastRunAt: null, result: null }), "Preflight has not run yet.");
  assert.match(
    buildDiagnosticsOneLine({ inProgress: false, lastRunAt: 1755820800000, result: { ok: true, summary: "All checks passed.", checks: [], rawStdout: "", rawStderr: "", exitCode: 0 } }),
    /^Ready as of/,
  );
  assert.equal(
    buildDiagnosticsOneLine({ inProgress: false, lastRunAt: null, result: { ok: false, summary: "Ollama is not reachable.", checks: [], rawStdout: "", rawStderr: "", exitCode: 1 } }),
    "Not ready: Ollama is not reachable.",
  );
});

void test("diagnostics report includes the required detail sections", () => {
  const report = buildDiagnosticsReport(reportInput({
    preflight: { inProgress: false, lastRunAt: 1755820800000, result: { ok: true, summary: "All checks passed.", checks: [{ code: "OK", label: "Ollama", status: "ok", message: "reachable" }], rawStdout: "", rawStderr: "", exitCode: 0 } },
  }));

  assert.match(report, /Runtime/);
  assert.match(report, /Command: python3 mindmap\.py --current --apply/);
  assert.match(report, /Script: .*mindmap\.py/);
  assert.match(report, /Config: .*config\.json/);
  assert.match(report, /Trust: trusted/);
  assert.match(report, /Provider/);
  assert.match(report, /Preflight/);
  assert.match(report, /Scheduler/);
  assert.match(report, /Recent log/);
});

void test("the API key value is never included in the report, only whether one is set", () => {
  const withKey = buildDiagnosticsReport(reportInput({ provider: { ...reportInput().provider, hasApiKey: true } }));
  assert.match(withKey, /API key: set/);
  assert.doesNotMatch(withKey, /sk-|Bearer/);

  const withoutKey = buildDiagnosticsReport(reportInput());
  assert.match(withoutKey, /API key: not set/);
});

void test("preflight check context redacts sensitive keys but keeps other diagnostic context", () => {
  const report = buildDiagnosticsReport(reportInput({
    preflight: {
      inProgress: false,
      lastRunAt: null,
      result: {
        ok: false,
        summary: "Provider auth failed.",
        checks: [{
          code: "PROVIDER_AUTH_FAILED",
          label: "Provider",
          status: "error",
          message: "Authentication failed.",
          context: { api_key: "sk-super-secret-value", authorization: "Bearer abc123", endpoint: "http://localhost:8000/v1", attempt: 2 },
        }],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      },
    },
  }));

  assert.doesNotMatch(report, /sk-super-secret-value/);
  assert.doesNotMatch(report, /Bearer abc123/);
  assert.match(report, /"api_key":"\[redacted\]"/);
  assert.match(report, /"authorization":"\[redacted\]"/);
  assert.match(report, /"endpoint":"http:\/\/localhost:8000\/v1"/);
  assert.match(report, /"attempt":2/);
});

void test("redactSecrets strips inline key/token/secret/password/authorization values from free-form log lines", () => {
  assert.equal(redactSecrets("Provider request failed: api_key=sk-abc123 rejected"), "Provider request failed: api_key=[redacted] rejected");
  assert.equal(redactSecrets("Authorization: Bearer abc.def.ghi failed"), "Authorization: [redacted] [redacted] failed");
  assert.doesNotMatch(redactSecrets("Authorization: Bearer abc.def.ghi failed"), /abc\.def\.ghi/);
  assert.equal(redactSecrets("token: xyz-789 expired"), "token: [redacted] expired");
  assert.equal(redactSecrets("ordinary log line with no secrets"), "ordinary log line with no secrets");
});

void test("recent log lines are bounded to the last MAX_REPORT_LOG_LINES and redacted", () => {
  const lines = Array.from({ length: MAX_REPORT_LOG_LINES + 10 }, (_, index) => `line ${index}`);
  lines[lines.length - 1] = "final line with api_key=super-secret-tail";
  const report = buildDiagnosticsReport(reportInput({ recentLogLines: lines }));

  assert.match(report, new RegExp(`Recent log \\(last ${MAX_REPORT_LOG_LINES} of ${lines.length}\\)`));
  assert.doesNotMatch(report, /line 0\n/);
  assert.match(report, /final line with api_key=\[redacted\]/);
  assert.doesNotMatch(report, /super-secret-tail/);
});

void test("no recent log lines renders a bounded placeholder, not an empty section", () => {
  const report = buildDiagnosticsReport(reportInput({ recentLogLines: [] }));
  assert.match(report, /Recent log \(last 0 of 0\)\n {2}\(none\)/);
});

void test("truncateField bounds a single string and appends an explicit marker only when it actually truncates", () => {
  assert.equal(truncateField("short"), "short");
  const long = "x".repeat(MAX_FIELD_CHARS + 50);
  const truncated = truncateField(long);
  assert.equal(truncated.length, MAX_FIELD_CHARS + "…[truncated]".length);
  assert.ok(truncated.startsWith("x".repeat(MAX_FIELD_CHARS)));
  assert.ok(truncated.endsWith("…[truncated]"));
});

void test("redactUrl strips userinfo credentials and redacts sensitive query parameter values, keeping the rest of the URL intact", () => {
  assert.equal(redactUrl("http://user:hunter2@localhost:8000/v1"), "http://localhost:8000/v1");
  assert.doesNotMatch(redactUrl("http://user:hunter2@localhost:8000/v1"), /hunter2|user:/);

  const withQuery = redactUrl("http://localhost:8000/v1?api_key=sk-abc123&model=llama3");
  assert.doesNotMatch(withQuery, /sk-abc123/);
  assert.match(withQuery, /api_key=%5Bredacted%5D|api_key=\[redacted\]/);
  assert.match(withQuery, /model=llama3/);

  // A value that doesn't parse as a URL still gets a best-effort redaction rather than being dropped or throwing.
  assert.equal(redactUrl("not a url with user:pw@ inline"), "not a url with user:pw@ inline");
});

void test("the provider base URL is redacted in the report when it carries credentials or a sensitive query token", () => {
  const report = buildDiagnosticsReport(reportInput({
    provider: { ...reportInput().provider, baseUrl: "http://svc-user:svc-pass@localhost:8000/v1?api_key=sk-live-abc123" },
  }));
  assert.doesNotMatch(report, /svc-pass/);
  assert.doesNotMatch(report, /sk-live-abc123/);
  assert.match(report, /Base URL:/);
});

void test("preflight check context is redacted recursively through nested objects and arrays at any depth", () => {
  const report = buildDiagnosticsReport(reportInput({
    preflight: {
      inProgress: false,
      lastRunAt: null,
      result: {
        ok: false,
        summary: "nested",
        checks: [{
          code: "NESTED",
          label: "Nested",
          status: "error",
          message: "nested context",
          context: {
            request: {
              headers: { authorization: "Bearer deep-secret-token" },
              attempts: [{ api_key: "sk-in-array-secret" }, { note: "fine" }],
            },
          },
        }],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      },
    },
  }));

  assert.doesNotMatch(report, /deep-secret-token/);
  assert.doesNotMatch(report, /sk-in-array-secret/);
  assert.match(report, /"authorization":"\[redacted\]"/);
  assert.match(report, /"api_key":"\[redacted\]"/);
  assert.match(report, /"note":"fine"/);
});

void test("context deeper than MAX_CONTEXT_DEPTH is bounded rather than expanded indefinitely", () => {
  let deep: unknown = { leaf: "bottom" };
  for (let i = 0; i < MAX_CONTEXT_DEPTH + 5; i += 1) {
    deep = { nested: deep };
  }
  const report = buildDiagnosticsReport(reportInput({
    preflight: {
      inProgress: false,
      lastRunAt: null,
      result: {
        ok: false,
        summary: "deep",
        checks: [{ code: "DEEP", label: "Deep", status: "error", message: "deep context", context: { deep } }],
        rawStdout: "",
        rawStderr: "",
        exitCode: 1,
      },
    },
  }));
  assert.match(report, /\[truncated: max depth\]/);
});

void test("a malicious/huge single field (check message) is truncated per-field with an explicit marker", () => {
  const huge = "A".repeat(50_000);
  const report = buildDiagnosticsReport(reportInput({
    preflight: {
      inProgress: false,
      lastRunAt: null,
      result: { ok: false, summary: "huge field", checks: [{ code: "HUGE", label: "Huge", status: "error", message: huge }], rawStdout: "", rawStderr: "", exitCode: 1 },
    },
  }));
  assert.doesNotMatch(report, new RegExp(`A{${MAX_FIELD_CHARS + 1}}`));
  assert.match(report, /…\[truncated\]/);
});

void test("more preflight checks than MAX_CHECKS are bounded with an explicit list-truncation marker", () => {
  const checks = Array.from({ length: MAX_CHECKS + 5 }, (_, index) => ({ code: `C${index}`, label: `Check ${index}`, status: "ok" as const, message: "ok" }));
  const report = buildDiagnosticsReport(reportInput({
    preflight: { inProgress: false, lastRunAt: null, result: { ok: true, summary: "many checks", checks, rawStdout: "", rawStderr: "", exitCode: 0 } },
  }));
  assert.match(report, /\[\+5 more, truncated\]/);
});

void test("more runtime messages than MAX_RUNTIME_MESSAGES are bounded with an explicit list-truncation marker", () => {
  const messages = Array.from({ length: MAX_RUNTIME_MESSAGES + 3 }, (_, index) => ({ level: "info", message: `message ${index}` }));
  const report = buildDiagnosticsReport(reportInput({ runtime: { ...reportInput().runtime, messages } }));
  assert.match(report, /\[\+3 more, truncated\]/);
});

void test("the whole report carries a deterministic total character cap with an explicit truncation marker", () => {
  const hugeLogLines = Array.from({ length: MAX_REPORT_LOG_LINES }, (_, index) => `line ${index} `.repeat(200));
  const report = buildDiagnosticsReport(reportInput({ recentLogLines: hugeLogLines }));
  assert.ok(report.length <= MAX_REPORT_CHARS + 200, `expected the report to respect the total cap, got ${report.length} characters`);
  assert.match(report, /…\[truncated\] \(report exceeded \d+ characters\)$/);
});
