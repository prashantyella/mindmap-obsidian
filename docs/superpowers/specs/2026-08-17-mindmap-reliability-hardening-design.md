# Mindmap Reliability Hardening Design

## Objective

Restore scheduled processing, drain the current backlog, and prevent silent failures with the smallest practical changes. Prefer extending existing modules over adding frameworks, daemons, databases, or broad abstractions.

## Current Findings

- The installed Obsidian plugin matches the current feature build.
- macOS LaunchAgent runs fail before Python starts because launchd receives `Operation not permitted`.
- Docker owns port 8000, so preflight reaches Docker rather than oMLX and receives HTTP 404.
- Four eligible notes are pending among 274 tracked notes.
- The plugin does not surface actual LaunchAgent exit health or catch up after missed runs.
- Preflight does not distinguish a port collision from an unavailable provider and does not manage oMLX during its probe.

## Design Principles

- Fix observed failures before adding safeguards.
- Keep the Python processor and macOS LaunchAgent architecture.
- Use small functions and existing status/settings surfaces.
- Add a component only when it creates a clear test boundary.
- Avoid a new resident service, job database, orchestration framework, or generalized recovery engine.
- Never run overlapping maintenance jobs.
- Preserve successfully processed state when an individual note fails.

## Phase 1: Operational Recovery

1. Grant the configured Python executable the required macOS access to the vault and confirm with a non-writing LaunchAgent preflight.
2. Move managed oMLX to an available port, updating both its configured port and `llm_base_url` consistently.
3. Reload the existing daily and weekly LaunchAgents.
4. Run preflight and one bounded manual all-scope run.
5. Drain the four eligible pending notes and verify the state file, note metadata, logs, and pending count.

These are environment/configuration repairs. They must be completed and verified before code changes are considered successful.

## Phase 2: Lightweight Code Hardening

### Provider diagnostics

Extend preflight to distinguish:

- connection refused;
- unexpected HTTP service or endpoint;
- authentication failure;
- configured model missing;
- managed oMLX unable to bind because the port is occupied.

When oMLX auto-management is enabled, preflight may start it for the probe and stop it afterward only if Mindmap started it. The error message should identify a port collision without attempting process termination.

### LaunchAgent health

Add a small health reader around existing LaunchAgent support. It should report:

- whether each agent is loaded;
- last exit code when available;
- last successful Mindmap log timestamp;
- whether that success is stale relative to the configured schedule.

Use the existing run log as the heartbeat. Do not introduce a separate persistence system unless the existing log cannot represent success reliably.

### Catch-up behavior

On Obsidian startup or settings status refresh, if the scheduled heartbeat is stale and eligible notes are pending, expose one explicit catch-up action. Do not add automatic catch-up in this implementation.

Process pending work using the existing changed-note/state hashes and all-scope run. Do not add a new queue or batching mechanism; the existing single-process guard prevents overlap.

### Failure isolation

Continue after a single malformed or provider-failed note. Record that note and its reason. Update state only for notes successfully completed. Provider-wide failures should stop the batch rather than generating repeated failures for every note.

### Obsidian status

Extend the existing status/settings UI instead of creating a new diagnostics subsystem. Show:

- scheduler healthy, stale, or failing;
- last successful scheduled run;
- current/all pending counts;
- provider readiness and port-conflict guidance;
- a repair or catch-up action when appropriate.

## Testing

Add focused tests for:

- preflight classification of 404, refused connection, authentication, missing model, and bind conflict;
- LaunchAgent loaded state, exit-code parsing, and stale heartbeat calculation;
- no overlapping catch-up run;
- successful-note state preservation when one note fails;
- pending count reaching zero after recovery.

Retain the existing lint, typecheck, unit-test, build, and release-validation suite. Resolve the current `workspaceView.ts` line warning only if touched code makes a small extraction natural; do not undertake a broad UI refactor.

## Success Criteria

- Preflight reports the true provider failure with actionable guidance.
- Daily and weekly agents can start Python and record outcomes.
- The current eligible backlog reaches zero.
- No scheduled failure remains silent in Obsidian.
- Missed work has one safe recovery path with no overlapping processes.
- Seven consecutive scheduled opportunities complete without silent failure.

## Implementation Management

- Implementation is delegated in small, bounded tasks to a coding agent using `gpt-5.6-luna` with high reasoning.
- The primary agent owns sequencing, scope control, review, local verification, and progress reporting.
- Each task should make the smallest coherent change, include tests, and stop for review before the next task.
- Complex structures require evidence that existing functions and state cannot support the requirement.
- Operational recovery and code hardening remain separate checkpoints.
