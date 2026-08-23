import type { DevShadowIntegration, DevShadowIntegrationHost } from "virtual:mindmap-dev-shadow";

/**
 * Production resolution of `virtual:mindmap-dev-shadow` (Checkpoint 9
 * requirement 4). Deliberately imports NOTHING from `./mindmapEngine`,
 * `./shadowEngine`, `./nodeFs`, or `./vaultCatalogReader` -- a production
 * bundle built with `esbuild.config.mjs production` resolves the virtual
 * specifier to exactly this file (see `scripts/dev-shadow-plugin.mjs`), so
 * none of those modules, the dev command's id/name strings, or the
 * `runDevelopmentShadowDiagnostics`/`getOrCreateMindmapEngine` identifiers
 * are ever read into the production bundle in the first place -- this is
 * enforced by `dist/main.js` never containing them at all, not by dead-code
 * elimination of a branch that was always reachable in source.
 */
export function createDevShadowIntegration(_host: DevShadowIntegrationHost): DevShadowIntegration {
  return {
    async run(): Promise<void> {},
    dispose(): void {},
  };
}
