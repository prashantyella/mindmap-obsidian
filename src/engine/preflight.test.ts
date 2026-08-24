import test from "node:test";
import assert from "node:assert/strict";

import { PREFLIGHT_CHECK_CODES, runPreflight, type PreflightCheckCode, type PreflightCheckDefinition } from "./preflight";

function ok(code: PreflightCheckCode, message = "ready"): PreflightCheckDefinition {
  return { code, probe: async () => ({ status: "ok", message }) };
}

/** Builds one definition per `PREFLIGHT_CHECK_CODES` entry (every real one defaults to `ok(code)`; every `override` replaces its default entirely) -- `runPreflight` now requires the exhaustive, exactly-once set (Checkpoint 9 requirement 7), so every test composes a full set rather than a partial one. */
function fullDefinitions(overrides: Partial<Record<PreflightCheckCode, PreflightCheckDefinition>> = {}): PreflightCheckDefinition[] {
  return PREFLIGHT_CHECK_CODES.map((code) => overrides[code] ?? ok(code));
}

void test("runPreflight aggregates required-vs-optional checks independently, and an optional-only failure degrades rather than making the overall status unavailable", async () => {
  const report = await runPreflight(
    fullDefinitions({
      OLLAMA_EMBEDDINGS: { code: "OLLAMA_EMBEDDINGS", probe: async () => ({ status: "unavailable", message: "no endpoint" }) },
    }),
  );
  assert.equal(report.summary.runtimeReady, true, "required checks all ok -> runtime ready even though an optional check failed");
  assert.equal(report.summary.overallStatus, "degraded", "an optional-only failure must degrade, never mark the overall status unavailable");
  assert.equal(report.summary.requiredOkCount, 6);
  assert.equal(report.summary.requiredCount, 6);
  assert.equal(report.summary.optionalOkCount, 4);
  assert.equal(report.summary.optionalCount, 5);
});

void test("runPreflight marks runtimeReady false and overallStatus unavailable when a required check fails, regardless of optional checks", async () => {
  const report = await runPreflight(
    fullDefinitions({
      OWNED_DATA_PATHS: { code: "OWNED_DATA_PATHS", probe: async () => ({ status: "unavailable", message: "cannot access data dir" }) },
    }),
  );
  assert.equal(report.summary.runtimeReady, false);
  assert.equal(report.summary.overallStatus, "unavailable");
});

void test("a required check that is merely degraded (not unavailable) pulls the overall status down to degraded only, never unavailable", async () => {
  const report = await runPreflight(
    fullDefinitions({
      TEMP_CLEANUP: { code: "TEMP_CLEANUP", probe: async () => ({ status: "degraded", message: "stale temp files pending cleanup" }) },
    }),
  );
  assert.equal(report.summary.overallStatus, "degraded");
  assert.equal(report.summary.runtimeReady, false, "a degraded required check still keeps runtimeReady false (requiredOkCount only counts status===ok)");
});

void test("every check ok -> overallStatus ok", async () => {
  const report = await runPreflight(fullDefinitions());
  assert.equal(report.summary.overallStatus, "ok");
  assert.equal(report.summary.runtimeReady, true);
});

void test("a check with no probe (capability not configured) reports degraded with a static message, never skipped and never gating runtimeReady", async () => {
  const report = await runPreflight(fullDefinitions({ APPLE_BOOKS_READING: { code: "APPLE_BOOKS_READING" } }));
  assert.equal(report.checks.length, PREFLIGHT_CHECK_CODES.length);
  const check = report.checks.find((entry) => entry.code === "APPLE_BOOKS_READING");
  assert.equal(check?.status, "degraded", "an unconfigured capability was never actually checked -- ok would overclaim health");
  assert.equal(check?.message, "Capability is not configured.");
  assert.equal(report.summary.runtimeReady, true, "an unconfigured OPTIONAL capability must never gate runtimeReady");
  assert.equal(report.summary.overallStatus, "degraded");
});

void test("a probe exceeding its bounded timeout is reported unavailable, never hangs runPreflight", async () => {
  const start = Date.now();
  const report = await runPreflight(
    fullDefinitions({
      OLLAMA_EMBEDDINGS: {
        code: "OLLAMA_EMBEDDINGS",
        timeoutMs: 30,
        probe: () => new Promise(() => {
          // Never resolves -- simulates a hung provider call.
        }),
      },
    }),
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `expected the bounded timeout to cut this off quickly, took ${elapsed}ms`);
  const check = report.checks.find((entry) => entry.code === "OLLAMA_EMBEDDINGS");
  assert.equal(check?.status, "unavailable");
  assert.match(check?.message ?? "", /bounded timeout/);
});

void test("runPreflight cancels every pending probe when the outer signal aborts", async () => {
  const controller = new AbortController();
  let observedAborted = false;
  const reportPromise = runPreflight(
    fullDefinitions({
      OLLAMA_EMBEDDINGS: {
        code: "OLLAMA_EMBEDDINGS",
        timeoutMs: 5000,
        probe: (signal) => new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            observedAborted = true;
            resolve({ status: "unavailable", message: "aborted" });
          });
        }),
      },
    }),
    { signal: controller.signal },
  );
  controller.abort();
  const report = await reportPromise;
  assert.equal(observedAborted, true);
  const check = report.checks.find((entry) => entry.code === "OLLAMA_EMBEDDINGS");
  assert.equal(check?.status, "unavailable");
});

void test("a probe that throws a raw exception (not a rejected PreflightProbeResult) is converted, never propagated", async () => {
  const report = await runPreflight(
    fullDefinitions({
      LOCAL_METADATA_PROVIDER: {
        code: "LOCAL_METADATA_PROVIDER",
        probe: async () => {
          throw new Error("raw secret token=abc123 leaked here");
        },
      },
    }),
  );
  const check = report.checks.find((entry) => entry.code === "LOCAL_METADATA_PROVIDER");
  assert.equal(check?.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(check), /abc123/);
});

void test("a malformed probe result (bad status/oversized message) still produces a valid HealthCheckV1, bounded and redacted", async () => {
  const report = await runPreflight(
    fullDefinitions({
      RESEARCH_PROVIDER: {
        code: "RESEARCH_PROVIDER",
        probe: async () => ({
          status: "ok",
          message: "x".repeat(10_000),
          context: { secretPath: "/Users/someone/very/secret/path", apiKey: "sk-short", nested: { a: 1 }, count: 42, flag: true, enumLike: "ready-state" },
        }),
      },
    }),
  );
  const check = report.checks.find((entry) => entry.code === "RESEARCH_PROVIDER");
  assert.ok((check?.message.length ?? 0) <= 241);
  assert.equal(check?.context?.secretPath, "[redacted]", "a key matching the sensitive-key pattern is redacted regardless of its value's shape");
  assert.equal(check?.context?.apiKey, "[redacted]", "a key matching the sensitive-key pattern is redacted even for a short value");
  assert.equal(check?.context?.nested, "[redacted]");
  assert.equal(check?.context?.count, 42);
  assert.equal(check?.context?.flag, true);
  assert.equal(check?.context?.enumLike, "ready-state", "a bounded, enum/identifier-shaped string under a non-sensitive key passes through");
});

void test("a context string shaped like a path/URL/free text is redacted even under a non-sensitive-looking key", async () => {
  const report = await runPreflight(
    fullDefinitions({
      RESEARCH_PROVIDER: {
        code: "RESEARCH_PROVIDER",
        probe: async () => ({ status: "ok", message: "ok", context: { note: "/Users/someone/file.txt", detail: "contains a \"quote\" and newline\ncharacter" } }),
      },
    }),
  );
  const check = report.checks.find((entry) => entry.code === "RESEARCH_PROVIDER");
  assert.equal(check?.context?.note, "[redacted:unsafe-value]");
  assert.equal(check?.context?.detail, "[redacted:unsafe-value]");
});

void test("PREFLIGHT_CHECK_CODES is the exact, exhaustive allow-list checkpoint 9 specifies", () => {
  assert.deepEqual(
    [...PREFLIGHT_CHECK_CODES].sort(),
    [
      "APPLE_BOOKS_READING",
      "BACKGROUND_SCHEDULER",
      "INDEX_STORE",
      "JOB_STORE",
      "LOCAL_METADATA_PROVIDER",
      "OLLAMA_EMBEDDINGS",
      "OWNED_DATA_PATHS",
      "RESEARCH_PROVIDER",
      "SCHEDULE_STORE",
      "TEMP_CLEANUP",
      "VAULT_ADAPTER",
    ].sort(),
  );
});

void test("runPreflight produces a deterministic summary independent of check array order", async () => {
  const definitions = fullDefinitions({ OLLAMA_EMBEDDINGS: { code: "OLLAMA_EMBEDDINGS", probe: async () => ({ status: "degraded", message: "slow" }) } });
  const forward = await runPreflight(definitions);
  const reversed = await runPreflight([...definitions].reverse());
  assert.deepEqual(forward.summary, reversed.summary);
});

void test("runPreflight rejects a definitions array with a duplicate check code before any probe runs", async () => {
  let probeCalled = false;
  const definitions = fullDefinitions({
    JOB_STORE: {
      code: "JOB_STORE",
      probe: async () => {
        probeCalled = true;
        return { status: "ok", message: "ready" };
      },
    },
  });
  await assert.rejects(() => runPreflight([...definitions, ok("JOB_STORE")]));
  assert.equal(probeCalled, false, "no probe must run once a contract violation is detected");
});

void test("runPreflight rejects a definitions array missing a required check code before any probe runs", async () => {
  const definitions = fullDefinitions().filter((definition) => definition.code !== "BACKGROUND_SCHEDULER");
  await assert.rejects(() => runPreflight(definitions));
});

void test("runPreflight rejects an invalid per-check timeoutMs (non-integer, zero, negative, or over the module bound) before any probe runs", async () => {
  for (const invalid of [0, -5, 1.5, 999_999_999]) {
    await assert.rejects(() => runPreflight(fullDefinitions({ OLLAMA_EMBEDDINGS: { code: "OLLAMA_EMBEDDINGS", timeoutMs: invalid, probe: async () => ({ status: "ok", message: "ok" }) } })));
  }
});

void test("runPreflight rejects an invalid defaultTimeoutMs (non-integer, zero, negative) before any probe runs, but clamps an oversized one rather than rejecting it", async () => {
  let probeCalled = false;
  const definitions = fullDefinitions({ OLLAMA_EMBEDDINGS: { code: "OLLAMA_EMBEDDINGS", probe: async () => { probeCalled = true; return { status: "ok", message: "ok" }; } } });
  for (const invalid of [0, -5, 1.5, NaN]) {
    await assert.rejects(() => runPreflight(definitions, { defaultTimeoutMs: invalid }));
  }
  assert.equal(probeCalled, false, "no probe must run once defaultTimeoutMs fails validation");
  const report = await runPreflight(definitions, { defaultTimeoutMs: 999_999_999 });
  assert.equal(report.checks.find((check) => check.code === "OLLAMA_EMBEDDINGS")?.status, "ok", "an oversized defaultTimeoutMs is clamped, not rejected");
});

void test("runPreflight rejects a non-canonical generatedAt (nowIso) timestamp", async () => {
  await assert.rejects(() => runPreflight(fullDefinitions(), {}, "2026-08-23"));
  await assert.rejects(() => runPreflight(fullDefinitions(), {}, "not-a-date"));
  await assert.rejects(() => runPreflight(fullDefinitions(), {}, "2026-08-23T10:00:00Z"));
});

void test("a malicious probe cannot inject an arbitrary status, code, or free-text/context field into the report", async () => {
  const report = await runPreflight(
    fullDefinitions({
      OLLAMA_EMBEDDINGS: {
        code: "OLLAMA_EMBEDDINGS",
        // A probe result carrying an out-of-band status, a spoofed "code" field (HealthCheckV1 has
        // no such input -- the CODE always comes from the definition, never the probe), and free
        // text in context must all be neutralized, not passed through.
        probe: async () => ({ status: "definitely-not-a-real-status" as never, message: "ignored", code: "SPOOFED_CODE" as never, context: { free: "text with a / path and \"quotes\"" } }),
      },
    }),
  );
  const check = report.checks.find((entry) => entry.code === "OLLAMA_EMBEDDINGS");
  assert.equal(check?.code, "OLLAMA_EMBEDDINGS", "the check code always comes from the definition, never the probe result");
  assert.equal(check?.status, "unavailable", "an invalid status is converted to unavailable, never passed through raw");
});

void test("runPreflight accepts the default canonical nowIso it generates itself", async () => {
  const report = await runPreflight(fullDefinitions());
  assert.match(report.generatedAtIso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
