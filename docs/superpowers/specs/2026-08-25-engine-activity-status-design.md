# Engine Activity Status Design

## Goal

Make the status bar accurately show TypeScript-engine work, including restart-safe bulk progress, while preventing overlapping manual or scheduled bulk runs. Single-note work remains available and coalesces normally.

## Scope

This change covers the durable `JobEngine` queue and bulk scope runs. Pending remains a separate “not indexed and not queued” concept. Reading, migration, and direct semantic-query behavior are not redesigned.

## Atomic batch ledger

Batch metadata belongs inside `JobStoreDocumentV1`, not in a separate store. Jobs, scheduled occurrences, and batch progress therefore change in one existing atomic commit with no cross-store recovery gap.

Add an optional `bulkBatches` collection that defaults to `[]` when loading existing version-1 queue documents. Keep only one non-terminal batch plus bounded terminal history.

A batch contains:

- batch ID, root scope-job ID, trigger, scope, and timestamps;
- optional scheduled occurrence ID;
- status: `active`, `completed`, `completed-with-failures`, `failed`, or `cancelled`;
- discovered total;
- a bounded item ledger keyed by a content-free `batchItemId` hash;
- each item’s current job ID and status.

Process-note jobs carry `batchId` and `batchItemId`. The item ID represents one discovered note slot and survives source-change replacements, preventing retries or replacement jobs from increasing the denominator.

Manual batch creation atomically appends the batch and root job. Scheduled batch creation atomically appends the batch, root job, and occurrence record. Retrying the same occurrence returns the same root even if it is already terminal.

When scope enqueue coalesces with matching single-note work, that job is atomically adopted into the batch. Replacements inherit both identifiers. Job transitions update the item ledger in the same `JobStore` mutation. Terminal jobs may then be pruned without losing progress.

An existing non-terminal unbatched scope/rebuild job blocks new bulk creation. Existing unbatched note jobs may be adopted during enqueue.

## Activity snapshot

`JobEngine` exposes a read-only subscription with one immutable snapshot:

- state: `idle`, `running`, `paused`, `faulted`, or `stopped`;
- non-terminal queued and active counts;
- current job kind, phase, relative path, and attempt;
- provider pause or engine fault;
- active-batch processed/total and failed counts;
- the latest terminal batch failure summary.

“Processed” means batch items in a terminal state; failures are reported separately. Before discovery completes, the batch reports `preparing` rather than a guessed denominator.

Snapshots are emitted only after durable mutations, plus pump idle/fault/stop transitions. Listener failures are isolated. Snapshot derivation reads the already-cached job document and never scans the vault or polls the filesystem.

## Status behavior

`main.ts` caches the latest snapshot and registers both the subscription cleanup and a bounded render timer with the plugin lifecycle. DOM updates are trailing-throttled to at most four per second.

Priority:

1. engine fault or provider pause;
2. active Reading or Web Research state;
3. active batch progress;
4. unbatched queue activity;
5. latest batch completed with failures;
6. preflight;
7. pending count / ready.

Examples:

- `Mindmap · preparing`
- `Mindmap · 374/933`
- `Mindmap · 12 queued`
- `Mindmap · paused`
- `Mindmap · 3 failed`

The tooltip/menu may show the current phase, note basename, queued count, and failed count. It never shows an absolute path.

Bulk actions and scheduled bulk ticks are blocked by the atomic engine rule, not merely disabled in the UI. Single-note actions remain enabled. Web Research is conservatively blocked while process-note work is non-terminal, matching the former whole-run exclusion without adding a new model-arbitration subsystem.

Remove `currentProcess` and `activeRunStatus` completely.

## Obsidian compliance

- Keep the existing `addStatusBarItem()` integration.
- Register subscription and timer cleanup through the plugin lifecycle.
- Build UI with Obsidian DOM helpers; never use `innerHTML`.
- Use sentence-case copy.
- Use CSS classes and Obsidian theme variables; add no inline or hardcoded colors.
- Add no global `app` access, console logging, vault-wide UI polling, Adapter API use, or file-by-path iteration.
- Run the repository’s official-guideline lint gate, `npm run lint:obsidian`.

These constraints follow Obsidian’s guidance on status items, cleanup, safe DOM construction, sentence case, styling, and avoiding unnecessary work.

## Testing

- Parse and migrate existing queue documents with no batch field.
- Prove atomic manual and scheduled batch/root creation.
- Prove single-active-batch enforcement and scheduled occurrence idempotency.
- Prove coalesced adoption, replacement inheritance, pruning-safe progress, failure totals, and restart recovery.
- Prove activity transitions: queued, active phase, idle, pause, fault, and completion.
- Prove active TypeScript work cannot render the idle orbit or only the pending count.
- Prove bulk actions block while single-note actions remain available.
- Prove lifecycle cleanup, render throttling, sentence-case UI, no absolute paths, and reduced motion.

## Delivery

Three reviewable checkpoints:

1. atomic batch ledger and propagation;
2. activity subscription and status wiring;
3. full regression, Obsidian lint, build, and disposable-vault verification.

No unrelated engine refactor, UI redesign, direct semantic telemetry, or production-vault deployment is included.
