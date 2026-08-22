import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// obsidianRequestUrlFetch.ts imports the "obsidian" module, which in this
// repo is types-only (no runtime implementation), so it cannot be imported
// directly in a Node test. This audits the source text instead, the same
// approach used for settingsTab.ts/scopeManager.ts.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

void test("obsidianRequestUrlFetch.ts is backed by Obsidian's requestUrl, never the global fetch", () => {
  const source = readSource("src/obsidianRequestUrlFetch.ts");
  assert.match(source, /import\s*\{\s*requestUrl\s*\}\s*from\s*"obsidian"/);
  assert.match(source, /requestUrl\(\{/);
  assert.doesNotMatch(source, /\bfetch\(/);
});

void test("obsidianRequestUrlFetch.ts preserves abort/timeout behavior by racing the request against the caller's AbortSignal", () => {
  const source = readSource("src/obsidianRequestUrlFetch.ts");
  assert.match(source, /signal\.addEventListener\("abort"/);
  assert.match(source, /AbortError/);
  assert.match(source, /Promise\.race/);
});

void test("source audit: exaResearchProvider.ts and localResearchModel.ts never reference the bare global fetch", () => {
  for (const file of ["src/exaResearchProvider.ts", "src/localResearchModel.ts"]) {
    const source = readSource(file);
    assert.doesNotMatch(source, /=\s*fetch\b/, `${file} must not default to the bare global fetch`);
    assert.doesNotMatch(source, /(?<!fetchImpl\()\bfetch\(/, `${file} must never call the bare global fetch directly`);
    assert.doesNotMatch(source, /from\s*"obsidian"/, `${file} should stay obsidian-import-free so its existing tests can inject fakes without a runtime obsidian module`);
  }
});

void test("source audit: main.ts wires requestUrlFetch into both ExaResearchProvider and createConfiguredLocalResearchModel production call sites", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /import\s*\{\s*requestUrlFetch\s*\}\s*from\s*"\.\/obsidianRequestUrlFetch"/);

  const exaCalls = mainSource.match(/new ExaResearchProvider\([^)]*\)/g) ?? [];
  assert.ok(exaCalls.length > 0, "expected at least one ExaResearchProvider construction site");
  for (const call of exaCalls) {
    assert.match(call, /requestUrlFetch/, `expected ${call} to pass requestUrlFetch explicitly`);
  }

  assert.match(mainSource, /createConfiguredLocalResearchModel\(\{[\s\S]*?\}, requestUrlFetch\)/);
});
