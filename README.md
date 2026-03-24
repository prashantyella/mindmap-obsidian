# Mindmap for Obsidian

Mindmap is a desktop-only Obsidian plugin that orchestrates a local Python pipeline for note summarization, tagging, concept extraction, and related-note suggestions.

The v1 plugin keeps the Python engine intact. The TypeScript plugin handles commands, settings, validation, scheduling, status, and release packaging.

## Desktop-only support

This plugin sets `isDesktopOnly: true` and is intended for Obsidian Desktop on macOS, Windows, and Linux.

Mobile is not supported in v1 because the runtime depends on a local Python installation and a locally reachable Ollama server.

## Requirements

Before using the plugin, install and verify:

- Obsidian Desktop `1.5.12+`
- Python `3.10+`
- Ollama running locally at `http://localhost:11434` unless you change the config
- The required Ollama models
  - Embeddings: `mxbai-embed-large`
  - LLM: `llama3.1:8b`

Install Python dependencies for the bundled runtime:

```bash
python3 -m pip install -r python/requirements.txt
```

Pull the default Ollama models:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

## Installation

### Manual install from a release

1. Download these release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `mindmap-python.zip`
2. Create the plugin folder at `.obsidian/plugins/mindmap-obsidian/` in your vault.
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Extract `mindmap-python.zip` so the Python runtime files are available to the plugin.
5. Enable the plugin in Obsidian.
6. Open the plugin settings and confirm Python, script, config, and Ollama preflight checks pass.

### Community plugin compatibility

The release metadata is prepared for Obsidian community-plugin packaging:

- `manifest.json` declares the plugin ID, version, minimum app version, and desktop-only support.
- `versions.json` maps each plugin version to its required `minAppVersion`.
- The release workflow publishes the standard plugin assets plus the Python runtime bundle required for v1.

## Usage

The primary flow in v1 is local and explicit:

1. Install Python dependencies and Ollama prerequisites.
2. Enable the plugin.
3. Review the settings and keep portable defaults unless you need vault-relative overrides.
4. Run the manual command from the command palette.
5. Inspect status, pending items, and logs from the plugin UI.

Manual execution is the first-class path on every supported desktop platform.

## Runtime files

The repository ships the Python engine in [`python/`](python/):

- `mindmap.py`
- `requirements.txt`
- `config.template.json`

The portable config template avoids machine-specific absolute paths. Script and config resolution are validated by the plugin before execution.

## Local development

Requirements:

- Node.js `20+`
- npm `10+`
- Python `3.10+`
- `zip` available on the host machine for release packaging

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm test
python3 -m unittest tests/test_frontmatter.py
npm run build
npm run validate
```

Prepare release assets:

```bash
npm run release:prepare
```

## Release assets

`npm run release:prepare` and the GitHub Actions release workflow produce:

- `main.js`
- `manifest.json`
- `styles.css`
- `mindmap-python.zip`

`mindmap-python.zip` contains:

- `mindmap.py`
- `requirements.txt`
- `config.template.json`

## Version compatibility

Keep these files aligned on every release:

- `manifest.json`
  - `version`
  - `minAppVersion`
- `versions.json`
  - must contain an entry mapping `manifest.version` to `manifest.minAppVersion`

`npm run validate` fails if those files drift out of sync.

## Contributing and releases

- Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md)
- Release history and release-note discipline: [CHANGELOG.md](CHANGELOG.md)
- License: [LICENSE](LICENSE)
