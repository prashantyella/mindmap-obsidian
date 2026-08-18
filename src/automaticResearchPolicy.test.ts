import test from "node:test";
import assert from "node:assert/strict";

import { AUTOMATIC_RESEARCH_DAILY_LIMIT, AUTOMATIC_RESEARCH_MAX_ERROR_CHARS, canAttemptAutomaticResearch, clearTransientAutomaticPause, createAutomaticResearchPolicy, createAutomaticResearchPolicyStore, loadAutomaticResearchPolicySafely, localResearchDay, recordAutomaticAttempt, validateAutomaticResearchPolicy } from "./automaticResearchPolicy";

class MemoryPolicyFileSystem {
  readonly files = new Map<string, string>();
  failWrite = false;
  failRename = false;
  async mkdir(): Promise<void> {}
  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  }
  async writeFile(filePath: string, content: string): Promise<void> {
    if (this.failWrite) throw new Error("write failed");
    this.files.set(filePath, content);
  }
  async rename(source: string, target: string): Promise<void> {
    if (this.failRename) throw new Error("rename failed");
    this.files.set(target, this.files.get(source)!);
    this.files.delete(source);
  }
  async unlink(filePath: string): Promise<void> { this.files.delete(filePath); }
}

test("automatic research policy limits, pauses, and rolls over deterministically", () => {
  let state = createAutomaticResearchPolicy("2026-08-17");
  for (let index = 0; index < AUTOMATIC_RESEARCH_DAILY_LIMIT; index += 1) state = recordAutomaticAttempt(state);
  assert.equal(state.pauseReason, "daily-limit");
  assert.equal(canAttemptAutomaticResearch(state), false);
  assert.deepEqual(createAutomaticResearchPolicy("2026-08-18").attempted, 0);
  assert.equal(localResearchDay(new Date("2026-08-17T12:00:00Z")).length, 10);
});

test("policy validation rejects malformed calendar, timestamp, pause, count, and error values", () => {
  for (const value of [
    { ...createAutomaticResearchPolicy("2026-02-30") },
    { ...createAutomaticResearchPolicy("2026-08-17"), attempted: 1.5 },
    { ...createAutomaticResearchPolicy("2026-08-17"), attempted: 10 },
    { ...createAutomaticResearchPolicy("2026-08-17"), pauseReason: "other" },
    { ...createAutomaticResearchPolicy("2026-08-17"), lastError: "x".repeat(AUTOMATIC_RESEARCH_MAX_ERROR_CHARS + 1) },
    { ...createAutomaticResearchPolicy("2026-08-17"), lastErrorAt: "2026-08-17T01:00:00Z" },
  ]) assert.throws(() => validateAutomaticResearchPolicy(value), /invalid/);
  assert.equal(validateAutomaticResearchPolicy({ ...createAutomaticResearchPolicy("2026-08-17"), lastErrorAt: "2026-08-17T01:00:00.000Z" }).day, "2026-08-17");
});

test("policy save normalizes the daily-cap invariant, clamps errors, and safe loads preserve startup", async () => {
  const fs = new MemoryPolicyFileSystem();
  const store = createAutomaticResearchPolicyStore("/runtime/policy.json", fs);
  await store.save({ ...createAutomaticResearchPolicy("2026-08-17"), attempted: 10, lastError: "x".repeat(AUTOMATIC_RESEARCH_MAX_ERROR_CHARS + 30) });
  const saved = await store.load("2026-08-17");
  assert.equal(saved.pauseReason, "daily-limit");
  assert.equal(saved.lastError?.length, AUTOMATIC_RESEARCH_MAX_ERROR_CHARS);
  assert.equal(clearTransientAutomaticPause(saved), saved);
  const transient = { ...createAutomaticResearchPolicy("2026-08-17"), attempted: 4, pauseReason: "provider-network" as const, lastError: "redacted", lastErrorAt: "2026-08-17T01:00:00.000Z" };
  assert.deepEqual(clearTransientAutomaticPause(transient), { ...transient, pauseReason: null, lastError: null, lastErrorAt: null });
  const unavailable = await loadAutomaticResearchPolicySafely({ load: async () => { throw new Error("corrupt"); }, save: async () => {} }, "2026-08-17");
  assert.equal(unavailable.state.attempted, 0);
  assert.equal(unavailable.error, "Automatic research policy is unavailable.");
});

test("policy store preserves committed data and cleans temporary writes after write or rename failure", async () => {
  const fs = new MemoryPolicyFileSystem();
  const file = "/runtime/policy.json";
  const store = createAutomaticResearchPolicyStore(file, fs);
  await store.save({ ...createAutomaticResearchPolicy("2026-08-17"), attempted: 3 });
  const committed = fs.files.get(file);
  fs.failWrite = true;
  await assert.rejects(() => store.save({ ...createAutomaticResearchPolicy("2026-08-17"), attempted: 4 }), /write failed/);
  assert.equal(fs.files.get(file), committed);
  assert.equal(fs.files.has(`${file}.tmp`), false);
  fs.failWrite = false;
  fs.failRename = true;
  await assert.rejects(() => store.save({ ...createAutomaticResearchPolicy("2026-08-17"), attempted: 4 }), /rename failed/);
  assert.equal(fs.files.get(file), committed);
  assert.equal(fs.files.has(`${file}.tmp`), false);
  assert.equal((await store.load("2026-08-18")).attempted, 0);
});
