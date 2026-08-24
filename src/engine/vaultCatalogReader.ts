import type { Vault } from "obsidian";

import type { ShadowNoteSource } from "./shadowEngine";
import { planCatalogSample, type CatalogSkipReasonCode, type CatalogTextReader } from "./vaultCatalogPlanner";

/**
 * The one place this checkpoint's read-only shadow profile touches
 * Obsidian's real `Vault` API. Kept isolated in its own module (mirrors
 * `readingVault.ts`'s existing pattern) so every other engine/shadow
 * module stays Node-testable against a fake -- this file is exercised
 * manually through the plugin's development-only shadow command, not by
 * an automated Node test.
 *
 * A THIN adapter only (Checkpoint 9 requirement 9): it enumerates
 * candidate paths (`vault.getMarkdownFiles()`) and reads text
 * (`vault.adapter.read()`) -- every eligibility/exclusion/identity
 * decision is made by `planCatalogSample` (`vaultCatalogPlanner.ts`,
 * fully Node-testable, no Obsidian import), never by this file. Never
 * mutates anything.
 */
export interface VaultCatalogReaderOptions {
  vault: Vault;
  /** Configured scope folders (`ScopeSelection.currentPaths`); a note outside every one of these is not eligible unless it also falls under the strict Reading-annotation shape. Empty means "no ordinary scope configured yet". */
  scopeFolders: readonly string[];
  /** Whether the strict Reading-annotation inclusion path is active -- see `CatalogPlannerConfig.includeReadingAnnotations`. Defaults to `true`. */
  includeReadingAnnotations?: boolean;
  /** Same threshold production's `min_note_words` config drives; defaults to 0 (no minimum) only when the caller genuinely has none configured. */
  minimumWords?: number;
  /** Obsidian's actual `Vault#configDir` -- defaults to `vault.configDir` when omitted; never a hardcoded `.obsidian` (Checkpoint 9 requirement 9). */
  configDir?: string;
}

/**
 * Widened beyond `ShadowNoteSource` (which stays narrow/generic on
 * purpose) so a caller holding this concrete return type -- not just the
 * narrow interface `runShadowComparison` accepts -- can also surface the
 * bounded catalog skip reasons directly. `getSkipReasonCounts` (no
 * `Last`) is the SAME method `ShadowNoteSource`'s own optional method
 * expects, so `runShadowComparison` picks these up automatically into
 * `ShadowReportV1.sourceSkipReasonCounts` too (Checkpoint 9 closure
 * review item 8: "Report catalog skip counts inside ShadowReportV1
 * itself so every consumer gets them, not only through a concrete source
 * getter/log").
 */
export interface VaultCatalogShadowSource extends ShadowNoteSource {
  /** The most recent `listEligibleSample` call's bounded skip-reason counts; empty until the first call completes. */
  getSkipReasonCounts(): Partial<Record<CatalogSkipReasonCode, number>>;
}

export function createVaultCatalogShadowSource(options: VaultCatalogReaderOptions): VaultCatalogShadowSource {
  let lastSkipReasonCounts: Partial<Record<CatalogSkipReasonCode, number>> = {};
  const reader: CatalogTextReader = {
    async readText(relpath: string): Promise<string> {
      // `vault.adapter.read(path)` (a plain string path, not a `TFile`) avoids ever needing a
      // `TFile`/`instanceof TFile`/cast at all -- simpler than resolving a `TFile` via
      // `getAbstractFileByPath` first just to hand it to `cachedRead`, and reads the same
      // committed-on-disk content this checkpoint's read-only sample needs.
      return options.vault.adapter.read(relpath);
    },
  };
  return {
    async listEligibleSample(maxCount: number, signal?: AbortSignal) {
      const candidatePaths = options.vault.getMarkdownFiles().map((file) => file.path);
      const plan = await planCatalogSample(
        candidatePaths,
        {
          scopeFolders: options.scopeFolders,
          includeReadingAnnotations: options.includeReadingAnnotations,
          minimumWords: options.minimumWords ?? 0,
          configDir: options.configDir ?? options.vault.configDir,
        },
        reader,
        maxCount,
        signal,
      );
      lastSkipReasonCounts = plan.skipReasonCounts;
      return plan.items.map((item) => ({ identity: item.identity, rawContent: item.rawContent }));
    },
    getSkipReasonCounts(): Partial<Record<CatalogSkipReasonCode, number>> {
      return lastSkipReasonCounts;
    },
  };
}
