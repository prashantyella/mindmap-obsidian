# Operator Pause Implementation Plan

## Goal

Add a durable, user-controlled Pause/Resume action that stops Mindmap after the current atomic phase and survives restart.

Design: `docs/superpowers/specs/2026-08-26-operator-pause-design.md`

## Constraints

- Keep pause state in the existing atomic job document.
- Never abort an active job phase or Ollama request.
- Keep operator pause independent from provider pause.
- Do not alter batch ownership, coalescing, or scheduler submission semantics.
- Keep production Mindmap disabled until disposable verification passes.

## Checkpoint 1 — Durable pause and user controls

Likely files:

- `src/jobs/jobTypes.ts` and tests
- `src/jobs/jobStore.ts` and tests
- `src/jobs/jobEngine.ts` and tests
- `src/jobs/jobActivity.ts` and tests
- `src/engine/productionEngine.ts` and tests
- `src/main.ts`
- `src/statusBarIntegration.ts`
- `src/statusBarState.ts` and tests
- `src/finalAuditSourceBundle.test.ts`

Work:

1. Add backward-compatible, validated `operatorPause` state to `JobStoreDocumentV1`.
2. Add atomic idempotent store/engine pause and resume operations.
3. Gate dispatch before every new phase while leaving an active phase uninterrupted.
4. Preserve operator pause through startup recovery; resume kicks the existing pump.
5. Add distinct operator/provider pause state to activity snapshots and status priority.
6. Add contextual `Pause processing` / `Resume processing` menu actions and callbacks.
7. Keep queue/batch details visible, preserve basename-only privacy, and use lifecycle-safe rendering.
8. Add source audit proving pause is durable and no active-phase abort path was introduced.

Tests:

- Legacy documents default to unpaused; malformed pause records fail closed.
- Pause during a controlled phase completes that phase and blocks the next one.
- Pause before dispatch, restart while paused, and resume after restart.
- Repeated pause/resume is idempotent.
- Provider and operator pauses are independent.
- Status/menu/ARIA priority, action wiring, and unavailable-engine behavior.
- No absolute paths, unsafe DOM, global app access, or unmanaged cleanup.

Gates:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobTypes.test.ts src/jobs/jobStore.test.ts src/jobs/jobEngine.test.ts src/jobs/jobActivity.test.ts src/engine/productionEngine.test.ts src/statusBarMenu.test.ts src/finalAuditSourceBundle.test.ts
npm run check
git diff --check
```

Commit: `feat: add durable operator pause`

## Verification

1. Build and deploy only to `Mindmap_Test`.
2. Start a disposable batch, pause during model work, and verify the current phase finishes while the queue stops.
3. Reload while paused, confirm it remains paused, then resume and confirm processing continues.
4. Verify provider pause remains independent.
5. Re-enable production Mindmap only with explicit user authorization after disposable smoke passes.
