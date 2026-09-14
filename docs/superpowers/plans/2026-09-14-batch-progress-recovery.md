# Batch Progress Recovery Implementation Plan

## Goal

Revert three regressive quick-fixes and replace them with correct batch progress tracking: one-snapshot catalog lookup, derived `preparing` state, `(D-E)+terminal` progress formula, and strict parsing invariants.

Design: `docs/superpowers/specs/2026-09-14-batch-progress-recovery-design.md`

## Constraints

- Never delete or edit the production queue (durable user state).
- Preserve operator pause/restart/recovery semantics unchanged.
- No new persisted schema changes.
- `npm run check` must pass at checkpoint acceptance (full gate need not run after every tiny edit).
- Focused tests: `npx tsx --import ./scripts/test-setup.mjs --test <files>`.

---

## Checkpoint 1 — Clean revert

Revert 25ffef7, db56367, 9a36415 in reverse chronological order with `git revert --no-commit`, then commit once.

Verify:
```
npm run check
```

Restores: `total: batch.discoveredTotal`, removes `processed === 0` guard, removes try/catch around `isAlreadyIndexed`.

---

## Checkpoint 2 — Parsing invariants

Files:
- `src/jobs/jobTypes.ts` — add `enqueuedCount <= discoveredCount` invariant to `parseJobReceiptV1` scope-receipt branch
- `src/jobs/jobTypes.ts` — add cross-field check in `assertPersistedJobInvariants`
- `src/jobs/jobTypes.ts` — update `parseBulkBatchV1` completion check: completed batches require `items.length === expectedItems`, where `expectedItems` = root scope receipt `enqueuedCount` when defined, otherwise `discoveredTotal`. Replaces the current bare `items.length !== record.discoveredTotal` check.
- `src/jobs/jobTypes.test.ts` — receipt invariant tests:
  - `enqueuedCount=40, discoveredCount=935` → parses ok
  - `enqueuedCount=936, discoveredCount=935` → `JOB_SHAPE_INVALID`
  - Cross-field check in `assertPersistedJobInvariants` rejects the same
- `src/jobs/jobTypes.test.ts` — `parseBulkBatchV1` completion tests:
  - D=935, E=40, completed batch with 40 terminal items → parses ok
  - D=935, E=40, completed batch with 935 items → `JOB_STORE_CORRUPT`
  - D=935, E=undefined (no scope receipt), completed batch with 935 terminal items → parses ok (falls back to discoveredTotal)
  - `completed-with-failures`: D=935, E=40, 40 items (39 completed + 1 failed) → parses ok
  - `rebuild-index`: D=0, no scope receipt, completed batch with 0 items → parses ok

Focused test:
```
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobTypes.test.ts
```

Accept: `npm run check`

---

## Checkpoint 3 — Catalog snapshot seam + `prepareLookup`

Files:
- `src/jobs/scopeJob.ts` — replace `ScopeIndexCheckSeam` with `ScopeCatalogSnapshotSeam`:
  ```
  interface ScopeCatalogSnapshotSeam {
    prepareLookup(): Promise<(identity: NoteIdentityV1, sourceHash: string) => boolean>;
  }
  ```
  Update `ScopeJobDeps`: `indexCheck?: ScopeIndexCheckSeam` → `catalogSnapshot?: ScopeCatalogSnapshotSeam`. Update `stepEnqueue`: call `prepareLookup()` once before loop, use returned predicate per item.
- `src/engine/productionEngine.ts` — build the seam: call `this.indexStore.snapshotCatalog()`, null → throw `EngineError("STORE_READ_FAILED", ...)`, otherwise build Map keyed by `noteIdentityStableKey`, return predicate checking `sourceHash` match and `relatedVersion >= expectedRelatedVersion`.
- `src/jobs/scopeJob.test.ts` — tests:
  - `prepareLookup()` returns predicate → skips indexed notes, `enqueuedCount` correct
  - `prepareLookup()` throws `STORE_READ_FAILED` → `.step` re-throws → `runPhaseStep` catch → retry
  - `prepareLookup()` throws (overlay validation) → same propagation
  - Predicate returns `false` for all (fresh index) → all notes enqueued
- `src/engine/productionEngine.test.ts` — tests:
  - Predicate returns `false` on `sourceHash` mismatch
  - Predicate returns `false` on stale `relatedVersion`
  - Predicate returns `true` on full match
  - `snapshotCatalog()` returns `null` → throws `STORE_READ_FAILED`
  - `snapshotCatalog()` returns `[]` → predicate rejects all

Focused tests:
```
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/scopeJob.test.ts src/engine/productionEngine.test.ts
```

Accept: `npm run check`

---

## Checkpoint 4 — Derived `preparing` + progress formula

Files:
- `src/jobs/jobActivity.ts` — extend `EngineActivitySnapshot.batch` with `preparing: boolean`, `enqueuedCount?: number`. Update `deriveEngineActivity`: `preparing = root is nonterminal` (root guaranteed by `parseBulkBatchV1`). After root completion: `processed = (D - E) + terminalChildren`.
- `src/jobs/jobActivity.test.ts` — tests:
  - `preparing=true` when root nonterminal (scope-refresh discover/enqueue; rebuild-index pre-terminal)
  - `preparing=false, processed=(D-E)+terminal` (E=40, D=935, 10 done → 905)
  - `preparing=false, processed=935` when all children terminal
  - `total=undefined` when `discoveredTotal` not yet set

Focused test:
```
npx tsx --import ./scripts/test-setup.mjs --test src/jobs/jobActivity.test.ts
```

Accept: `npm run check`

---

## Checkpoint 5 — Status bar: label, ARIA, title, menu detail

Files:
- `src/statusBarState.ts` — update preparing guard: `activity?.batch && (activity.batch.total === undefined || activity.batch.preparing)` → "Mindmap · preparing". Progress: "Mindmap · N/M". Update aria-label to match. Preserve priority: fault > operator-paused > provider-paused > Reading > Research > batch > queued > latest-failure > running > reading > pending.
- `src/statusBarState.test.ts` (new) — tests:
  - `preparing=true` → label "Mindmap · preparing"
  - `preparing=false, 895/935` → label "Mindmap · 895/935"
  - Aria-label matches label
  - Fault/pause/Reading/Research priority preserved
- `src/statusBarMenu.test.ts` — verify engine detail row shows preparing/progress correctly

Focused tests:
```
npx tsx --import ./scripts/test-setup.mjs --test src/statusBarState.test.ts src/statusBarMenu.test.ts
```

Accept: `npm run check`

---

## Checkpoint 6 — End-to-end progress sequence + full gates

Tests (add to `src/jobs/jobActivity.test.ts` or `src/jobs/scopeJob.test.ts` as appropriate):
- Full lifecycle: preparing → preparing → 895/935 → 935/935
- Pause during enqueue → resume → still preparing until root completes
- Restart re-derives preparing/processed from persisted state

Final gate:
```
npm run check
```

This runs lint, typecheck, all tests, build, and validate.
