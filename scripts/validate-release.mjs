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
  const installSection = readme.slice(readme.indexOf("## Install"), readme.indexOf("## First Run"));
  if (installSection.includes("pip install")) {
    throw new Error("README.md primary Install section must not present a manual pip install command; keep it under Troubleshooting/Advanced only.");
  }
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes("## Unreleased")) {
  throw new Error("CHANGELOG.md must include an Unreleased section");
}
if (!new RegExp(`^## ${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "m").test(changelog)) {
  throw new Error(`CHANGELOG.md must include a section for ${manifest.version}`);
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
for (const asset of ["release/main.js", "release/manifest.json", "release/styles.css", "release/mindmap-python.zip"]) {
  if (!workflow.includes(asset)) {
    throw new Error(`Release workflow must publish ${asset}`);
  }
}

if (!fs.existsSync(".github/workflows/ci.yml")) {
  throw new Error("Missing required file: .github/workflows/ci.yml");
}
const ciWorkflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
if (!/on:[\s\S]*pull_request/.test(ciWorkflow)) {
  throw new Error("CI workflow must trigger on pull_request.");
}
for (const step of ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build", "npm run validate"]) {
  if (!ciWorkflow.includes(step)) {
    throw new Error(`CI workflow must run: ${step}`);
  }
}
if (!/discover -s tests/.test(ciWorkflow)) {
  throw new Error("CI workflow must run the Python test suite.");
}

console.log("Release validation passed.");
