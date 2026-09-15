# Remove generated Mindmap footer design

**Date:** 2026-09-14  
**Branch:** `fix/remove-mindmap-footer`  
**Baseline:** latest `origin/main`, plugin version `0.3.5`

## Goal and scope

Remove the generated Mindmap/Related body footer from ordinary notes during normal processing while preserving all frontmatter and every existing related-output consumer. This is a frontmatter-only output change: no sidebar query/ranking/cards/graph/content API or UI behavior changes, no queue edits, and no plugin version/release change.

## Existing behavior to preserve

Ordinary-note processing continues to use the existing `selectRelated` behavior, embedding/index vectors, related candidate kinds, and related frontmatter fields/values unchanged. Sidebar queries, ranking, cards, graph/content APIs, and their UI remain byte- and behavior-identical. Apple Books annotation handling remains unchanged, including its existing managed-section behavior.

## Note rewrite behavior

`NoteJobRunner` still computes/selects related candidates for ordinary notes as it does today, but passes no body `relatedLinks` to `NoteWriter`. It sets `writeMindmapSection: false` and `removeMindmapSection: true` for ordinary notes. `NoteWriter` therefore removes an existing managed Mindmap/Related callout and its owned divider when rewriting a note, without creating a replacement callout.

The rewrite preserves:

- all unrelated frontmatter and managed related frontmatter;
- user-authored body text, headings, dividers, and whitespace outside the owned footer;
- source-hash calculation and stale-source checks;
- Apple annotation output and all non-ordinary note paths.

The owned footer boundary is the existing managed callout/divider format already recognized by `relatedSectionWriter`; no broad body cleanup or heuristic deletion is introduced. If the body is ambiguous or malformed, the writer fails closed according to its existing frontmatter/body validation rather than deleting user content.

## Related-output freshness and reprocessing

Increment `PRODUCTION_RELATED_VERSION` from `1` to `2`. The production catalog predicate treats records with `relatedVersion < 2` as stale even when source hash and identity match. A manual all-scope refresh consequently reprocesses every eligible configured-scope note whose catalog record is version 1, removing any existing generated footer and writing a version-2 overlay. Records already at version 2 remain current and are not redundantly reprocessed.

The version is internal related-output freshness metadata only. `package.json`, `package-lock.json`, `manifest.json`, `versions.json`, release tags, and GitHub release metadata remain unchanged at `0.3.5`.

## Atomicity and recovery

Existing JobEngine phase boundaries, source freshness checks, queue persistence, operator/provider pause semantics, restart recovery, coalescing, and batch ownership remain unchanged. No queue document is edited or reset directly. Normal processing writes the note and overlay through their existing durable paths; a failure leaves the existing retry/recovery position intact.

## Tests

Add focused regressions for:

1. ordinary-note frontmatter and related values are retained exactly;
2. an existing generated Mindmap/Related callout plus owned divider is removed;
3. no new callout is created when rewriting an ordinary note;
4. user body text and user-authored dividers remain byte-identical;
5. source-hash stability is unchanged;
6. catalog records with related version 1 are stale and version 2 are current;
7. a manual all-scope refresh reprocesses version-1 eligible notes and writes version-2 overlays;
8. Apple annotation behavior is unchanged;
9. sidebar production/workspace query, ranking, card, graph, and content tests remain unchanged and passing.

## Delivery constraints

This checkpoint is documentation-first, followed by a lean implementation and focused tests. Commit the design and implementation normally on this branch, then push/merge through review. Build the merged `main` and install only after the explicit manager checkpoint. Operational all-notes processing occurs only through the existing non-confirming mindmap-run-all command after installation; never edit queue state directly. Do not re-enable production Mindmap or touch vault data before that checkpoint.

## Self-review

- Footer removal is limited to ordinary-note body output; frontmatter and all read/query/UI consumers are explicitly preserved.
- Version 2 is internal catalog freshness, not a plugin release bump.
- Version-1 records become stale; version-2 records remain current.
- Apple annotation, pause/restart, atomic phases, and queue semantics are not redesigned.
- No ambiguous deletion rule permits removal of user-authored content outside the existing managed footer boundary.
