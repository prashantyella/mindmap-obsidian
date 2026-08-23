import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { runtimeAssetPlugin } from "./scripts/runtime-asset-plugin.mjs";
import { devShadowPlugin } from "./scripts/dev-shadow-plugin.mjs";

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
  // Dead-code elimination for `if (__MINDMAP_DEV_BUILD__) { ... }` branches is required, not
  // cosmetic, for production builds: it is what physically removes the development-only shadow
  // command (and everything it transitively imports) from the shipped bundle -- see
  // `productionBuildIsolation.test.ts`. Only enabled for production so a dev build's output stays
  // readable for debugging.
  minifySyntax: production,
  // Identifier/whitespace minification (production only) is what actually removes source-level
  // doc-comment PROSE referencing the dev-only virtual module (`virtual:mindmap-dev-shadow`,
  // `devShadowIntegration.ts`) and renames internal-only accessor names (e.g.
  // `getOrCreateDevShadowIntegration`) to short mangled identifiers -- `minifySyntax` alone strips
  // dead branches but neither removes comments nor renames identifiers, so a name/comment that is
  // merely UNREACHABLE in production (rather than physically absent, like the real engine/shadow
  // modules `devShadowStub.ts` never imports) would otherwise still read literally in
  // `dist/main.js`. See `scripts/validate-release.mjs`'s post-build forbidden-string audit, which
  // is the authoritative check this is required to pass.
  minifyIdentifiers: production,
  minifyWhitespace: production,
  legalComments: production ? "none" : "eof",
  define: {
    __MINDMAP_DEV_BUILD__: production ? "false" : "true",
  },
  banner: {
    js: "/* Generated for Obsidian plugin distribution. */",
  },
  plugins: [runtimeAssetPlugin(process.cwd()), devShadowPlugin(process.cwd(), !production)],
});

if (watch) {
  await copyStatic();
  await ctx.watch();
} else {
  await ctx.rebuild();
  await copyStatic();
  await ctx.dispose();
}
