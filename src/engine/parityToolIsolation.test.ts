import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(REPO_ROOT, "src");

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Development-only parity tooling under tools/parity/ must never be
 * reachable from production source. Two independent checks: no source file
 * under src/ has an actual import/require statement naming tools/parity
 * (a fixture's provenance metadata, or this file's own doc comments, may
 * legitimately mention the path as text without importing it), and
 * esbuild's only entry point (src/main.ts, per esbuild.config.mjs) is not
 * tools/parity itself and does not transitively require it.
 */
const IMPORT_OR_REQUIRE_OF_PARITY_PATTERN =
  /(?:\bfrom\s+|\brequire\s*\(|\bimport\s*\(|\bimport\s+)\s*["'][^"']*tools\/parity[^"']*["']/;

void test("no file under src/ has an import/require statement naming tools/parity", () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(SRC_DIR)) {
    const content = fs.readFileSync(file, "utf8");
    if (IMPORT_OR_REQUIRE_OF_PARITY_PATTERN.test(content)) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `Found src/ imports of tools/parity in: ${offenders.join(", ")}`);
});

void test("esbuild's declared entry point is src/main.ts, not tools/parity", () => {
  const esbuildConfig = fs.readFileSync(path.join(REPO_ROOT, "esbuild.config.mjs"), "utf8");
  assert.match(esbuildConfig, /entryPoints:\s*\["src\/main\.ts"\]/);
  assert.doesNotMatch(esbuildConfig, /tools\/parity/);
});

void test("tools/parity is outside tsconfig.json's compiled include set", () => {
  const tsconfig = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8")) as { include?: string[] };
  const include = tsconfig.include ?? [];
  assert.ok(!include.some((pattern) => pattern.startsWith("tools/")), "tsconfig.json must not compile tools/parity as part of the plugin build");
});

void test("dist/main.js, when built, contains no reference to tools/parity", () => {
  const distMain = path.join(REPO_ROOT, "dist", "main.js");
  if (!fs.existsSync(distMain)) {
    return;
  }
  const built = fs.readFileSync(distMain, "utf8");
  assert.doesNotMatch(built, /tools\/parity/);
});
