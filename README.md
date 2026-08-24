# Mindmap AI

Mindmap is a desktop-only Obsidian plugin, written entirely in TypeScript and bundled into the plugin itself, that:
- summarizes notes
- suggests tags and concepts
- generates related-note links in a `## Mindmap` section
- searches indexed notes with natural-language questions
- pins high-value connections to the active note

Everything runs inside the Obsidian process. There is no companion runtime or separate executable to install, and no local network service other than the Ollama server you already run.

## Architecture

- **Engine.** A single TypeScript `ProductionEngine`, composed once when the plugin loads, owns embeddings, metadata extraction, the exact-cosine vector index, the persistent job queue, and the in-app scheduler. It is mandatory on this desktop-only plugin: if it fails to start, Mindmap fails closed with a clear in-app notice rather than falling back to anything else.
- **Models.** Ollama hosts both the embedding model and the local metadata model. No other provider is supported.
- **Apple Books.** Reading annotations are read directly from the local Apple Books SQLite database using a fixed-argument `/usr/bin/sqlite3` call (`shell: false`, read-only), never a general-purpose scripting engine or a modification of Apple's own database.
- **Scheduling.** An in-app `CoreScheduler` performs due work (daily maintenance, weekly refresh, Reading sync) once Obsidian is open. An optional macOS LaunchAgent adapter can additionally wake or open the vault at the scheduled time via a fixed `/usr/bin/open` call — it never runs Mindmap work itself while Obsidian is closed.
- **Configuration.** All runtime configuration (Ollama base URLs/models, scope folders, Apple Books database overrides) lives in plugin settings. A vault upgrading from an earlier plugin release has its existing configuration imported into settings automatically, once, the first time this version loads.

## Requirements

- Obsidian Desktop `1.7.2+`
- Ollama running locally, with:
  - an embedding model (default: `mxbai-embed-large`)
  - a metadata model (default: `llama3.1:8b`)

## Install

1. In Obsidian: `Settings -> Community plugins`.
2. Install and enable `Mindmap`.
3. Pull the Ollama models you plan to use:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

## First Run

1. Open `Mindmap` settings and confirm the **Overview** row reads Ready (or use **Run checks** and follow its guidance).
2. Under **Local AI**, confirm the embedding and metadata base URLs/models match your Ollama setup.
3. Under **Scope**, select folders for both the current-note scope and the all-notes scope, then save.
4. If this vault was previously running an earlier version of Mindmap, the status menu shows a first-run **migration** step that builds the TypeScript vector index; start it and let it finish (it can be retried if interrupted). A brand-new vault skips straight to indexing on its first run.
5. Run one command:
   - `Run Mindmap (current scope)` or
   - `Run Mindmap (all scopes)`
   - `Run Mindmap metadata refresh (all notes)` to rewrite note metadata without rebuilding embeddings
   - `Run Mindmap full refresh (all notes)` after changing metadata models/prompts
   - `Run Mindmap full rebuild (all notes)` to rebuild the vector index from the committed generation

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
- `LaunchAgent`: the in-app `CoreScheduler` performs daily/weekly/Reading-sync work whenever Obsidian is open, exactly like Interval mode does for its own schedule; additionally, an optional macOS LaunchAgent wakes or opens the vault at the scheduled time (a fixed `/usr/bin/open <vault>` call, disclosed and confirmed before it is installed) so that work can actually run even if Obsidian was closed at the scheduled time. The LaunchAgent itself never touches your notes, the index, or any model — it only opens the app.

Default schedules:

- Daily Monday-Saturday 02:30: an all-scope refresh.
- Weekly Sunday 03:00: a full all-scope rebuild.

Scheduled maintenance runs Mindmap only. It never starts Web Research.

`Run Mindmap full rebuild (all notes)` rebuilds the local vector index from the current committed generation for your configured all-scope folders, atomically switching over only once the rebuild is verified.

## Reading Mode and Apple Books

Reading Mode is an experimental, opt-in workflow for Apple Books annotations. The first enablement previews access and eligible-note counts before any import. Mindmap reads the local Apple Books annotation database (and its WAL/SHM companions) through a fixed-argument, read-only `/usr/bin/sqlite3` call — it never modifies Apple Books or your source database, and never invokes a general-purpose scripting engine.

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

Before either research mode is enabled, Mindmap shows consent. Annotation or note excerpts stay on your machine for local query derivation and synthesis, using the same Ollama metadata model configured under Local AI. Exa receives only one or two derived queries; it returns up to five bounded source excerpts and metadata. Unrelated vault content is never sent to Exa.

Automatic for Reading is capped at five attempts per sync and ten per local calendar day. The status menu and Settings show current usage, pauses, errors, and retry controls. A daily cap resumes after local midnight; scheduled maintenance does not use Web Research.

### Exa Keychain setup

Store the Exa API key in macOS Keychain under service `com.mindmap-ai.web-research` and account `exa-api-key`. Mindmap reads it through macOS Keychain; it does not persist the key in plugin settings, note frontmatter, logs, or diagnostics.

## Vault Path Safety

Mindmap stores its own runtime data (index, job queue, schedules) under `.obsidian/plugins/mindmap-ai/data/` inside your current vault, and never writes outside it. The only processes Mindmap ever starts are the four fixed-argument system binaries disclosed throughout this README (`/usr/bin/sqlite3` for Apple Books reads, `/usr/bin/security` for Keychain access, `/bin/launchctl` and `/usr/bin/open` for the optional LaunchAgent adapter) — always `shell: false`, never with vault content interpolated into the command line.

## Privacy

- Note and annotation content sent for embeddings or metadata extraction goes only to the Ollama server you configure (default `http://localhost:11434`); Mindmap never sends vault content to any other network destination on its own.
- Optional Exa Web Research sends only the one or two short derived queries described above, never raw note or annotation text, and never unrelated vault content.
- The Exa API key lives only in macOS Keychain; it is never written to plugin settings, note frontmatter, logs, or diagnostics output.
- Diagnostics you copy from Troubleshooting are bounded and redact anything key/token/secret/password/authorization-shaped before they are ever assembled.

## Troubleshooting

- Overview shows the engine is unavailable: open the Troubleshooting section, run **Run preflight**, and use **Copy diagnostics** for a bounded, redacted report of provider/scheduler/engine state.
- Missing models:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

- Plugin shows `scope setup required`:
  - complete Scope setup in plugin settings and save.
- A first-run migration failed partway: reopen the status menu and use **Retry migration** — it resumes rather than starting over, and never touches the vault's existing note content.

## Notes

- Desktop only (`isDesktopOnly: true`)
- Mobile is not supported
- Mindmap processing and query preparation for Web Research run locally through Ollama. Optional Exa Web Research sends only derived queries as described above.

## Release Metadata

- `manifest.json` defines plugin ID, version, and compatibility.
- `versions.json` maps plugin versions to minimum Obsidian versions.
