import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const releaseDir = path.join(root, "release");
const bundleDir = path.join(releaseDir, "mindmap-python");

await fs.promises.rm(releaseDir, { recursive: true, force: true });
await fs.promises.mkdir(bundleDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await fs.promises.copyFile(path.join(root, "dist", file), path.join(releaseDir, file));
}

for (const file of ["mindmap.py", "requirements.txt", "config.template.json"]) {
  await fs.promises.copyFile(path.join(root, "python", file), path.join(bundleDir, file));
}

const zipPath = path.join(releaseDir, "mindmap-python.zip");
execFileSync("zip", ["-r", zipPath, "mindmap-python"], {
  cwd: releaseDir,
  stdio: "inherit",
});

console.log("Prepared release assets in ./release");
