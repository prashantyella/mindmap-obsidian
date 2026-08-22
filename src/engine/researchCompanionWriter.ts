import { Document, parseDocument } from "yaml";

import { companionPathForAnnotation, isValidAnnotationSourcePath } from "../readingResearchCompanion";
import { hasControlOrDelimiterChar } from "../readingTypes";
import { EngineError } from "./errors";
import { splitFrontmatter } from "./frontmatterCore";
import type { NoteVaultAdapter } from "./noteWriter";

/**
 * Companion-note write safety, reusing the same structural rules the
 * existing proven src/readingResearchCompanion.ts primitives enforce
 * rather than drifting a parallel copy of them:
 *
 * - `isValidAnnotationSourcePath` (imported, unchanged) requires the exact
 *   6-segment `.../Annotations/<file>.md` shape and rejects control/
 *   traversal/wikilink-delimiter characters.
 * - `companionPathForAnnotation` (imported, unchanged) is the SOLE
 *   generator of every candidate/collision-numbered companion path this
 *   module ever reads or writes -- both the default candidates this module
 *   generates itself and any caller-supplied `storedCompanionPath` are
 *   required to be one of ITS outputs (`isKnownCandidatePath`), so "the
 *   same books Research folder, single basename, no traversal" is
 *   guaranteed by construction rather than re-validated by a second,
 *   possibly-drifting path-shape check.
 *
 * Unlike src/readingResearchCompanion.ts's `writeCompanionNote` (manual
 * `yamlScalar()`/regex-based `readFrontmatterValue()`), this module renders
 * and reads the companion note's frontmatter through the `yaml` package's
 * `Document` API -- the same engine already uses in `frontmatterEngine.ts`
 * -- so any value needing YAML quoting (a colon, a purely numeric-looking
 * ID, wikilink brackets in `source`) is always quoted/round-tripped
 * correctly rather than relying on a hand-written quoting heuristic.
 */

/**
 * Renders the companion note's frontmatter + content. Throws a plain
 * `Error` (not `EngineError`) for a caller-supplied precondition violation
 * -- these are invariants the caller (not the vault) is responsible for
 * upholding, mirroring the original module's behavior.
 */
export function renderResearchCompanionNote(annotationPath: string, annotationId: string, content: string): string {
  if (!isValidAnnotationSourcePath(annotationPath)) {
    throw new Error("Invalid annotation source path for research companion note.");
  }
  const trimmedId = annotationId.trim();
  if (!trimmedId || hasControlOrDelimiterChar(trimmedId)) {
    throw new Error("Research companion note requires a valid, non-empty annotation_id.");
  }
  if (!content.trim()) {
    throw new Error("Research companion note requires non-empty research content.");
  }
  const link = `[[${annotationPath.replace(/\\/g, "/").replace(/\.md$/i, "")}]]`;
  const doc = new Document();
  doc.contents = doc.createNode({
    type: "mindmap-reading-research",
    source: link,
    annotation_id: trimmedId,
  });
  const frontmatter = doc.toString({ singleQuote: true, lineWidth: 0 });
  return `---\n${frontmatter}---\n${content}\n`;
}

/** `undefined` for anything that isn't a well-formed frontmatter block, isn't valid YAML, or has no string `annotation_id` -- never throws. */
function readAnnotationId(text: string): string | undefined {
  const { frontmatterRaw } = splitFrontmatter(text);
  if (frontmatterRaw === null) return undefined;
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(frontmatterRaw, { uniqueKeys: true });
  } catch {
    return undefined;
  }
  if (doc.errors.length > 0) return undefined;
  const value: unknown = doc.get("annotation_id");
  return typeof value === "string" ? value : undefined;
}

/** Ensures every ancestor folder of `filePath` exists, starting from its very top-level segment (not just its immediate parent) -- required because the top-level `Books` folder is not guaranteed to already exist. */
async function ensureAncestorFolders(vault: NoteVaultAdapter, filePath: string): Promise<void> {
  const parts = filePath.split("/");
  for (let index = 0; index < parts.length - 1; index += 1) {
    await vault.ensureFolder(parts.slice(0, index + 1).join("/"));
  }
}

type ProbeResult = { kind: "missing" } | { kind: "unreadable" } | { kind: "content"; text: string };

/** A path that exists but can't be read (permission error, binary file, adapter fault) is treated exactly like an unrelated occupied path -- never as "safe to overwrite" and never as "missing." */
async function probePath(vault: NoteVaultAdapter, path: string): Promise<ProbeResult> {
  let text: string | null;
  try {
    text = await vault.read(path);
  } catch {
    return { kind: "unreadable" };
  }
  return text === null ? { kind: "missing" } : { kind: "content", text };
}

async function modifyCompanionFile(vault: NoteVaultAdapter, path: string, text: string): Promise<void> {
  try {
    await vault.modify(path, text);
  } catch {
    throw new EngineError("VAULT_WRITE_FAILED", `Failed to write research companion note "${path}".`, { path });
  }
}

const MAX_COLLISION_ATTEMPTS_CEILING = 100;

/** Validated before any vault probing: a positive integer, bounded at `MAX_COLLISION_ATTEMPTS_CEILING`. Rejects 0, negative, fractional, `NaN`/`Infinity`, and anything above the ceiling. */
function validateMaxCollisionAttempts(value: number | undefined): number {
  if (value === undefined) return MAX_COLLISION_ATTEMPTS_CEILING;
  if (!Number.isInteger(value) || value < 1 || value > MAX_COLLISION_ATTEMPTS_CEILING) {
    throw new EngineError(
      "CONTRACT_SHAPE_INVALID",
      `maxCollisionAttempts must be a positive integer no greater than ${MAX_COLLISION_ATTEMPTS_CEILING}.`,
      { value },
    );
  }
  return value;
}

/** True only when `candidatePath` is exactly one of `companionPathForAnnotation`'s own deterministic outputs for `annotationPath` -- the single source of truth for "is this a structurally valid companion path for this annotation," reused rather than re-implemented. */
function isKnownCandidatePath(annotationPath: string, candidatePath: string, maxAttempts: number): boolean {
  for (let index = 0; index < maxAttempts; index += 1) {
    if (companionPathForAnnotation(annotationPath, index) === candidatePath) return true;
  }
  return false;
}

export interface WriteResearchCompanionOptions {
  annotationPath: string;
  annotationId: string;
  content: string;
  /** A previously recorded companion path to try first/reuse. Only honored when it is exactly one of `companionPathForAnnotation`'s own candidate outputs for `annotationPath` -- anything else is ignored and the normal candidate search below runs instead. */
  storedCompanionPath?: string;
  maxCollisionAttempts?: number;
}

export interface WriteResearchCompanionResult {
  action: "created" | "updated" | "unchanged";
  companionPath: string;
}

/**
 * Re-probes a path after a lost exclusive-create race (or after a `create`
 * failure that might be a race): adopts/updates the occupant only if its
 * `annotation_id` matches this write's own annotation -- a concurrent
 * writer's unrelated note occupying the path is never overwritten, and the
 * caller is told to move on to the next collision candidate instead
 * (`kind: "foreign"`). A path that is still missing/unreadable after the
 * `create` call failed is a genuine write failure, not a race
 * (`kind: "failed"`).
 */
async function adoptAfterLostCreateRace(
  vault: NoteVaultAdapter,
  path: string,
  noteText: string,
  trimmedId: string,
): Promise<{ kind: "unchanged" } | { kind: "updated" } | { kind: "foreign" } | { kind: "failed" }> {
  const reprobe = await probePath(vault, path);
  if (reprobe.kind !== "content") {
    return { kind: "failed" };
  }
  if (readAnnotationId(reprobe.text) !== trimmedId) {
    return { kind: "foreign" };
  }
  if (reprobe.text === noteText) {
    return { kind: "unchanged" };
  }
  await modifyCompanionFile(vault, path, noteText);
  return { kind: "updated" };
}

/**
 * Idempotent create/update over the deterministic candidate sequence
 * `companionPathForAnnotation` generates: an existing companion note is
 * only reused/overwritten when its `annotation_id` matches; anything else
 * occupying a candidate path (a foreign note, or a path that exists but
 * can't be read) is left untouched and the search moves to the next
 * collision-numbered candidate, bounded by `maxCollisionAttempts`.
 *
 * A brand-new companion note is written with an exclusive `create`, never
 * a create-or-overwrite `modify` -- if a concurrent writer wins the race
 * and occupies the path first, `create` rejects and this function re-probes
 * (`adoptAfterLostCreateRace`) rather than blindly overwriting whatever the
 * race winner wrote: it adopts/updates only if the winner's own
 * `annotation_id` matches, and otherwise moves on to the next
 * collision-numbered candidate exactly as it would for any other foreign
 * occupant.
 */
export async function writeResearchCompanionNote(
  vault: NoteVaultAdapter,
  options: WriteResearchCompanionOptions,
): Promise<WriteResearchCompanionResult> {
  const maxAttempts = validateMaxCollisionAttempts(options.maxCollisionAttempts);
  const noteText = renderResearchCompanionNote(options.annotationPath, options.annotationId, options.content);
  const trimmedId = options.annotationId.trim();

  if (options.storedCompanionPath && isKnownCandidatePath(options.annotationPath, options.storedCompanionPath, maxAttempts)) {
    const probe = await probePath(vault, options.storedCompanionPath);
    if (probe.kind === "content" && readAnnotationId(probe.text) === trimmedId) {
      if (probe.text === noteText) {
        return { action: "unchanged", companionPath: options.storedCompanionPath };
      }
      await modifyCompanionFile(vault, options.storedCompanionPath, noteText);
      return { action: "updated", companionPath: options.storedCompanionPath };
    }
  }

  for (let collisionIndex = 0; collisionIndex < maxAttempts; collisionIndex += 1) {
    const candidate = companionPathForAnnotation(options.annotationPath, collisionIndex);
    const probe = await probePath(vault, candidate);
    if (probe.kind === "missing") {
      await ensureAncestorFolders(vault, candidate);
      try {
        await vault.create(candidate, noteText);
        return { action: "created", companionPath: candidate };
      } catch {
        const outcome = await adoptAfterLostCreateRace(vault, candidate, noteText, trimmedId);
        if (outcome.kind === "unchanged") return { action: "unchanged", companionPath: candidate };
        if (outcome.kind === "updated") return { action: "updated", companionPath: candidate };
        if (outcome.kind === "foreign") continue;
        throw new EngineError("VAULT_WRITE_FAILED", `Failed to create research companion note "${candidate}".`, { path: candidate });
      }
    }
    if (probe.kind === "unreadable") {
      continue;
    }
    if (readAnnotationId(probe.text) === trimmedId) {
      if (probe.text === noteText) {
        return { action: "unchanged", companionPath: candidate };
      }
      await modifyCompanionFile(vault, candidate, noteText);
      return { action: "updated", companionPath: candidate };
    }
  }
  throw new EngineError("VAULT_WRITE_FAILED", "Too many research companion path collisions.", { annotationPath: options.annotationPath });
}
