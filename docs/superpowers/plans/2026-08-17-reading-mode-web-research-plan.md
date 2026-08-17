# Reading Mode and Web Research Implementation Plan

## Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-17-reading-mode-web-research-design.md`.
- Keep Reading Mode experimental, macOS-only, and active only while Obsidian is open.
- Do not copy Mastra, MCP, Anthropic, OpenAI, or the unsafe filesystem server.
- Do not store or log the Exa credential; production retrieval is through macOS Keychain.
- Delegate one bounded coding task at a time to `gpt-5.6-luna` with high reasoning.
- Primary agent reviews scope, security, diff, tests, and live behavior before advancing.
- Preserve existing scheduling, Qwen configuration, vault state, and installed plugin settings.

## 1. Interactive status menu and scheduler states

Likely files:

- `src/statusBarMenu.ts` and tests
- `src/main.ts`
- `src/launchAgent.ts` and tests
- `styles.css`

Work:

- Turn the status item into a semantic, keyboard-accessible menu button.
- Use a native Obsidian `Menu` with mode, queue, reading, research, and health groups.
- Initially wire existing pending, preflight, open-note, and run-all actions.
- Add explicit waiting, healthy, running, overdue, failing, and disabled agent states.
- Prevent a newly reconciled weekly agent from appearing stale before its first due time.
- Add mode icon infrastructure with Standard Mode as the initial active mode.
- Disable continuous spinners under reduced motion.

Checkpoint:

- Focused unit tests, full TypeScript suite, lint, typecheck, build, and visual inspection in Obsidian.

## 2. Individual-note processing

Likely files:

- `python/mindmap.py`
- Python workflow tests
- `src/runArguments.ts` and tests
- `src/runProfiles.ts` and tests
- `src/main.ts`
- `src/pluginCommands.ts`
- status-menu integration

Work:

- Add validated `--note <vault-relative-markdown-path>` support.
- Reject absolute paths, traversal, runtime internals, missing files, and out-of-scope paths.
- Process one target while retaining the full related-candidate universe.
- Apply the ordinary threshold to normal notes and an eight-word threshold to Apple Books annotation notes.
- Add active-note and pending-item commands/actions.
- Keep failures pending and reuse the process guard.

Checkpoint:

- Python path/scope/state tests, argument-security tests, TypeScript tests, live run on a backed-up note, and full validation.

## 3. Read-only Apple Books reader

Likely files:

- `python/apple_books_reader.py`
- fixture SQLite databases under `tests/fixtures/`
- `tests/test_apple_books_reader.py`
- runtime asset declarations and tests
- preflight diagnostics

Work:

- Copy only database discovery, schema adaptation, and normalization concepts from the external agent.
- Use standard-library SQLite read-only connections and consistent snapshots.
- Normalize stable ID, quote, note, book, author, chapter, location, and timestamps.
- Emit versioned JSON only.
- Add access and schema checks to preflight.
- Never write to source databases.

Checkpoint:

- Fixture tests, filesystem mutation checks, Python suite, packaged-runtime validation, and a read-only live probe.

## 4. Annotation importer and state

Likely files:

- `src/readingTypes.ts`
- `src/appleBooksImport.ts` and tests
- `src/readingState.ts` and tests
- plugin runtime integration

Work:

- Parse and validate reader JSON.
- Sanitize author, book, and annotation path components.
- Create one note per annotation and one index per book through the Obsidian Vault API.
- Preserve an immutable source section.
- Track stable IDs, content hashes, note paths, research status, and processed timestamps.
- Write state atomically only after vault writes succeed.
- Import short annotations but mark those below eight words as `too-short`.
- Retain notes whose source annotations disappear.

Checkpoint:

- Mock-vault tests for new, duplicate, edited, deleted, collision, traversal, and partial-write cases.

## 5. Reading Mode controller

Likely files:

- `src/readingMode.ts` and tests
- `src/settings.ts`
- `src/main.ts`
- status menu and settings integration

Work:

- Add persisted Standard/Reading mode.
- Add first-use experimental setup and Apple Books preflight.
- Sync immediately on enable.
- Poll database/WAL timestamps every 60 seconds and debounce changes for 10 seconds.
- Coalesce triggers and enforce one watcher, timer, import, and processing job.
- Queue imported notes sequentially through individual-note processing.
- Stop cleanly when disabled or unloaded.

Checkpoint:

- Fake-clock lifecycle tests, reload persistence, duplicate-trigger tests, live annotation dry run, then backed-up import.

## 6. Manual Exa Web Research

Likely files:

- `src/webResearchTypes.ts`
- `src/exaResearchProvider.ts` and tests
- `src/keychainCredential.ts` and tests
- `src/researchWriter.ts` and tests
- commands/status menu/settings

Work:

- Add provider-neutral interfaces with Exa as the only implementation.
- Retrieve the production key from macOS Keychain; permit an environment override only in development/tests.
- Send only selected text or a bounded active-note excerpt plus necessary metadata.
- Request at most five results with bounded highlights.
- Use local Qwen for queries and grounded synthesis.
- Validate sources and write idempotent managed research markers.
- Add selected-text, active-note, and research-and-reprocess actions.
- Keep Web Research off by default.

Checkpoint:

- Mock HTTP tests for success, empty, malformed, quota, timeout, and network failure; credential leakage scan; one manual backed-up live research run.

## 7. Automatic Reading Mode research

Likely files:

- Reading controller and state
- web-research policy module and tests
- status menu/settings

Work:

- Add separate explicit consent for `automatic-reading`.
- Sequence import, research, and Qwen processing.
- Limit automatic work to five annotations per sync and ten per day.
- Pause automatic research on quota/network/provider failure without blocking local imports.
- Expose usage, pause reason, and retry controls.

Checkpoint:

- Policy-limit tests, privacy-payload assertions, partial-failure recovery, and multi-annotation live dry run.

## 8. Operations UX and release verification

Likely files:

- Existing Mindmap view or a small dedicated Operations view
- status menu and styles
- accessibility and UI regression tests
- README and release metadata

Work:

- Add inspectable queue, Reading sync, research, and scheduler details.
- Ensure keyboard access, focus visibility, WCAG-AA state contrast, narrow-window behavior, and reduced motion.
- Remove single-paragraph status Notices where persistent detail is more appropriate.
- Keep mode, pending, and error copy concise and non-contradictory.
- Run complete lint, typecheck, TypeScript tests, Python tests, build, validate, packaged-runtime inspection, and deployment backup.
- Verify ten annotation cycles without duplicates or lost state.

## Commit and Deployment Discipline

- One reviewed commit per checkpoint.
- No task starts with uncommitted changes from the prior task.
- Do not modify the external `books-obsidian-agent` repository.
- Installed plugin deployment occurs only after source and release validation pass.
- Preserve `config.json`, `data.json`, state, logs, and user notes during every deployment.
