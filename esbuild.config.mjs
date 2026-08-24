import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { runtimeAssetPlugin } from "./scripts/runtime-asset-plugin.mjs";

const production = process.argv.includes("production");
const watch = process.argv.includes("--watch");
const outdir = "dist";

await fs.promises.mkdir(outdir, { recursive: true });

const copyDir = async (sourceDir, targetDir) => {
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(targetDir, { recursive: true });

  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
      continue;
    }

    await fs.promises.copyFile(sourcePath, targetPath);
  }
};

const copyStatic = async () => {
  for (const file of ["manifest.json", "styles.css"]) {
    await fs.promises.copyFile(file, path.join(outdir, file));
  }
  await copyDir("python", path.join(outdir, "python"));
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: production ? false : "inline",
  logLevel: "info",
  outfile: path.join(outdir, "main.js"),
  treeShaking: true,
  banner: {
    js: "/* Generated for Obsidian plugin distribution. */",
  },
  plugins: [runtimeAssetPlugin(process.cwd())],
});

if (watch) {
  await copyStatic();
  await ctx.watch();
} else {
  await ctx.rebuild();
  await copyStatic();
  await ctx.dispose();
}
