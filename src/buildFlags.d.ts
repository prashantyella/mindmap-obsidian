/**
 * Injected by esbuild via `define` (see `esbuild.config.mjs`) as a literal
 * boolean -- `false` for a production build, `true` otherwise. Every
 * development-only branch gated on this constant is removed entirely from
 * a production bundle by esbuild's dead-code elimination (`minifySyntax`,
 * enabled only for production builds) -- see
 * `src/engine/productionBuildIsolation.test.ts`, which builds and audits
 * `dist/main.js` for this.
 */
declare const __MINDMAP_DEV_BUILD__: boolean;
