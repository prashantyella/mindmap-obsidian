# Engine Activity Status Implementation Plan

## Goal

Wire the TypeScript engine's durable work into the status bar, provide restart-safe bulk progress, and prevent overlapping manual or scheduled bulk runs without blocking single-note coalescing.

Design: `docs/superpowers/specs/2026-08-25-engine-activity-status-design.md`

## Constraints

- Preserve the job engine's single-dispatch, crash-safe model.
- Keep pending distinct from queued/active work.
- Persist only bounded metadata—never note content, model output, vectors, or absolute paths.
- Do not poll `queue.json` or the DOM.
- Do not turn Reading Mode into a bulk batch.
- Test each checkpoint before committing it.

## Dependency order

```text
Batch contracts/store
  -> batch-aware submission
  -> activity snapshots
  -> status and concurrency wiring
  -> full verification
```

## Checkpoint 1 — Persisted batch foundation

Outcome: add bounded batch records with atomic single-active-batch enforcement.

Likely files:

- `src/jobs/batchTypes.ts` and tests
- `src/jobs/batchStore.ts` and tests
- `src/engine/contracts.ts` and tests
- `src/jobs/jobTypes.ts` and tests

Work:

1. Write failing tests for parsing, lifecycle invariants, bounds, pruning, and corrupt-store rejection.
2. Define `BulkBatchV1`: batch ID, optional schedule occurrence ID, trigger, scope, root job ID, discovered total, lifecycle, timestamps, and bounded failure code.
3. Implement `BatchStore` on `AtomicStore` with atomic `createIfIdle`, occurrence lookup, idempotent updates, one-active-batch enforcement, and bounded terminal history.
4. Add optional `batchId` to persisted jobs and submission inputs.
5. Keep batch identity outside note-job idempotency so matching single-note work can coalesce.

Tests:

- Concurrent creates produce one batch and one `BULK_BATCH_ACTIVE` error.
- A scheduled occurrence resolves to the same batch after retry/restart.
- Invalid transitions, oversized fields, duplicates, and unsupported versions fail closed.
- Existing queue documents without `batchId` remain valid.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/batchTypes.test.ts src/jobs/batchStore.test.ts src/engine/contracts.test.ts src/jobs/jobTypes.test.ts
npm run typecheck
```

Commit: `feat: add durable bulk batch state`

## Checkpoint 2 — Batch-aware submission

Outcome: manual and scheduled scope runs create one batch; participating and replacement note jobs retain its identity; overlapping bulk work is rejected at the engine boundary.

Likely files:

- `src/jobs/jobStore.ts` and tests
- `src/jobs/jobEngine.ts` and tests
- `src/jobs/scopeJob.ts` and tests
- `src/jobs/noteJob.ts` and tests
- `src/engine/productionVaultAdapter.ts` and tests
- `src/engine/productionEngine.ts` and tests
- `src/scheduling/coreScheduler.test.ts`

Work:

1. Write failing tests for propagation, adoption, replacements, restart gaps, and overlap rejection.
2. Make `appendOrCoalesce` atomically attach the active batch to matching non-terminal single-note work; reject association with another active batch.
3. Thread `batchId` through scope enqueue and note replacement seams.
4. Add a `BulkBatchCoordinator` owned by `ProductionEngine` to create/reuse batches, submit the root scope job idempotently, reconcile startup gaps, derive counters, and settle lifecycle.
5. Route manual and interval scope submissions through the coordinator.
6. Replace the production `CoreScheduler`→`JobEngine` direct seam with a batch-aware adapter:
   - scheduled scope refresh creates or reuses an occurrence-keyed batch;
   - rebuild is rejected while a batch is active;
   - Reading sync remains non-batch;
   - acknowledgement semantics remain unchanged.
7. Surface `BULK_BATCH_ACTIVE` as concise guidance.

Tests:

- Manual and scheduled scope runs create exactly one batch.
- Crashes after batch creation or root submission reconcile without duplication.
- Discovered children and source-change replacements retain the batch.
- Matching pre-existing single-note work is adopted, not duplicated.
- Manual, interval, daily, and weekly bulk submissions are blocked during an active batch.
- Single-note and Reading submissions preserve existing behavior.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobStore.test.ts src/jobs/jobEngine.test.ts src/jobs/scopeJob.test.ts src/jobs/noteJob.test.ts src/engine/productionVaultAdapter.test.ts src/engine/productionEngine.test.ts src/scheduling/coreScheduler.test.ts
npm run typecheck
```

Commit: `feat: track bulk work as durable batches`

## Checkpoint 3 — Observable engine activity

Outcome: expose one immutable snapshot for queue state, current phase, model activity, faults, pauses, and batch progress.

Likely files:

- `src/jobs/jobActivity.ts` and tests
- `src/jobs/jobEngine.ts` and tests
- `src/engine/productionEngine.ts` and tests

Work:

1. Write failing activity-transition tests.
2. Define `EngineActivitySnapshot` and pure derivation from job store, batch store, provider pause, pump state, and engine fault.
3. Add `subscribeActivity(listener)` with an immediate snapshot and updates after submit, phase start/outcome, pause/resume, fault, idle, recovery, stop, and dispose.
4. Isolate observer failures and support unsubscribe.
5. Track model activity for embedding/metadata phases and direct semantic queries.
6. Expose the combined subscription through `ProductionEngine`; reconcile batches before the startup snapshot.
7. Coalesce rapid notifications without dropping final idle/fault state.

Tests:

- Exact snapshot sequence from queued through completion.
- Accurate phase, basename-safe path data, queue counts, batch progress, and failure counts.
- Pause/fault override running state.
- Restart publishes accurate existing activity before new work.
- Throwing/unsubscribed observers cannot affect execution.
- Direct semantic work toggles model-busy without replacing bulk progress.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobActivity.test.ts src/jobs/jobEngine.test.ts src/engine/productionEngine.test.ts
npm run typecheck
```

Commit: `feat: expose live engine activity snapshots`

## Checkpoint 4 — Status and concurrency integration

Outcome: all user-facing status and relevant guards consume engine activity; retired subprocess state is removed.

Likely files:

- `src/main.ts`
- `src/statusBarIntegration.ts`
- `src/statusBarState.ts`
- `src/statusBarMenu.ts`
- `src/statusBarMenu.test.ts`
- `src/finalAuditSourceBundle.test.ts`
- `styles.css`

Work:

1. Write failing presentation and integration tests.
2. Cache and subscribe to engine activity in `MindmapPlugin`; unsubscribe on teardown and render through a short trailing throttle.
3. Delete `currentProcess`, `activeRunStatus`, and every dependent guard.
4. Apply priority: fault/pause → Reading/Web Research → bulk progress → unbatched activity → preflight → pending/ready.
5. Render compact labels such as `Mindmap · 374/933` and `Mindmap · 566 queued`; keep phase, note basename, queue, and failures in tooltip/menu.
6. Disable bulk actions from active-batch state while leaving single-note actions enabled.
7. Guard competing Ollama calls with model-busy state, not backlog existence.
8. Keep pending labels explicitly separate from queue progress.
9. Add a source audit forbidding retired subprocess status fields.

Tests:

- Controlled engine integration renders loader → progress → idle.
- Active TypeScript work cannot render idle orbit.
- Hundreds queued cannot appear as only the pending count.
- Bulk actions disable while single-note actions remain enabled.
- Pause/fault uses an alert without a spinner.
- Tooltip/menu contains no absolute paths.
- Rendering stays bounded and honors reduced motion.

Gate:

```bash
npx tsx --import ./scripts/test-setup.mjs --test src/statusBarMenu.test.ts src/finalAuditSourceBundle.test.ts src/engine/productionEngine.test.ts
npm run lint:obsidian
npm run typecheck
```

Commit: `fix: wire status bar to engine activity`

## Checkpoint 5 — Full verification

Work:

1. Run all repository gates and build the plugin.
2. Verify in a disposable vault only:
   - bulk total/progress/current phase;
   - progress recovery after reload;
   - second manual and scheduled bulk rejection;
   - single-note coalescing;
   - provider-pause alert;
   - separate pending and queued counts.
3. Inspect job/batch stores for bounded, content-free records.
4. Review the diff for unrelated refactors and production-vault writes.

Gate:

```bash
npm run check
git diff --check
```

Final acceptance:

- Status always reflects TypeScript-engine work.
- Bulk progress is accurate across restarts.
- Overlapping bulk runs are blocked at the engine boundary.
- Single-note work still coalesces.
- Faults and pauses are visible.
- No retired subprocess busy state remains.

Commit: `test: close engine activity status regressions`
