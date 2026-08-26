# Engine Activity Status Implementation Plan

## Goal

Wire durable TypeScript-engine activity into the status bar, show accurate bulk progress across restarts, and block overlapping bulk runs without blocking single-note coalescing.

Design: `docs/superpowers/specs/2026-08-25-engine-activity-status-design.md`

## Constraints

- Keep batch metadata inside the existing atomic job document.
- Keep pending distinct from queued work.
- Persist bounded, content-free metadata only.
- Do not poll the queue, vault, Ollama, or DOM.
- Do not redesign Reading, migration, or semantic lookup.
- Follow Obsidian lifecycle, DOM, copy, styling, and performance guidelines.
- Test first; commit each checkpoint separately.

## Checkpoint 1 — Atomic bulk progress

Outcome: one atomic job document owns root submission, scheduled occurrence identity, child membership, and progress.

Likely files:

- `src/engine/contracts.ts` and tests
- `src/jobs/jobTypes.ts` and tests
- `src/jobs/jobStore.ts` and tests
- `src/jobs/jobEngine.ts` and tests
- `src/jobs/scopeJob.ts` and tests
- `src/jobs/noteJob.ts` and tests
- `src/engine/productionVaultAdapter.ts` and tests
- `src/engine/productionEngine.ts` and tests
- `src/scheduling/coreScheduler.test.ts`

Work:

1. Write failing batch-schema and crash-window tests.
2. Add bounded `BulkBatchV1` records to `JobStoreDocumentV1`; default a missing field to `[]` for existing queues.
3. Add optional `batchId` and `batchItemId` job fields. Derive the item ID from batch ID plus stable discovered-note identity.
4. Add atomic `JobStore` operations for:
   - manual batch + root creation;
   - scheduled batch + root + occurrence creation/retry;
   - child append/coalesced adoption;
   - job transition + item progress;
   - bounded terminal-batch pruning.
5. Block a second scope/rebuild submission when a batch or unbatched bulk root is non-terminal.
6. Thread both IDs through scope enqueue and source-change replacements.
7. Settle the batch only when the root and every discovered item are terminal; distinguish completed, completed-with-failures, failed, and cancelled.
8. Make startup recovery update active jobs and their batch items atomically.

Tests:

- Existing queue documents load unchanged.
- Concurrent manual creates yield one batch and one `BULK_BATCH_ACTIVE` error.
- Scheduled occurrence retry returns the same root even after terminal completion.
- Every discovered note maps to one item despite coalescing, retry, replacement, or pruning.
- Crash simulations at each mutation boundary preserve exact progress.
- Manual, interval, daily, and weekly bulk work is blocked during an active batch.
- Single-note and Reading submissions preserve existing behavior.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/engine/contracts.test.ts src/jobs/jobTypes.test.ts src/jobs/jobStore.test.ts src/jobs/jobEngine.test.ts src/jobs/scopeJob.test.ts src/jobs/noteJob.test.ts src/engine/productionVaultAdapter.test.ts src/engine/productionEngine.test.ts src/scheduling/coreScheduler.test.ts
npm run typecheck
npm run lint:obsidian
```

Commit: `feat: track bulk progress atomically`

## Checkpoint 2 — Activity and status wiring

Outcome: one subscription drives status, menu state, and concurrency guards; retired subprocess state disappears.

Likely files:

- `src/jobs/jobActivity.ts` and tests
- `src/jobs/jobEngine.ts` and tests
- `src/engine/productionEngine.ts` and tests
- `src/main.ts`
- `src/statusBarIntegration.ts`
- `src/statusBarState.ts`
- `src/statusBarMenu.ts`
- `src/statusBarMenu.test.ts`
- `src/finalAuditSourceBundle.test.ts`
- `styles.css`

Work:

1. Write failing activity-sequence and presentation tests.
2. Derive `EngineActivitySnapshot` from the cached committed job document and pump state; exclude historical terminal jobs from ordinary queue counts.
3. Add a safe `subscribeActivity()` with immediate state, unsubscribe, listener isolation, and updates after durable transitions plus idle/fault/stop.
4. Cache activity in `MindmapPlugin`; register unsubscribe and `window.setTimeout` cleanup with `this.register()`.
5. Trailing-throttle status rendering to at most four updates per second.
6. Remove `currentProcess`, `activeRunStatus`, and all dependent status/scheduler/research guards.
7. Render priority and labels exactly as specified; expose only relative basenames in UI detail.
8. Disable bulk actions from batch state, leave single-note actions enabled, and rely on engine rejection as the final race-safe guard.
9. Conservatively block Web Research while process-note work is non-terminal.
10. Use Obsidian DOM helpers, sentence-case copy, existing CSS classes/theme variables, and reduced-motion behavior.
11. Add source audits forbidding retired fields, global `app`, unsafe HTML, inline colors, and unregistered activity cleanup in the new path.

Tests:

- Controlled engine flow renders preparing → progress → idle.
- Active or queued work cannot render idle orbit or only pending count.
- Pause/fault renders a stable alert without spinner.
- Completed-with-failures remains visible as the latest result.
- Bulk actions block; single-note actions remain enabled.
- Unload cancels pending render and unsubscribes exactly once.
- Rapid transitions stay within the render bound.
- UI contains no absolute paths and uses sentence case.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobActivity.test.ts src/jobs/jobEngine.test.ts src/engine/productionEngine.test.ts src/statusBarMenu.test.ts src/finalAuditSourceBundle.test.ts
npm run typecheck
npm run lint:obsidian
```

Commit: `fix: wire status bar to engine activity`

## Checkpoint 3 — Verification

Work:

1. Run the full repository gates and inspect the production bundle.
2. Verify in a disposable vault only:
   - bulk preparation, total, progress, phase, completion, and failures;
   - reload recovery;
   - manual and scheduled overlap rejection;
   - single-note coalescing;
   - provider-pause/fault presentation;
   - distinct pending and queued counts;
   - cleanup after plugin disable/reload.
3. Confirm no new console logging, global app access, unsafe HTML, inline styling, vault polling, or unmanaged timers/listeners.
4. Inspect persisted queue data for bounded content-free batch records.
5. Review the diff for unrelated refactors and production-vault writes.

Gate:

```bash
npm run check
git diff --check
```

Final acceptance:

- Status reflects all durable JobEngine work.
- Progress is exact across restart, coalescing, replacement, failure, and pruning.
- Bulk overlap is blocked atomically.
- Single-note work still coalesces.
- Faults and pauses are visible.
- Obsidian guideline lint passes.
- No retired subprocess busy state remains.

Commit: `test: close engine activity status regressions`
