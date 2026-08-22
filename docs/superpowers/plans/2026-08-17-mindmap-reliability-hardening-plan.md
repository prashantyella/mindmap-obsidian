# Mindmap Reliability Hardening Implementation Plan

## Constraints

- Prefer direct extensions to existing functions and UI.
- No new daemon, queue, persistence layer, or generalized framework.
- Delegate one bounded coding task at a time to `gpt-5.6-luna` with high reasoning.
- Primary agent reviews scope, diff, tests, and progress before the next task.

## 1. Restore the local runtime

- Move the managed oMLX endpoint from Docker-owned port 8000 to an available port.
- Update `llm_base_url` and `omlx_port` together in the installed config.
- Run non-writing preflight.
- Identify the Python executable for macOS Full Disk Access and verify LaunchAgent execution after the user grants it.
- Reload existing agents without changing their schedules.

## 2. Improve provider diagnostics

Files: `python/mindmap.py`, `tests/test_preflight.py`.

- Classify connection refusal, unexpected HTTP service/404, authentication failure, missing model, and managed-server bind failure.
- Allow managed-oMLX preflight to start and stop oMLX when Mindmap owns the process.
- Never terminate an unrelated port owner.
- Add focused Python tests.

Checkpoint: Python tests and manual preflight output.

## 3. Read LaunchAgent health

Files: `src/launchAgent.ts`, `src/launchAgent.test.ts`, with minimal wiring in `src/main.ts`.

- Parse loaded state and last exit code from `launchctl print` output.
- Read the existing successful-run log timestamp as the heartbeat.
- Calculate healthy, stale, or failing status relative to configured schedules.
- Keep this read-only and avoid new stored state.

Checkpoint: targeted TypeScript tests, typecheck, and scheduler status inspection.

## 4. Expose recovery in Obsidian

Files: existing settings/status modules only.

- Show loaded state, last exit, last successful run, pending count, and actionable provider guidance.
- When stale with pending notes, expose one explicit catch-up action using the existing all-scope run.
- Reuse the existing process guard; do not add automatic execution or batching.

Checkpoint: targeted tests, lint, typecheck, and built plugin inspection.

## 5. Verify and recover backlog

- Run `npm run check` and Python tests.
- Build and validate release artifacts.
- Deploy only the verified plugin assets while preserving installed `config.json`, state, and user settings.
- Reload Obsidian/plugin and LaunchAgents.
- Run preflight, then the explicit all-scope catch-up.
- Confirm four pending eligible notes reach zero and logs/state remain consistent.
- Observe scheduled health; seven consecutive scheduled opportunities is the operational acceptance window.
