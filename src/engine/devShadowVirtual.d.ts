/**
 * Ambient module declaration for the esbuild-resolved virtual specifier
 * `"virtual:mindmap-dev-shadow"` (see `scripts/dev-shadow-plugin.mjs`).
 * `main.ts` imports ONLY from this specifier -- never directly from
 * `./engine/mindmapEngine`, `./engine/shadowEngine`, `./engine/nodeFs`, or
 * `./engine/vaultCatalogReader` -- so a production build can point the
 * specifier at a zero-import no-op stub (`devShadowStub.ts`) while a dev
 * build points it at the real implementation (`devShadowIntegration.ts`),
 * with esbuild resolving to exactly ONE of the two files per build: the
 * other is never even parsed into the bundle, regardless of dead-code
 * elimination (Checkpoint 9 requirement 4).
 *
 * Deliberately has NO top-level `import`/`export` of its own (referenced
 * types use inline `import(...)` types instead): a top-level import would
 * make this file itself a module, and TypeScript then treats a `declare
 * module "..."` block inside it as an AUGMENTATION of an existing module
 * rather than as declaring a brand-new ambient one -- which fails to
 * resolve at all for a specifier no real file provides.
 */
declare module "virtual:mindmap-dev-shadow" {
  export interface DevShadowIntegrationHost {
    /** Absolute, plugin-owned directory (never the vault root, never a Python-managed path). */
    pluginDir: string;
    vault: import("obsidian").Vault;
    /** Obsidian's `registerInterval` wrapper composed with `window.setInterval`. */
    registerInterval: (callback: () => void, intervalMs: number) => number;
    appendLog: (message: string) => void;
    notice: (message: string, durationMs?: number) => void;
    getResolvedRuntime: () => import("../pathResolver").ResolvedRuntime;
    canManageConfig: (runtime: import("../pathResolver").ResolvedRuntime) => boolean;
    /**
     * `fetch`-compatible seam for the optional Ollama/local-metadata
     * readiness probes and related-parity embedding calls this
     * integration makes ONLY during an explicit `run()` -- always
     * Obsidian's `requestUrl`-backed adapter in production, injected here
     * (rather than imported directly by `devShadowIntegration.ts`) so
     * that module stays free of a value-level `"obsidian"` import and
     * therefore Node-testable under `node:test`.
     */
    fetchImpl: typeof fetch;
  }

  export interface DevShadowIntegration {
    /** Runs one bounded, read-only diagnostic pass. Concurrent calls reject as busy rather than interleaving; a call after `dispose()` is a safe no-op. */
    run(): Promise<void>;
    /** Idempotent. Aborts any in-flight pass and guarantees no later `Notice`/log callback fires. */
    dispose(): void;
  }

  export function createDevShadowIntegration(host: DevShadowIntegrationHost): DevShadowIntegration;
}
