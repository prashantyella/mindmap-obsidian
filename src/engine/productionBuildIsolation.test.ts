import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Checkpoint 9 requirement 9: "Build production and audit dist/main.js: no
 * shadow command strings/parity tooling/dev Python invocation reachable
 * when production flag false." This test reads whatever `dist/main.js`
 * already exists (it does not run a build itself -- that belongs to the
 * `npm run check`/`build` gate, not a unit test) and, if present, asserts
 * the development-only shadow command's identifying strings are absent.
 * If `dist/main.js` has never been built in this checkout, the test is a
 * no-op rather than a false failure -- mirrors
 * `parityToolIsolation.test.ts`'s own "when built" pattern.
 *
 * This is a NECESSARY, not sufficient, check on its own: it only proves
 * something about whatever build currently sits in `dist/`. The real gate
 * is running `node esbuild.config.mjs production` immediately before this
 * suite, which the checkpoint's own gate step does.
 */
const DIST_MAIN = path.join(REPO_ROOT, "dist", "main.js");

const FORBIDDEN_IN_PRODUCTION: { label: string; pattern: RegExp }[] = [
  { label: "dev shadow command id", pattern: /mindmap-dev-run-shadow-diagnostics/ },
  { label: "dev shadow command name", pattern: /Development: Run TypeScript shadow diagnostics/ },
  { label: "tools/parity reference", pattern: /tools\/parity/ },
  { label: "Python parity comparison invocation", pattern: /generate_fixtures\.py|generate_apple_books_fixtures\.py|compare\.mts/ },
];

void test("dist/main.js, when a production build exists, contains no development-only shadow command strings or parity tooling references", () => {
  if (!fs.existsSync(DIST_MAIN)) {
    return;
  }
  const built = fs.readFileSync(DIST_MAIN, "utf8");
  for (const { label, pattern } of FORBIDDEN_IN_PRODUCTION) {
    assert.doesNotMatch(built, pattern, `dist/main.js matched forbidden production pattern for "${label}" -- rebuild with "node esbuild.config.mjs production" before running this check`);
  }
});

void test("esbuild.config.mjs defines __MINDMAP_DEV_BUILD__ as false only for a production build, and enables minifySyntax only then (required for the dev branch to actually be dead-code-eliminated)", () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, "esbuild.config.mjs"), "utf8");
  assert.match(config, /__MINDMAP_DEV_BUILD__:\s*production\s*\?\s*"false"\s*:\s*"true"/);
  assert.match(config, /minifySyntax:\s*production/);
});

void test("main.ts gates the dev shadow command's addCommand call and the integration's dispose call behind __MINDMAP_DEV_BUILD__", () => {
  const mainTs = fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf8");
  assert.match(mainTs, /if \(__MINDMAP_DEV_BUILD__\) \{\s*\n\s*this\.addCommand\(\{\s*\n\s*id: "mindmap-dev-run-shadow-diagnostics"/);
  assert.match(mainTs, /if \(__MINDMAP_DEV_BUILD__\) \{\s*\n\s*this\.diagOverlay\?\.dispose\(\);/);
});

void test("main.ts never directly imports the real engine/shadow modules -- only the virtual:mindmap-dev-shadow specifier", () => {
  const mainTs = fs.readFileSync(path.join(REPO_ROOT, "src", "main.ts"), "utf8");
  for (const forbidden of ['from "./engine/mindmapEngine"', 'from "./engine/nodeFs"', 'from "./engine/shadowEngine"', 'from "./engine/vaultCatalogReader"']) {
    assert.doesNotMatch(mainTs, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(mainTs, /from "virtual:mindmap-dev-shadow"/);
});

void test("the production dev-shadow stub imports none of the real engine/shadow modules", () => {
  const stub = fs.readFileSync(path.join(REPO_ROOT, "src", "engine", "devShadowStub.ts"), "utf8");
  for (const forbidden of ["mindmapEngine", "shadowEngine", "nodeFs", "vaultCatalogReader"]) {
    assert.doesNotMatch(stub, new RegExp(`from ["'][^"']*${forbidden}["']`));
  }
});

void test("esbuild.config.mjs wires the dev-shadow virtual-module plugin, switched by the same production flag as __MINDMAP_DEV_BUILD__", () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, "esbuild.config.mjs"), "utf8");
  assert.match(config, /devShadowPlugin\(process\.cwd\(\),\s*!production\)/);
});

void test("dist/main.js, when a production build exists, contains no engine/shadow module source (function/class names unique to those files)", () => {
  if (!fs.existsSync(DIST_MAIN)) {
    return;
  }
  const built = fs.readFileSync(DIST_MAIN, "utf8");
  for (const identifier of [
    "runShadowComparison", "createVaultCatalogShadowSource", "class MindmapEngine", "class NodeOwnedFs", "parseShadowBaselineV1", "planCatalogSample",
    "class IndexStore", "class AppleBooksSqliteReader", "createNodeAppleBooksFsAdapter", "createNodeSqliteProcess", "verifyCurrentGenerationFully",
    "generate_shadow_baseline",
  ]) {
    assert.doesNotMatch(built, new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `dist/main.js contains "${identifier}" -- the dev-shadow virtual module resolved to the real implementation instead of the production stub`);
  }
});

void test("dist/main.js, when a production build exists, contains no virtual-module marker, dev-integration accessor identifier, or dev-only doc-comment prose", () => {
  if (!fs.existsSync(DIST_MAIN)) {
    return;
  }
  const built = fs.readFileSync(DIST_MAIN, "utf8");
  for (const identifier of ["virtual:mindmap-dev-shadow", "createDevShadowIntegration", "DevShadowIntegration", "getOrCreateDevShadowIntegration", "devShadowIntegration.ts", "devShadowStub.ts"]) {
    assert.doesNotMatch(built, new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `dist/main.js contains "${identifier}" -- a doc comment or accessor identifier leaked through; production minification (minifyWhitespace/minifyIdentifiers/legalComments) may not be enabled`);
  }
});

void test("esbuild.config.mjs enables comment-stripping and identifier minification for production builds only (required to remove dev-only doc-comment prose from dist/main.js)", () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, "esbuild.config.mjs"), "utf8");
  assert.match(config, /minifyIdentifiers:\s*production/);
  assert.match(config, /minifyWhitespace:\s*production/);
  assert.match(config, /legalComments:\s*production\s*\?\s*"none"/);
});
