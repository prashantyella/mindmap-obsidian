import path from "node:path";

/**
 * Resolves the virtual specifier `"virtual:mindmap-dev-shadow"` (imported
 * only by `main.ts`) to exactly ONE real file per build: the real
 * implementation for a dev build, or a zero-import no-op stub for a
 * production build. Unlike `__MINDMAP_DEV_BUILD__`-gated branches (dead-
 * code elimination, which only removes code esbuild can prove is
 * unreachable), this makes it structurally impossible for the wrong
 * module's imports to even be resolved/parsed into a production bundle --
 * see `src/engine/devShadowVirtual.d.ts`, `src/engine/devShadowIntegration.ts`,
 * and `src/engine/devShadowStub.ts`.
 */
export function devShadowPlugin(rootDir, isDevBuild) {
  const targetFile = path.join(rootDir, "src", "engine", isDevBuild ? "devShadowIntegration.ts" : "devShadowStub.ts");
  return {
    name: "dev-shadow-plugin",
    setup(build) {
      build.onResolve({ filter: /^virtual:mindmap-dev-shadow$/ }, () => ({ path: targetFile }));
    },
  };
}
