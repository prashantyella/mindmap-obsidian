import test from "node:test";
import assert from "node:assert/strict";

import { commitAutomaticResearchAttempt, pauseReasonFor, persistAutomaticResearchOutcome, runAutomaticResearch, selectAutomaticResearchCandidates, selectSyncResearchCandidates, TerminalAutomaticResearchError } from "./automaticResearch";
import { createAutomaticResearchPolicy, type AutomaticResearchPolicyState } from "./automaticResearchPolicy";
import { WebResearchError } from "./webResearchTypes";

class MemoryPolicy {
  state = createAutomaticResearchPolicy("2026-08-17");
  saves: AutomaticResearchPolicyState[] = [];
  async load(): Promise<AutomaticResearchPolicyState> { return { ...this.state }; }
  async save(state: AutomaticResearchPolicyState): Promise<void> { this.state = { ...state }; this.saves.push({ ...state }); }
}

test("automatic research caps each sync and pauses safely after a provider failure", async () => {
  const store = new MemoryPolicy();
  let calls = 0;
  const result = await runAutomaticResearch({ store, now: new Date("2026-08-17T12:00:00Z"), candidates: [1, 2, 3, 4, 5, 6], attempt: async () => { calls += 1; return true; } });
  assert.equal(calls, 5);
  assert.equal(result.attempted, 5);
  const failure = await runAutomaticResearch({ store, now: new Date("2026-08-17T12:00:00Z"), candidates: [7], attempt: async () => { throw new WebResearchError("EXA_HTTP_429", "redacted"); } });
  assert.equal(failure.pauseReason, "provider-quota");
});

test("automatic policy persists before attempts, honors remaining daily capacity, and stops when continuation ends", async () => {
  const store = new MemoryPolicy();
  store.state = { ...store.state, attempted: 8 };
  let calls = 0;
  const result = await runAutomaticResearch({
    store,
    now: new Date("2026-08-17T12:00:00Z"),
    candidates: [1, 2, 3],
    shouldContinue: () => calls < 2,
    attempt: async () => { calls += 1; assert.equal(store.saves[store.saves.length - 1]?.attempted, calls + 8); return true; },
  });
  assert.equal(calls, 2);
  assert.equal(result.attempted, 2);
  assert.equal(store.state.attempted, 10);
  assert.equal(store.state.pauseReason, "daily-limit");
});

test("automatic error codes map to stable pause reasons", () => {
  const cases: Array<[string, ReturnType<typeof pauseReasonFor>]> = [
    ["CREDENTIAL_UNAVAILABLE", "credential"], ["LOCAL_MODEL_TIMEOUT", "local-model"], ["EXA_HTTP_401", "provider-auth"], ["EXA_HTTP_403", "provider-auth"], ["EXA_HTTP_429", "provider-quota"], ["EXA_TIMEOUT", "provider-timeout"], ["EXA_NETWORK", "provider-network"], ["OTHER", "invalid-result"],
  ];
  for (const [code, expected] of cases) assert.equal(pauseReasonFor(new WebResearchError(code, "redacted")), expected);
});

test("terminal automatic result is counted, skipped next sync, and does not block later candidates", async () => {
  const store = new MemoryPolicy();
  const attempted: string[] = [];
  const result = await runAutomaticResearch({
    store,
    now: new Date("2026-08-17T12:00:00Z"),
    candidates: ["terminal", "later"],
    attempt: async (candidate) => {
      attempted.push(candidate);
      if (candidate === "terminal") throw new TerminalAutomaticResearchError("No usable sources.");
      return true;
    },
  });
  assert.deepEqual(attempted, ["terminal", "later"]);
  assert.equal(result.pauseReason, null);
  assert.equal(result.attempted, 2);
  assert.deepEqual(selectAutomaticResearchCandidates({ terminal: { notePath: "t.md", contentHash: "a", importedAt: "now", researchStatus: "unresearchable", processedAt: null }, later: { notePath: "l.md", contentHash: "b", importedAt: "now", researchStatus: "off", processedAt: null } }).map((item) => item.annotationId), ["later"]);
});

test("typed automatic outcomes mark terminal results and preserve transient provider codes for pause mapping", async () => {
  const statuses: string[] = [];
  await assert.rejects(
    () => persistAutomaticResearchOutcome({ outcome: { ok: false, code: "NO_USABLE_SOURCES", message: "redacted terminal" }, updateStatus: async (status) => { statuses.push(status); return "updated"; } }),
    TerminalAutomaticResearchError,
  );
  assert.deepEqual(statuses, ["unresearchable"]);
  const store = new MemoryPolicy();
  await runAutomaticResearch({
    store,
    now: new Date("2026-08-17T12:00:00Z"),
    candidates: ["network"],
    attempt: async () => await persistAutomaticResearchOutcome({ outcome: { ok: false, code: "EXA_NETWORK", message: "redacted network" }, updateStatus: async () => "updated" }),
  });
  assert.equal(store.state.pauseReason, "provider-network");
});

test("a failing tenth pre-counted attempt remains daily-limited and cannot be retried past the cap", async () => {
  const store = new MemoryPolicy();
  store.state = { ...store.state, attempted: 9 };
  const result = await runAutomaticResearch({
    store,
    now: new Date("2026-08-17T12:00:00Z"),
    candidates: ["tenth"],
    attempt: async () => { throw new WebResearchError("EXA_NETWORK", "network body redacted"); },
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.pauseReason, "daily-limit");
  assert.equal(store.state.attempted, 10);
  assert.equal(store.state.pauseReason, "daily-limit");
  const retry = await runAutomaticResearch({ store, now: new Date("2026-08-17T12:01:00Z"), candidates: ["blocked"], attempt: async () => { throw new Error("must not run"); } });
  assert.equal(retry.attempted, 0);
});

test("automatic candidate selection excludes complete entries and invokes each selected lifecycle once", async () => {
  const candidates = selectAutomaticResearchCandidates({
    complete: { notePath: "complete.md", contentHash: "a", importedAt: "now", researchStatus: "complete", processedAt: null },
    retryable: { notePath: "retryable.md", contentHash: "b", importedAt: "now", researchStatus: "retryable", processedAt: "done" },
    off: { notePath: "off.md", contentHash: "c", importedAt: "now", researchStatus: "off", processedAt: null },
    short: { notePath: "short.md", contentHash: "d", importedAt: "now", researchStatus: "too-short", processedAt: null },
  });
  assert.deepEqual(candidates.map((candidate) => candidate.annotationId), ["off", "retryable"]);

  const store = new MemoryPolicy();
  let lifecycleUpdates = 0;
  const result = await runAutomaticResearch({
    store,
    now: new Date("2026-08-17T12:00:00Z"),
    candidates: candidates.slice(0, 1),
    attempt: async () => { lifecycleUpdates += 1; return true; },
  });
  assert.equal(result.attempted, 1);
  assert.equal(lifecycleUpdates, 1);
});

test("automatic success commits complete once without any notification hook", async () => {
  const statuses: string[] = [];
  let providerCalls = 0;
  const result = await commitAutomaticResearchAttempt({
    runResearch: async () => { providerCalls += 1; return true; },
    updateStatus: async (status) => { statuses.push(status); return "updated"; },
  });
  assert.equal(result, true);
  assert.equal(providerCalls, 1);
  assert.deepEqual(statuses, ["complete"]);
});

test("automatic provider failure persists retryable without changing processed lifecycle", async () => {
  const statuses: string[] = [];
  await assert.rejects(
    () => commitAutomaticResearchAttempt({
      runResearch: async () => false,
      updateStatus: async (status) => { statuses.push(status); return "updated"; },
    }),
    /Automatic research failed/,
  );
  assert.deepEqual(statuses, ["retryable"]);
});

test("automatic attempt rejects when complete or retryable lifecycle status cannot be applied", async () => {
  await assert.rejects(
    () => commitAutomaticResearchAttempt({ runResearch: async () => true, updateStatus: async () => false }),
    /status could not be applied/,
  );
  await assert.rejects(
    () => commitAutomaticResearchAttempt({ runResearch: async () => false, updateStatus: async () => false }),
    /status could not be applied/,
  );
});

test("selectSyncResearchCandidates scopes to eligible created/updated items with valid research status", () => {
  const entries = {
    a: { notePath: "a.md", contentHash: "h", importedAt: "now", researchStatus: "off" as const, processedAt: null },
    b: { notePath: "b.md", contentHash: "h", importedAt: "now", researchStatus: "complete" as const, processedAt: null },
    c: { notePath: "c.md", contentHash: "h", importedAt: "now", researchStatus: "retryable" as const, processedAt: null },
    d: { notePath: "d.md", contentHash: "h", importedAt: "now", researchStatus: "off" as const, processedAt: null },
    e: { notePath: "e.md", contentHash: "h", importedAt: "now", researchStatus: "too-short" as const, processedAt: null },
  };
  const imported = [
    { annotationId: "a", notePath: "a.md", action: "created" as const, eligible: true },
    { annotationId: "b", notePath: "b.md", action: "created" as const, eligible: true },
    { annotationId: "c", notePath: "c.md", action: "updated" as const, eligible: true },
    { annotationId: "d", notePath: "d.md", action: "unchanged" as const, eligible: true },
    { annotationId: "e", notePath: "e.md", action: "created" as const, eligible: false },
  ];
  const result = selectSyncResearchCandidates(imported, entries);
  assert.deepEqual(result.map((r) => r.annotationId), ["a", "c"]);
  assert.equal(result[0]?.action, "created");
  assert.equal(result[1]?.action, "updated");
});
