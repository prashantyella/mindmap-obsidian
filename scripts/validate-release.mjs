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
  "dist/python/requirements.txt",
  "dist/python/config.template.json",
  "python/mindmap.py",
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
for (const phrase of ["Community plugins", "restore its Python runtime automatically"]) {
  if (!readme.includes(phrase)) {
    throw new Error(`README.md must mention ${phrase} for one-click onboarding.`);
  }
}
if (readme.includes("manual release install")) {
  throw new Error("README.md must not present manual release install as the primary onboarding path.");
}

const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes("## Unreleased")) {
  throw new Error("CHANGELOG.md must include an Unreleased section");
}

const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
for (const asset of ["release/main.js", "release/manifest.json", "release/styles.css", "release/mindmap-python.zip"]) {
  if (!workflow.includes(asset)) {
    throw new Error(`Release workflow must publish ${asset}`);
  }
}

console.log("Release validation passed.");
