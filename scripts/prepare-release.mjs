import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "release");

await fs.promises.rm(releaseDir, { recursive: true, force: true });
await fs.promises.mkdir(releaseDir, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await fs.promises.copyFile(path.join(root, "dist", file), path.join(releaseDir, file));
}

console.log("Prepared release assets in ./release");
