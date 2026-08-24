import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const production = process.argv.includes("production");
const watch = process.argv.includes("--watch");
const outdir = "dist";

await fs.promises.mkdir(outdir, { recursive: true });

const copyStatic = async () => {
  for (const file of ["manifest.json", "styles.css"]) {
    await fs.promises.copyFile(file, path.join(outdir, file));
  }
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
  minifySyntax: production,
  minifyIdentifiers: production,
  minifyWhitespace: production,
  legalComments: production ? "none" : "eof",
  banner: {
    js: "/* Generated for Obsidian plugin distribution. */",
  },
});

if (watch) {
  await copyStatic();
  await ctx.watch();
} else {
  await ctx.rebuild();
  await copyStatic();
  await ctx.dispose();
}
