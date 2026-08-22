# Mindmap for Obsidian

Mindmap is a desktop-only Obsidian plugin that runs a local Python workflow to:
- summarize notes
- suggest tags and concepts
- generate related-note links in a `## Mindmap` section
- search indexed notes with natural-language questions
- pin high-value connections to the active note

## Requirements

- Obsidian Desktop `1.5.12+`
- macOS, for the automated Python runtime setup below (Windows/Linux use an advanced manual interpreter path instead — see Advanced Runtime Overrides)
- Ollama running locally at `http://localhost:11434`
- oMLX with `Qwen3.5-9B-MLX-4bit` for metadata extraction
- Ollama models:
  - `mxbai-embed-large`

## Install

1. In Obsidian: `Settings -> Community plugins`.
2. Install and enable `Mindmap`.
3. On enable, Mindmap automatically looks for a compatible Python 3.11-3.13 already on your Mac (Framework installs, Homebrew, PATH, Xcode). If it finds one with the required packages already installed, it's selected and Mindmap is ready immediately — no terminal, no path to edit.
4. If Mindmap finds Python but not the required packages, Settings and the status-bar menu show **Runtime setup required** with a **Set up Mindmap runtime** action. Choosing it shows one confirmation before anything happens: Mindmap will create a private Python environment, download pinned packages from PyPI, and store them outside every vault under `~/Library/Application Support/Mindmap AI/runtime/<fingerprint>` (shared and reused across vaults; a change to the pinned package set creates a new versioned folder alongside the old one). This takes a few minutes and needs network access; setup shows live progress and can be cancelled or retried at any point.
5. If no compatible Python is found at all, Settings link directly to the official [Python macOS installer](https://www.python.org/downloads/macos/) (Python 3.11-3.13). Install it, then reopen Mindmap settings to retry discovery.
6. Pull required Ollama embedding model and install the default oMLX metadata model:

```bash
ollama pull mxbai-embed-large
```

Install `Qwen3.5-9B-MLX-4bit` in oMLX, then set the local oMLX API key in Mindmap settings if your oMLX server requires one.

## First Run

1. Confirm `Mindmap runtime` shows ready in Settings (see Install above), then run `Run Mindmap preflight checks` from Command Palette.
2. Open `Mindmap` settings -> `Scope setup`.
3. Select folders for both:
   - `Current scope (--current)`
   - `All scope (--all)`
4. Click `Save setup`.
5. Run one command:
   - `Run Mindmap (current scope)` or
   - `Run Mindmap (all scopes)`
   - `Run Mindmap metadata refresh (all notes)` to rewrite note metadata without rebuilding embeddings
   - `Run Mindmap full refresh (all notes)` after changing metadata models/prompts
   - `Run Mindmap full rebuild (all notes)` to wipe and rebuild the vector index

## Main Commands

- `Run Mindmap preflight checks`
- `Run Mindmap (current scope)`
- `Run Mindmap (all scopes)`
- `Run Mindmap metadata refresh (all notes)`
- `Run Mindmap full refresh (all notes)`
- `Run Mindmap full rebuild (all notes)`
- `Open Mindmap lookup`
- `Show Mindmap status`
- `Enable Mindmap LaunchAgent scheduler`
- `Disable Mindmap schedulers`

## Scheduling

Mindmap supports three scheduler modes:

- `Manual`: runs only from commands.
- `Interval`: runs current scope while Obsidian is open.
- `LaunchAgent`: writes plugin-managed macOS LaunchAgents so scheduled runs continue when Obsidian is closed.

LaunchAgent mode uses the plugin runtime resolved in settings. With default paths, scheduled runs use:

- `.obsidian/plugins/mindmap-ai/python/mindmap.py`
- `.obsidian/plugins/mindmap-ai/python/config.json`

Default LaunchAgent schedules:

- Daily Mon-Sat 02:30: `--all --apply --include-reading-pending`. The extra flag only adds already-imported, pending `Books/Apple Books` annotation notes to that run's note universe; it never reads the Apple Books database or widens your configured all-scope folders.
- Weekly Sunday 03:00: `--all --refresh-all --apply`. Weekly refresh never includes Reading notes.

Scheduled maintenance runs Mindmap only. It never starts Web Research.

`Run Mindmap full rebuild (all notes)` deletes and recreates the local vector collections for your configured all-scope folders. Any already-indexed Apple Books annotation vectors are snapshotted first and restored afterward, so a manual rebuild of your regular notes does not force the whole Reading history to be re-embedded by the next daily run.

## Reading Mode and Apple Books

Reading Mode is an experimental, opt-in workflow for Apple Books annotations. The first enablement previews access and eligible-note counts before any import. Mindmap reads the supported Apple Books annotation database and its WAL/SHM companions without modifying Apple Books or your source database.

**Import-only first activation.** Enabling Reading Mode imports every eligible annotation into your vault, but does not process the historical backlog automatically. If any annotations are pending right after import, Mindmap asks once whether to process them now. If you decline (or close the prompt), pending notes stay visible in the status menu behind a **Process Reading backlog** action you can trigger at any time, and they are also picked up by the next daily scheduled run (see Scheduling above).

**Live processing for new annotations.** Once Reading Mode is active, any annotation you highlight afterward is imported and processed immediately and sequentially while Obsidian is open, with no additional prompt. A failed note is left pending for manual or scheduled retry rather than retried in a tight loop.

**Readable notes.** Annotation notes live at `Books/Apple Books/<Author>/<Book>/Annotations/<Title>.md`, where `<Title>` is a short, human-readable title derived from the quote (falling back to your note, chapter, or location) instead of a date or opaque ID. The note body is just your annotation as a leading blockquote, plus any Apple Books note; there is no visible technical marker. Concepts and related notes are stored as readable `[[wikilink]]` values in frontmatter; Mindmap never writes generated summary or tag fields to an annotation note.

**Companion research.** When Web Research runs against an Apple Books annotation, its synthesis and sources are written to a separate companion note at `Books/Apple Books/<Author>/<Book>/Research/<Title>.md`, linked back from the annotation via a `research` frontmatter wikilink, so the annotation body itself stays annotation-only.

The native status menu shows Reading Mode, sync time, pending notes, and actionable import or processing errors. Turn Reading Mode off to stop its watcher and automatic work.

## Web Research

Web Research has three modes in the status menu and Settings:

- `Off`: no research requests.
- `Manual`: research selected text or an active Markdown note on demand.
- `Automatic for Reading`: includes the Manual actions and may research eligible Apple Books annotations while Reading Mode is active.

Before either research mode is enabled, Mindmap shows consent. Annotation or note excerpts stay on your machine for local Qwen query derivation and synthesis. Exa receives only one or two derived queries; it returns up to five bounded source excerpts and metadata. Unrelated vault content is never sent to Exa.

Automatic for Reading is capped at five attempts per sync and ten per local calendar day. The status menu and Settings show current usage, pauses, errors, and retry controls. A daily cap resumes after local midnight; scheduled maintenance does not use Web Research.

### Exa Keychain setup

Store the Exa API key in macOS Keychain under service `com.mindmap-ai.web-research` and account `exa-api-key`. Mindmap reads it through macOS Keychain; it does not persist the key in plugin settings, note frontmatter, logs, or diagnostics.

## Vault Path Safety

By default, Mindmap stores runtime data under `.obsidian/plugins/mindmap-ai/` inside your current vault; if you customize runtime paths, keep them vault-relative and inside the same vault.

## Advanced Runtime Overrides

Mindmap's automated setup covers macOS. Windows/Linux, and any macOS setup that needs a specific interpreter, use the **Advanced** section of Mindmap settings: set `pythonCommand` to an absolute interpreter path (with the required packages already installed) or a PATH command name. An explicit `pythonCommand` is validated as-is and is never replaced or offered automated setup; leave it blank or the default `python3` to re-enable automatic discovery.

## Troubleshooting

- Runtime setup shows `unavailable` or a Set up/Retry action never finishes: check Settings for the current status message, then use the **Retry** action. As a fallback, or on Windows/Linux, install dependencies manually against your own interpreter and set `pythonCommand` under Advanced (see above):

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-ai/python/requirements.txt
```

- Missing models:

```bash
ollama pull mxbai-embed-large
```

For metadata extraction, confirm oMLX exposes `Qwen3.5-9B-MLX-4bit` from `http://localhost:8000/v1/models`.

- Plugin shows `scope setup required`:
  - complete `Scope setup` in plugin settings and save.

## Notes

- Desktop only (`isDesktopOnly: true`)
- Mobile is not supported
- Mindmap processing and Qwen research preparation run locally. Optional Exa Web Research sends only derived queries as described above.

## Release Metadata

- `manifest.json` defines plugin ID, version, and compatibility.
- `versions.json` maps plugin versions to minimum Obsidian versions.
