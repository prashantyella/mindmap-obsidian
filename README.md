# Mindmap for Obsidian

Standalone Obsidian plugin repository for the Mindmap workflow.

## Scope

This repository contains:
- A TypeScript Obsidian plugin scaffold
- The v1 Python runtime package in `python/`
- Build and release automation for community plugin assets

This phase preserves the Python engine. The Obsidian plugin is the orchestrator layer.

## Local development

Requirements:
- Node.js 20+
- npm 10+
- Python 3.10+
- `zip` available on the host machine for release packaging

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Validate release inputs:

```bash
npm run validate
```

Prepare release assets:

```bash
npm run release:prepare
```

## Release outputs

The release workflow produces:
- `main.js`
- `manifest.json`
- `styles.css`
- `mindmap-python.zip`

The Python bundle includes:
- `mindmap.py`
- `requirements.txt`
- `config.template.json`

## Python runtime

The portable config template avoids machine-specific absolute paths. Future issues will wire runtime installation and path resolution into the plugin.
