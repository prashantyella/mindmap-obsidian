import { appleAnnotationConceptWikilinks, appleAnnotationRelatedWikilinks } from "./appleAnnotationWikilinks";
import type { CanonicalPath, MetadataOutputV1, NoteIdentityV1 } from "./contracts";
import { EngineError } from "./errors";
import { detectNewline, replaceBody, splitFrontmatter } from "./frontmatterCore";
import { updateFrontmatter } from "./frontmatterEngine";
import { clearManagedRelatedSection, updateRelatedSection, type RelatedSectionLink } from "./relatedSectionWriter";
import { MANAGED_FRONTMATTER_KEYS, projectSource } from "./sourceProjection";

/**
 * The vault seam `NoteWriter` (and the research-companion writer) mutate
 * through. Deliberately narrow (read a single note by vault path, mutate an
 * existing one, exclusively create a new one, ensure a folder exists) so
 * tests can substitute an in-memory fake and production wires a thin
 * adapter over Obsidian's Vault API -- this module itself never touches
 * Obsidian or the filesystem.
 *
 * `modify`/`create` are deliberately two separate expected-state
 * primitives rather than one create-or-overwrite `write()`: `modify` is
 * only ever called after a caller has confirmed (via `read`/a probe) that
 * the path currently holds content it means to replace, and `create` is
 * only ever called for a path a caller has just confirmed is empty --
 * `create` must reject if a file already exists there (an exclusive
 * create, not create-or-overwrite) so a caller that loses a create race to
 * a concurrent writer can detect that and re-probe instead of silently
 * overwriting whatever the race winner wrote.
 */
export interface NoteVaultAdapter {
  /** `null` when the path does not exist. */
  read(path: string): Promise<string | null>;
  /** Overwrites a path the caller has confirmed already holds content. Must not be used to create a new file. */
  modify(path: string, content: string): Promise<void>;
  /** Exclusive create: must reject without writing anything if a file already exists at `path`, rather than silently overwriting it. */
  create(path: string, content: string): Promise<void>;
  ensureFolder(path: string): Promise<void>;
}

const APPLE_ANNOTATION_CLEARED_KEYS = ["summary", "tags"] as const;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;

function identitiesEqual(a: NoteIdentityV1, b: NoteIdentityV1): boolean {
  return a.schemaVersion === b.schemaVersion
    && a.kind === b.kind
    && a.canonicalPath === b.canonicalPath
    && a.appleAnnotationId === b.appleAnnotationId;
}

function buildMetadataUpdates(isAppleAnnotation: boolean, metadata: MetadataOutputV1): Record<string, unknown> {
  if (isAppleAnnotation) {
    return {
      concepts: appleAnnotationConceptWikilinks(metadata.concepts),
      related: appleAnnotationRelatedWikilinks(metadata.related),
    };
  }
  return {
    summary: metadata.summary,
    tags: metadata.tags,
    concepts: metadata.concepts,
    related: metadata.related,
  };
}

export interface WriteNoteMetadataOptions {
  identity: NoteIdentityV1;
  /** Vault-relative path to read/write; equal to `identity.canonicalPath` for every caller today, kept separate so a future rename-in-flight case can pass the current on-disk path explicitly. */
  path: CanonicalPath;
  /** `sourceHash` the metadata in `metadata` was computed against. Re-verified against a fresh read immediately before any mutation. */
  expectedSourceHash: string;
  metadata: MetadataOutputV1;
  isAppleAnnotation: boolean;
  /** Ordinary notes only: candidates to render in the Related callout. Ignored for Apple annotation notes, which never gain a generated related section (they render `related` as wikilink values instead -- see `build_metadata_updates` in python/mindmap.py). */
  relatedLinks?: RelatedSectionLink[];
  mindmapHeading?: string;
  /** Ordinary notes only. Mutually exclusive with `removeMindmapSection`; ignored for Apple annotation notes (always cleared). */
  writeMindmapSection: boolean;
  /** Ordinary notes only. */
  removeMindmapSection: boolean;
}

export type WriteNoteMetadataResult =
  | { status: "written"; content: string }
  | { status: "unchanged"; content: string };

/**
 * The single UI-free mutation boundary for note frontmatter/body. Composes
 * `FrontmatterEngine` (managed-key updates), `relatedSectionWriter`
 * (managed body section), and `sourceProjection` (stale-source guard) over
 * an injected `NoteVaultAdapter`. Every write:
 *
 * - re-reads the current note and recomputes `sourceHash` immediately
 *   before mutating, rejecting (`EngineError("SOURCE_STALE", ...)`, no
 *   write performed) if the user has changed the source since the metadata
 *   was computed;
 * - touches only the managed frontmatter keys (`summary`/`tags`/`concepts`/
 *   `related`) and the managed related-section body region, preserving
 *   every other frontmatter/body byte;
 * - for Apple annotation notes, clears `summary`/`tags` entirely, renders
 *   `concepts`/`related` as wikilinks, and always removes any managed
 *   related-section body content -- the body stays annotation-only;
 * - is idempotent: re-applying the same metadata against the same
 *   `expectedSourceHash` produces byte-identical output and skips the
 *   vault write (`status: "unchanged"`).
 *
 * Before touching the vault at all, every call is misrouting-checked and
 * fails closed (`EngineError("IDENTITY_INVALID", ...)`) unless `path`
 * equals `identity.canonicalPath`, `metadata.identity` exactly matches
 * `identity`, `isAppleAnnotation` agrees with `identity.kind`, and
 * `expectedSourceHash` is a well-formed hash -- a caller that has wired the
 * wrong identity/metadata/path together for a batch/queued write can never
 * silently read or mutate the wrong note. A vault write failure is wrapped
 * as a structured `EngineError("VAULT_WRITE_FAILED", ...)` that never
 * includes the underlying adapter error's raw text (which could leak
 * vault-internal paths/details) -- only the note path being written.
 */
export class NoteWriter {
  constructor(private readonly vault: NoteVaultAdapter) {}

  async writeMetadata(options: WriteNoteMetadataOptions): Promise<WriteNoteMetadataResult> {
    if (options.writeMindmapSection && options.removeMindmapSection) {
      throw new EngineError("FRONTMATTER_MALFORMED", "writeMindmapSection and removeMindmapSection are mutually exclusive.", {});
    }
    if (options.path !== options.identity.canonicalPath) {
      throw new EngineError("IDENTITY_INVALID", "options.path must equal identity.canonicalPath; refusing to read/write a possibly misrouted note.", {
        path: options.path,
      });
    }
    if (!identitiesEqual(options.metadata.identity, options.identity)) {
      throw new EngineError(
        "IDENTITY_INVALID",
        "metadata.identity does not match the note identity being written; refusing to apply metadata computed for a different note.",
        { path: options.path },
      );
    }
    const identityIsAppleAnnotation = options.identity.kind === "apple-annotation";
    if (options.isAppleAnnotation !== identityIsAppleAnnotation) {
      throw new EngineError(
        "IDENTITY_INVALID",
        `isAppleAnnotation (${String(options.isAppleAnnotation)}) disagrees with identity.kind ("${options.identity.kind}").`,
        { path: options.path },
      );
    }
    if (!HEX_64_PATTERN.test(options.expectedSourceHash)) {
      throw new EngineError("CONTRACT_SHAPE_INVALID", "expectedSourceHash must be a 64-character lowercase hex hash.", { path: options.path });
    }

    let rawContent: string | null;
    try {
      rawContent = await this.vault.read(options.path);
    } catch {
      throw new EngineError("VAULT_WRITE_FAILED", `Failed to read note "${options.path}".`, { path: options.path });
    }
    if (rawContent === null) {
      throw new EngineError("VAULT_WRITE_FAILED", `Note "${options.path}" does not exist.`, { path: options.path });
    }

    const projection = projectSource(options.identity, rawContent);
    if (projection.sourceHash !== options.expectedSourceHash) {
      throw new EngineError("SOURCE_STALE", `Note "${options.path}" changed since its metadata was computed; refusing to write.`, {
        path: options.path,
        expected: options.expectedSourceHash,
        actual: projection.sourceHash,
      });
    }

    const updates = buildMetadataUpdates(options.isAppleAnnotation, options.metadata);
    const removeKeys = options.isAppleAnnotation ? [...APPLE_ANNOTATION_CLEARED_KEYS] : undefined;
    const withFrontmatter = updateFrontmatter(rawContent, {
      updates,
      preferredOrder: [...MANAGED_FRONTMATTER_KEYS],
      removeKeys,
    });

    const newline = detectNewline(rawContent);
    const { body } = splitFrontmatter(withFrontmatter);
    let newBody = body;
    if (options.isAppleAnnotation) {
      newBody = clearManagedRelatedSection(body, options.mindmapHeading);
    } else if (options.writeMindmapSection) {
      newBody = updateRelatedSection(body, options.relatedLinks ?? [], { heading: options.mindmapHeading, newline });
    } else if (options.removeMindmapSection) {
      newBody = updateRelatedSection(body, [], { heading: options.mindmapHeading, newline });
    }

    const finalContent = replaceBody(withFrontmatter, newBody);
    if (finalContent === rawContent) {
      return { status: "unchanged", content: finalContent };
    }
    try {
      await this.vault.modify(options.path, finalContent);
    } catch {
      throw new EngineError("VAULT_WRITE_FAILED", `Failed to write note "${options.path}".`, { path: options.path });
    }
    return { status: "written", content: finalContent };
  }
}
