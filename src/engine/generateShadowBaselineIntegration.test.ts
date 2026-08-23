import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHash } from "node:crypto";
import { parseShadowBaselineV1, runShadowComparison, type ShadowEngineCapabilities } from "./shadowEngine";
import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "./contracts";

/**
 * Fixture/integration test for Checkpoint 9 closure review item 1: proves
 * `tools/parity/generate_shadow_baseline.py` (a) actually runs against a
 * synthetic, disposable vault, (b) produces a file `parseShadowBaselineV1`
 * accepts without modification, and (c) that baseline drives
 * `runShadowComparison`'s `comparison.comparisonUnavailable` to `false`
 * for a matching TS-side sample -- i.e. this is not merely a schema check,
 * it proves the generator's OWN hashing scheme is byte-compatible with
 * `shadowEngine.ts`'s `hashIdentity`.
 *
 * Skips (does not fail) when `python3` is unavailable in this environment
 * -- mirrors this repo's other cross-language fixture tests' "when
 * available" pattern; the authoritative gate is `npm run check`'s Python
 * step, which always has python3.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const GENERATOR_SCRIPT = path.join(REPO_ROOT, "tools", "parity", "generate_shadow_baseline.py");

function findPython3(): string | null {
  for (const candidate of ["python3", "python"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function identity(relpath: string): NoteIdentityV1 {
  return stableNoteIdentity(canonicalizePath(relpath));
}

void test("tools/parity/generate_shadow_baseline.py produces a file that parseShadowBaselineV1 accepts and that drives comparisonUnavailable=false for a matching TS sample", async () => {
  const python = findPython3();
  if (!python) {
    return; // environment has no python3 -- covered by npm run check's Python step instead
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shadow-baseline-fixture-"));
  try {
    const vaultRoot = path.join(workDir, "vault");
    const notesDir = path.join(vaultRoot, "Notes");
    await fs.promises.mkdir(notesDir, { recursive: true });
    const rawContent = `---\n---\n${"word ".repeat(60)}`;
    await fs.promises.writeFile(path.join(notesDir, "a.md"), rawContent);

    const configPath = path.join(workDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], min_note_words: 5 }));

    const outputPath = path.join(workDir, "data", "mindmap-engine", "shadow-baseline.json");

    execFileSync(python, [GENERATOR_SCRIPT, "--vault-root", vaultRoot, "--config", configPath, "--output", outputPath], { timeout: 30_000 });

    assert.ok(fs.existsSync(outputPath), "generator must produce the output file");
    const raw: unknown = JSON.parse(await fs.promises.readFile(outputPath, "utf8"));

    // (b) parseShadowBaselineV1 accepts the file as-is, no modification.
    const baseline = parseShadowBaselineV1(raw);
    assert.ok(baseline.entries.length > 0);

    // (c) The SAME hashing scheme: this test's own note, hashed via shadowEngine.ts's exact
    // formula, must appear in the generator's output.
    const expectedHashedId = createHash("sha256").update("path:Notes/a.md", "utf8").digest("hex");
    assert.ok(baseline.entries.some((entry) => entry.hashedId === expectedHashedId), "generator's hashedId scheme must match shadowEngine.ts's hashIdentity exactly");

    // Feed the SAME note through runShadowComparison as a TS-side sample and confirm the baseline
    // actually drives a real comparison, not just "parses".
    const capabilities: ShadowEngineCapabilities = {
      noteSource: { listEligibleSample: async () => [{ identity: identity("Notes/a.md"), rawContent }] },
    };
    const report = await runShadowComparison(capabilities, { baseline });
    assert.equal(report.comparison.comparisonUnavailable, false, "a real generated baseline must drive comparisonUnavailable=false");
    assert.equal(report.comparison.eligibilityDisagreementCount, 0, "the matching note must not be reported as an eligibility disagreement");
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});

void test("the ShadowBaselineV1 fixture file never contains raw note text, paths, or secrets -- hashes/counts/statuses only", async () => {
  const python = findPython3();
  if (!python) return;

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shadow-baseline-fixture-"));
  try {
    const vaultRoot = path.join(workDir, "vault");
    const notesDir = path.join(vaultRoot, "Notes");
    await fs.promises.mkdir(notesDir, { recursive: true });
    const secretBody = "This body mentions a secret project codename Zephyr.";
    await fs.promises.writeFile(path.join(notesDir, "secret-plan.md"), `---\n---\n${secretBody} ${"word ".repeat(30)}`);

    const configPath = path.join(workDir, "config.json");
    await fs.promises.writeFile(configPath, JSON.stringify({ notes_paths_current: ["Notes"], min_note_words: 5 }));
    const outputPath = path.join(workDir, "data", "mindmap-engine", "shadow-baseline.json");

    execFileSync(python, [GENERATOR_SCRIPT, "--vault-root", vaultRoot, "--config", configPath, "--output", outputPath], { timeout: 30_000 });

    const serialized = await fs.promises.readFile(outputPath, "utf8");
    assert.doesNotMatch(serialized, /Zephyr/);
    assert.doesNotMatch(serialized, /secret-plan\.md/);
    assert.doesNotMatch(serialized, /Notes\/secret-plan/);
    assert.doesNotMatch(serialized, new RegExp(vaultRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
});
