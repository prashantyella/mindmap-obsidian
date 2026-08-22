# Zero-Terminal Runtime Setup Implementation Plan

## Constraints

- Follow `docs/superpowers/specs/2026-08-22-zero-terminal-runtime-setup-design.md`.
- macOS-first; preserve manual overrides on other platforms.
- Never invoke a shell or interpolate command strings.
- Network access requires explicit user confirmation.
- Managed files live only below the validated Mindmap application-support root.
- The visible `mindmap-coder` worker implements bounded checkpoints without Git, vault, deployment, or release actions.
- The manager owns design, review, commits, remote updates, disposable-vault integration, and production decisions.

## 1. Discovery and Probe Primitives

Likely files:

- new `src/runtimeDiscovery.ts` and tests
- `src/pathResolver.ts` and tests
- `src/settings.ts`

Work:

- Define supported Python versions and required package versions.
- Generate deterministic macOS candidates for the fingerprinted managed runtime, Framework installs, Homebrew installs, PATH results, and Xcode/system bootstrap fallback.
- Normalize/deduplicate candidates and reject unsafe/non-file values.
- Add an injectable argument-array interpreter probe that distinguishes `ready`, `bootstrap-only`, `incompatible`, and `unavailable`.
- Preserve explicit custom interpreter settings; automatic discovery applies only to blank/default settings.
- Select a ready interpreter without network access and return the best bootstrap candidate otherwise.
- Define requirements fingerprint and managed/staging paths under Application Support.

Tests:

- candidate order/dedup and both Mac architectures;
- supported/unsupported versions;
- ready versus missing-dependency versus missing-venv results;
- explicit custom preservation;
- no shell and bounded/redacted probe errors;
- shared runtime wins on a second vault.

Checkpoint:

- Manager reviews path/trust boundaries and process arguments before installation exists.

## 2. Managed Runtime Installer

Likely files:

- new `src/runtimeSetup.ts` and tests
- a small confirmation modal
- runtime state types

Work:

- Implement one serialized setup controller with injectable filesystem, process, clock, and persistence seams.
- Confirm network download and target location.
- Create a validated staging venv, run pip against shipped requirements, probe/verify it, then atomically rename it to the final fingerprinted location.
- Persist the final interpreter only after verification; roll back in-memory settings on save failure.
- Expose setup phases and retry/cancel actions.
- Kill owned children and clean only the exact validated staging directory on cancellation/unload/failure.
- Reuse a verified final runtime without running pip.

Tests:

- happy path and existing-runtime reuse;
- one-job coalescing;
- create/pip/probe/rename/persist failures;
- cancellation, unload, timeout, late callback suppression;
- cleanup path validation;
- no secrets, note text, or environment values in logs/settings.

Checkpoint:

- Manager reviews destructive boundaries and subprocess lifecycle.

## 3. Plugin, Reading, Scheduler, and UI Integration

Likely files:

- `src/main.ts`
- `src/settingsTab.ts`
- `src/statusBarState.ts`, menu/integration, and tests
- `src/readingMode.ts` and tests
- scheduler/semantic guards

Work:

- Start discovery after bundled assets are ready.
- Auto-persist a ready interpreter and rerun preflight without restart.
- Surface `Runtime setup required`, setup progress, retry, cancel, and ready states in settings and the native status menu.
- Keep Advanced path fields but remove them from normal onboarding.
- Disable manual runs, semantic startup, automatic Reading processing, backlog processing, and LaunchAgent installation until ready.
- Permit standard-library Apple Books preview/import through the bootstrap interpreter while keeping processing pending.
- If first import completes before runtime readiness, replace the process-now offer with the setup action.
- Refresh scheduler, pending state, and status immediately after setup.

Tests:

- fresh default selects an existing working Python;
- Xcode Python missing dependencies surfaces setup instead of a failed processing run;
- setup completes without restart;
- Reading import succeeds while backlog processing stays disabled;
- scheduler/semantic/manual guards;
- status/menu/settings copy, keyboard behavior, and busy conflicts;
- unload cancels discovery/setup and prevents late persistence.

Checkpoint:

- Manager runs the complete UI/controller/runtime test groups before release work.

## 4. Packaging, Documentation, and Fresh-Vault Gate

Likely files:

- `python/requirements.txt`
- `README.md`, `CHANGELOG.md`
- release validation and CI
- disposable integration vault only after source gates

Work:

- Pin direct managed-runtime packages consistently and include requirements in the fingerprint.
- Document one-click setup, storage, network consent, supported versions/platform, retry, and advanced overrides.
- Validate release assets contain the requirements/runtime metadata and no managed environment or machine paths.
- Run dependency, secret, and unsafe-process scans.
- Rebuild the disposable integration vault from an empty `data.json` and no custom Python setting.
- Verify discovery or one-click setup, passing preflight, import-only Reading activation, readable annotation note, explicit backlog processing, and reload reuse.

Final gates:

- TypeScript and Python tests;
- lint and typecheck;
- build, release validation, and release archive inspection;
- CI and peer review;
- no production deployment until the new fresh-vault integration is green.
