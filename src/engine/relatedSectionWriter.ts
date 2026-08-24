import { canonicalizePath, type CanonicalPath, type RelatedCandidateKind } from "./contracts";
import { DEFAULT_MINDMAP_HEADING, stripManagedRelatedSection } from "./sourceProjection";

export interface RelatedSectionLink {
  /**
   * Prefer an already-`canonicalizePath`-validated `CanonicalPath` (as
   * `RelatedCandidateV1.path` already is). `updateRelatedSection` still
   * re-validates/re-canonicalizes every candidate at render time regardless
   * -- the branded type is a compile-time convenience for callers, never a
   * substitute for the runtime check, since nothing prevents an unsafe
   * string from being force-cast to it.
   */
  path: CanonicalPath;
  kind: RelatedCandidateKind;
}

const WIKILINK_DELIMITER_PATTERN = /[[\]|<>]/;

/**
 * Validates and canonicalizes a related-note target immediately before it
 * is embedded into wikilink/HTML markup. Rejects (returns `null` rather
 * than throwing -- one unsafe candidate must never abort the whole
 * related-section write) anything `canonicalizePath` itself rejects
 * (control characters, absolute/drive-letter/UNC paths, `..` traversal,
 * empty) plus `[`, `]`, `|`, which would otherwise let a crafted path
 * break out of the `[[path|label]]` wikilink syntax it is about to be
 * embedded in, and `<`, `>`, which would otherwise let a crafted path
 * inject markup into the surrounding `<span>`. The path/label are emitted
 * verbatim (matching python/mindmap.py's `update_related_section`) rather
 * than HTML-escaped -- escaping would change the wikilink target itself
 * for any otherwise-valid filename containing `&`, `'`, or `"`.
 */
function canonicalizeRelatedTarget(rawPath: string): CanonicalPath | null {
  let canonical: CanonicalPath;
  try {
    canonical = canonicalizePath(rawPath);
  } catch {
    return null;
  }
  if (WIKILINK_DELIMITER_PATTERN.test(canonical)) {
    return null;
  }
  return canonical;
}

/** Mirrors `Path(path).stem` in python/mindmap.py: strips only the final `.suffix`, keeps everything else, and falls back to the whole basename when there is no dot. */
function pathStem(fullPath: string): string {
  const basename = fullPath.split("/").pop() || fullPath;
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(0, dotIndex) : basename;
}

/** Validates/canonicalizes every candidate up front and drops the unsafe ones -- so a link list that becomes empty only after filtering is treated exactly like an originally-empty list (no callout header emitted for zero surviving items). */
function filterValidLinks(links: readonly RelatedSectionLink[]): { path: CanonicalPath; kind: RelatedCandidateKind }[] {
  const valid: { path: CanonicalPath; kind: RelatedCandidateKind }[] = [];
  for (const link of links) {
    const canonical = canonicalizeRelatedTarget(link.path);
    if (canonical === null) continue;
    valid.push({ path: canonical, kind: link.kind });
  }
  return valid;
}

function renderCalloutLines(links: readonly { path: CanonicalPath; kind: RelatedCandidateKind }[], newline: "\r\n" | "\n"): string {
  const lines = ["> [!mindmap]- Mindmap"];
  for (const link of links) {
    const label = pathStem(link.path);
    lines.push(`> - <span class="mindmap-link is-${link.kind}">[[${link.path}|${label}]]</span>`);
  }
  return lines.join(newline);
}

/** Removes trailing blank-only lines (using the given newline convention), preserving every other byte untouched. */
function trimTrailingBlankLines(text: string, newline: "\r\n" | "\n"): string {
  const lines = text.split(newline);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(0, end).join(newline);
}

/**
 * Mirrors `update_related_section` in python/mindmap.py, built on the
 * byte/CRLF-preserving `stripManagedRelatedSection` (Checkpoint 1) rather
 * than Python's own `strip_related_section`, which normalizes the whole
 * body to LF via `splitlines()`/`"\n".join()` even outside the section it
 * touches. Only the removed/regenerated managed region and its immediately
 * owned surrounding blank lines/divider are reformatted; every other body
 * byte (including its original CRLF/LF convention) survives untouched --
 * an intentional, documented improvement consistent with Checkpoint 2's
 * LF/CRLF preservation requirement.
 *
 * With no links, returns the body with any existing managed section
 * removed and nothing appended (used for both "no related notes found" and
 * an explicit remove-mindmap-section configuration).
 */
export function updateRelatedSection(
  body: string,
  links: readonly RelatedSectionLink[],
  options: { heading?: string; newline: "\r\n" | "\n" },
): string {
  const heading = options.heading ?? DEFAULT_MINDMAP_HEADING;
  const stripped = stripManagedRelatedSection(body, heading).text;
  const validLinks = filterValidLinks(links);
  if (validLinks.length === 0) {
    return stripped;
  }
  const trimmed = trimTrailingBlankLines(stripped, options.newline);
  const calloutBlock = renderCalloutLines(validLinks, options.newline);
  return `${trimmed}${options.newline}${options.newline}---${options.newline}${options.newline}${calloutBlock}${options.newline}`;
}

/**
 * Apple Books annotation notes never gain a generated Mindmap/Related body
 * section (see `build_metadata_updates`/`apply_note_frontmatter_write` in
 * python/mindmap.py): any existing managed section is removed and nothing
 * is ever appended, regardless of related links.
 */
export function clearManagedRelatedSection(body: string, heading: string = DEFAULT_MINDMAP_HEADING): string {
  return stripManagedRelatedSection(body, heading).text;
}
