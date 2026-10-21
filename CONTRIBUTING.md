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

1. Keep the version in `manifest.json`, `package.json`, and `package-lock.json` synchronized.
2. Update `versions.json` so `manifest.version` maps to `manifest.minAppVersion`.
3. Add a `CHANGELOG.md` entry and review the current `RELEASE_CHECKLIST.md`.
4. Run `npm run check`, then `npm run release:prepare`.
   Both enforce `npm run test:release`, an isolated on-disk lifecycle regression gate using synthetic data and production queue/index components. No vault or Ollama server is needed. CI runs it explicitly; release preparation must pass it before packaging. This does not replace the live Obsidian acceptance checks.
5. Confirm `release/` contains exactly `main.js`, `manifest.json`, and `styles.css`.
6. Complete the documented live acceptance checks and verify CI before merging or tagging.
7. Tag the approved release commit with the exact manifest version. Pushing that tag publishes release assets automatically; preparing assets alone does not publish them.

## Pull requests

Include:

- the Linear issue ID
- a short behavior summary
- validation commands run
- any known risks or follow-up work
