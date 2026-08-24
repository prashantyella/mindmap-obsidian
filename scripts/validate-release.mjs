import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const requiredFiles = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "dist/main.js",
  "dist/manifest.json",
  "dist/styles.css",
  "versions.json",
  ".github/workflows/release.yml",
  ".github/workflows/ci.yml",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// Checkpoint 11: no tracked Python source, cache artifact, or Python-only
// runtime directory anywhere in the repository.
// ---------------------------------------------------------------------------

const trackedFiles = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);

const trackedCacheArtifacts = trackedFiles.filter((file) => /(^|\/)__pycache__\/|\.pyc$/.test(file));
if (trackedCacheArtifacts.length > 0) {
  throw new Error(`Tracked Python cache artifacts must not be committed: ${trackedCacheArtifacts.join(", ")}`);
}

const trackedPythonFiles = trackedFiles.filter((file) => file.endsWith(".py"));
if (trackedPythonFiles.length > 0) {
  throw new Error(`No tracked Python source files are permitted in the shipping repository: ${trackedPythonFiles.join(", ")}`);
}

const forbiddenTrackedPaths = trackedFiles.filter((file) => file === "python" || file.startsWith("python/") || file === "tools/parity" || file.startsWith("tools/parity/"));
if (forbiddenTrackedPaths.length > 0) {
  throw new Error(`The Python runtime directory and the dev-shadow parity tooling must not be tracked: ${forbiddenTrackedPaths.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Source scan: no shipped src/ file may reference Python/pip/venv/runtime-
// installer/Chroma tooling, or invoke python3/mindmap.py/mindmap_worker/
// apple_books_reader as a real process. Fixed-argv system integrations this
// plugin DOES ship (sqlite3, security, launchctl, open) are the only
// approved child-process targets, and only ever with shell:false.
// ---------------------------------------------------------------------------

// Filename-shaped patterns require a single/double-quoted literal (a real path/string
// construction a caller could actually reach at runtime) -- backticks are deliberately excluded
// since this codebase uses them as markdown code-span delimiters inside doc comments (e.g.
// "mirrors `python/mindmap.py`'s `select_mindmap_links` behaviorally"), which document parity
// with the retired oracle and are explicitly out of scope for this scan; a bare, unquoted mention
// is prose for the same reason.
const FORBIDDEN_SOURCE_PATTERNS = [
  { label: "python3 interpreter invocation", pattern: /["']python3["']/ },
  { label: "mindmap.py script path construction", pattern: /["'][^"'\n]*mindmap\.py["']/ },
  { label: "mindmap_worker script path construction", pattern: /["'][^"'\n]*mindmap_worker[^"'\n]*["']/ },
  { label: "apple_books_reader.py script path construction", pattern: /["'][^"'\n]*apple_books_reader\.py["']/ },
  { label: "pip install reference", pattern: /\bpip install\b/ },
  { label: "venv/virtualenv reference", pattern: /\bvenv\b|virtualenv/ },
  { label: "requirements.txt reference", pattern: /requirements\.txt/ },
  { label: "chromadb reference", pattern: /chromadb/i },
  { label: "semantic worker client reference", pattern: /semanticWorkerClient|SemanticWorkerClient/ },
  { label: "localhost IPC worker port reference", pattern: /127\.0\.0\.1:\d{4,5}.*worker|worker.*127\.0\.0\.1:\d{4,5}/i },
];

const srcFiles = trackedFiles.filter((file) => file.startsWith("src/") && !file.endsWith(".test.ts") && !file.endsWith(".test-support.ts"));
const sourceFailures = [];
for (const file of srcFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const { label, pattern } of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(content)) {
      sourceFailures.push(`${file}: ${label}`);
    }
  }
}
if (sourceFailures.length > 0) {
  throw new Error(`Forbidden Python/Chroma/semantic-worker reference(s) in shipping source:\n${sourceFailures.join("\n")}`);
}

// Approved fixed-argv system integrations only -- every real child-process invocation in shipping
// source must be one of these four, and every one must be shell:false and disclosed.
const APPROVED_SYSTEM_BINARIES = ["/usr/bin/sqlite3", "/usr/bin/security", "/bin/launchctl", "/usr/bin/open"];
const execFileCallPattern = /execFile\(\s*(["'`])((?:(?!\1).)*)\1/g;
const spawnCallPattern = /spawn\(\s*(["'`])((?:(?!\1).)*)\1/g;
const unsupportedProcessCalls = [];
for (const file of srcFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of [execFileCallPattern, spawnCallPattern]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const target = match[2];
      // A relative/variable executable path (e.g. a helper binding, or "sqlite3Path") is not a
      // literal binary invocation this scan can evaluate -- only a literal absolute path is
      // checked against the approved allow-list.
      if (!target.startsWith("/")) continue;
      if (!APPROVED_SYSTEM_BINARIES.includes(target)) {
        unsupportedProcessCalls.push(`${file}: unsupported process target "${target}"`);
      }
    }
  }
}
if (unsupportedProcessCalls.length > 0) {
  throw new Error(`Unsupported process invocation(s) in shipping source (only ${APPROVED_SYSTEM_BINARIES.join(", ")} are approved):\n${unsupportedProcessCalls.join("\n")}`);
}

const shellTrueUsages = [];
for (const file of srcFiles) {
  const content = fs.readFileSync(file, "utf8");
  // Line-scoped, and skips comment lines (leading `//` or `*`) -- this codebase documents the
  // shell:false requirement in doc comments using backtick-quoted code spans like
  // "never ... with `shell: true`", which must not be mistaken for the real object property.
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (/shell:\s*true/.test(line)) {
      shellTrueUsages.push(file);
      break;
    }
  }
}
if (shellTrueUsages.length > 0) {
  throw new Error(`shell:true is never permitted in shipping source: ${shellTrueUsages.join(", ")}`);
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const mappedVersion = versions[manifest.version];

if (!mappedVersion) {
  throw new Error(`versions.json is missing version ${manifest.version}`);
}

if (mappedVersion !== manifest.minAppVersion) {
  throw new Error(
    `versions.json mismatch for ${manifest.version}: expected ${manifest.minAppVersion}, got ${mappedVersion}`,
  );
}

if (packageJson.version !== manifest.version) {
  throw new Error(
    `package.json version ${packageJson.version} must match manifest.json version ${manifest.version}`,
  );
}

if (packageJson.license !== "MIT") {
  throw new Error(`package.json license must be MIT, got ${packageJson.license ?? "missing"}`);
}

for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
  if (!manifest[field]) {
    throw new Error(`manifest.json is missing required field: ${field}`);
  }
}

if (manifest.isDesktopOnly !== true) {
  throw new Error("manifest.json must keep isDesktopOnly set to true");
}

const distManifest = JSON.parse(fs.readFileSync(path.join("dist", "manifest.json"), "utf8"));
if (distManifest.version !== manifest.version) {
  throw new Error("dist/manifest.json is not in sync with manifest.json");
}

const readme = fs.readFileSync("README.md", "utf8");
for (const phrase of ["desktop-only", "TypeScript", "Ollama", "Apple Books", "/usr/bin/sqlite3", "LaunchAgent", "migration", "Troubleshooting", "Privacy", "versions.json", "manifest.json"]) {
  if (!readme.includes(phrase)) {
    throw new Error(`README.md must mention ${phrase}`);
  }
}
for (const phrase of ["Python", "pip install", "virtual environment", "PyPI", "interpreter"]) {
  if (readme.includes(phrase)) {
    throw new Error(`README.md must not describe a Python onboarding step ("${phrase}" found) -- the plugin ships no Python.`);
  }
}
{
  const installIndex = readme.indexOf("## Install");
  const firstRunIndex = readme.indexOf("## First Run");
  if (installIndex === -1) {
    throw new Error("README.md must include an ## Install heading.");
  }
  if (firstRunIndex === -1) {
    throw new Error("README.md must include a ## First Run heading.");
  }
  if (firstRunIndex <= installIndex) {
    throw new Error("README.md must present ## Install before ## First Run.");
  }
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes("## Unreleased")) {
  throw new Error("CHANGELOG.md must include an Unreleased section");
}
{
  const versionHeadingPattern = new RegExp(`^## ${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m");
  if (!versionHeadingPattern.test(changelog)) {
    throw new Error(`CHANGELOG.md must include a section for ${manifest.version}.`);
  }
}

const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const RELEASE_ASSETS = ["release/main.js", "release/manifest.json", "release/styles.css"];

if (!/persist-credentials:\s*false/.test(workflow)) {
  throw new Error("Release workflow checkout must keep persist-credentials: false.");
}

if (!/id-token:\s*write/.test(workflow) || !/attestations:\s*write/.test(workflow)) {
  throw new Error("Release workflow must grant id-token: write and attestations: write permissions for build attestation.");
}

if (/setup-python|requirements\.txt|python -m/.test(workflow)) {
  throw new Error("Release workflow must never install or invoke Python.");
}

{
  const attestIndex = workflow.indexOf("actions/attest@v4");
  if (attestIndex === -1) {
    throw new Error("Release workflow must attest release assets with actions/attest@v4.");
  }
  const prepareIndex = workflow.indexOf("npm run release:prepare");
  const publishIndex = workflow.indexOf("softprops/action-gh-release");
  if (prepareIndex === -1 || attestIndex <= prepareIndex) {
    throw new Error("Release workflow must attest assets after preparing them (npm run release:prepare).");
  }
  if (publishIndex === -1 || attestIndex >= publishIndex) {
    throw new Error("Release workflow must attest assets before publishing the GitHub release.");
  }
  const attestStepEnd = workflow.indexOf("\n\n", attestIndex);
  const attestStep = workflow.slice(attestIndex, attestStepEnd === -1 ? publishIndex : attestStepEnd);
  for (const asset of RELEASE_ASSETS) {
    if (!attestStep.includes(asset)) {
      throw new Error(`Release workflow's attest step must cover ${asset} as a subject-path.`);
    }
  }
}

{
  const publishIndex = workflow.indexOf("softprops/action-gh-release");
  if (publishIndex === -1) {
    throw new Error("Release workflow must publish the GitHub release via softprops/action-gh-release.");
  }
  const publishStep = workflow.slice(publishIndex);
  const filesMatch = /files:\s*\|\s*\n((?:[ \t]+\S.*\n?)+)/.exec(publishStep);
  if (!filesMatch) {
    throw new Error("Release workflow's publish step must set files: | to a literal block list of asset paths.");
  }
  const publishedAssets = filesMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const publishedAssetSet = new Set(publishedAssets);
  const expectedAssetSet = new Set(RELEASE_ASSETS);
  const missing = RELEASE_ASSETS.filter((asset) => !publishedAssetSet.has(asset));
  const unexpected = publishedAssets.filter((asset) => !expectedAssetSet.has(asset));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Release workflow must publish exactly ${JSON.stringify(RELEASE_ASSETS)}` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""),
    );
  }
  if (!/generate_release_notes:\s*true/.test(publishStep) && !publishStep.includes("body_path")) {
    throw new Error("Release workflow must make the release non-empty via generate_release_notes: true (preferred) or an explicit body_path.");
  }
}

if (!workflow.includes("npm run lint:obsidian")) {
  throw new Error("Release workflow must run the official Obsidian plugin guidelines lint gate (npm run lint:obsidian).");
}

const ciWorkflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
if (!/on:[\s\S]*pull_request/.test(ciWorkflow)) {
  throw new Error("CI workflow must trigger on pull_request.");
}
for (const step of ["npm ci", "npm run lint", "npm run lint:obsidian", "npm run typecheck", "npm test", "npm run build", "npm run validate"]) {
  if (!ciWorkflow.includes(step)) {
    throw new Error(`CI workflow must run: ${step}`);
  }
}
if (/setup-python|requirements\.txt|python -m/.test(ciWorkflow)) {
  throw new Error("CI workflow must never install or invoke Python.");
}

if (!manifest.authorUrl || manifest.authorUrl.trim().length === 0) {
  throw new Error("manifest.json must set a non-empty authorUrl.");
}

{
  const readmeTitleMatch = readme.match(/^#\s+(.+)$/m);
  if (!readmeTitleMatch) {
    throw new Error("README.md must start with an H1 title.");
  }
  if (readmeTitleMatch[1].trim() !== manifest.name) {
    throw new Error(`README.md H1 (${readmeTitleMatch[1].trim()}) must exactly match manifest.json name (${manifest.name}).`);
  }
}

// ---------------------------------------------------------------------------
// Production bundle audit: dist/main.js must contain no Python/Chroma/
// semantic-worker/runtime-installer content, and no leftover dev-shadow
// surface (that subsystem is deleted entirely as of Checkpoint 11, so these
// identifiers can now never legitimately appear at all).
// ---------------------------------------------------------------------------
{
  const distMainPath = path.join("dist", "main.js");
  if (!fs.existsSync(distMainPath)) {
    throw new Error(`${distMainPath} does not exist -- run "npm run build" before "npm run validate".`);
  }
  const distMain = fs.readFileSync(distMainPath, "utf8");
  const FORBIDDEN_IN_PRODUCTION_DIST = [
    { label: "python3 interpreter reference", pattern: /\bpython3\b/ },
    { label: "mindmap.py script reference", pattern: /mindmap\.py\b/ },
    { label: "mindmap_worker reference", pattern: /mindmap_worker/ },
    { label: "apple_books_reader.py reference", pattern: /apple_books_reader\.py/ },
    { label: "chromadb reference", pattern: /chromadb/i },
    { label: "pip install reference", pattern: /pip install/ },
    { label: "requirements.txt reference", pattern: /requirements\.txt/ },
    { label: "semantic worker client reference", pattern: /semanticWorkerClient|SemanticWorkerClient/ },
    { label: "dev shadow command id", pattern: /mindmap-dev-run-shadow-diagnostics/ },
    { label: "dev shadow command name", pattern: /Development: Run TypeScript shadow diagnostics/ },
    { label: "runDevelopmentShadowDiagnostics identifier", pattern: /runDevelopmentShadowDiagnostics/ },
    { label: "getOrCreateMindmapEngine identifier", pattern: /getOrCreateMindmapEngine/ },
    { label: "shadowEngine.ts source path reference", pattern: /src\/engine\/shadowEngine\.ts/ },
    { label: "tools/parity reference", pattern: /tools\/parity/ },
    { label: "runShadowComparison function name", pattern: /runShadowComparison/ },
    { label: "createVaultCatalogShadowSource function name", pattern: /createVaultCatalogShadowSource/ },
    { label: "class MindmapEngine (retired dev-shadow composer)", pattern: /class MindmapEngine\b/ },
    { label: "virtual:mindmap-dev-shadow module marker", pattern: /virtual:mindmap-dev-shadow/ },
    { label: "createDevShadowIntegration factory name", pattern: /createDevShadowIntegration/ },
    { label: "DevShadowIntegration type/identifier name", pattern: /DevShadowIntegration/ },
    { label: "devShadowIntegration.ts source path reference", pattern: /devShadowIntegration\.ts/ },
    { label: "devShadowStub.ts source path reference", pattern: /devShadowStub\.ts/ },
    { label: "generate_shadow_baseline.py generator script reference", pattern: /generate_shadow_baseline/ },
  ];
  const distFailures = FORBIDDEN_IN_PRODUCTION_DIST.filter(({ pattern }) => pattern.test(distMain));
  if (distFailures.length > 0) {
    throw new Error(
      `dist/main.js contains forbidden content: ${distFailures.map((entry) => entry.label).join(", ")}.`,
    );
  }
}

console.log("Release validation passed.");
