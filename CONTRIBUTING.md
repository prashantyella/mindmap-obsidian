# Contributing

## Scope

This repository ships a desktop-only Obsidian plugin that orchestrates an external Python runtime. Keep changes small, traceable to a Linear issue, and focused on one concern at a time.

## Local setup

1. Install Node.js `20+`, npm `10+`, and Python `3.10+`.
2. Install JavaScript dependencies:

```bash
npm install
```

3. Install Python dependencies:

```bash
python3 -m pip install -r python/requirements.txt
```

4. Run checks before opening a PR:

```bash
npm test
python3 -m unittest tests/test_frontmatter.py
npm run build
npm run validate
```

## Change rules

- Preserve the Python engine. Do not port core algorithm behavior to TypeScript in v1.
- Keep plugin changes desktop-only and cross-platform.
- Avoid machine-specific absolute paths, secrets, and vault-specific runtime data in source control.
- Add or update tests for critical behavior and regressions.
- Do not bundle unrelated refactors with issue-focused work.

## Release metadata discipline

Before tagging a release:

1. Update `manifest.json` version fields as needed.
2. Update `versions.json` so `manifest.version` maps to `manifest.minAppVersion`.
3. Add a `CHANGELOG.md` entry.
4. Run `npm run release:prepare`.
5. Confirm the release includes `main.js`, `manifest.json`, `styles.css`, and `mindmap-python.zip`.

## Pull requests

Include:

- the Linear issue ID
- a short behavior summary
- validation commands run
- any known risks or follow-up work
