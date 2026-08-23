import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Checkpoint 9 requirement: "Shadow mode cannot access mutation methods" /
 * "No Python fallback inside TypeScript component interfaces." This module
 * never imports the real `IndexStore` (whose class exposes `upsertNote`/
 * `deleteNote`/`compact`), `NoteWriter`, `JobEngine`, `ScheduleStore`, or
 * any Python/subprocess path -- it only imports narrow read-only TYPES
 * (`QueryRelatedOptions`, `ScoredNote`, `AppleBooksReadResult`). A source
 * scan is the right proof here: TypeScript's own structural typing means
 * an object literal satisfying `ReadOnlyIndexQuery` can never expose
 * `upsertNote` simply by being assigned that type, but the STRONGER and
 * more durable guarantee is that this file has no way to reach a real
 * mutating instance in the first place, because it never imports the
 * class that creates one.
 */
const SHADOW_ENGINE_PATH = path.join(__dirname, "shadowEngine.ts");

const FORBIDDEN_IMPORT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "IndexStore class (mutation-capable)", pattern: /import\s+.*\bIndexStore\b.*from\s+["'][^"']*indexStore["']/ },
  { label: "NoteWriter (vault mutation seam)", pattern: /from\s+["'][^"']*noteWriter["']/ },
  { label: "JobEngine (submit/execution)", pattern: /from\s+["'][^"']*jobEngine["']/ },
  { label: "JobStore", pattern: /from\s+["'][^"']*jobStore["']/ },
  { label: "ScheduleStore", pattern: /from\s+["'][^"']*scheduleStore["']/ },
  { label: "AtomicStore (state write seam)", pattern: /from\s+["'][^"']*atomicStore["']/ },
  { label: "obsidian runtime", pattern: /from\s+["']obsidian["']/ },
  { label: "Python subprocess", pattern: /child_process|execFile|spawn\(/ },
  { label: "tools/parity", pattern: /tools\/parity/ },
];

void test("shadowEngine.ts never imports a mutation-capable store class, NoteWriter, JobEngine, or a Python/subprocess path", () => {
  const content = fs.readFileSync(SHADOW_ENGINE_PATH, "utf8");
  for (const { label, pattern } of FORBIDDEN_IMPORT_PATTERNS) {
    assert.doesNotMatch(content, pattern, `shadowEngine.ts matched forbidden pattern for "${label}"`);
  }
});

void test("shadowEngine.ts's own capability interfaces expose no mutation method names outside of doc comments", () => {
  const content = fs.readFileSync(SHADOW_ENGINE_PATH, "utf8");
  // Strip block (/** ... */) and line (// ...) comments -- this test is about the actual
  // TYPE/CODE surface, not about prose that explains what was deliberately left out.
  const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const mutationMethod of ["upsertNote", "deleteNote", "compact(", "submit(", "requestCancel", "writeNote", "reconfigure", "acknowledgeScheduledOccurrence"]) {
    assert.doesNotMatch(code, new RegExp(mutationMethod.replace(/[()]/g, "\\$&")), `shadowEngine.ts references mutation method "${mutationMethod}" outside a comment`);
  }
});

void test("ReadOnlyIndexQuery, at runtime, is satisfied by an object literal that structurally has no other IndexStore method", async () => {
  const { runShadowComparison } = await import("./shadowEngine");
  const capabilities = {
    noteSource: { listEligibleSample: async () => [] },
    indexQuery: { queryRelated: async () => [] },
  };
  assert.deepEqual(Object.keys(capabilities.indexQuery), ["queryRelated"]);
  const report = await runShadowComparison(capabilities);
  assert.equal(report.items.length, 0);
});
