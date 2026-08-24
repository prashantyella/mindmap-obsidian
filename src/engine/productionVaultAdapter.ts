import type { TAbstractFile, TFile, TFolder, Vault, Workspace } from "obsidian";

import { canonicalizePath, stableNoteIdentity, type NoteIdentityV1 } from "./contracts";
import { EngineError } from "./errors";
import type { NoteReplacementSeam, NoteSourceReader } from "../jobs/noteJob";
import type { ScopeDiscoveryItem, ScopeDiscoverySeam, ScopeEnqueueSeam, ScopeImportSeam } from "../jobs/scopeJob";
import type { JobTrigger } from "./contracts";
import type { NoteVaultAdapter } from "./noteWriter";
import { findCatalogItemByAnnotationId, streamFullCatalogDiscovery, type CatalogPlannerConfig, type CatalogTextReader } from "./vaultCatalogPlanner";

/**
 * Checkpoint 10A: the ONLY place production write-capable composition
 * touches Obsidian's real `Vault`/`Workspace` API. Every adapter here is a
 * THIN seam over `vault.getAbstractFileByPath`/`vault.read`/`cachedRead`/
 * `modify`/`create`/`createFolder`/`workspace.openLinkText` -- every
 * eligibility/identity/projection decision is made by the already-
 * Node-testable `vaultCatalogPlanner.ts`/`sourceProjection.ts`/
 * `contracts.ts`, never re-derived here. No raw Node `fs` access to vault
 * notes anywhere in this file (that stays exclusively `NodeOwnedFs`'s job,
 * confined to plugin-owned data outside the vault) -- see
 * `productionEngineIsolation.test.ts`.
 *
 * Item 5 (Checkpoint 10A sub-milestone C): note MUTATIONS go through
 * `vault.modify`/`vault.create` exclusively -- never `vault.adapter.write`
 * -- so Obsidian's own metadata cache and file-change events fire exactly
 * as they would for a user-driven edit (a bare `adapter.write` bypasses
 * both, leaving the cache/other panes stale). Reads resolve a REAL `TFile`
 * via `vault.getAbstractFileByPath` first: `null` there is the ONLY
 * "genuinely missing" case (returns `null`, never throws); a resolved
 * path that is a folder, not a file, is likewise treated as "no note here"
 * (`null`); everything else -- a `vault.read`/`cachedRead` call that
 * itself throws once a `TFile` was already resolved (a permission error, a
 * delete-race after resolution) -- throws a closed, retryable
 * `VAULT_READ_FAILED`/`VAULT_WRITE_FAILED` `EngineError` rather than
 * silently downgrading to `null`, so a genuine I/O failure is retried
 * instead of being misread as "note deleted".
 */

/** `obsidian` ships as type declarations only (see its own `package.json`, `"main": ""`) -- importing `TFile`/`TFolder` as VALUES for `instanceof` (as `main.ts` itself does, safely, only inside the real plugin runtime) would break every Node test that loads this module. These structural predicates are the test-safe FALLBACK: a `TFile` carries `extension`/`stat` and never `children`; a `TFolder` carries a `children` array. */
function isTFileStructural(candidate: TAbstractFile): candidate is TFile {
  const record = candidate as unknown as Record<string, unknown>;
  return typeof record.extension === "string" && !Array.isArray(record.children);
}

function isTFolderStructural(candidate: TAbstractFile): candidate is TFolder {
  const record = candidate as unknown as Record<string, unknown>;
  return Array.isArray(record.children);
}

/** Item 3 (10A blocker pass): the real Obsidian `TFile`/`TFolder` CLASSES, injectable by the composition root (`main.ts`, safely importing them as values exactly like it already does elsewhere) once a later checkpoint wires this module up for real. */
export interface VaultFileClasses {
  TFile: abstract new (...args: never[]) => TFile;
  TFolder: abstract new (...args: never[]) => TFolder;
}

/** Resolves real `instanceof`-based guards when `classes` is injected; falls back to the structural shape check above when it is not (every Node test, and any caller that has not yet been updated to inject the real classes). Lazy: this module never imports `TFile`/`TFolder` as values itself, so it stays loadable in Node regardless of which path a given call takes. */
function resolveVaultClassGuards(classes: VaultFileClasses | undefined): { isTFile(candidate: TAbstractFile): candidate is TFile; isTFolder(candidate: TAbstractFile): candidate is TFolder } {
  if (!classes) return { isTFile: isTFileStructural, isTFolder: isTFolderStructural };
  const { TFile: RealTFile, TFolder: RealTFolder } = classes;
  return {
    isTFile: (candidate): candidate is TFile => candidate instanceof RealTFile,
    isTFolder: (candidate): candidate is TFolder => candidate instanceof RealTFolder,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Vault operation aborted.");
}

interface CatalogTextReaderFor {
  reader: CatalogTextReader;
}

/** Catalog SCANNING (discovery/full-catalog walks, potentially thousands of notes) uses `vault.cachedRead` -- Obsidian's own guidance is to prefer it "for better performance" whenever the caller does not need to guarantee the absolute latest on-disk bytes for every single candidate in one large pass. A per-note resolve-before-write path (`resolveByPath` below) uses the uncached `vault.read` instead, where freshness at the moment of use matters more than scan throughput. Item 3: `signal` is re-checked AFTER the `cachedRead` await too, not merely before it -- a cancellation that lands while the read is in flight must still stop the walk promptly rather than silently returning one more item past the cancellation point. */
function makeCatalogTextReader(vault: Vault, classes?: VaultFileClasses): CatalogTextReaderFor["reader"] {
  const guards = resolveVaultClassGuards(classes);
  return {
    async readText(relpath: string, signal?: AbortSignal): Promise<string> {
      throwIfAborted(signal);
      const af = vault.getAbstractFileByPath(relpath);
      if (af === null || !guards.isTFile(af)) throw new Error(`ENOENT: ${relpath}`);
      throwIfAborted(signal);
      const text = await vault.cachedRead(af);
      throwIfAborted(signal);
      return text;
    },
  };
}

/** Obsidian-backed `NoteVaultAdapter` for `NoteWriter` -- the exact narrow seam Checkpoint 7's `NoteWriter` was designed to be substituted over. `create` uses `vault.create`, which itself rejects (without writing) if the path already exists -- an exclusive create, never create-or-overwrite. `modify` requires an already-resolved `TFile` (mirrors this adapter's own doc comment: `modify` is only ever called after a caller has confirmed the path currently holds content) -- attempting to modify a path that no longer resolves throws rather than silently creating one, since `create`/`modify` are deliberately distinct expected-state primitives. Item 3: every thrown `EngineError` here is a STATIC, redacted message -- the raw caught error (which could echo vault note content, a real filesystem path, or other user data) is never attached as `context`/`cause`. */
export function createProductionNoteVaultAdapter(vault: Vault, classes?: VaultFileClasses): NoteVaultAdapter {
  const guards = resolveVaultClassGuards(classes);
  return {
    async read(path: string): Promise<string | null> {
      const af = vault.getAbstractFileByPath(path);
      if (af === null || !guards.isTFile(af)) return null; // genuinely missing (or a folder, never a note) -- the ONLY null case
      try {
        return await vault.read(af);
      } catch {
        throw new EngineError("VAULT_READ_FAILED", "Reading an existing vault note failed.");
      }
    },
    async modify(path: string, content: string): Promise<void> {
      const af = vault.getAbstractFileByPath(path);
      if (af === null || !guards.isTFile(af)) {
        throw new EngineError("VAULT_WRITE_FAILED", "Cannot modify a vault note that no longer resolves to a file.");
      }
      try {
        await vault.modify(af, content);
      } catch {
        throw new EngineError("VAULT_WRITE_FAILED", "Modifying an existing vault note failed.");
      }
    },
    async create(path: string, content: string): Promise<void> {
      await vault.create(path, content);
    },
    async ensureFolder(path: string): Promise<void> {
      if (path === "" || path === ".") return;
      const existing = vault.getAbstractFileByPath(path);
      if (existing !== null) {
        if (guards.isTFolder(existing)) return; // already a folder -- safe no-op
        throw new EngineError("VAULT_WRITE_FAILED", "A vault note already occupies the path a folder was expected at.");
      }
      try {
        await vault.createFolder(path);
      } catch {
        // Item 5: safe TFolder handling under a create race -- another writer may have created the
        // SAME folder between the check above and this call. Re-check before treating the failure
        // as real: only a confirmed-still-absent (or confirmed-not-a-folder) path re-throws.
        const afterRace = vault.getAbstractFileByPath(path);
        if (afterRace !== null && guards.isTFolder(afterRace)) return;
        throw new EngineError("VAULT_WRITE_FAILED", "Creating a vault folder failed.");
      }
    },
  };
}

export interface ProductionCatalogOptions {
  vault: Vault;
  /** Configured "all scope" folders -- `ScopeSelection.allPaths` (never `.currentPaths`, which is the smaller day-to-day working set): migration/full-catalog discovery must see every note the user has ever configured, not just the active subset. */
  scopeFolders: readonly string[];
  minimumWords: number;
  configDir?: string;
  /** Item 3: injected real `TFile`/`TFolder` classes (see `VaultFileClasses`) -- when omitted, every guard here falls back to the structural shape check (test-safe default). */
  vaultFileClasses?: VaultFileClasses;
}

function toCatalogConfig(options: ProductionCatalogOptions, includeReadingAnnotations: boolean): CatalogPlannerConfig {
  return {
    scopeFolders: options.scopeFolders,
    includeReadingAnnotations,
    minimumWords: options.minimumWords,
    configDir: options.configDir ?? options.vault.configDir,
  };
}

/**
 * Resolves a `process-note` job's stable identity to its current on-disk
 * content, per `NoteSourceReader`'s own contract: a `"path"` identity is
 * resolved by that exact path only (its path IS its whole stable identity
 * -- a missing path means the note is gone, never searched for
 * elsewhere); an `"apple-annotation"` identity is resolved by its
 * `appleAnnotationId`, found via a bounded full catalog scan of the
 * Reading root so a RENAMED annotation file is still followed to its new
 * path (Checkpoint 7 requirement 8) -- never trusted to still live at its
 * originally-queued path.
 */
export function createProductionNoteSourceReader(options: ProductionCatalogOptions): NoteSourceReader {
  const reader = makeCatalogTextReader(options.vault, options.vaultFileClasses);
  const guards = resolveVaultClassGuards(options.vaultFileClasses);

  /** Uses the UNCACHED `vault.read` (never `cachedRead`) -- this result becomes `sourceHash`/what gets embedded, so it must reflect the actual current disk bytes, not a possibly-stale cache entry, at the moment a job resolves its source. Item 3: `signal` is re-checked immediately after the `vault.read` await too -- a cancellation landing while the read is in flight must still be honored rather than silently returning a stale-relative-to-cancellation result. */
  async function resolveByPath(canonicalPath: string, signal?: AbortSignal): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
    throwIfAborted(signal);
    const af = options.vault.getAbstractFileByPath(canonicalPath);
    if (af === null || !guards.isTFile(af)) return null; // genuinely missing -- the ONLY null case
    throwIfAborted(signal);
    let rawContent: string;
    try {
      rawContent = await options.vault.read(af);
    } catch {
      throw new EngineError("VAULT_READ_FAILED", "Reading an existing vault note's source failed.");
    }
    throwIfAborted(signal);
    return { identity: stableNoteIdentity(canonicalizePath(canonicalPath)), rawContent };
  }

  async function resolveByAnnotationId(appleAnnotationId: string, signal?: AbortSignal): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
    throwIfAborted(signal);
    const candidatePaths = options.vault.getMarkdownFiles().map((file) => file.path);
    // Item 8: content-free single-identity resolution -- never retains every other candidate's
    // body while searching for this one match. `findCatalogItemByAnnotationId` itself checks
    // `signal.aborted` between every candidate (item 5: "abort-check around ... annotation scan").
    return findCatalogItemByAnnotationId(candidatePaths, toCatalogConfig(options, true), reader, appleAnnotationId, signal);
  }

  return {
    async read(identity: NoteIdentityV1, signal?: AbortSignal): Promise<{ identity: NoteIdentityV1; rawContent: string } | null> {
      if (identity.kind === "apple-annotation") {
        if (!identity.appleAnnotationId) return null;
        return resolveByAnnotationId(identity.appleAnnotationId, signal);
      }
      return resolveByPath(identity.canonicalPath, signal);
    },
  };
}

/**
 * Real vault-backed `ScopeDiscoverySeam` for `"scope-refresh"` jobs:
 * walks the FULL configured scope (never a 50-note dev-diagnostic sample)
 * via `planFullCatalogDiscovery`, and computes each item's `sourceHash`
 * through `projectSource` -- the SAME normalized-projection hash every
 * other write path in this codebase uses, never a raw-content hash.
 */
export function createProductionScopeDiscoverySeam(options: ProductionCatalogOptions, embeddingModel: string): ScopeDiscoverySeam {
  const reader = makeCatalogTextReader(options.vault, options.vaultFileClasses);
  return {
    async discover(_scopeId: string, signal: AbortSignal): Promise<ScopeDiscoveryItem[]> {
      const candidatePaths = options.vault.getMarkdownFiles().map((file) => file.path);
      // Item 8: content-free streaming discovery -- never retains more than one note's body at a
      // time, regardless of how many thousands of notes the configured scope covers.
      const stream = await streamFullCatalogDiscovery(candidatePaths, toCatalogConfig(options, true), reader, signal);
      return stream.items.map((item) => ({ identity: item.identity, sourceHash: item.sourceHash, embeddingModel }));
    },
  };
}

/**
 * Checkpoint 10A explicitly forbids a live Apple Books call from this
 * checkpoint's composition -- a real `"reading-sync"` import (pulling
 * NEWLY-read annotations from Apple Books into the vault) would require
 * exactly that. This seam therefore stays a documented, honest no-op: it
 * satisfies `ScopeJobRunner`'s REQUIRED dependency (so composing a
 * `"reading-sync"` runner never silently skips its `"import"` phase, per
 * `ScopeJobDeps`'s own doc comment) without ever touching Apple Books.
 * `"reading-sync"` is not exercised in 10A's migration flow (which only
 * ever submits `"scope-refresh"`/`"process-note"`/`"migrate-index"`); a
 * later checkpoint wires the real import against `appleBooksImport.ts`.
 */
export function createDeferredScopeImportSeam(): ScopeImportSeam {
  return {
    async import(): Promise<void> {
      // Deliberately empty -- see this function's own doc comment.
    },
  };
}

export interface JobSubmitter {
  submit(input: { trigger: JobTrigger; kind: "process-note"; identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }): Promise<unknown>;
}

/** Submits (or coalesces onto) one `"process-note"` job per discovered item, backed by the real `JobEngine.submit` -- see `ScopeEnqueueSeam`'s own doc comment on why re-submitting an already-queued identical item is always safe. */
export function createProductionScopeEnqueueSeam(jobEngine: JobSubmitter, trigger: JobTrigger): ScopeEnqueueSeam {
  return {
    async enqueueProcessNote(item: ScopeDiscoveryItem, pipelineVersion: number): Promise<void> {
      await jobEngine.submit({ trigger, kind: "process-note", identity: item.identity, sourceHash: item.sourceHash, embeddingModel: item.embeddingModel, pipelineVersion });
    },
  };
}

/** Backed by the real `JobEngine.submit` -- see `NoteReplacementSeam`'s own doc comment (Checkpoint 7 final-closure requirement 6: a source-change-in-flight must always produce a real replacement job, never a swallowed edit). */
export function createProductionNoteReplacementSeam(jobEngine: JobSubmitter, trigger: JobTrigger): NoteReplacementSeam {
  return {
    async enqueueReplacement(input: { identity: NoteIdentityV1; sourceHash: string; embeddingModel: string; pipelineVersion: number }): Promise<void> {
      await jobEngine.submit({ trigger, kind: "process-note", identity: input.identity, sourceHash: input.sourceHash, embeddingModel: input.embeddingModel, pipelineVersion: input.pipelineVersion });
    },
  };
}

export interface OpenRelatedNoteOptions {
  /** Obsidian's actual `Vault#configDir` (may be renamed by the user) -- a related-note target inside it is rejected, never opened. */
  configDir?: string;
  /** The plugin's own runtime-internal folder inside the vault (`<configDir>/plugins/<pluginId>`), when the plugin stores anything there -- a related-note target inside it is likewise rejected. */
  runtimeFolder?: string;
}

function isWithinConfiguredFolder(relpath: string, folder: string | undefined): boolean {
  if (folder === undefined) return false;
  const normalizedFolder = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalizedFolder === "" || normalizedFolder === ".") return false;
  return relpath === normalizedFolder || relpath.startsWith(`${normalizedFolder}/`);
}

/**
 * Item 6: opens a related note in the workspace -- the one UI-adjacent
 * vault effect this checkpoint's production adapters expose. Requires an
 * ALREADY-canonical, safe, vault-relative `.md` path: `canonicalizePath`
 * itself rejects an absolute path, `..` traversal, and any control/NUL
 * character (throwing the same closed `PATH_*` codes every other identity
 * in this codebase fails closed with); this function additionally rejects
 * a path inside the configured `configDir` or `runtimeFolder`, and any
 * non-`.md` path, BEFORE ever calling `workspace.openLinkText` -- never
 * silently "fixing up" or re-normalizing an unsafe value into something
 * that happens to look safe. Mirrors `statusBarIntegration.ts`'s existing
 * `openNote` pattern otherwise; no other eligibility/identity logic of its
 * own.
 */
export async function openRelatedNote(workspace: Workspace, notePath: string, options: OpenRelatedNoteOptions = {}): Promise<void> {
  if (typeof notePath !== "string" || notePath.trim().length === 0) {
    throw new EngineError("IDENTITY_INVALID", "openRelatedNote requires a non-empty note path.");
  }
  // Throws PATH_EMPTY/PATH_ABSOLUTE/PATH_TRAVERSAL/PATH_CONTROL_CHARACTER for anything unsafe --
  // the canonical result is used for every check below, never the raw caller-supplied string.
  const canonical = canonicalizePath(notePath);
  if (!canonical.toLowerCase().endsWith(".md")) {
    throw new EngineError("IDENTITY_INVALID", "openRelatedNote requires a .md path.");
  }
  if (isWithinConfiguredFolder(canonical, options.configDir)) {
    throw new EngineError("IDENTITY_INVALID", "openRelatedNote must never target a path inside the Obsidian configDir.");
  }
  if (isWithinConfiguredFolder(canonical, options.runtimeFolder)) {
    throw new EngineError("IDENTITY_INVALID", "openRelatedNote must never target a path inside the plugin's own runtime-internal folder.");
  }
  await workspace.openLinkText(canonical, "", false);
}
