# Mindmap for Obsidian

Mindmap is a desktop-only Obsidian plugin that runs a local Python workflow to:
- summarize notes
- suggest tags and concepts
- generate related-note links in a `## Mindmap` section

## Requirements

- Obsidian Desktop `1.5.12+`
- Python `3.10+`
- Ollama running locally at `http://localhost:11434`
- Ollama models:
  - `mxbai-embed-large`
  - `llama3.1:8b`

## Install

1. In Obsidian: `Settings -> Community plugins`.
2. Install and enable `Mindmap`.
3. From your vault root, install Python dependencies:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-obsidian/python/requirements.txt
```

4. Pull required Ollama models:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

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

## Main Commands

- `Run Mindmap preflight checks`
- `Run Mindmap (current scope)`
- `Run Mindmap (all scopes)`
- `Show Mindmap status`

## Vault Path Safety

By default, Mindmap stores runtime data under `.obsidian/plugins/mindmap-obsidian/` inside your current vault; if you customize runtime paths, keep them vault-relative and inside the same vault.

## Troubleshooting

- Python/dependency issues:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-obsidian/python/requirements.txt
```

- Missing models:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

- Plugin shows `scope setup required`:
  - complete `Scope setup` in plugin settings and save.

## Notes

- Desktop only (`isDesktopOnly: true`)
- Mobile is not supported
- All processing is local (Python + Ollama on your machine)
