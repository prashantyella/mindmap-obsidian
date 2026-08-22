# Mindmap 0.3.0 TypeScript Engine Rewrite Implementation Plan

## Goal

Replace every shipped Python-owned capability with TypeScript while preserving Mindmap's data-integrity, Reading, research, search, recovery, and scheduling behavior.

The final release is a standard desktop-only Obsidian plugin containing only `main.js`, `manifest.json`, and `styles.css`. No Python source, interpreter, dependency, package installer, worker, archive, daemon, companion application, or localhost IPC service remains.

Design specification:

- `docs/superpowers/specs/2026-08-22-typescript-engine-rewrite-design.md`

Starting point:

- Branch: `feature/product-ui-cleanup`
- Design commit: `fe5aec1`
- Community compliance baseline: `c256d5f`

## Working rules

- The manager assigns one checkpoint at a time to the visible `mindmap-coder` tmux worker.
- The worker does not commit, push, tag, release, deploy, or touch production vaults unless a checkpoint explicitly authorizes it.
- The manager reviews diffs and gates before committing each checkpoint.
- Python remains the read-only behavioral oracle only until the parity and migration gates pass.
- No checkpoint performs Python and TypeScript writes against the same note or index.
- Apple-owned databases are always read-only and are never repaired, modified, or replaced.
- Release-facing code uses Obsidian APIs, `requestUrl`, fixed-argument `execFile`, and `shell: false`.
- Every persistent format is versioned, validated, bounded, and recoverable.
- Substantive failure paths receive deterministic tests before integration.
- The existing official Obsidian lint gate remains at zero errors. The documented settings-search warning may remain while `minAppVersion` is 1.7.2.

## Dependency graph

```text
Behavior contracts
  -> frontmatter/source hash/state
  -> Apple Books reader
  -> vector codecs/store
  -> Ollama embeddings + metadata pipeline
  -> persistent job engine
  -> core/background schedulers
  -> shadow plugin integration
  -> migration + TypeScript cutover
  -> Python removal + 0.3.0 release
```

Frontmatter/state, Apple Books, and vector storage can be developed independently after the shared contracts exist. Plugin cutover waits for all three plus the job engine.

## Checkpoint 1 — Behavioral contracts and parity corpus

### Outcome

Create the TypeScript-domain contracts and a deterministic fixture corpus that records behavior without changing production execution.

### Likely files

- `src/engine/contracts.ts`
- `src/engine/errors.ts`
- `src/engine/sourceProjection.ts`
- `src/engine/contracts.test.ts`
- `src/engine/sourceProjection.test.ts`
- `tests/fixtures/engine/`
- `tools/parity/` (temporary development-only tooling)

### Work

- Define versioned types for note snapshots, source projections, metadata output, embeddings, related candidates, index records, queue jobs, health checks, and structured failures.
- Define canonical path normalization and stable note identity.
- Define `sourceHash` input precisely:
  - user-authored frontmatter and body are included;
  - Mindmap-managed frontmatter keys and managed sections are excluded;
  - newline convention is normalized only for hashing, never for writes.
- Extract deterministic fixtures from current Python tests for:
  - frontmatter parsing/mutation;
  - chunking;
  - tag/concept normalization;
  - related-link selection and tie-breaking;
  - individual-note eligibility;
  - Reading formatting and companion behavior;
  - preview validation and diagnostics.
- Add a development-only comparison command that reads fixtures and emits normalized JSON. It must not read production vaults or become reachable from `main.ts`.
- Record the current production scale benchmark without note content: 1,094 scoped Markdown notes, 275 indexed notes, 436 chunks, 1,024 dimensions.

### Tests

- Contract schema/version rejection.
- Stable hash across managed-output-only changes.
- Hash change for user-authored changes.
- LF/CRLF hash equivalence while preserving original bytes in the snapshot.
- Deterministic paths, ordering, and error codes.
- Source audit proving parity tooling is not imported by production code.

### Gates

- Existing TypeScript/Python suites.
- Typecheck, both lint gates, build, release validation, diff check.
- No production behavior change.

## Checkpoint 2 — Frontmatter, atomic state, and note-write parity

### Outcome

Provide the TypeScript data-integrity foundation before model or index work.

### Likely files

- `src/engine/frontmatterEngine.ts`
- `src/engine/frontmatterEngine.test.ts`
- `src/engine/atomicStore.ts`
- `src/engine/atomicStore.test.ts`
- `src/engine/noteWriter.ts`
- `src/engine/noteWriter.test.ts`
- `package.json`
- `package-lock.json`

### Work

- Add a pinned, pure-TypeScript YAML document dependency after license and bundle inspection.
- Parse and update frontmatter while preserving:
  - key order and comments;
  - scalar/list types;
  - unrelated fields;
  - LF/CRLF convention;
  - exact bytes outside managed regions.
- Port the Python normalization contracts for summary, tags, concepts, related links, and Apple annotation special handling.
- Implement `AtomicStore<T>` with schema validation, temp write, fsync where supported, atomic rename, stale-temp cleanup, and fail-closed load behavior.
- Implement a UI-free `NoteWriter` seam over a vault adapter.
- Re-read and validate `sourceHash` immediately before mutation.
- Keep standard-note managed sections, annotation-only bodies, and research companion rules idempotent.
- Do not wire production commands yet.

### Tests

- Golden byte parity for all Python frontmatter fixtures.
- Comments, quoted scalars, multiline values, Unicode, CRLF, malformed/incomplete frontmatter.
- Existing managed section replacement and user section preservation.
- Annotation summary/tag removal and concept/related wikilinks.
- State write/rename/fsync/load failures and corrupt-version recovery.
- Stale-source rejection immediately before note modification.
- Ten-cycle idempotency for ordinary and Reading notes.

### Gates

- Exact fixture parity for deterministic outputs.
- No note writes outside injected memory-vault tests.
- Full existing gates.

## Checkpoint 3 — TypeScript Apple Books SQLite reader

### Outcome

Replace `apple_books_reader.py` with a read-only TypeScript reader behind the existing Reading payload boundary.

### Likely files

- `src/reading/appleBooksSqlite.ts`
- `src/reading/appleBooksSqlite.test.ts`
- `src/reading/appleBooksSchema.ts`
- `src/reading/appleBooksSchema.test.ts`
- `src/reading/sqliteProcess.ts`
- `src/reading/sqliteProcess.test.ts`
- existing Apple Books discovery/import integration files
- CI workflow only if a deterministic SQLite fixture tool is needed

### Work

- Create an injected `SqliteProcess` interface and real `/usr/bin/sqlite3` `execFile` adapter.
- Enforce fixed arguments, `shell: false`, bounded stdout/stderr, timeout, cancellation, and Error-only rejection.
- Discover bounded annotation/library database roles using existing TS discovery rules.
- Query source databases with `-readonly`, explicit transactions, and JSON output.
- Check source size/mtime before and after reads; retry a bounded number of times on change.
- Implement SQLite `.backup` isolation only when direct consistency cannot be established.
- Validate the generated temporary root and backup destination before invocation.
- Port schema/table/column discovery and timestamp/text validation from Python behavior.
- Produce the exact existing `AppleBooksReaderPayload` contract.
- Add structured codes for missing SQLite, permission denial, schema partial, timeout, unstable source, and malformed output.
- Wire a development shadow reader that compares payloads without importing or writing notes.

### Tests

- Fixed argv/no-shell/source-readonly assertions.
- Synthetic supported, partial, malformed, deleted-row, and versioned-file schemas.
- Direct-read success, source-change retry, backup fallback, cancellation, and temp cleanup.
- Bounded output and redacted process errors.
- Stable IDs and payload equality with Python fixtures.
- Live probe: source metadata unchanged before/after; no vault writes.

### Gates

- TypeScript reader parity on all deterministic fixtures.
- Live macOS probe remains optional and read-only.
- Full existing gates.

## Checkpoint 4 — Vector codecs and exact-query core

### Outcome

Build the dependency-free mathematical and binary-format core of the Chroma replacement.

### Likely files

- `src/index/vectorTypes.ts`
- `src/index/vectorCodec.ts`
- `src/index/vectorCodec.test.ts`
- `src/index/cosineIndex.ts`
- `src/index/cosineIndex.test.ts`
- `src/index/indexManifest.ts`
- `src/index/indexManifest.test.ts`

### Work

- Define the versioned base-generation and overlay formats.
- Encode/decode little-endian `Float32Array` vectors with dimension/count/checksum validation.
- Normalize vectors once and use deterministic exact cosine ranking.
- Define stable tie-breaking by score then normalized path/record ID.
- Implement note-first search and bounded chunk refinement for top note candidates.
- Validate model identity and embedding dimensions on every load/query/update.
- Set target budgets:
  - 10,000 notes;
  - 100,000 chunks;
  - 1,024 dimensions;
  - bounded top-note refinement;
  - committed-index startup at or below 3 seconds on the reference Mac;
  - query p95 at or below 250 milliseconds at the synthetic target scale;
  - steady-state index memory at or below 128 MB beyond Obsidian's baseline;
  - rebuild peak memory at or below 512 MB;
  - index disk usage at or below 600 MB.

### Tests

- Round-trip binary fixtures and endian checks.
- NaN/Infinity/wrong-dimension/truncated/corrupt-checksum rejection.
- Exact ranking and deterministic ties.
- Tombstone and overlay shadow semantics as pure record operations.
- Target-scale synthetic benchmark with recorded memory/query timings.

### Gates

- No filesystem or plugin wiring yet.
- Benchmark regression thresholds documented, not silently loosened.
- Full existing gates.

## Checkpoint 5 — Persistent index generations, overlays, and compaction

### Outcome

Make the vector index crash-safe and incrementally writable.

### Likely files

- `src/index/vectorStore.ts`
- `src/index/vectorStore.test.ts`
- `src/index/generationStore.ts`
- `src/index/generationStore.test.ts`
- `src/index/overlayStore.ts`
- `src/index/overlayStore.test.ts`
- `src/index/indexFs.ts`

### Work

- Implement base-generation storage in the plugin data directory.
- Implement atomic per-note overlays and tombstones that shadow base records.
- Load the current base plus overlays into a searchable committed view.
- Write compaction/rebuild output into a new staging generation.
- Validate manifest, checksums, dimensions, counts, paths, tombstones, and sample queries.
- Atomically switch `current.json` only after verification.
- Ignore incomplete staging generations on load and clean them safely later.
- Serialize mutation/compaction while allowing concurrent reads of the prior committed generation.
- Keep legacy Chroma untouched and outside all runtime load paths.

### Tests

- Fault injection before/after every file write, rename, pointer switch, and cleanup.
- Overlay update/delete/rename precedence.
- Reader consistency during compaction.
- Corrupt current pointer fallback to last valid generation without guessing.
- Model/dimension migration requiring rebuild.
- Rebuild cancellation leaves active generation unchanged.

### Gates

- Crash matrix passes.
- No Chroma imports or reads in new index modules.
- Full existing gates.

## Checkpoint 6 — Ollama embeddings and metadata pipeline

### Outcome

Port inference, chunking, normalization, and related selection into provider-neutral TypeScript services.

### Likely files

- `src/engine/embeddingProvider.ts`
- `src/engine/ollamaEmbeddingProvider.ts`
- `src/engine/ollamaEmbeddingProvider.test.ts`
- `src/engine/chunker.ts`
- `src/engine/chunker.test.ts`
- `src/engine/metadataPipeline.ts`
- `src/engine/metadataPipeline.test.ts`
- `src/engine/relatedSelector.ts`
- `src/engine/relatedSelector.test.ts`

### Work

- Implement Ollama embeddings through `requestUrl` with bounded batching, retries, backoff, timeout, cancellation, and dimension validation.
- Port chunking and overlap behavior from fixtures.
- Port metadata prompts, response parsing, validation, tag aliases/frequency filters, concept rules, and related-link selection.
- Retain local Ollama/OpenAI-compatible metadata providers behind existing TypeScript interfaces.
- Keep embeddings Ollama-only in 0.3.0.
- Separate model inference from all note/index writes.
- Redact provider responses and authentication details from errors/logs.

### Tests

- Request shape, batching, retries, cancellation, malformed response, missing model, and dimension mismatch.
- Golden chunk boundaries and normalization outputs.
- Strict JSON/schema failures produce no writes.
- Related-selection parity and deterministic ordering.
- No remote embedding-provider implementation or configuration appears.

### Gates

- Deterministic fixture parity.
- No live model calls in automated tests.
- Full existing gates.

## Checkpoint 7 — Persistent job engine and recovery

### Outcome

Replace Python process orchestration with one serialized TypeScript state machine.

### Likely files

- `src/jobs/jobTypes.ts`
- `src/jobs/jobStore.ts`
- `src/jobs/jobStore.test.ts`
- `src/jobs/jobEngine.ts`
- `src/jobs/jobEngine.test.ts`
- `src/jobs/noteJob.ts`
- `src/jobs/noteJob.test.ts`
- `src/jobs/rebuildJob.ts`
- `src/jobs/rebuildJob.test.ts`

### Work

- Define versioned jobs, phases, attempts, timestamps, pause reasons, and terminal outcomes.
- Generate idempotency keys from operation, stable note identity, source hash, embedding model, and pipeline version.
- Coalesce duplicate manual, Reading, scheduled, and rebuild triggers.
- Serialize mutation-capable jobs; allow read-only searches on the committed generation.
- Implement the strict note-job phase order from the design.
- Persist before external/model work where retry accounting matters.
- Re-read source before note mutation and discard stale results.
- Recover pending/in-progress jobs deterministically on startup.
- Provide cancellation and teardown without committing later phases.
- Route rebuild/compaction through the same queue.

### Tests

- Failure/restart after every phase.
- Note write succeeds/index fails; retry repairs index without rewriting user bytes.
- Source edit during inference.
- Rename/delete during queued and active work.
- Concurrent trigger coalescing and ordering.
- Cancellation before and after irreversible commits.
- Provider terminal versus transient outcomes.

### Gates

- Fault-injection matrix complete.
- No subprocess orchestration in the new engine.
- Full existing gates.

## Checkpoint 8 — Core scheduler and optional BackgroundScheduler

### Outcome

Replace Python-oriented scheduling with persisted TypeScript due-state and an isolated optional LaunchAgent adapter.

### Likely files

- `src/scheduling/coreScheduler.ts`
- `src/scheduling/coreScheduler.test.ts`
- `src/scheduling/scheduleStore.ts`
- `src/scheduling/scheduleStore.test.ts`
- `src/scheduling/backgroundScheduler.ts`
- `src/scheduling/backgroundScheduler.test.ts`
- existing scheduler/settings modules

### Work

- Persist schedule definitions, timezone-aware next due time, last run, and outcome.
- Use `registerInterval()` while Obsidian is open.
- Submit at most one catch-up job per overdue schedule on startup.
- Route all due work into `JobEngine`; never execute directly from a timer callback.
- Implement `BackgroundScheduler` as an optional macOS adapter:
  - explicit consent;
  - fixed `/usr/bin/open` argv with an encoded Obsidian vault URL;
  - no shell, job arguments, note paths, or processing logic;
  - exact plist/label ownership and safe removal;
  - startup reconciliation and fail-safe unload behavior.
- Keep the adapter removable through dependency injection/feature composition.

### Tests

- Fake-clock interval, day/week/timezone/DST behavior.
- At-most-one catch-up and no replay cascade.
- Queue coalescing when startup, timer, and manual triggers coincide.
- Consent and unsupported-platform behavior.
- Exact plist/argv, ownership validation, reconciliation, disable/removal, reload, and ambiguous unload.

### Gates

- Core scheduler passes with background adapter omitted.
- Official lint and disclosure audit.
- Full existing gates.

## Checkpoint 9 — Shadow plugin integration and TypeScript preflight

### Outcome

Connect the new engine read-only to the plugin without changing production writes.

### Likely files

- `src/engine/mindmapEngine.ts`
- `src/engine/mindmapEngine.test.ts`
- `src/engine/preflight.ts`
- `src/engine/preflight.test.ts`
- `src/main.ts`
- status/settings integration files
- temporary parity commands guarded from production UI

### Work

- Compose catalog, frontmatter, Apple reader, embeddings, vector store, jobs, and scheduler behind `MindmapEngine`.
- Implement TypeScript-only structured preflight.
- Add a development-only shadow profile that:
  - reads the same eligible notes;
  - computes previews and search results;
  - performs no note/index/state writes;
  - compares normalized output with Python.
- Keep existing production commands on Python during this checkpoint.
- Expose bounded shadow diagnostics outside ordinary settings/status UI.
- Replace Python Apple Books reader calls with TypeScript only after payload parity passes.

### Tests

- Composition and lifecycle teardown.
- Optional capability isolation.
- Preflight exact checks/codes and no subprocess/provider hangs.
- Shadow mode cannot access mutation methods.
- No Python fallback inside TypeScript component interfaces.

### Gates

- Disposable-vault shadow comparison.
- Production-vault read-only shadow report.
- No production write-path change yet.

## Checkpoint 10 — TypeScript cutover, migration, search, and UI

### Outcome

Make the TypeScript engine authoritative while retaining a controlled rollback branch in Git history, not at runtime.

### Likely files

- `src/main.ts`
- command/status/settings/sidebar integration files
- migration modules and tests
- semantic environment modules
- pending scan modules

### Work

- Route manual/current/all/Reading/rebuild commands into `JobEngine`.
- Replace Python semantic worker with direct committed-index queries.
- Replace Python pending state with catalog/job/index state.
- Implement first-run 0.2.x migration:
  - preserve settings, Reading/research state, and schedule history;
  - build and verify the TypeScript generation;
  - leave Chroma untouched and ignored;
  - resume after cancellation/failure;
  - expose progress, retry, and later explicit cleanup.
- Replace runtime/Python setup status with engine/index/provider health.
- Keep Standard Mode usable while optional Reading/research/index migration is unavailable.
- Remove Python execution from all user commands and scheduled paths.

### Tests

- Command-to-job mappings and action guards.
- Migration success, failure, cancellation, restart, model change, and already-migrated no-op.
- Sidebar lookup/pinning/search against TypeScript index.
- Reading first import/backlog/new annotation behavior.
- Status/settings product-state regressions.
- Source audit: no user-reachable Python execution.

### Gates

- Fresh disposable-vault install using only TypeScript paths.
- Existing product UI regressions.
- Python remains only for development comparison, not runtime.

## Checkpoint 11 — Remove Python and prepare 0.3.0

### Outcome

Delete the obsolete runtime and make Python absence a permanent release invariant.

### Likely removals

- `python/`
- Python tests and fixtures no longer needed by TypeScript tests
- runtime discovery/setup/verifier/assets modules
- Python process/worker/command construction modules
- Python configuration migration code after required settings migration is captured in TypeScript
- Python packaging and archive creation
- Python CI setup/install/test steps

### Work

- Remove every Python runtime, worker, preflight, installer, requirements, zip, and bundled-runtime asset.
- Remove Python settings and UI copy.
- Remove Python-oriented child-process paths; retain only approved system integrations (`/usr/bin/sqlite3`, `/usr/bin/security`, `/bin/launchctl`, `/usr/bin/open`) with fixed argv and disclosures.
- Update release preparation to emit only three supported assets.
- Bump all version metadata to `0.3.0` and write the final changelog section.
- Update README architecture, privacy, migration, Apple Books, Ollama, Exa, scheduler, and troubleshooting documentation.
- Add validation that fails on:
  - tracked `.py` files;
  - requirements/pip/venv/runtime-installer strings in shipping source;
  - Python assets or zip files in release output;
  - unsupported release attachments;
  - missing attestations/release notes.

### Tests

- Source/release scans for forbidden Python artifacts and commands.
- Fresh `npm ci` with no Python installation.
- Reproducible build and artifact attestation inputs.
- Official Obsidian lint and dependency audit.

### Gates

- `npm run check` is the complete build/test gate.
- Release directory contains exactly `main.js`, `manifest.json`, and `styles.css`.
- No Python executable is invoked during any test or runtime path.

## Checkpoint 12 — Real-vault migration, soak, and Community release

### Outcome

Prove the rewrite on realistic data before publishing 0.3.0.

### Work

1. Build a disposable integration vault beside the existing test vault.
2. Run a read-only production shadow comparison and archive only aggregate metrics/redacted mismatches.
3. Confirm parity thresholds before writes:
   - 100% deterministic frontmatter/Reading fixture parity;
   - zero unsafe paths or destructive proposals;
   - stable note/index counts;
   - mean related-note overlap@8 of at least 75% across the representative production sample;
   - no query that returns related results in Python becomes empty in TypeScript without an explicitly reviewed eligibility correction;
   - every ranking mismatch is included in the redacted review report rather than silently waived;
   - committed-index startup at or below 3 seconds and query p95 at or below 250 milliseconds on the reference Mac;
   - steady-state index memory at or below 128 MB, rebuild peak memory at or below 512 MB, and index disk usage at or below 600 MB at the synthetic target scale.
4. Run controlled production migration with Chroma untouched.
5. Exercise Standard/Reading switching, import, backlog, new annotations, manual/automatic research, search, rebuild, scheduler, restart, and cancellation.
6. Soak ordinary and Reading scheduling for multiple days while monitoring job/index health.
7. Run dependency, secret, unsafe-process, official-lint, archive, and reproducibility audits.
8. Obtain peer code review and close blockers.
9. Open/merge the release PR, tag `0.3.0`, publish only supported attested assets with release notes, deploy the production vault, and resubmit to Obsidian.

### Release stop conditions

- Any note-byte corruption outside managed fields.
- Any Apple-owned source mutation.
- Any index pointer/rebuild state that cannot recover to the prior generation.
- Any user-reachable Python path or Python artifact.
- Any unredacted credential/provider body in logs or diagnostics.
- Any official Obsidian lint error.
- Any unresolved Community Plugin policy blocker.

## Final acceptance checklist

- [ ] Standard Obsidian TypeScript plugin; `isDesktopOnly: true`.
- [ ] Three supported release assets only.
- [ ] No Python or companion runtime.
- [ ] Ollama-only embeddings behind a TypeScript interface.
- [ ] Read-only Apple Books access through fixed-argument `/usr/bin/sqlite3`.
- [ ] Deterministic exact vector index with atomic rebuild and overlays.
- [ ] Frontmatter/state/Reading/research parity.
- [ ] Persistent serialized TypeScript job engine.
- [ ] In-app scheduling with startup catch-up.
- [ ] Optional removable BackgroundScheduler adapter.
- [ ] Chroma ignored, never parsed; cleanup remains explicit.
- [ ] Fresh install, migration, production dry run, and soak pass.
- [ ] Official lint, security, reproducibility, attestation, and Community review pass.
