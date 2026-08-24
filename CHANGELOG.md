# Changelog

All notable changes to this project should be documented in this file.

## Unreleased

### Release process
- Update this changelog for every user-visible plugin release.
- Keep `manifest.json` and `versions.json` in sync.
- Document compatibility-impacting changes explicitly.

## 0.3.0

### Changed
- **Mindmap is now a standard, Python-free Obsidian plugin.** Every shipped/runtime Python file, the bundled runtime installer/discovery/verifier, the Python semantic-worker subprocess, the Python LaunchAgent, and the `python`/`tools/parity` directories are deleted from the repository and the release. The release bundle is exactly `main.js`, `manifest.json`, and `styles.css` — no `mindmap-python.zip`, no companion runtime, no interpreter to discover or install.
- The TypeScript `ProductionEngine` (embeddings, metadata, the exact-cosine vector index, job queue, scheduler, and Apple Books reading, all built out over the prior 0.3.0 development checkpoints) is now the **only** engine: it is mandatory on this desktop-only plugin, and a construction/start failure fails closed with a clear in-app notice rather than ever falling back to a subprocess.
- Runtime configuration (Ollama embedding/metadata provider and model, scope folders, Apple Books database overrides) now lives entirely in plugin settings (`data.json`), never a Python `config.json`. A vault upgrading from an earlier Python-powered install has its existing `config.json` values imported into settings automatically, once, the first time the new version loads; existing Chroma vector data is left untouched on disk and simply ignored (no automatic migration or deletion).
- Settings, the status-bar menu, and diagnostics/troubleshooting copy no longer mention Python, `pip`, virtual environments, or a runtime installer anywhere; the former "Advanced runtime overrides" (Python command/script/config path) fields are removed.
- README rewritten for the TypeScript-only architecture: Ollama (embeddings + local metadata), Apple Books reading through a fixed-argument `/usr/bin/sqlite3` call, the in-app scheduler plus an optional LaunchAgent adapter that only wakes/opens the vault (`/usr/bin/open`) — CoreScheduler performs the actual work once Obsidian is open — first-run migration/retry, and privacy/troubleshooting guidance for the new architecture.
- CI and the release workflow no longer install Python or run the Python test suite; both are Node-only (`npm ci`, lint, official Obsidian lint, typecheck, `npm test`, build, validate).
- Release validation (`npm run validate`) now asserts the release directory contains exactly three files, scans the built `dist/main.js` for any Python/Chroma/semantic-worker/runtime-installer string or process invocation, and confirms no `.py` file remains tracked in the repository.

### Removed
- `python/`, `tools/parity/` (the Python-oracle fixture/parity generators and the dev-shadow TypeScript comparison command), every Python unit test, the bundled-runtime-asset pipeline, the runtime discovery/setup/verifier/coordinator modules, the Python semantic-worker client, the Python LaunchAgent plist builder, and the Python config-migration helper.

`minAppVersion` is unchanged at `1.7.2` for this release; this is a runtime-architecture release, not an API-compatibility bump.

## 0.2.1

### Changed
- Standard/Reading mode selection is now explicit and idempotent: switching to Standard stops in-flight Reading watcher/debounce/queued work and prevents any later processing of it, switching to the already-active mode is a no-op, and a failed mode save rolls back cleanly instead of leaving the plugin in a partial state.
- The status-bar menu is distilled into compact Mode / Run / Reading (when active) / Research / Navigation groups with a single top recovery row, replacing the previous denser menu.
- Settings is reorganized into a linear flow — Overview, Reading and Research, Scope, Schedule, Local AI, Troubleshooting — with a single Overview readiness indicator, bounded and secret-redacted diagnostics export, and steadier save-on-blur behavior for scope/provider fields.
- Raised `minAppVersion` to `1.7.2` (matching the `Workspace.ensureSideLeaf`/`Workspace.revealLeaf` API requirement flagged by `obsidianmd/no-unsupported-api`) and added the corresponding `versions.json` entry.
- README `H1` now matches the manifest `name` (`Mindmap AI`) exactly, and its Requirements section reflects the new minimum Obsidian version.
- `manifest.json` description rewritten as concise, user-facing product copy, and `authorUrl` now points at the repository owner's GitHub profile.
- The official Community Plugins release now publishes only `main.js`, `manifest.json`, and `styles.css`; `mindmap-python.zip` is no longer attached to the GitHub release.
- Release workflow now attests `release/main.js`, `release/manifest.json`, and `release/styles.css` with `actions/attest` (build provenance) before publishing, and generates its release notes automatically instead of shipping an empty release body.
- Production network access for Web Research now goes through Obsidian's `requestUrl` instead of the global `fetch`, and hardcoded `.obsidian`-style path checks were generalized to any hidden/dot-prefixed path segment, ahead of the official Community Plugins review guidelines.

### Added
- Reading annotation notes and their generated book indexes are now excluded from ordinary pending/current/all scans (TypeScript and Python) so a Reading vault doesn't inflate day-to-day scope; explicit annotation targets and the daily maintenance run still include them where appropriate.
- Pinned `eslint-plugin-obsidianmd` as a dev dependency and a separate `npm run lint:obsidian` gate (scoped to shipped `src`, excluding tests), run in both CI and the release workflow alongside the project's own lint gate.

### Fixed
- Official Community Plugins lint findings across the shipped source (unsafe timers, promise/error handling, DOM/SVG creation, `instanceof` usage, unnecessary type assertions, and UI copy casing) were remediated with behavior-preserving changes; the one remaining accepted warning (`settings-tab/prefer-setting-definitions`) is documented in `src/settingsTab.ts`.

## 0.2.0

### Added
- Native status-menu controls for pending notes, individual-note runs, Reading Mode sync health, scheduler health, preflight, and Web Research state.
- Reading Mode imports Apple Books annotations through read-only source access and preserves source/user note content.
- Manual and Automatic for Reading Web Research with explicit consent, local Qwen preparation/synthesis, bounded Exa queries, Keychain credentials, and five-per-sync / ten-per-day limits.
- Zero-terminal runtime setup on macOS: on enable, Mindmap automatically discovers a compatible Python 3.11-3.13 (Framework, Homebrew, PATH, Xcode) and selects a working one immediately, with no terminal command or interpreter path to edit. When Python is found but the required packages are not installed, Settings and the status-bar menu offer a one-click **Set up Mindmap runtime** action that, after one explicit confirmation naming the PyPI download and the private, shared `~/Library/Application Support/Mindmap AI` install location, creates an isolated virtual environment, installs the pinned dependencies, and verifies the result using an isolated runtime-only preflight mode before activating it — all without restarting Obsidian. Setup shows live discovering/creating/installing/verifying progress and can be cancelled or retried at any point; if no compatible Python exists at all, Settings link directly to the official Python macOS installer. Manual/scheduled Mindmap runs, the semantic environment, automatic Reading research, backlog processing, and LaunchAgent installation stay gated until the runtime is ready, while Apple Books preview/import keeps working through the discovered interpreter. An explicit custom `pythonCommand` under Advanced settings is always validated as-is and is never replaced or offered automated setup.
- Reading Mode activation is import-only: the first enablement imports every eligible Apple Books annotation but processes none of the historical backlog automatically. A separately confirmed **Process Reading backlog** action (also available from the status menu) processes it explicitly; an annotation highlighted afterward is processed immediately and sequentially.
- Annotation notes use a short, human-readable title derived from the quote instead of a date or opaque ID, and their body is just the annotation as a leading blockquote with no visible technical marker. Concepts and related notes are stored as readable `[[wikilink]]` values; generated summary/tag fields are never written to an annotation note.
- Web Research for an Apple Books annotation is written to a separate companion note under the same book's `Research/` folder, linked from the annotation via a `research` frontmatter wikilink, keeping the annotation body annotation-only.
- Daily scheduled maintenance extends its note universe with pending Reading annotations (`--include-reading-pending`); weekly refresh and manual runs never do. `Run Mindmap full rebuild (all notes)` preserves already-indexed Reading vector rows across the rebuild instead of discarding them.
- Minimal pull-request CI workflow (`.github/workflows/ci.yml`) runs install, lint, typecheck, TypeScript tests, Python tests, build, and release validation on every PR, using the repository's pinned lockfile/dependency versions and no secrets.

### Fixed
- Individual Reading annotation notes can run explicitly without widening scheduled all-scope maintenance.
- Reader cancellation, automatic-research retry/terminal handling, state recovery, and LaunchAgent reconciliation are guarded against stalled or unsafe states.
- Preflight, scheduler, and status errors remain actionable without exposing credentials or raw provider responses.
- Notes no longer lose hand-authored `## Related` / `## Mindmap` sections when `write_mindmap_section` is `false`. Stripping now requires the explicit `remove_mindmap_section` option (default `false`), and only the literal JSON boolean `true` enables it — a truthy non-boolean config value (e.g. the string `"false"`) no longer silently enables the strip.
- The configured LLM API key is trimmed on every resolution path, including when read from an environment variable or entered in Settings, before its truthiness selects an authentication mode or is persisted; a whitespace-only value no longer triggers a Bearer-auth request with a garbage token or clears the configured environment variable.
- `--apply-preview` now routes a stale Apple Books annotation preview entry through the same annotation-safe write rules as live/scheduled processing (no generated summary/tags, wikilink concepts/related, no generated body section) instead of writing the plain format; ordinary note preview entries are unchanged. Preview entries targeting plugin/runtime internals or carrying malformed metadata field types are now rejected rather than applied.

### Security
- `chromadb==1.4.0` is pinned for the tested embedded `PersistentClient` datastore. CVE-2026-45829 / PYSEC-2026-311 concerns the Python FastAPI server; Mindmap never starts or exposes that server. This does not claim the package itself is unflagged.
- The managed runtime installer runs `pip install` with a minimal allowlisted environment (`PATH`/`HOME`/`LANG`/`LC_ALL`/`TMPDIR` only, `PIP_CONFIG_FILE=/dev/null`) so ambient provider API keys and user-level pip index credentials can never be forwarded into the child process. `ruamel.yaml` is now pinned to the exact tested `0.19.1` release (Python `>=3.9`, compatible with the supported `3.11-3.13` range), alongside the existing `chromadb==1.4.0` pin, so both direct managed-runtime dependencies resolve deterministically.
- CI and release workflows check out the repository with `persist-credentials: false`, since neither workflow needs the job token to survive past the checkout step for any subsequent `git` operation.

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
