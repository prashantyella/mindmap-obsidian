import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { presentPreflight } from "./preflightPresentation";
import { formatPreflightNotice, type PreflightResult } from "./diagnostics";
import { PREFLIGHT_CHECK_CODES, type PreflightReportV1 } from "./engine/preflight";

function report(ready = true): PreflightReportV1 {
  return { schemaVersion: 1, generatedAtIso: new Date(0).toISOString(), checks: PREFLIGHT_CHECK_CODES.map((code) => ({ schemaVersion: 1, code, status: !ready && code === "LOCAL_METADATA_PROVIDER" ? "unavailable" : "ok", message: "Checked." })), summary: { runtimeReady: true, overallStatus: ready ? "ok" : "degraded", requiredOkCount: 6, requiredCount: 6, optionalOkCount: ready ? 5 : 4, optionalCount: 5 } };
}

interface Engine { recheckReadiness(): Promise<PreflightReportV1> }
interface FixturePlugin {
  productionEngine: Engine | null;
  diagnosticsState: { inProgress: boolean; result: PreflightResult | null; lastRunAt: number | null };
  diagnosticsListeners: Set<() => void>;
  preflightRetryDelay: number;
  activateProductionEngine(): Promise<void>;
  onLayoutReadyDeferred(): Promise<void>;
  runPreflight(trigger: "manual" | "startup"): Promise<PreflightResult>;
}

/** Run the actual lifecycle methods in isolation, with no live app/model/vault effects. */
function fixture(engine: Engine): { plugin: FixturePlugin; timers: Map<number, { callback: () => void; ms: number }>; notices: string[] } {
  const source = ts.createSourceFile("main.ts", fs.readFileSync("src/main.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === "MindmapPlugin") as ts.ClassDeclaration;
  const names = new Set(["onLayoutReadyDeferred", "startProductionEngine", "runPreflight", "runProductionPreflight", "toPreflightResult", "notifyDiagnostics", "preflightFailure", "schedulePreflightRetry"]);
  const methods = declaration.members.filter((node) => ts.isMethodDeclaration(node) && node.name && names.has(node.name.getText(source))).map((node) => node.getText(source)).join("\n");
  const output = ts.transpileModule(`export class MindmapPlugin { ${methods} }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, unknown> = {};
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const clock = { setTimeout: (callback: () => void, ms: number) => { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout: (id: number) => timers.delete(id) };
  const notices: string[] = [];
  class Notice { constructor(message: string) { notices.push(message); } }
  const execute = vm.runInThisContext(`(function(exports, window, presentPreflight, formatPreflightNotice, Notice) { ${output}\n})`) as (exports: Record<string, unknown>, clock: unknown, presenter: typeof presentPreflight, noticeFormatter: typeof formatPreflightNotice, notice: typeof Notice) => void;
  execute(exports, clock, presentPreflight, formatPreflightNotice, Notice);
  const Constructor = exports.MindmapPlugin as new () => FixturePlugin;
  const plugin = new Constructor();
  Object.assign(plugin, {
    productionEngine: engine, diagnosticsState: { inProgress: false, result: null, lastRunAt: null },
    diagnosticsListeners: new Set(), preflightPromise: null, preflightEngine: null,
    preflightRetryTimer: null, preflightRetryDelay: 5_000, unloaded: false,
    settings: { embedModel: "embed", llmModel: "llm", readingMode: "standard" },
    cachedMigrationStatus: { phase: "complete" }, updateStatusBar() {}, appendLog() {},
    refreshCachedMigrationStatus: async () => {}, retireLegacyLaunchAgents: async () => {},
    refreshAutomaticResearchPolicyStatus: async () => {}, migrateLegacyConfigOnce: async () => {},
    activateProductionEngine: async () => { plugin.diagnosticsState.result = presentPreflight(await engine.recheckReadiness()); },
  });
  return { plugin, timers, notices };
}

void test("startup displays progress and reuses its completed automatic report without an extra model check", async () => {
  let calls = 0;
  const { plugin } = fixture({ recheckReadiness: async () => { calls++; return report(); } });
  const progress: boolean[] = [];
  plugin.diagnosticsListeners.add(() => progress.push(plugin.diagnosticsState.inProgress));
  await plugin.onLayoutReadyDeferred();
  assert.equal(calls, 1);
  assert.equal(progress[0], true);
  assert.equal(progress[progress.length - 1], false);
  assert.equal(plugin.diagnosticsState.result?.ok, true);
});

void test("concurrent checks share one request and failures always clear the running state", async () => {
  let resolve!: (value: PreflightReportV1) => void;
  let calls = 0;
  const engine = { recheckReadiness: () => { calls++; return new Promise<PreflightReportV1>((finish) => { resolve = finish; }); } };
  const { plugin } = fixture(engine);
  const a = plugin.runPreflight("manual"); const b = plugin.runPreflight("manual");
  assert.equal(calls, 1); assert.equal(plugin.diagnosticsState.inProgress, true);
  resolve(report()); await Promise.all([a, b]);
  assert.equal(plugin.diagnosticsState.inProgress, false);
  engine.recheckReadiness = async () => { throw new Error("secret provider body"); };
  const failed = await plugin.runPreflight("manual");
  assert.equal(failed.ok, false); assert.doesNotMatch(failed.summary, /secret/);
  assert.equal(plugin.diagnosticsState.inProgress, false);
});

void test("model recovery is retried automatically without repeated startup popups", async () => {
  let ready = false;
  const { plugin, timers, notices } = fixture({ recheckReadiness: async () => report(ready) });
  await plugin.onLayoutReadyDeferred();
  assert.equal(plugin.diagnosticsState.result?.ok, false);
  assert.equal(timers.size, 1);
  const [id, timer] = [...timers][0];
  assert.equal(timer.ms, 5_000);
  ready = true; timers.delete(id); timer.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.diagnosticsState.result?.ok, true);
  assert.equal(timers.size, 0);
  assert.equal(plugin.preflightRetryDelay, 5_000);
  assert.deepEqual(notices, []);
});

void test("an old engine's completed check cannot overwrite replacement-engine readiness", async () => {
  let resolve!: (value: PreflightReportV1) => void;
  const { plugin } = fixture({ recheckReadiness: () => new Promise<PreflightReportV1>((finish) => { resolve = finish; }) });
  const pending = plugin.runPreflight("startup");
  plugin.productionEngine = { recheckReadiness: async () => report() };
  const current = presentPreflight(report());
  plugin.diagnosticsState.result = current;
  plugin.diagnosticsState.inProgress = true;
  resolve(report(false)); await pending;
  assert.equal(plugin.diagnosticsState.result, current);
  assert.equal(plugin.diagnosticsState.inProgress, true);
});
