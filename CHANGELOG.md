# Changelog

All notable changes to this project should be documented in this file.

## Unreleased

### Added
- Reading Mode activation is import-only: the first enablement imports every eligible Apple Books annotation but processes none of the historical backlog automatically. A separately confirmed **Process Reading backlog** action (also available from the status menu) processes it explicitly; an annotation highlighted afterward is processed immediately and sequentially.
- Annotation notes use a short, human-readable title derived from the quote instead of a date or opaque ID, and their body is just the annotation as a leading blockquote with no visible technical marker. Concepts and related notes are stored as readable `[[wikilink]]` values; generated summary/tag fields are never written to an annotation note.
- Web Research for an Apple Books annotation is written to a separate companion note under the same book's `Research/` folder, linked from the annotation via a `research` frontmatter wikilink, keeping the annotation body annotation-only.
- Daily scheduled maintenance extends its note universe with pending Reading annotations (`--include-reading-pending`); weekly refresh and manual runs never do. `Run Mindmap full rebuild (all notes)` preserves already-indexed Reading vector rows across the rebuild instead of discarding them.
- Minimal pull-request CI workflow (`.github/workflows/ci.yml`) runs install, lint, typecheck, TypeScript tests, Python tests, build, and release validation on every PR, using the repository's pinned lockfile/dependency versions and no secrets.

### Fixed
- Notes no longer lose hand-authored `## Related` / `## Mindmap` sections when `write_mindmap_section` is `false`. Stripping now requires the explicit `remove_mindmap_section` option (default `false`), and only the literal JSON boolean `true` enables it — a truthy non-boolean config value (e.g. the string `"false"`) no longer silently enables the strip.
- The configured LLM API key is trimmed on every resolution path, including when read from an environment variable, before its truthiness selects an authentication mode; a whitespace-only value no longer triggers a Bearer-auth request with a garbage token.
- `--apply-preview` now routes a stale Apple Books annotation preview entry through the same annotation-safe write rules as live/scheduled processing (no generated summary/tags, wikilink concepts/related, no generated body section) instead of writing the plain format; ordinary note preview entries are unchanged. Preview entries targeting plugin/runtime internals or carrying malformed metadata field types are now rejected rather than applied.

### Release process
- Update this changelog for every user-visible plugin release.
- Keep `manifest.json` and `versions.json` in sync.
- Document compatibility-impacting changes explicitly.

## 0.2.0

### Added
- Native status-menu controls for pending notes, individual-note runs, Reading Mode sync health, scheduler health, preflight, and Web Research state.
- Reading Mode imports Apple Books annotations through read-only source access and preserves source/user note content.
- Manual and Automatic for Reading Web Research with explicit consent, local Qwen preparation/synthesis, bounded Exa queries, Keychain credentials, and five-per-sync / ten-per-day limits.

### Fixed
- Individual Reading annotation notes can run explicitly without widening scheduled all-scope maintenance.
- Reader cancellation, automatic-research retry/terminal handling, state recovery, and LaunchAgent reconciliation are guarded against stalled or unsafe states.
- Preflight, scheduler, and status errors remain actionable without exposing credentials or raw provider responses.

### Security
- `chromadb==1.4.0` is pinned for the tested embedded `PersistentClient` datastore. CVE-2026-45829 / PYSEC-2026-311 concerns the Python FastAPI server; Mindmap never starts or exposes that server. This does not claim the package itself is unflagged.

## 0.1.3

### Changed
- Updated plugin display name to `Mindmap AI` to avoid collisions in the community directory.
- Updated plugin description to satisfy community directory validation rules.

## 0.1.2

### Changed
- Updated plugin ID from `mindmap-obsidian` to `mindmap-ai` for community-directory compliance.
- Updated bundled runtime paths, dependency guidance, and defaults to use `.obsidian/plugins/mindmap-ai/`.
- Updated tests and docs to reflect the new plugin ID and install paths.

## 0.1.1

### Fixed
- Pending counter now correctly includes vault-wide scope (`"."`) notes.
- Bundled `config.json` vault root migration for existing installs using legacy `../..` path.
- Default bundled runtime config now targets correct plugin-to-vault relative root.
- Mindmap callout output no longer inserts the graph command shortcut link.

### Changed
- Mindmap callout UI spacing tightened and icon hidden for a cleaner output.
- Release validation now enforces the correct bundled `vault_root`.

## 0.1.0

### Added
- Standalone Obsidian plugin scaffold and release packaging.
- Portable runtime path resolution and validation.
- Safer frontmatter mutation in the Python runtime.
- Cross-platform internal scheduler support.
- Subprocess trust-boundary hardening.
- UI regression guard against unsafe HTML insertion.
- Incremental pending-scan infrastructure for large vaults.
- Public release metadata and compliance essentials.
