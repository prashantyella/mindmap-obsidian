import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Checkpoint 10A item 7: "Add isolation audits proving migration/
 * composition has no Python imports/process calls and production
 * adapters do not use Node fs for vault notes." Static source-text
 * checks only -- no build step, no execution.
 */
const NEW_10A_FILES = [
  "src/engine/productionEngine.ts",
  "src/engine/productionVaultAdapter.ts",
  "src/engine/productionProviderSeams.ts",
  "src/migration/migrationContract.ts",
  "src/migration/migrationStore.ts",
  "src/migration/migrationRunner.ts",
];

function read(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

void test("Checkpoint 10A production/migration composition files import no Python source and spawn no subprocess", () => {
  for (const relPath of NEW_10A_FILES) {
    const source = read(relPath);
    assert.doesNotMatch(source, /\.py['"]/, `${relPath} references a .py file`);
    assert.doesNotMatch(source, /["'][^"'\n]*\.py\b[^"'\n]*["']|["'][^"'\n]*\bpython3?['"]/i, `${relPath} contains a literal python-interpreter/script string`);
    assert.doesNotMatch(source, /node:child_process|\bspawn\(|\bexecFile\(/, `${relPath} spawns a subprocess -- only reading/writing/vault APIs are allowed here`);
    assert.doesNotMatch(source, /:\/\/(?:localhost|127\.0\.0\.1)/, `${relPath} contains a literal localhost IPC endpoint URL`);
  }
});

void test("productionVaultAdapter.ts never imports Node's raw fs/fs.promises -- every vault-note effect goes through the injected Obsidian Vault", () => {
  const source = read("src/engine/productionVaultAdapter.ts");
  assert.doesNotMatch(source, /from ["']node:fs["']/);
  assert.doesNotMatch(source, /from ["']fs["']/);
  assert.doesNotMatch(source, /require\(["']fs["']\)/);
});

void test("productionVaultAdapter.ts never calls vault.adapter.write for a note mutation -- vault.modify/vault.create are the only note-mutation paths (item 5)", () => {
  const source = read("src/engine/productionVaultAdapter.ts");
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /vault\.adapter\.write/, "note mutations must go through vault.modify/vault.create so Obsidian's cache/events fire, never a raw adapter.write");
});

void test("productionProviderSeams.ts never imports Node's raw fs/fs.promises or child_process", () => {
  const source = read("src/engine/productionProviderSeams.ts");
  assert.doesNotMatch(source, /from ["']node:fs["']/);
  assert.doesNotMatch(source, /from ["']node:child_process["']/);
});

void test("migration/*.ts never imports NodeOwnedFs or node:fs directly -- every store persists ONLY through the injected AtomicStoreFs/IndexFs seam", () => {
  for (const relPath of ["src/migration/migrationContract.ts", "src/migration/migrationStore.ts", "src/migration/migrationRunner.ts"]) {
    const source = read(relPath);
    assert.doesNotMatch(source, /from ["'][^"']*nodeFs["']/, `${relPath} imports NodeOwnedFs directly`);
    assert.doesNotMatch(source, /from ["']node:fs["']/, `${relPath} imports node:fs directly`);
  }
});

void test("migration/*.ts never contains a literal chroma path/string -- only prose explaining it is deliberately never touched", () => {
  for (const relPath of ["src/migration/migrationContract.ts", "src/migration/migrationStore.ts", "src/migration/migrationRunner.ts"]) {
    const source = read(relPath);
    assert.doesNotMatch(source, /[/\\]chroma|chroma[/\\.]/i, `${relPath} contains a literal chroma path fragment -- migration must never reference an actual Chroma path, only explain in prose that it is deliberately untouched`);
  }
});

void test("productionEngine.ts never registers a \"migrate-index\" job runner -- migration is self-contained inside MigrationRunner (item 3), never a parallel JobEngine-dispatched reimplementation", () => {
  const source = read("src/engine/productionEngine.ts");
  assert.doesNotMatch(source, /runners\["migrate-index"\]/);
});

void test("productionEngine.ts registers the SAME ScopeJobRunner instance for BOTH reading-sync and scope-refresh (item 3: one runner, two job kinds, never two separate instances)", () => {
  const source = read("src/engine/productionEngine.ts");
  assert.match(source, /runners\["scope-refresh"\]\s*=\s*scopeRunner/);
  assert.match(source, /runners\["reading-sync"\]\s*=\s*scopeRunner/);
});

void test("migrationIngest.ts's MigrationIngestionDeps never carries a NoteWriter/metadata/research/Apple-import field -- migration ingestion is structurally confined to sourceReader+embedding alone (item 9)", () => {
  const source = read("src/migration/migrationIngest.ts");
  const depsMatch = source.match(/export interface MigrationIngestionDeps \{[\s\S]*?\n\}/);
  assert.ok(depsMatch, "MigrationIngestionDeps interface must exist");
  // Strip block/line comments first -- this interface's OWN doc comment explains (in prose) what
  // it deliberately does NOT depend on, which would otherwise make this check self-defeating.
  const body = depsMatch![0].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /noteWriter|NoteWriter/, "migration ingestion must never depend on NoteWriter");
  assert.doesNotMatch(body, /metadata|Metadata/, "migration ingestion must never depend on a metadata seam");
  assert.doesNotMatch(body, /research|Research/i, "migration ingestion must never depend on the research provider");
  assert.doesNotMatch(body, /apple|Apple/i, "migration ingestion must never depend on Apple Books import");
});

void test("migrationRunner.ts never imports NoteWriter, a metadata provider/pipeline, the research provider, or Apple Books import (item 9)", () => {
  const source = read("src/migration/migrationRunner.ts");
  assert.doesNotMatch(source, /from ["'][^"']*noteWriter["']/);
  assert.doesNotMatch(source, /from ["'][^"']*metadataPipeline["']/);
  assert.doesNotMatch(source, /from ["'][^"']*webResearch["']/i);
  assert.doesNotMatch(source, /from ["'][^"']*appleBooks(Import|Sqlite)["']/i);
});

void test("main.ts does not import or construct ProductionEngine -- no user-reachable cutover in Checkpoint 10A", () => {
  const mainTs = read("src/main.ts");
  assert.doesNotMatch(mainTs, /productionEngine/i);
  assert.doesNotMatch(mainTs, /ProductionEngine/);
});

void test("dist/main.js, when a production build exists, contains no Checkpoint 10A production/migration identifiers (nothing is wired to main.ts yet, but this stays a belt-and-suspenders check)", () => {
  const distMain = path.join(REPO_ROOT, "dist", "main.js");
  if (!fs.existsSync(distMain)) return;
  const built = fs.readFileSync(distMain, "utf8");
  for (const identifier of ["class ProductionEngine", "class MigrationRunner", "class MigrationStore", "createProductionNoteVaultAdapter", "createProductionScopeDiscoverySeam"]) {
    assert.doesNotMatch(built, new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `dist/main.js contains "${identifier}" -- Checkpoint 10A composition must not be reachable from the production bundle yet`);
  }
});
