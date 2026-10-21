# Contributing

## Scope

This repository ships a desktop-only Obsidian plugin with an in-process TypeScript engine and local Ollama models. Keep changes focused, traceable, and backed by behavioral tests.

## Local setup

1. Install Node.js `20+` and npm `10+` (CI uses Node 20).
2. Install JavaScript dependencies:

```bash
npm ci
```

3. Run checks before opening a PR:

```bash
npm run check
```

## Change rules

- Keep engine work in TypeScript; no companion runtime is shipped.
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
   `check` includes unit and integration suites via `npm test`; release preparation reruns the mandatory integration gate. No vault or Ollama server is needed. CI runs both suites explicitly. This does not replace the live Obsidian acceptance checks.
5. Confirm `release/` contains exactly `main.js`, `manifest.json`, and `styles.css`.
6. Complete the documented live acceptance checks and verify CI before merging or tagging.
7. Tag the approved release commit with the exact manifest version. Pushing that tag publishes release assets automatically; preparing assets alone does not publish them.

## Pull requests

Include:

- the Linear issue ID
- a short behavior summary
- validation commands run
- any known risks or follow-up work

## Test suite structure and requirements

- `npm test`: all unit/regression and on-disk integration tests, discovered deterministically without shell-specific commands.
- `npm run test:unit`: `src/**/*.test.ts` and `scripts/**/*.test.mjs`; existing opt-in performance benchmarks may remain skipped.
- `npm run test:release`: every `src/**/*.integration.ts`; empty files, skipped/TODO tests, missing totals, or failures block the gate.
- Queue state-machine, retry-timer, and lifecycle/status tests live in separate files sharing `jobEngine.test-support.ts`. Pending-scan fixtures implement a narrow typed production contract and explicitly provide the expected connection version.
- Persistence regressions must assert semantic round trips, not just vector counts: identity, source hash, model, chunk count, and optional connection freshness must survive verification, cleanup, cold reads, and repeated compaction. Missing freshness stays unknown; it must never be upgraded by assumption.
- The on-disk release gate must also run the pending scan and scope-refresh job after compaction: unchanged processed notes produce zero pending entries and zero process-note jobs. Changed content and future connection versions remain eligible.
- Snapshot/restart adoption must reject a generation with different freshness metadata, even if hashes and vectors otherwise match. Older metadata with no freshness field remains readable but conservatively stale.
- Each incident needs a regression that fails against the broken behavior. Dispose services/timers in test cleanup; use synthetic data, never checked-in personal-vault snapshots.

### Indexes already affected by freshness loss

Preserving metadata prevents recurrence; it cannot reconstruct a marker already lost by an older rebuild. Such records remain conservatively stale. Do not stamp every row with the current version or infer processing completion from an unchanged source hash alone. Restore only from a verified pre-rebuild backup with matching note/model/content provenance, preserve newer work, and keep the engine quiescent during any offline repair. Otherwise the affected notes require processing. Never edit the live queue or immutable generation metadata in place.
