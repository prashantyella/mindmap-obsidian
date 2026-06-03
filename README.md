# Mindmap for Obsidian

Mindmap is a desktop-only Obsidian plugin that runs a local Python workflow to:
- summarize notes
- suggest tags and concepts
- generate related-note links in a `## Mindmap` section
- search indexed notes with natural-language questions
- pin high-value connections to the active note

## Requirements

- Obsidian Desktop `1.5.12+`
- Python `3.10+`
- Ollama running locally at `http://localhost:11434`
- oMLX with `gemma-4-E4B-it-MLX-8bit` for metadata extraction
- Ollama models:
  - `mxbai-embed-large`

## Install

1. In Obsidian: `Settings -> Community plugins`.
2. Install and enable `Mindmap`.
   On first enable, the plugin can restore its Python runtime automatically inside the plugin folder.
3. From your vault root, install Python dependencies:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-ai/python/requirements.txt
```

4. Pull required Ollama embedding model and install the default oMLX metadata model:

```bash
ollama pull mxbai-embed-large
```

Install `gemma-4-E4B-it-MLX-8bit` in oMLX, then set the local oMLX API key in Mindmap settings if your oMLX server requires one.

## First Run

1. Run `Run Mindmap preflight checks` from Command Palette.
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

- Daily Mon-Sat 02:30: `--all --apply`
- Weekly Sunday 03:00: `--all --refresh-all --apply`

## Vault Path Safety

By default, Mindmap stores runtime data under `.obsidian/plugins/mindmap-ai/` inside your current vault; if you customize runtime paths, keep them vault-relative and inside the same vault.

## Troubleshooting

- Python/dependency issues:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-ai/python/requirements.txt
```

- Missing models:

```bash
ollama pull mxbai-embed-large
```

For metadata extraction, confirm oMLX exposes `gemma-4-E4B-it-MLX-8bit` from `http://localhost:8000/v1/models`.

- Plugin shows `scope setup required`:
  - complete `Scope setup` in plugin settings and save.

## Notes

- Desktop only (`isDesktopOnly: true`)
- Mobile is not supported
- All processing is local (Python + Ollama/oMLX on your machine)

## Release Metadata

- `manifest.json` defines plugin ID, version, and compatibility.
- `versions.json` maps plugin versions to minimum Obsidian versions.
