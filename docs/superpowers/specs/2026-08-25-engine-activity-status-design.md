# Engine Activity Status Design

## Goal

Make the Mindmap status bar accurately represent TypeScript-engine work. It must show both live queue activity and trustworthy progress for a bulk run, survive restarts, and prevent overlapping manual or scheduled bulk runs. Single-note submissions remain available and continue to coalesce.

## Non-goals

- Replacing the durable job engine or its single-worker execution model.
- Turning the status bar into a job-management dashboard.
- Combining "pending" discovery with queued work. Pending continues to mean eligible work that is neither current in the index nor already queued.
- Showing progress for unbatched work as though it belonged to a bulk run.

## State model

### Engine activity snapshot

`JobEngine` exposes an immutable activity snapshot and a subscription API. The snapshot contains:

- pump state: `stopped`, `idle`, `running`, `paused`, or `faulted`;
- queued, active, failed, and terminal counts for non-historical work;
- provider-pause and engine-fault information;
- the current job's kind, phase, path when applicable, and attempt count;
- the currently active bulk batch summary, if one exists.

Subscribers receive an initial snapshot and updates after submission, phase start, phase outcome, pause/resume, fault, idle transition, startup recovery, and disposal. Observer failures are isolated and never affect job execution.

### Persisted bulk batch

Add a bounded, versioned `BatchStore` under the production-engine data root. A batch record contains:

- `batchId`, trigger, scope, and timestamps;
- lifecycle state: `creating`, `active`, `completed`, `completed-with-failures`, `failed`, or `cancelled`;
- root scope-job ID;
- discovered total;
- last known failure code where applicable.

Every process-note job participating in the batch carries the batch ID. A batch's completed, failed, cancelled, queued, and active counters are derived from `JobStore`; they are not independently authoritative counters. This prevents cross-store counter drift. Startup reconciliation repairs batch lifecycle state from the root job and associated child jobs.

Only one non-terminal bulk batch may exist. Batch creation uses the store's serialized mutation lane, making the check-and-create operation atomic.

## Submission and execution flow

1. A bulk command asks `ProductionEngine` to create a batch.
2. `BatchStore` rejects creation when another batch is non-terminal.
3. The engine submits the root scope-refresh job with the batch ID and records its job ID. A `creating` record makes the submit step restart-safe; reconciliation retries an incomplete submit using the same batch identity.
4. Scope discovery records the discovered total.
5. Scope enqueue attaches the batch ID to each child process-note job. When submission coalesces with matching existing work, the existing non-terminal job is adopted into the active batch rather than duplicated.
6. Replacement jobs caused by source changes inherit the batch ID.
7. Activity snapshots derive progress from all jobs carrying that batch ID.
8. The batch becomes terminal after the root job and every associated child job are terminal.

Manual and scheduled bulk submissions are rejected while a batch is active. Single-note submissions remain permitted; identical work coalesces normally. Reading submissions keep their existing behavior and are not treated as bulk batches in this change.

## Status-bar behavior

`main.ts` caches the latest engine activity snapshot and requests a status render through a short trailing throttle. It removes `currentProcess` and `activeRunStatus` entirely.

Priority is:

1. actionable fault or provider pause;
2. active Reading or Web Research state;
3. active bulk-batch progress;
4. unbatched engine activity;
5. preflight;
6. pending count / ready state.

Examples:

- `Mindmap · 374/933` while a bulk batch is progressing;
- `Mindmap · 566 queued` for unbatched queued work;
- `Mindmap · paused` or `Mindmap · fault` with an alert icon;
- `Mindmap · 1 pending` only when the engine is otherwise idle.

The tooltip/menu adds current phase, current note basename, queued count, and failure count. It does not expose absolute paths.

Bulk actions and scheduled bulk ticks use active-batch state for blocking. Single-note actions remain enabled. Web Research uses current model activity—not the existence of a long backlog—to avoid competing Ollama calls while still remaining usable between model phases.

Migration and direct semantic lookup remain separate activity sources. Migration activity is included in the same presentation priority; short sidebar lookup calls do not replace bulk progress but may mark the engine model as busy for concurrency control.

## Error and restart behavior

- Provider pause produces a stable alert state until explicitly resumed.
- Job-engine faults produce a stable fault state and stop progress animation.
- Individual failures increment batch failure progress; the batch settles as `completed-with-failures` after all other children finish.
- A failed root scope job settles the batch as `failed`.
- Startup reconciles `creating` and `active` batches before publishing the initial snapshot.
- Malformed batch data fails closed through the same bounded persistence conventions as jobs and schedules.
- Status observers and DOM rendering failures never affect durable execution.

## Testing

### Unit tests

- Batch creation, single-active-batch enforcement, lifecycle transitions, and bounded parsing.
- Child association, coalesced-job adoption, replacement inheritance, and derived counters.
- Retry, failure, cancellation, provider pause, fault, and restart reconciliation.
- Activity emissions for submit, phase start/outcome, idle, pause/resume, fault, and dispose.
- Observer isolation and render throttling.

### Integration tests

- A controlled real `ProductionEngine` job drives `main.ts` status from idle to loader to completion.
- Bulk progress remains accurate across restart.
- Manual and scheduled bulk runs are blocked during an active batch.
- Single-note work remains allowed and coalesces during an active batch.
- Pending counts remain independent from queue and batch progress.
- Migration and Web Research retain their higher-priority actionable states.

### Regression tests

- An active TypeScript job cannot render the idle orbit state.
- Hundreds of queued jobs cannot render merely as the pending count.
- A second bulk command cannot create another bulk batch.
- No production status or concurrency guard references the retired subprocess fields.

## Delivery boundaries

Implement in three reviewable slices:

1. persisted batch identity and lifecycle;
2. engine activity observation and snapshot derivation;
3. status/menu integration, concurrency guards, and end-to-end regression tests.

No unrelated UI redesign or engine refactor is included.
