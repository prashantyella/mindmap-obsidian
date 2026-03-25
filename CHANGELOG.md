# Changelog

All notable changes to this project should be documented in this file.

## Unreleased

### Release process
- Update this changelog for every user-visible plugin release.
- Keep `manifest.json` and `versions.json` in sync.
- Document compatibility-impacting changes explicitly.

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
