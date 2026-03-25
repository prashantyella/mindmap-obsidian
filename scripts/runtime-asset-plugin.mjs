import fs from "node:fs";
import path from "node:path";

const RUNTIME_ASSET_FILES = ["mindmap.py", "requirements.txt", "config.template.json"];

export function runtimeAssetPlugin(rootDir) {
  return {
    name: "runtime-asset-plugin",
    setup(build) {
      build.onResolve({ filter: /^virtual:runtime-assets$/ }, () => ({
        path: "virtual:runtime-assets",
        namespace: "runtime-assets",
      }));

      build.onLoad({ filter: /.*/, namespace: "runtime-assets" }, async () => {
        const assets = {};
        for (const fileName of RUNTIME_ASSET_FILES) {
          const assetPath = path.join(rootDir, "python", fileName);
          assets[fileName] = await fs.promises.readFile(assetPath, "utf8");
        }

        return {
          contents: `export const BUNDLED_RUNTIME_ASSETS = ${JSON.stringify(assets)};`,
          loader: "js",
        };
      });
    },
  };
}
