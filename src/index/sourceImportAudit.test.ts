import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Source audit: no file under `src/index/` may import Obsidian's runtime
 * API, the plugin's `main.ts` entry point, an embedding/metadata
 * provider, or the legacy Chroma/Python engine. Checkpoint 5 builds a
 * pure, filesystem-seam-injected persistence layer -- it must never be
 * reachable through, or reach into, plugin wiring, and the legacy Chroma
 * store must stay completely outside every new index module's import
 * graph. This is a static text scan of every import/require specifier in
 * every `src/index/*.ts` file, not a runtime check.
 */

const SRC_INDEX_DIR = __dirname;
const FORBIDDEN_SPECIFIER_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "the Obsidian plugin API", pattern: /^obsidian$/ },
  { label: "the plugin's main.ts entry point", pattern: /\bmain(\.ts)?$/ },
  { label: "an embedding/metadata provider module", pattern: /provider/i },
  { label: "the legacy Chroma/Python engine", pattern: /chroma|python/i },
];

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g;
  const requireRe = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [importRe, requireRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

void test("no src/index/*.ts file imports Obsidian, main.ts, a provider module, or Chroma/Python", () => {
  const files = fs.readdirSync(SRC_INDEX_DIR).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0, "expected to find .ts files in src/index");

  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(SRC_INDEX_DIR, file), "utf8");
    for (const specifier of importSpecifiers(source)) {
      for (const { label, pattern } of FORBIDDEN_SPECIFIER_PATTERNS) {
        if (pattern.test(specifier)) {
          offenders.push(`${file} imports "${specifier}" (matches forbidden: ${label})`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `found forbidden import(s):\n${offenders.join("\n")}`);
});
