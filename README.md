# Mindmap for Obsidian

Mindmap is a desktop-only Obsidian plugin that runs a local Python workflow for note summarization, tagging, concept extraction, and related-note suggestions.

The TypeScript plugin handles commands, settings, runtime validation, scope setup, scheduler status, and release packaging. The Python runtime under `python/` does the indexing and note updates.

## Desktop-only support

This plugin sets `isDesktopOnly: true` and is intended for Obsidian Desktop on macOS, Windows, and Linux.

Mobile is not supported in v1 because the runtime depends on a local Python installation and a locally reachable Ollama server.

## Quick start (new user onboarding)

### 1. Prerequisites

Install and verify:

- Obsidian Desktop `1.5.12+`
- Python `3.10+`
- Ollama running locally at `http://localhost:11434` (default)
- Required models:
  - Embeddings: `mxbai-embed-large`
  - LLM: `llama3.1:8b`

### 2. Install plugin files (manual release install)

1. Download these release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `mindmap-python.zip`
2. Create `.obsidian/plugins/mindmap-obsidian/` in your vault.
3. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
4. Extract `mindmap-python.zip` into `.obsidian/plugins/mindmap-obsidian/` so `python/` exists there.
5. Enable the plugin in Obsidian.

When the plugin is enabled, it creates `.obsidian/plugins/mindmap-obsidian/python/config.json` from `config.template.json` if `config.json` does not already exist.

### 3. Install Python dependencies (exact command)

Run from your vault root:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-obsidian/python/requirements.txt
```

### 4. Pull Ollama models (exact commands)

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

### 5. Run plugin preflight validation

In Obsidian Command Palette, run:

- `Run Mindmap preflight checks`

Optional shell equivalent (from vault root):

```bash
python3 .obsidian/plugins/mindmap-obsidian/python/mindmap.py --config .obsidian/plugins/mindmap-obsidian/python/config.json --preflight
```

### 6. Complete scope setup (required before first run)

In plugin settings:

1. Open `Runtime` and keep defaults unless you intentionally need custom vault-relative paths.
2. Open `Scope setup`.
3. Under `Current scope (--current)`, select at least one folder.
4. Under `All scope (--all)`, select at least one folder.
5. Click `Save setup`.

If scope setup is incomplete, the status bar shows `Mindmap: scope setup required` and manual runs are blocked.

### 7. First run path (exact command name)

In Command Palette, run:

- `Run Mindmap (current scope)`

This executes the plugin-managed runtime command with `--current --apply`.

Use `Show Mindmap status` to inspect runtime trust, scheduler state, pending counts, and latest preflight summary.

## Trust model (local execution and boundaries)

- Execution model: The plugin spawns a local Python process on your machine. It does not execute shell pipelines and blocks shell metacharacters in `Python command`.
- Interpreter boundary: `Python command` accepts a PATH executable name (for example `python3`) or a direct executable path.
- Script/config boundary: `Script path` and `Config path` must be vault-relative (or blank for bundled defaults). Absolute paths are blocked for these settings.
- Read/write boundary: Note writes are constrained to markdown files inside the configured vault root; traversal and outside-vault targets are rejected.
- Scope boundary: Manual run command uses `--current --apply`; scope folders come from `notes_paths_current` and `notes_paths_all` in config.
- Trust surfacing: The `Status` section shows `Trust`, `Interpreter`, `Script source`, and `Config source` as `trusted`, `caution`, or `blocked` based on your runtime configuration.

## Troubleshooting

### Python not found

Symptoms:

- Preflight fails with `Python executable not found: <command>`
- Check code may show `PYTHON_EXECUTABLE_MISSING`

Fix:

1. Verify Python: `python3 --version`
2. In settings, set `Python command` to a valid executable.
3. Re-run `Run Mindmap preflight checks`.

### Dependencies missing

Symptoms:

- Preflight shows `DEPENDENCY_RUAMEL_MISSING` or `DEPENDENCY_CHROMADB_MISSING`

Fix:

```bash
python3 -m pip install -r .obsidian/plugins/mindmap-obsidian/python/requirements.txt
```

Then rerun preflight.

### Ollama unreachable

Symptoms:

- Preflight shows `OLLAMA_UNREACHABLE`

Fix:

1. Ensure Ollama is running locally.
2. Verify endpoint in config: `ollama_base_url` (default `http://localhost:11434`).
3. Re-run preflight.

### Required models missing

Symptoms:

- Preflight shows `OLLAMA_MODELS_MISSING`

Fix:

```bash
ollama pull mxbai-embed-large
ollama pull llama3.1:8b
```

Then rerun preflight.

### Scope setup required

Symptoms:

- Status bar shows `Mindmap: scope setup required`
- Manual run notice includes guidance to select folders

Fix:

1. Open settings `Scope setup`.
2. Select at least one folder in both `Current scope (--current)` and `All scope (--all)`.
3. Click `Save setup`.
4. Re-run `Run Mindmap (current scope)`.

## Runtime files

The repository ships the Python engine in [`python/`](python/):

- `mindmap.py`
- `requirements.txt`
- `config.template.json`

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
python3 -m unittest tests/test_frontmatter.py tests/test_preflight.py tests/test_preview_validation.py
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

## Community plugin compatibility

The release metadata is prepared for Obsidian community-plugin packaging:

- `manifest.json` declares the plugin ID, version, minimum app version, and desktop-only support.
- `versions.json` maps each plugin version to its required `minAppVersion`.
- The release workflow publishes the standard plugin assets plus the Python runtime bundle required for v1.

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
