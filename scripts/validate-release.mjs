import fs from "node:fs";
import path from "node:path";

const requiredFiles = [
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
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));
const mappedVersion = versions[manifest.version];

if (!mappedVersion) {
  throw new Error(`versions.json is missing version ${manifest.version}`);
}

if (mappedVersion !== manifest.minAppVersion) {
  throw new Error(
    `versions.json mismatch for ${manifest.version}: expected ${manifest.minAppVersion}, got ${mappedVersion}`,
  );
}

if (manifest.isDesktopOnly !== true) {
  throw new Error("manifest.json must keep isDesktopOnly set to true");
}

const config = JSON.parse(fs.readFileSync("python/config.template.json", "utf8"));
const serialized = JSON.stringify(config);
if (serialized.includes("/Users/") || serialized.includes("\\Users\\")) {
  throw new Error("config.template.json contains a machine-specific path");
}

const distManifest = JSON.parse(fs.readFileSync(path.join("dist", "manifest.json"), "utf8"));
if (distManifest.version !== manifest.version) {
  throw new Error("dist/manifest.json is not in sync with manifest.json");
}

console.log("Release validation passed.");
