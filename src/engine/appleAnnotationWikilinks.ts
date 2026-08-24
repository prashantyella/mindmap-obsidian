/**
 * Ports `sanitize_apple_annotation_concept`, `apple_annotation_concept_wikilink(s)`,
 * `is_safe_apple_annotation_related_target`, and `apple_annotation_related_wikilink(s)`
 * from python/mindmap.py. Apple Books annotation notes render their
 * `concepts`/`related` metadata as readable Obsidian wikilinks rather than
 * plain values (see `build_metadata_updates`); this module is the single
 * place that sanitization/rendering happens for the TypeScript engine.
 */

const MAX_ANNOTATION_COMPONENT_LENGTH = 80;
const RESERVED_ANNOTATION_COMPONENTS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** Strips control/path-unsafe characters, bounds length, and falls back to `fallback` rather than silently dropping an unusable concept. */
export function sanitizeAppleAnnotationConcept(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").normalize("NFKC");
  let cleaned = Array.from(normalized)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join("");
  cleaned = cleaned
    .replace(/[\\/]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/[<>:"|?*#[\]]/g, "-")
    .replace(/-+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .replace(/^\.+/, "")
    .trim();
  const bounded = Array.from(cleaned).slice(0, MAX_ANNOTATION_COMPONENT_LENGTH).join("");
  if (!bounded || bounded === "." || bounded === ".." || !/[\p{L}\p{N}]/u.test(bounded)) {
    return fallback;
  }
  if (RESERVED_ANNOTATION_COMPONENTS.has(bounded.toLowerCase())) {
    return `${bounded}-`;
  }
  return bounded;
}

export function appleAnnotationConceptWikilink(concept: string): string {
  const cleaned = sanitizeAppleAnnotationConcept(concept, "Concept");
  return `[[${cleaned}]]`;
}

/** Concepts arrive already bounded by the configured concept limit upstream; this only sanitizes and deduplicates. */
export function appleAnnotationConceptWikilinks(concepts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const concept of concepts) {
    const link = appleAnnotationConceptWikilink(concept);
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }
  return out;
}

const RESERVED_PATH_CHAR_PATTERN = /[[\]|]/;

/**
 * Rejects anything structurally unsafe (absolute paths, `..` traversal,
 * non-Markdown targets, control characters, wikilink delimiters) instead of
 * sanitizing it, so a valid Unicode vault-relative path passes through
 * untouched -- including a legitimate dot-prefixed user folder such as
 * `.journal/Note.md`, which is not unsafe on its own.
 *
 * Deliberately does NOT exclude Obsidian's configuration folder here: that
 * folder is user-configurable (`Vault#configDir`, not always literally
 * `.obsidian`) and this is a pure, vault-independent string sanitizer with
 * no access to that configuration. Excluding the actual configured config
 * directory is the calling catalog/site's responsibility, where the real
 * `configDir` value is in scope.
 */
export function isSafeAppleAnnotationRelatedTarget(relpath: string): boolean {
  const text = String(relpath);
  if (!text.trim()) return false;
  if (Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  })) {
    return false;
  }
  if (RESERVED_PATH_CHAR_PATTERN.test(text)) return false;
  const normalized = text.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\")) return false;
  const segments = normalized.split("/");
  if (segments.includes("..")) return false;
  return normalized.toLowerCase().endsWith(".md");
}

export function appleAnnotationRelatedWikilink(relpath: string): string {
  const text = String(relpath);
  if (!isSafeAppleAnnotationRelatedTarget(text)) return "";
  const normalized = text.replace(/\\/g, "/");
  const target = normalized.slice(0, -3);
  const label = target.split("/").pop() || target;
  return `[[${target}|${label}]]`;
}

export function appleAnnotationRelatedWikilinks(related: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const relpath of related) {
    const link = appleAnnotationRelatedWikilink(relpath);
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }
  return out;
}
