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
  "dist/python/mindmap.py",
  "dist/python/mindmap_worker.py",
  "dist/python/apple_books_reader.py",
  "dist/python/requirements.txt",
  "dist/python/config.template.json",
  "python/mindmap.py",
  "python/mindmap_worker.py",
  "python/apple_books_reader.py",
  "python/requirements.txt",
  "python/config.template.json",
  "versions.json",
  ".github/workflows/release.yml",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const trackedCacheArtifacts = execSync(
  "git ls-files",
  { encoding: "utf8" },
).split("\n").filter((file) => /(^|\/)__pycache__\/|\.pyc$/.test(file));

if (trackedCacheArtifacts.length > 0) {
  throw new Error(
    `Tracked Python cache artifacts must not be committed: ${trackedCacheArtifacts.join(", ")}`,
  );
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

const config = JSON.parse(fs.readFileSync("python/config.template.json", "utf8"));
const serialized = JSON.stringify(config);
if (serialized.includes("/Users/") || serialized.includes("\\Users\\")) {
  throw new Error("config.template.json contains a machine-specific path");
}
if (config.vault_root !== "../../../../") {
  throw new Error(`config.template.json vault_root must be "../../../../", got ${String(config.vault_root)}`);
}
if (config.llm_api_key !== "" || config.llm_api_key_env !== "") {
  throw new Error("config.template.json must not ship a baked-in llm_api_key or llm_api_key_env.");
}
if (config.remove_mindmap_section !== false) {
  throw new Error(`config.template.json remove_mindmap_section must be the literal boolean false, got ${JSON.stringify(config.remove_mindmap_section)}`);
}

const distManifest = JSON.parse(fs.readFileSync(path.join("dist", "manifest.json"), "utf8"));
if (distManifest.version !== manifest.version) {
  throw new Error("dist/manifest.json is not in sync with manifest.json");
}

const readme = fs.readFileSync("README.md", "utf8");
for (const phrase of ["desktop-only", "Python", "Ollama", "versions.json", "manifest.json"]) {
  if (!readme.includes(phrase)) {
    throw new Error(`README.md must mention ${phrase}`);
  }
}
for (const phrase of [
  "Community plugins",
  "automatically looks for a compatible Python",
  "Set up Mindmap runtime",
  "PyPI",
  "Application Support/Mindmap AI",
  "cancelled or retried",
  "3.11-3.13",
  "python.org/downloads/macos",
]) {
  if (!readme.includes(phrase)) {
    throw new Error(`README.md must mention ${phrase} for zero-terminal onboarding.`);
  }
}
if (readme.includes("manual release install")) {
  throw new Error("README.md must not present manual release install as the primary onboarding path.");
}
if (readme.includes("restore its Python runtime automatically")) {
  throw new Error("README.md must not claim the plugin silently restores a Python runtime; describe explicit discovery/one-click setup instead.");
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
  const installSection = readme.slice(installIndex, firstRunIndex);
  if (installSection.includes("pip install")) {
    throw new Error("README.md primary Install section must not present a manual pip install command; keep it under Troubleshooting/Advanced only.");
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
for (const requirementsPath of ["python/requirements.txt", "dist/python/requirements.txt"]) {
  const lines = fs.readFileSync(requirementsPath, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.includes("chromadb==1.4.0")) {
    throw new Error(`${requirementsPath} must pin chromadb==1.4.0 for the embedded client.`);
  }
  if (!lines.includes("ruamel.yaml==0.19.1")) {
    throw new Error(`${requirementsPath} must pin the tested ruamel.yaml==0.19.1 release.`);
  }
  const looseLines = lines.filter((line) => /(>=|<=|~=|!=|>|<)/.test(line));
  if (looseLines.length > 0) {
    throw new Error(`${requirementsPath} must pin every direct managed-runtime dependency to an exact version; found non-exact spec(s): ${looseLines.join(", ")}`);
  }
}

const distMindmapSource = fs.readFileSync("dist/python/mindmap.py", "utf8");
if (!distMindmapSource.includes("--runtime-preflight") || !distMindmapSource.includes("run_runtime_preflight")) {
  throw new Error("dist/python/mindmap.py must ship the isolated --runtime-preflight mode used by the plugin's runtime verifier.");
}

const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const RELEASE_ASSETS = ["release/main.js", "release/manifest.json", "release/styles.css"];

if (!/persist-credentials:\s*false/.test(workflow)) {
  throw new Error("Release workflow checkout must keep persist-credentials: false.");
}

if (!/id-token:\s*write/.test(workflow) || !/attestations:\s*write/.test(workflow)) {
  throw new Error("Release workflow must grant id-token: write and attestations: write permissions for build attestation.");
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

if (!fs.existsSync(".github/workflows/ci.yml")) {
  throw new Error("Missing required file: .github/workflows/ci.yml");
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
if (!/discover -s tests/.test(ciWorkflow)) {
  throw new Error("CI workflow must run the Python test suite.");
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

// Checkpoint 9 requirement 4/13: the production dev-shadow isolation audit is authoritative HERE
// (running against the dist/main.js this same "npm run check"/"npm run validate" pipeline just
// built via "npm run build", immediately before this script), not in a unit test that can no-op
// silently on a missing/stale dist/main.js. See productionBuildIsolation.test.ts for the
// unit-level config-wiring checks (esbuild.config.mjs plugin wiring, source-level import
// patterns) that remain useful even without a build, but are NOT a substitute for this gate.
{
  const distMainPath = path.join("dist", "main.js");
  if (!fs.existsSync(distMainPath)) {
    throw new Error(`${distMainPath} does not exist -- run "npm run build" before "npm run validate".`);
  }
  const distMain = fs.readFileSync(distMainPath, "utf8");
  const FORBIDDEN_IN_PRODUCTION_DIST = [
    { label: "dev shadow command id", pattern: /mindmap-dev-run-shadow-diagnostics/ },
    { label: "dev shadow command name", pattern: /Development: Run TypeScript shadow diagnostics/ },
    { label: "runDevelopmentShadowDiagnostics identifier", pattern: /runDevelopmentShadowDiagnostics/ },
    { label: "getOrCreateMindmapEngine identifier (Checkpoint 9's legacy composer)", pattern: /getOrCreateMindmapEngine/ },
    { label: "shadowEngine.ts source path reference", pattern: /src\/engine\/shadowEngine\.ts/ },
    { label: "shadow reason string PROJECTION_FAILED", pattern: /PROJECTION_FAILED/ },
    { label: "shadow reason string RELATED_PREVIEW_UNAVAILABLE", pattern: /RELATED_PREVIEW_UNAVAILABLE/ },
    { label: "dev summary string 'Mindmap dev shadow:'", pattern: /Mindmap dev shadow:/ },
    { label: "tools/parity reference", pattern: /tools\/parity/ },
    { label: "runShadowComparison function name", pattern: /runShadowComparison/ },
    { label: "createVaultCatalogShadowSource function name", pattern: /createVaultCatalogShadowSource/ },
    { label: "MindmapEngine class name", pattern: /class MindmapEngine/ },
    { label: "NodeOwnedFs class name", pattern: /class NodeOwnedFs/ },
    { label: "planCatalogSample function name", pattern: /planCatalogSample/ },
    { label: "virtual:mindmap-dev-shadow module marker", pattern: /virtual:mindmap-dev-shadow/ },
    { label: "createDevShadowIntegration factory name", pattern: /createDevShadowIntegration/ },
    { label: "DevShadowIntegration type/identifier name", pattern: /DevShadowIntegration/ },
    { label: "getOrCreateDevShadowIntegration accessor name (renamed in source; must never reappear)", pattern: /getOrCreateDevShadowIntegration/ },
    { label: "devShadowIntegration.ts source path reference", pattern: /devShadowIntegration\.ts/ },
    { label: "devShadowStub.ts source path reference", pattern: /devShadowStub\.ts/ },
    { label: "parseShadowBaselineV1 function name", pattern: /parseShadowBaselineV1/ },
    { label: "vaultCatalogPlanner.ts source path reference", pattern: /vaultCatalogPlanner\.ts/ },
    { label: "shadow reason string CONTENT_TOO_LARGE", pattern: /CONTENT_TOO_LARGE/ },
    { label: "shadow reason string SOURCE_ITEM_INVALID", pattern: /SOURCE_ITEM_INVALID/ },
    { label: "catalog skip reason string RESEARCH_COMPANION", pattern: /RESEARCH_COMPANION/ },
    { label: "generate_shadow_baseline.py generator script reference", pattern: /generate_shadow_baseline/ },
    { label: "IndexStore class name", pattern: /class IndexStore/ },
    { label: "AppleBooksSqliteReader class name", pattern: /class AppleBooksSqliteReader/ },
    { label: "createNodeAppleBooksFsAdapter function name", pattern: /createNodeAppleBooksFsAdapter/ },
    { label: "createNodeSqliteProcess function name", pattern: /createNodeSqliteProcess/ },
    { label: "createAppleBooksReadinessProbe function name", pattern: /createAppleBooksReadinessProbe/ },
    { label: "createOllamaEmbeddingReadinessProbe function name", pattern: /createOllamaEmbeddingReadinessProbe/ },
    { label: "createResearchCredentialReadinessProbe function name", pattern: /createResearchCredentialReadinessProbe/ },
    { label: "verifyCurrentGenerationFully function name", pattern: /verifyCurrentGenerationFully/ },
    { label: "hasResearchCredential function name", pattern: /hasResearchCredential/ },
    { label: "OllamaEmbeddingProvider class name", pattern: /class OllamaEmbeddingProvider/ },
    { label: "appleBooksSqlite.ts source path reference", pattern: /reading\/appleBooksSqlite\.ts/ },
    { label: "sqliteProcess.ts source path reference", pattern: /reading\/sqliteProcess\.ts/ },
  ];
  const distFailures = FORBIDDEN_IN_PRODUCTION_DIST.filter(({ pattern }) => pattern.test(distMain));
  if (distFailures.length > 0) {
    throw new Error(
      `dist/main.js contains forbidden development-only content: ${distFailures.map((entry) => entry.label).join(", ")}. ` +
      "The virtual:mindmap-dev-shadow module must resolve to devShadowStub.ts (not devShadowIntegration.ts) for a production build -- check esbuild.config.mjs's devShadowPlugin(process.cwd(), !production) wiring.",
    );
  }
}

console.log("Release validation passed.");
