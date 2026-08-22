# Mindmap 0.3.0 TypeScript Engine Rewrite Design

## Objective

Rewrite Mindmap as a standard desktop-only Obsidian TypeScript plugin. Python is the behavioral reference during development, not part of the final architecture or release.

The final product ships only the Community Plugin assets Obsidian supports:

- `main.js`
- `manifest.json`
- `styles.css`

It ships no Python interpreter, Python source, Python packages, requirements file, installer, daemon, companion application, localhost IPC service, or Python release archive.

## Product constraints

- `isDesktopOnly` remains `true`.
- Plugin logic runs in Obsidian's Electron/Node environment and is written in TypeScript.
- Ollama is the only embedding provider in 0.3.0, behind a provider-neutral TypeScript interface.
- Existing local metadata providers remain supported where practical: Ollama and OpenAI-compatible local endpoints.
- Exa remains an optional research provider with its existing consent, Keychain, privacy, and usage-limit boundaries.
- The rewrite preserves Standard Mode, Reading Mode, research companions, native status controls, settings, and note-writing behavior.
- The implementation treats the Python behavior and tests as a specification. It does not translate the Python implementation line by line.

## Architecture

### Vault catalog

`VaultCatalog` enumerates configured scopes through Obsidian's Vault API. It owns note eligibility, source hashing, rename/delete reconciliation, and the boundary between ordinary notes and managed Reading artifacts.

A note's `sourceHash` is calculated from user-authored content while excluding Mindmap-managed frontmatter keys and managed output sections. Mindmap's own writes therefore do not create processing loops. A separate generated-output hash records what Mindmap last wrote without making generated content the source of truth.

### Frontmatter and note writer

`FrontmatterEngine` uses a bundled TypeScript YAML document model that preserves key order, comments, scalar types, unrelated fields, and newline convention. It retains the current byte-preservation rules around managed regions.

`NoteWriter` is the single mutation boundary. It:

- writes vault notes only through Obsidian's Vault API;
- validates the current source hash immediately before mutation;
- preserves unrelated frontmatter and user-authored body content;
- keeps Apple Books annotation bodies annotation-only;
- writes Reading research to companion notes;
- makes every managed update idempotent.

### Embeddings and metadata

`EmbeddingProvider` is a TypeScript interface. The 0.3.0 implementation, `OllamaEmbeddingProvider`, uses Obsidian `requestUrl`, bounded batches, explicit timeouts, retry/backoff, and strict model/dimension validation.

Metadata extraction reuses provider-neutral TypeScript request and validation boundaries. Model output is schema-validated before any note or index write. Provider responses and errors remain redacted.

### Persistent vector index

The Chroma replacement is a deterministic two-tier exact index stored in the plugin's data directory.

The base generation contains:

- a contiguous `Float32Array` note-vector matrix;
- note metadata and stable path identifiers;
- sharded chunk-vector data with per-note offsets;
- a versioned manifest containing embedding model, dimension, counts, checksums, and schema version.

Incremental changes use atomic per-note overlay records. An overlay shadows the corresponding base note and contains its current note vector, chunk vectors, metadata, source hash, and checksum. Delete operations create tombstones.

Search first performs exact cosine ranking over note vectors. It then inspects chunk vectors only for the bounded top-note candidate set. This keeps memory and query cost predictable at the target ceiling of 10,000 notes and 100,000 chunks without introducing an approximate-nearest-neighbor dependency.

Compaction creates a new generation from the current base plus overlays. The plugin validates dimensions, counts, checksums, tombstones, and sample queries before atomically switching `current.json`. An interrupted or invalid rebuild leaves the prior generation active. Staging directories are ignored until verified and are cleaned safely on a later startup.

### Apple Books SQLite reader

`AppleBooksReader` is macOS-only and invokes `/usr/bin/sqlite3` through `execFile()` with fixed arguments and `shell: false`.

The reader:

- discovers only bounded, known Apple Books database roles;
- opens source databases read-only;
- uses SQLite transactions for consistent direct-read snapshots;
- checks source metadata before and after a read and retries if it changed;
- uses SQLite's backup mechanism into a private temporary directory only when isolation is required;
- never manually copies a database, WAL, or SHM file;
- validates table/column shapes and every returned field;
- emits structured, redacted diagnostics;
- removes only its own temporary files.

The backup destination is plugin-generated, validated to be inside the owned temporary directory, and passed as SQLite input rather than interpolated from user-controlled text.

If `/usr/bin/sqlite3`, Apple Books databases, or Full Disk Access are unavailable, Reading Mode degrades with actionable guidance. Standard Mode remains usable.

### Persistent job engine

`JobEngine` is the only execution coordinator. It serializes manual, scheduled, Reading, rebuild, and migration work and persists a versioned queue with atomic temp-write/rename semantics.

Each note job uses an idempotency key derived from operation, path identity, source hash, embedding model, and pipeline version. Its phases are:

1. discover and validate source;
2. embed;
3. extract and validate metadata;
4. re-read and confirm the source hash is unchanged;
5. write the note;
6. write the vector overlay;
7. mark the job complete.

A crash before completion leaves the job retryable. If the source changes during model work, the result is discarded and the new source is queued. Re-running any committed phase does not duplicate sections, frontmatter, companions, annotations, or vectors.

Only one mutation-capable job runs at a time. Read-only status and search operations may run concurrently against the last committed index generation.

### Preflight and health

TypeScript preflight checks:

- vault/config access;
- Ollama reachability and required embedding/model availability;
- metadata-provider configuration;
- vector index schema/model/dimension health;
- Apple Books SQLite availability and permissions when Reading is enabled;
- scheduler state and optional background integration.

Optional failures never disable unrelated capabilities. Health is represented as concise product state; bounded technical diagnostics remain behind explicit Copy diagnostics.

## Scheduling

### Core scheduler

`CoreScheduler` persists schedule definitions, `lastRunAt`, `nextRunAt`, and the last outcome. It uses `registerInterval()` while Obsidian is open.

On startup, it submits at most one catch-up job for each overdue schedule. It never replays a cascade of every missed interval. Daily maintenance, weekly refresh/rebuild, Reading sync, and manual work all enter the same `JobEngine` queue.

### Optional background scheduler

`BackgroundScheduler` is a removable adapter:

- macOS-only;
- disabled by default;
- enabled only after explicit consent;
- creates only a validated Mindmap-owned user LaunchAgent;
- invokes `/usr/bin/open` with a fixed `obsidian://open?vault=...` URL;
- runs no Mindmap logic, note path, Python, shell, daemon, or IPC process;
- may visibly open Obsidian, which is disclosed before activation.

When Obsidian opens, `CoreScheduler` decides what is due. The LaunchAgent contains no job semantics.

Turning the option off removes the exact Mindmap-owned plist and label. The plugin uses Obsidian's quit event to distinguish normal shutdown from disable/reload when available. If lifecycle intent is ambiguous, cleanup fails safe by removing the agent; it can be reconciled on the next launch when the setting remains enabled.

The adapter can be removed from a Community Plugin build without changing core scheduling, queue state, or schedule definitions if Obsidian review objects to OS-level scheduling.

## Data integrity and recovery

- Vault notes are authoritative; queues and vectors are rebuildable.
- State schemas are versioned and fail closed on unknown or corrupt data.
- State writes use validated temporary files and atomic replacement.
- Note writes precede vector-overlay commits; job completion follows both.
- Rename events preserve note identity. Missed rename events reconcile as delete plus add.
- Deleted notes create vector tombstones and never cause unrelated file deletion.
- Apple annotation IDs remain the stable identity for adoption and collision handling.
- Deleted Apple source annotations do not delete imported vault notes.
- Initial Reading activation remains import-only. Historical processing requires explicit confirmation; later annotations queue automatically while Reading Mode is active.
- Provider, SQLite, permission, and index failures are isolated and retryable without blocking ordinary vault use.

## Migration from 0.2.x

The migration preserves:

- plugin settings and scope selections;
- note content and frontmatter;
- Reading state, annotation paths, research status, and companion paths;
- research content and Keychain references;
- schedule definitions and last-run history where compatible.

The Chroma database is not parsed or imported. On first 0.3.0 startup, the plugin builds a complete TypeScript index from current vault notes. Chroma remains untouched and ignored until the TypeScript generation passes all verification. It is never used as a runtime fallback. A later explicit cleanup action may remove the legacy data.

Migration is resumable. Failure leaves notes unchanged and the new index inactive. Standard note editing and non-index-dependent UI remain available while migration waits or retries.

## Product behavior

- Python/runtime setup UI is removed.
- First 0.3.0 launch presents bounded index migration progress with cancellation and retry.
- Search and processing remain unavailable until a valid TypeScript generation exists; other plugin settings and Reading import health remain inspectable.
- Status and settings retain the simplified 0.2.1 information architecture.
- README disclosures cover Apple Books outside-vault access, `/usr/bin/sqlite3` execution, Ollama, Exa, and optional LaunchAgent management.

## Testing strategy

### Behavioral parity

During development, Python and TypeScript run against identical deterministic fixtures. Comparison covers frontmatter, metadata normalization, chunking, related-link selection, Reading annotation formatting, preview/apply behavior, and structured diagnostics.

Python comparison tooling is temporary. Before release, all Python production code, Python tests, requirements, packaging, installer code, runtime discovery/setup, and Python assets are removed from the repository's shipping surface.

### Fault injection

Tests interrupt every job and rebuild phase, including:

- before and after note mutation;
- before and after overlay commit;
- state-save and rename failures;
- stale source edits;
- provider timeout/auth/model failures;
- corrupt manifests, checksums, dimensions, overlays, and tombstones;
- cancellation and restart;
- concurrent manual, Reading, and scheduled triggers.

### Apple Books

Synthetic SQLite fixtures cover supported, partial, malformed, and evolving schemas. Tests assert fixed argv, no shell, read-only source behavior, source-stability retries, SQLite backup fallback, temporary cleanup, and actionable permission failures. A live probe verifies source size and modification time remain unchanged.

### Vector index

Fixed vectors assert deterministic cosine rankings and tie-breaking. Tests cover overlay precedence, delete/rename reconciliation, compaction, interrupted rebuilds, atomic generation switching, model/dimension changes, and target-scale memory/performance budgets.

### Scheduler

Fake-clock tests cover due calculations, timezone/day rollover, at-most-one startup catch-up, queue coalescing, failure backoff, and shutdown/restart. Background-adapter tests assert exact plist ownership, `/usr/bin/open` arguments, consent, reconciliation, and removal behavior.

### Integration and soak

Release gates include:

1. disposable-vault fresh install;
2. Python-versus-TypeScript shadow comparison with no writes;
3. production-vault dry run;
4. controlled TypeScript migration;
5. multi-day ordinary/Reading/scheduled soak;
6. official Obsidian lint and release review;
7. archive/source scan proving no Python, pip, requirements, runtime installer, daemon, companion, or Python asset ships.

## Implementation order

1. Capture behavioral contracts and golden fixtures.
2. Implement frontmatter, source hashing, state, and note-write parity.
3. Implement Apple Books SQLite reading and Reading import parity.
4. Implement Ollama embeddings and the two-tier persistent vector index.
5. Implement the persistent job engine, rebuild, recovery, and TypeScript preflight.
6. Replace scheduler integration and isolate the optional background adapter.
7. Migrate UI/runtime wiring, remove Python production paths, and complete migration tooling.
8. Run real-vault comparison, migration, soak, and Community Plugin release gates.

## Explicit non-goals for 0.3.0

- Python compatibility or fallback at runtime.
- Importing Chroma's internal vector representation.
- Remote embedding providers.
- SQLite WASM, `node:sqlite`, or native Node addons.
- A daemon, companion app, or localhost IPC service.
- Running Mindmap processing while Obsidian is closed.
- Replaying every schedule missed while Obsidian was closed.

## Success criteria

- The release contains only supported Obsidian plugin assets.
- No Python file, dependency, command, setup flow, or archive exists in the final product.
- Existing notes, Reading imports, research companions, and user-authored formatting survive migration unchanged except for explicitly managed fields.
- Search and related-note quality meet recorded parity thresholds on the production corpus.
- Rebuild and crash recovery never leave the active index unusable.
- Standard Mode remains usable when optional capabilities fail.
- The plugin passes TypeScript, official Obsidian lint, release validation, security scans, disposable-vault tests, production dry run, and soak testing.
