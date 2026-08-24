import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readSource(relativePath));
}

const manifest = readJson("manifest.json") as { name: string; version: string; minAppVersion: string; authorUrl: string };
const versions = readJson("versions.json") as Record<string, string>;
const packageJson = readJson("package.json") as { version: string; devDependencies: Record<string, string>; scripts: Record<string, string> };

// ---------------------------------------------------------------------------
// (1) minAppVersion / versions.json consistency for the ensureSideLeaf/
// revealLeaf API requirement (obsidianmd/no-unsupported-api).
// ---------------------------------------------------------------------------

void test("manifest.json minAppVersion is exactly 1.7.2, matching the ensureSideLeaf/revealLeaf @since requirement", () => {
  assert.equal(manifest.minAppVersion, "1.7.2");
});

void test("versions.json maps the current manifest version to the current minAppVersion, and never rewrites an already-published version's entry", () => {
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  // 0.2.0 was already tagged/released with minAppVersion 1.5.12; that
  // historical record must never be rewritten to match a later working
  // tree's minAppVersion bump.
  assert.equal(versions["0.2.0"], "1.5.12");
});

void test("package.json version matches manifest.json version", () => {
  assert.equal(packageJson.version, manifest.version);
});

void test("source audit: main.ts still calls ensureSideLeaf/revealLeaf directly -- the API was raised to, not replaced", () => {
  const mainSource = readSource("src/main.ts");
  assert.match(mainSource, /\.ensureSideLeaf\(/);
  assert.match(mainSource, /\.revealLeaf\(/);
});

// ---------------------------------------------------------------------------
// (2) Metadata: README title, manifest description/authorUrl.
// ---------------------------------------------------------------------------

void test("README.md H1 exactly matches manifest.json name", () => {
  const readme = readSource("README.md");
  const titleMatch = readme.match(/^#\s+(.+)$/m);
  assert.ok(titleMatch, "expected an H1 title in README.md");
  assert.equal(titleMatch![1].trim(), manifest.name);
});

void test("manifest.json authorUrl is present and a plausible profile/repository URL", () => {
  assert.ok(manifest.authorUrl && manifest.authorUrl.trim().length > 0, "authorUrl must not be empty");
  assert.match(manifest.authorUrl, /^https:\/\/github\.com\//);
});

void test("manifest.json description is concise, user-facing product copy, not internal implementation language", () => {
  const description = readJson("manifest.json").description as string;
  assert.ok(description.length > 0 && description.length <= 200, "description should be a single concise sentence");
  assert.doesNotMatch(description, /orchestrat|engine\b/i);
});

// ---------------------------------------------------------------------------
// (3)/(4) Release workflow: allowed assets, attestation, non-empty notes.
// ---------------------------------------------------------------------------

const releaseWorkflow = readSource(".github/workflows/release.yml");
const ciWorkflow = readSource(".github/workflows/ci.yml");

void test("release workflow publishes only main.js, manifest.json, and styles.css -- never mindmap-python.zip", () => {
  const publishIndex = releaseWorkflow.indexOf("softprops/action-gh-release");
  assert.ok(publishIndex >= 0, "expected a softprops/action-gh-release publish step");
  const publishStep = releaseWorkflow.slice(publishIndex);
  for (const asset of ["release/main.js", "release/manifest.json", "release/styles.css"]) {
    assert.ok(publishStep.includes(asset), `expected ${asset} in the publish step`);
  }
  assert.doesNotMatch(publishStep, /release\/mindmap-python\.zip/);
});

void test("Checkpoint 11: prepare-release.mjs no longer packages a Python zip -- the release ships exactly three files", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "scripts/prepare-release.mjs")), "prepare-release.mjs must still exist");
  const prepareScript = readSource("scripts/prepare-release.mjs");
  assert.doesNotMatch(prepareScript, /mindmap-python\.zip/);
  assert.doesNotMatch(prepareScript, /\bpython\b/i);
});

void test("release workflow makes the release non-empty via generate_release_notes (preferred) or an explicit body_path", () => {
  const publishIndex = releaseWorkflow.indexOf("softprops/action-gh-release");
  const publishStep = releaseWorkflow.slice(publishIndex);
  const hasGeneratedNotes = /generate_release_notes:\s*true/.test(publishStep);
  const hasBodyPath = publishStep.includes("body_path");
  assert.ok(hasGeneratedNotes || hasBodyPath, "expected generate_release_notes: true or a body_path");
  assert.ok(hasGeneratedNotes, "generate_release_notes: true is preferred absent a workflow constraint requiring body_path");
});

void test("release workflow grants id-token/attestations permissions and attests exactly the three published assets after prepare and before publish", () => {
  assert.match(releaseWorkflow, /id-token:\s*write/);
  assert.match(releaseWorkflow, /attestations:\s*write/);

  const prepareIndex = releaseWorkflow.indexOf("npm run release:prepare");
  const attestIndex = releaseWorkflow.indexOf("actions/attest@v4");
  const publishIndex = releaseWorkflow.indexOf("softprops/action-gh-release");
  assert.ok(prepareIndex >= 0 && attestIndex > prepareIndex, "attest step must come after release:prepare");
  assert.ok(publishIndex >= 0 && attestIndex < publishIndex, "attest step must come before publishing");

  const attestStep = releaseWorkflow.slice(attestIndex, publishIndex);
  for (const asset of ["release/main.js", "release/manifest.json", "release/styles.css"]) {
    assert.ok(attestStep.includes(asset), `expected the attest step's subject-path to include ${asset}`);
  }
  assert.doesNotMatch(attestStep, /release\/mindmap-python\.zip/, "the zip is not a published asset and should not be attested as one");
});

void test("release workflow checkout preserves persist-credentials: false", () => {
  assert.match(releaseWorkflow, /persist-credentials:\s*false/);
});

// ---------------------------------------------------------------------------
// (5) Official Obsidian ESLint plugin: pinned dependency, separate gate, CI wiring.
// ---------------------------------------------------------------------------

void test("eslint-plugin-obsidianmd is pinned (not a caret/range) as a dev dependency", () => {
  const spec = packageJson.devDependencies["eslint-plugin-obsidianmd"];
  assert.ok(spec, "expected eslint-plugin-obsidianmd in devDependencies");
  assert.match(spec, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "the version spec must be an exact version, not a range");
});

void test("lint:obsidian is a separate npm script scoped to src, distinct from the main lint gate", () => {
  assert.ok(packageJson.scripts["lint:obsidian"], "expected a lint:obsidian script");
  assert.notEqual(packageJson.scripts["lint:obsidian"], packageJson.scripts.lint);
  assert.match(packageJson.scripts["lint:obsidian"], /\bsrc\b/);
});

void test("both CI and the release workflow run the official Obsidian lint gate", () => {
  assert.match(ciWorkflow, /npm run lint:obsidian/);
  assert.match(releaseWorkflow, /npm run lint:obsidian/);
});

// ---------------------------------------------------------------------------
// (6) CHANGELOG: the current release has its own version heading with real
// notes, and Unreleased still exists (empty, ready for the next change).
// ---------------------------------------------------------------------------

void test("CHANGELOG.md documents the current release under its own version heading, with an empty Unreleased section above it", () => {
  const changelog = readSource("CHANGELOG.md");
  assert.match(changelog, /^## Unreleased/m);

  const versionHeadingPattern = new RegExp(`^## ${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m");
  assert.match(changelog, versionHeadingPattern);

  const versionIndex = changelog.search(versionHeadingPattern);
  const nextHeadingIndex = changelog.indexOf("\n## ", versionIndex + 1);
  const versionBody = changelog.slice(versionIndex, nextHeadingIndex === -1 ? undefined : nextHeadingIndex);

  assert.match(versionBody, /minAppVersion/);
  assert.match(versionBody, /1\.7\.2/);
});

// ---------------------------------------------------------------------------
// (7) readingVault.ts must never reference "obsidian" as a dynamic
// import(): esbuild preserves a dynamic import() of an external bare
// specifier verbatim in the CommonJS bundle, and Obsidian's CommonJS
// plugin loader can't resolve that form for "obsidian". (The real TFile
// constructor is injected by main.ts instead -- see createObsidianVaultApi.)
// ---------------------------------------------------------------------------

void test("readingVault.ts never references \"obsidian\" as a dynamic import() that esbuild would preserve unresolved", () => {
  const source = readSource("src/readingVault.ts");
  assert.doesNotMatch(source, /\bawait\s+import\s*\(\s*["']obsidian["']\s*\)/);
});
