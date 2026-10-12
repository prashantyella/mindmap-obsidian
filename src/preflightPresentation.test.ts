import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { presentPreflight } from "./preflightPresentation";
import { PREFLIGHT_CHECK_CODES, type PreflightReportV1 } from "./engine/preflight";
import { buildOverviewState } from "./settingsOverview";

function report(): PreflightReportV1 {
  return { schemaVersion: 1, generatedAtIso: new Date(0).toISOString(), checks: PREFLIGHT_CHECK_CODES.map((code) => ({ schemaVersion: 1, code, status: "ok", message: "Ready." })), summary: { runtimeReady: true, overallStatus: "ok", requiredOkCount: 6, requiredCount: 6, optionalOkCount: 5, optionalCount: 5 } };
}

void test("healthy filesystem checks cannot hide an unavailable summaries model", () => {
  const input = report();
  input.checks.find((check) => check.code === "LOCAL_METADATA_PROVIDER")!.status = "unavailable";
  const result = presentPreflight(input);
  assert.equal(result.ok, false);
  assert.match(result.summary, /Summaries and tags model is not ready/);
  assert.match(result.summary, /Start Ollama/);
  assert.doesNotMatch(result.summary, /required|optional|TypeScript/);
  assert.equal(buildOverviewState({ productionEngineAvailable: true, scopeComplete: true, preflightOk: result.ok, summary: result.summary }).message, result.summary);
});

void test("disabled optional capabilities are not failures and do not block note processing", () => {
  const input = report();
  for (const code of ["APPLE_BOOKS_READING", "RESEARCH_PROVIDER", "BACKGROUND_SCHEDULER"]) {
    const check = input.checks.find((item) => item.code === code)!;
    check.status = "degraded"; check.message = "Capability is not configured.";
  }
  const result = presentPreflight(input);
  assert.equal(result.ok, true);
  assert.equal(result.checks.filter((check) => check.status === "skipped").length, 3);
  assert.match(result.summary, /ready for note processing/);
});

void test("migration and checking states cannot claim processing readiness", () => {
  assert.equal(presentPreflight(report(), false).ok, false);
  assert.match(presentPreflight(report(), false).summary, /Finish index setup/);
  const checking = buildOverviewState({ productionEngineAvailable: true, scopeComplete: true, preflightOk: true, checking: true });
  assert.equal(checking.ready, false);
  assert.equal(checking.checking, true);
});

void test("startup uses its automatic report; settings observe state without recreating draft inputs", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  const settings = fs.readFileSync("src/settingsTab.ts", "utf8");
  assert.match(main, /if \(!this\.diagnosticsState\.result\) await this\.runPreflight\("startup"\)/);
  assert.match(main, /finally \{[\s\S]*?this\.diagnosticsState\.inProgress = false/);
  assert.match(main, /this\.preflightPromise && this\.preflightEngine === engine/);
  assert.match(settings, /this\.plugin\.subscribeDiagnostics/);
  assert.match(settings, /hide\(\): void \{ this\.unsubscribeDiagnostics/);
});
