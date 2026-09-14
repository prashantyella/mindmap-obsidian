# Batch Progress Recovery Design

**Date:** 2026-09-14
**Branch:** `fix/batch-progress-recovery`
**Reverts:** 9a36415, db56367, 25ffef7

---

## Problem

Three commits addressed batch progress display symptoms individually:

- **9a36415** — Replaced `discoveredTotal` denominator with `items.length`. Wrong: the denominator grows with the numerator, so progress never advances meaningfully.
- **db56367** — Reverted the denominator but added `processed === 0 → "preparing"`, hiding the display indefinitely when no child has completed yet.
- **25ffef7** — Wrapped per-note `isAlreadyIndexed` in try/catch with `return false` fallback. This silently re-enqueues already-indexed notes, inflating the batch and causing progress to race from 0% to 100%.

Root cause: these patches conflate discover, enqueue, and processing phases, and fix display at the wrong layer.

## Design

### 1. Revert all three commits

Normal `git revert --no-commit` in reverse chronological order. Restores `total: batch.discoveredTotal`, removes the `processed === 0` guard, and removes the try/catch around `isAlreadyIndexed`. Tests must pass after revert before new work begins.

### 2. Catalog snapshot replaces per-note index I/O

Replace the per-note `indexStore.getRecord()` approach with a single `IndexStore.snapshotCatalog()` call at the start of the enqueue phase. The snapshot, Map construction, and `expectedRelatedVersion` threshold all live inside `productionEngine.ts` — `ScopeJobRunner` never sees the raw Map or the version constant.

**`ScopeIndexCheckSeam` becomes `ScopeCatalogSnapshotSeam`:**

```typescript
export interface ScopeCatalogSnapshotSeam {
  prepareLookup(): Promise<(identity: NoteIdentityV1, sourceHash: string) => boolean>;
}
```

`prepareLookup()` is called once before the enqueue loop. It returns a synchronous predicate: `(identity, sourceHash) => boolean` — `true` when the note is already indexed with a matching `sourceHash` and adequate `relatedVersion`. The runner calls the predicate per item; it never handles the Map, `expectedRelatedVersion`, or error-to-`EngineError` conversion itself.

**Seam semantics:**

- `snapshotCatalog()` returns `[]` for a fresh/empty index (legitimate — every note needs processing). Returns `null` when the current generation's verification fails (corrupt catalog).
- `null` → `prepareLookup` throws `EngineError("STORE_READ_FAILED", ...)` inside the seam. `stepEnqueue` does not catch — the throw propagates to `.step`, which re-throws EngineErrors; `JobEngine.runPhaseStep`'s catch converts to `{ type: "retry", failureCode: toFailureCode(error) }`. Retries are bounded by `MAX_ATTEMPT_COUNT`.
- `[]` → empty Map inside the seam, predicate returns `false` for every note. Correct for a fresh index.
- Overlay validation throws from `snapshotCatalog()` propagate the same way: seam → `stepEnqueue` → `.step` re-throw → `runPhaseStep` catch → retry.

**`productionEngine.ts` builds the seam, owning the Map and `expectedRelatedVersion`:**

```typescript
const expectedRelatedVersion = relatedConfig
  ? PRODUCTION_RELATED_VERSION : undefined;

const catalogSnapshot: ScopeCatalogSnapshotSeam = {
  prepareLookup: async () => {
    const records = await this.indexStore.snapshotCatalog();
    if (records === null) {
      throw new EngineError("STORE_READ_FAILED",
        "Catalog snapshot returned null (generation verification failed).", {});
    }
    const map = new Map<string, { sourceHash: string; relatedVersion?: number }>();
    for (const r of records) {
      map.set(noteIdentityStableKey(r.identity), {
        sourceHash: r.sourceHash,
        relatedVersion: r.relatedVersion,
      });
    }
    return (identity: NoteIdentityV1, sourceHash: string): boolean => {
      const entry = map.get(noteIdentityStableKey(identity));
      if (!entry || entry.sourceHash !== sourceHash) return false;
      if (expectedRelatedVersion !== undefined
        && (entry.relatedVersion ?? 0) < expectedRelatedVersion) return false;
      return true;
    };
  },
};
```

**`ScopeJobRunner.stepEnqueue` — consumer side:**

```typescript
const isAlreadyIndexed = this.deps.catalogSnapshot
  ? await this.deps.catalogSnapshot.prepareLookup()
  : () => false;

for (const item of items) {
  if (signal.aborted) return { type: "cancelled" };
  if (isAlreadyIndexed(item.identity, item.sourceHash)) continue;
  await this.deps.enqueue.enqueueProcessNote(item, pipelineVersion, signal, batchId);
  enqueuedCount++;
}
```

No per-note async I/O. No Map or version knowledge in the runner.

### 3. Activity batch: `preparing` boolean

Add `preparing: boolean` to `EngineActivitySnapshot.batch`. No unbounded string.

`preparing` is `true` when the root job is nonterminal. Only `scope-refresh` and `rebuild-index` are bulk root kinds under current `submit()`/parser contracts (`reading-sync` is not bulk). For `scope-refresh`, preparing covers discover/enqueue; for `rebuild-index`, preparing covers all phases until terminal.

The root job is guaranteed present for an active batch by `parseBulkBatchV1`'s store invariant.

```typescript
batch?: {
  status: BulkBatchV1["status"];
  processed: number;
  total?: number;
  failed: number;
  preparing: boolean;
  enqueuedCount?: number;
};
```

### 4. Progress formula: `processed = (D - E) + terminal children`

After root completion: `D` = `discoveredTotal`, `E` = `enqueuedCount` from root's scope receipt, `(D - E)` = notes skipped by index check. During preparation, the presentation layer ignores numeric `processed` and shows "preparing". When D=0 (empty scope), the formula yields `processed=0, total=0` — no special handling, behavior unchanged.

### 5. Parsing invariants

**Receipt invariant:** `enqueuedCount <= discoveredCount` — add to `parseJobReceiptV1` scope-receipt validation and to `assertPersistedJobInvariants`. Never clamp — corrupted data fails the parse closed.

**`parseBulkBatchV1` completion invariant — `expectedItems`:** Completed batches (`completed` or `completed-with-failures`) require `items.length === expectedItems`, where `expectedItems` = root scope receipt `enqueuedCount` when defined, otherwise `discoveredTotal`. This replaces the current check against bare `discoveredTotal`, which is wrong when the catalog snapshot skips already-indexed notes (E < D). `syncBatches` already derives `expectedChildren` this way (line 230); the parser must enforce the same rule at load time. `rebuild-index` has no scope receipt, so falls back to `discoveredTotal`. D=0 (empty scope): `expectedItems=0`, `items.length=0` — passes.

### 6. Presentation: label, aria, title, menu detail

Preparing guard: `activity?.batch && (activity.batch.total === undefined || activity.batch.preparing)`. Priority chain unchanged: fault > operator-paused > provider-paused > Reading > Research > batch preparing/progress > queued > latest-failure > running > reading > pending. Aria-label and engine detail row follow the same preparing/progress split.

### 7. Pause/restart recovery — no changes

Queue is durable user state: never deleted, never edited. `preparing`, `processed`, `enqueuedCount` derived on-the-fly by `deriveEngineActivity` from persisted job/receipt state. `syncBatches`, `operatorPause`, `recoverInterruptedJobs` unchanged.

---

## Contract changes

| Contract | Change |
|---|---|
| `EngineActivitySnapshot.batch` | Add `preparing: boolean`, `enqueuedCount?: number` |
| `ScopeIndexCheckSeam` | Replace with `ScopeCatalogSnapshotSeam` |
| `ScopeCatalogSnapshotSeam` | `prepareLookup(): Promise<(identity: NoteIdentityV1, sourceHash: string) => boolean>` |
| `ScopeJobRunner` constructor deps | `indexCheck` → `catalogSnapshot` (optional `ScopeCatalogSnapshotSeam`) |
| `ScopeJobRunner.stepEnqueue` | Calls `prepareLookup()` once; uses returned predicate per item |
| `productionEngine.ts` | Builds seam: owns Map, `expectedRelatedVersion`, null→throw conversion |
| `parseJobReceiptV1` (scope) | Add `enqueuedCount <= discoveredCount` invariant |
| `assertPersistedJobInvariants` | Same invariant as cross-field check |
| `parseBulkBatchV1` | Completed batches: `items.length === expectedItems` where `expectedItems` = root `enqueuedCount` when defined, else `discoveredTotal` |

No persisted schema changes. No new files.

---

## Acceptance tests

**Group 1 — `deriveEngineActivity` batch progress:**
- `preparing=true` when root is nonterminal (scope-refresh: discover/enqueue; rebuild-index: all pre-terminal phases)
- `preparing=false, processed=(D-E)+terminal` when root completed, E=40, D=935, 10 children done → processed=905
- `preparing=false, processed=935` when all 40 children terminal
- `total=undefined` when `discoveredTotal` not yet set

**Group 2 — `buildStatusBarPresentation`:**
- `batch.preparing=true` → label "Mindmap · preparing" regardless of numeric total
- `batch.preparing=false, processed=895, total=935` → label "Mindmap · 895/935"
- Aria-label matches label state
- Fault/pause/Reading/Research priority preserved over batch display

**Group 3 — Catalog snapshot predicate (`scopeJob.test.ts`):**
- `prepareLookup()` returns predicate → skips notes with matching `sourceHash` and adequate `relatedVersion`, `enqueuedCount` correct
- `prepareLookup()` throws `STORE_READ_FAILED` (null snapshot) → `.step` re-throws, `runPhaseStep` converts to retry
- `prepareLookup()` throws (overlay validation) → same propagation path
- `prepareLookup()` returns predicate that rejects everything (fresh index) → all notes enqueued
- Predicate rejects stale `relatedVersion` even when `sourceHash` matches

**Group 4 — `productionEngine.ts` seam construction:**
- Predicate returns `false` when `sourceHash` mismatches
- Predicate returns `false` when `relatedVersion < expectedRelatedVersion`
- Predicate returns `true` when both `sourceHash` and `relatedVersion` match
- `snapshotCatalog()` returns `null` → seam throws `STORE_READ_FAILED`
- `snapshotCatalog()` returns `[]` → predicate returns `false` for all notes

**Group 5 — `enqueuedCount <= discoveredCount` invariant (`jobTypes.test.ts`):**
- `enqueuedCount=40, discoveredCount=935` → parses ok
- `enqueuedCount=936, discoveredCount=935` → `JOB_SHAPE_INVALID`
- Cross-field check in `assertPersistedJobInvariants` rejects the same

**Group 6 — `parseBulkBatchV1` completion with `expectedItems` (`jobTypes.test.ts`):**
- D=935, E=40, completed batch with 40 terminal items → parses ok
- D=935, E=40, completed batch with 935 items → `JOB_STORE_CORRUPT` (items.length !== expectedItems)
- D=935, E=undefined (no scope receipt yet), completed batch with 935 terminal items → parses ok (falls back to discoveredTotal)
- `completed-with-failures`: D=935, E=40, 40 items (39 completed + 1 failed) → parses ok
- `rebuild-index`: D=0, no scope receipt, completed batch with 0 items → parses ok

**Group 7 — End-to-end progress sequence:**
- Full lifecycle: preparing → preparing → 895/935 → 935/935
- Pause during enqueue → resume → still preparing until root completes
- Restart re-derives preparing/processed from persisted state

---

## Files changed

- `src/jobs/jobActivity.ts` — `EngineActivitySnapshot.batch` type, `deriveEngineActivity`
- `src/jobs/scopeJob.ts` — `ScopeCatalogSnapshotSeam` interface, `stepEnqueue` calls `prepareLookup()` and uses returned predicate
- `src/engine/productionEngine.ts` — Builds `ScopeCatalogSnapshotSeam`: owns Map, `expectedRelatedVersion`, null→throw
- `src/jobs/jobTypes.ts` — `enqueuedCount <= discoveredCount` invariant
- `src/statusBarState.ts` — preparing guard, aria-label, menu detail
- Test files: `jobActivity.test.ts`, `statusBarState.test.ts`, `scopeJob.test.ts`, `jobTypes.test.ts`
