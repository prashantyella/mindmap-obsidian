# Operator Pause Design

## Goal

Add a user-controlled Pause/Resume action for Mindmap processing. Pause is durable across Obsidian restarts, lets the current atomic job phase finish, and prevents any later phase from starting until the user resumes.

## Scope

This applies to the durable `JobEngine` pump only. It does not cancel jobs, delete queue data, interrupt Ollama, alter provider-pause recovery, or change batch ownership and progress rules.

## Persisted state

Add an `operatorPause` record to `JobStoreDocumentV1`:

- `active: boolean`
- `pausedAt` only when active, as a canonical ISO timestamp

Older queue documents without the field load as `{ active: false }`. The record is validated, bounded, and written through the existing atomic `JobStore` mutation lane. `pausedAt` is required and canonical only when active, and is cleared on resume.

Provider pause and operator pause are independent. Provider pause represents an automatic provider-wide failure; operator pause represents the user’s explicit choice. Both can be active at once. Resume clears only operator pause.

## Engine behavior

`JobEngine.pause()` persists the operator pause and returns immediately. It never aborts the active phase or its model request.

Before dispatching the next queued phase, the pump checks `operatorPause`. If active, it exits idle without selecting a job. This check runs at each dispatch boundary, so a pause requested during a phase takes effect immediately after that phase’s durable outcome is recorded.

`JobEngine.resume()` clears the operator pause atomically and kicks the pump. Calls are idempotent. Startup recovery leaves an active operator pause intact, so a restarted plugin does not resume work accidentally.

Schedulers may continue submitting durable work while paused, but the pump does not execute it. Existing bulk overlap and single-note coalescing behavior is unchanged.

## Activity and UI

Extend `EngineActivitySnapshot` with operator-pause state, distinct from provider pause. Presentation precedence is:

1. engine fault;
2. operator pause;
3. provider pause;
4. active Reading/Web Research;
5. active engine progress or queued work;
6. latest terminal batch failure;
7. normal idle/pending state.

The existing Mindmap status menu gains one contextual action:

- `Pause processing` while the engine can dispatch work;
- `Resume processing` while operator pause is active.

The status label and ARIA text identify a user pause without leaking paths or note content. Queue/batch detail remains visible while paused. Pause/Resume is disabled only when the production engine is unavailable.

## Error handling and lifecycle

- Store persistence failures leave pause state unchanged and surface through existing engine fault handling.
- A paused engine has no in-flight timer or listener beyond its existing pump lifecycle.
- Plugin unload/dispose does not clear the persisted operator pause.
- Resume after a provider pause clears only operator pause; the provider pause remains actionable until ordinary recovery clears it.

## Tests

- Backward-compatible queue parsing and malformed operator-pause rejection.
- Pause during a controlled active phase: the phase completes, then no next phase starts.
- Pause before dispatch, restart while paused, and resume after restart.
- Idempotent repeated pause/resume.
- Independent provider/operator pause combinations.
- Snapshot precedence and status/menu/ARIA copy.
- Pause/Resume action wiring and unavailable-engine behavior.
- Obsidian guideline lint and full repository verification.

## Delivery

Implement as one focused checkpoint:

1. durable pause state and `JobEngine` dispatch gate;
2. activity/status/menu integration and focused tests;
3. full automated verification plus a disposable-vault smoke check before production re-enable.

Production Mindmap stays disabled until the change is reviewed and verified.
