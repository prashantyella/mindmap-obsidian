import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// Checkpoint 10B FINAL AUDIT: the specific production command surfaces this
// checkpoint migrated (run/preflight/sidebar/pending/LaunchAgent/semantic
// environment) must all prefer the TypeScript `ProductionEngine` and never
// unconditionally reach a Python invocation. These read the real shipped
// `src/main.ts` as text and assert stable structural patterns -- never a
// line number -- exactly like `runtimeReleaseAudit.test.ts`'s own source
// audits. This is NOT a full "delete Python" audit (dev-only parity
// tooling and every tracked Python file are explicitly out of scope until
// Checkpoint 11); it only proves the specific paths this checkpoint
// touched are gated.
// ---------------------------------------------------------------------------

void test("source audit: runMindmap routes every RunScope through the TypeScript ProductionEngine whenever one is composed for this vault", () => {
  const mainSource = readSource("src/main.ts");
  const match = mainSource.match(/async runMindmap\(trigger: RunTrigger, scope: RunScope = "current", notePath\?: string\): Promise<boolean> \{\s*\n\s*if \(this\.productionEngine\) \{\s*\n\s*return await this\.runMindmapViaProductionEngine/);
  assert.ok(match, "runMindmap must check `this.productionEngine` and delegate to runMindmapViaProductionEngine BEFORE any Python runtime-setup/spawn logic runs");
});

void test("source audit: runMindmapViaProductionEngine maps refreshAll/metadataAll to a force all-scope refresh and rebuildAll to rebuild-index, never a Python argument list", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /await engine\.submitRebuild\(trigger\)/);
  assert.match(mainSource, /await engine\.submitScopeRefresh\(PRODUCTION_SCOPE_ALL, trigger\)/);
});

void test("source audit: preflight is ProductionEngine.recheckReadiness() whenever the engine is available, never the Python --preflight subprocess", () => {
  const mainSource = readSource("src/main.ts");
  const match = mainSource.match(/async runPreflight\(trigger: "manual" \| "startup"\): Promise<PreflightResult> \{\s*\n\s*if \(this\.productionEngine\) \{\s*\n\s*return await this\.runProductionPreflight/);
  assert.ok(match, "runPreflight must check `this.productionEngine` and delegate to runProductionPreflight BEFORE the Python `--preflight` spawn path");
  assert.match(mainSource, /await engine\.recheckReadiness\(\)/);
});

void test("source audit: sidebar live/lookup related queries prefer the TypeScript ProductionEngine over the Python semantic worker", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /async queryLiveRelated\(path: string\): Promise<LiveRelatedResponse> \{[\s\S]{0,300}if \(this\.productionEngine\) \{/);
  assert.match(mainSource, /async queryLookupRelated\(query: string, limit\?: number\): Promise<LookupRelatedResponse> \{[\s\S]{0,300}if \(this\.productionEngine\) \{/);
});

void test("source audit: reading Apple Books annotations never falls back to the Python apple_books_reader.py subprocess", () => {
  const mainSource = readSource("src/main.ts");
  assert.doesNotMatch(mainSource, /path\.join\([^)]*"apple_books_reader\.py"\)/, "the Python Apple Books reader script must never be constructed as a real path from main.ts again");
  assert.match(mainSource, /this\.productionEngine\.appleBooksReader\.readAnnotations\(\)/);
});

void test("source audit: starting the semantic environment is a TypeScript-engine no-op (never spawns the Python worker) whenever a ProductionEngine is composed", () => {
  const mainSource = readSource("src/main.ts");
  const match = mainSource.match(/async startSemanticEnvironment\(showNotice: boolean\): Promise<void> \{\s*\n\s*if \(this\.productionEngine\) \{/);
  assert.ok(match, "startSemanticEnvironment must check `this.productionEngine` and return BEFORE ever touching `this.semanticEnvironment` (the Python worker client)");
});

void test("source audit: pending-notes scanning is entirely TypeScript-engine-backed -- no Python state.json reader is wired into production pending scanning", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /createProductionPendingScanService/);
  assert.doesNotMatch(mainSource, /createPendingScanService\(/, "main.ts must no longer construct the Python state.json-backed PendingScanService");
});

void test("source audit: the LaunchAgent path installs only the accepted TS BackgroundScheduler (open/wake), never a Python-executing plist", () => {
  const mainSource = readSource("src/main.ts");
  assert.doesNotMatch(mainSource, /buildPluginLaunchAgentSpecs/);
  assert.match(mainSource, /backgroundScheduler\.reconcile\(/);
});

// ---------------------------------------------------------------------------
// Final 10B cleanup: a ProductionEngine construction/start() FAILURE (as
// opposed to a genuinely non-desktop filesystem adapter, where construction
// is never attempted) must fail closed with a static Notice/result, never
// silently fall back to a Python/semantic-worker command path.
// ---------------------------------------------------------------------------

void test("source audit: startProductionEngine sets productionEngineFailed and shows a Notice on a construction/start failure, and wraps construction itself (not just start())", () => {
  const mainSource = readSource("src/main.ts");
  const method = mainSource.match(/private async startProductionEngine\(\): Promise<void> \{[\s\S]*?\n {2}\}/);
  assert.ok(method, "startProductionEngine method not found");
  const body = method![0];
  assert.match(body, /try \{\s*\n\s*const engine = new ProductionEngine\(options\);/, "construction itself must be inside the try block, not just start()");
  assert.match(body, /this\.productionEngineFailed = true;/);
  assert.match(body, /new Notice\(/);
});

void test("source audit: runMindmap/runPreflight/queryLiveRelated/queryLookupRelated/startSemanticEnvironment all check productionEngineFailed and fail closed before reaching any Python/semantic-worker fallback", () => {
  const mainSource = readSource("src/main.ts");
  const occurrences = mainSource.match(/this\.productionEngineFailed/g) ?? [];
  // One assignment (in startProductionEngine) plus one read-check per guarded command entry point.
  assert.ok(occurrences.length >= 6, `expected productionEngineFailed to be assigned once and checked in at least 5 command entry points, found ${occurrences.length} references`);

  for (const guardedMethod of [
    /async runMindmap\(trigger: RunTrigger, scope: RunScope = "current", notePath\?: string\): Promise<boolean> \{[\s\S]{0,400}if \(this\.productionEngineFailed\) \{/,
    /async runPreflight\(trigger: "manual" \| "startup"\): Promise<PreflightResult> \{[\s\S]{0,400}if \(this\.productionEngineFailed\) \{/,
    /async queryLiveRelated\(path: string\): Promise<LiveRelatedResponse> \{[\s\S]{0,900}if \(this\.productionEngineFailed\) \{/,
    /async queryLookupRelated\(query: string, limit\?: number\): Promise<LookupRelatedResponse> \{[\s\S]{0,500}if \(this\.productionEngineFailed\) \{/,
    /async startSemanticEnvironment\(showNotice: boolean\): Promise<void> \{[\s\S]{0,400}if \(this\.productionEngineFailed\) \{/,
  ]) {
    assert.match(mainSource, guardedMethod);
  }
});
