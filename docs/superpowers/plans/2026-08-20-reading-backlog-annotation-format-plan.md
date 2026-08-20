# Reading Backlog and Annotation Format Implementation Plan

## Constraints

- Follow `docs/superpowers/specs/2026-08-20-reading-backlog-annotation-format-design.md`.
- Primary manager owns scope, review, commits, pushes, tags, PR actions, vault access, integration testing, and deployment.
- The visible `mindmap-coder` worker receives one bounded task at a time and may not commit, push, tag, deploy, or touch a vault.
- Keep the implementation lightweight. Reuse the importer, Reading controller, Python state file, native status menu, and existing process guards.
- Do not mutate the user's configured current/all scope folders.
- Daily scheduled processing may include Reading notes. Weekly refresh/rebuild must not.
- Scheduled maintenance never invokes Web Research.
- Preserve Apple Books source integrity, user content, unrelated frontmatter, Reading state, Python state, and book indexes.

## 1. Human-readable path and note-format primitives

Likely files:

- `src/readingTypes.ts`
- `src/readingTypes.test.ts`
- a small annotation-format module if the type file would become less focused

Work:

- Derive a safe human title from the first meaningful quote phrase.
- Fall back in order to Apple Books user note, chapter, location, then `Annotation`.
- Remove dates and opaque identifiers from the visible filename.
- Resolve collisions with deterministic numeric suffixes (`Title.md`, `Title · 2.md`).
- Preserve any stored path once allocated.
- Render the source as one leading blockquote with an optional Apple Books note inside the same quote.
- Parse and replace only the leading managed blockquote while preserving following user content.
- Convert concepts and related paths to readable Obsidian wikilink values.

Tests:

- title normalization, punctuation, Unicode, empty input, reserved/dot paths, and length bounds;
- deterministic collisions and stored-path stability;
- quote/note rendering;
- leading-blockquote replacement with CRLF and user-content preservation;
- readable concept/related wikilinks.

Checkpoint:

- Manager reviews the pure diff and focused tests before integration work begins.

## 2. Importer migration and stable renames

Likely files:

- `src/appleBooksImport.ts`
- `src/appleBooksImport.test.ts`
- `src/readingVault.ts`
- `src/readingTypes.ts`

Work:

- Extend the Vault abstraction with a rename operation.
- New imports use readable paths from checkpoint 1.
- Existing opaque generated paths may migrate once through Vault rename.
- Probe all destination candidates before rename and retain the old path on failure.
- Update Reading state and book indexes only after rename succeeds.
- Remove visible Apple source markers and migrate the source block to the leading blockquote.
- Remove generated annotation `summary` and `tags` fields.
- Convert generated `concepts` and `related` fields to readable wikilinks.
- Preserve unrelated frontmatter, following user body content, source identity, timestamps, research/processing status, and missing-source retention.
- Keep repeated imports and migrations idempotent.

Tests:

- new readable import;
- byte-preserving migration;
- collision, occupied target, rename failure, state failure, and orphan adoption;
- index updates after rename;
- ten repeated cycles with no duplicate notes.

Checkpoint:

- Manager runs the complete importer/state test group and reviews every vault mutation path.

## 3. Reading research companion notes

Likely files:

- `src/researchWriter.ts`
- `src/webResearch.ts`
- `src/main.ts` integration seam
- focused tests

Work:

- For Apple Books annotations, place synthesis and sources in:
  `Books/Apple Books/<Author>/<Book>/Research/<Annotation title>.md`.
- Add a readable `research` wikilink property to the annotation note.
- Mindmap owns the complete companion note; no visible managed markers are needed.
- Update the companion idempotently after successful research.
- Migrate an existing valid inline Reading research block into the companion before removing it from the annotation body.
- Preserve ordinary-note inline Web Research behavior.
- Ensure failed/empty research does not create or replace a companion.
- Keep source validation, citation integrity, privacy bounds, Keychain handling, automatic limits, and retry semantics unchanged.

Tests:

- manual and automatic Reading research create/update one stable companion;
- ordinary notes remain inline;
- inline Reading research migration;
- missing/invalid results produce no companion write;
- collision and partial state/write recovery;
- no credential or unrelated note content persisted.

Checkpoint:

- Manager verifies research privacy and note preservation before queue changes.

## 4. Split activation backlog from live Reading work

Likely files:

- `src/readingMode.ts`
- `src/readingMode.test.ts`
- `src/readingState.ts`
- `src/readingTypes.ts`
- `src/main.ts`
- status menu/settings state and tests

Work:

- Persist whether the initial Reading import has completed, with backward-compatible state parsing.
- First activation imports all annotations and processes zero historical notes automatically.
- The first-use copy clearly separates import consent from backlog processing.
- Normal subsequent syncs process only annotations created or source-changed by that sync.
- Add a separately confirmed `Process imported backlog now` action.
- Keep backlog count visible and preserve individual-note actions.
- A failed live note remains pending without an immediate retry loop.
- A newly detected annotation after activation processes immediately, sequentially.
- Existing manual/Reading workflow serialization and automatic research ordering remain intact.

Tests:

- first import versus reload;
- explicit backlog processing;
- new/changed live annotations only;
- failure pending behavior;
- trigger coalescing, disable, unload, and process guards;
- status copy and action enablement.

Checkpoint:

- Manager reviews controller state transitions with fake clocks before scheduling changes.

## 5. Daily-only scheduled Reading backlog

Likely files:

- `python/mindmap.py`
- Python tests
- `src/runArguments.ts`
- `src/runProfiles.ts`
- `src/launchAgentHealth.ts`
- launch-agent tests
- a small TypeScript Python-state reconciliation helper and tests

Work:

- Add an allowlisted `--include-reading-pending` option valid only with `--all` apply maintenance.
- Daily LaunchAgent arguments include the option; weekly refresh/rebuild arguments do not.
- The option extends only that run's note universe with `Books/Apple Books` and does not write scope configuration.
- Runs without the option preserve Reading entries already present in the Python state/index rather than treating them as deleted.
- Specialize Apple annotation metadata writes:
  - do not persist generated summary or tags;
  - persist concepts as readable concept wikilinks;
  - persist related notes as readable path/alias wikilinks.
- Reconcile successful scheduled Reading work from Python `state.json` into Reading `processedAt` by comparing the Python SHA-1 body signature. Do not add a visible processed property.
- Reconciliation is read-only against Python state and mutates Reading state through its serialized mutation queue.

Tests:

- daily arguments include Reading; weekly/manual profiles do not;
- invalid flag combinations are rejected;
- normal all/weekly runs preserve Reading index/state entries;
- scheduled annotation output format;
- Python-state signature reconciliation and malformed/missing state handling;
- no duplicate scans or scope mutation.

Checkpoint:

- Manager runs full TypeScript/Python validation and inspects generated LaunchAgent arguments.

## 6. Recovery review, CI, and clean integration

Work:

- Resolve the two verified CodeRabbit findings:
  - `remove_mindmap_section` accepts only Boolean `true`;
  - API keys are trimmed before authentication-mode selection.
- Add pull-request CI for lint, typecheck, TypeScript tests, Python tests, build, and release validation.
- Run dependency/secret/unsafe-API scans.
- Reconcile the canonical remote branch before changing PR base or history.
- Remove/recreate the stale local `0.2.0` tag only after the final reviewed commit; no release currently exists remotely.
- Create a fresh disposable integration vault. Do not reuse the populated `Mindmap_Test` state as the clean baseline.
- Verify:
  1. preflight;
  2. import-only first activation;
  3. readable note format;
  4. explicit backlog action;
  5. one newly detected annotation processing immediately;
  6. one manual companion research run;
  7. one automatic companion research run;
  8. daily-only scheduled Reading processing;
  9. reload idempotency and scheduler health.

Final gate:

- Manager backs up and deploys to the production vault only after source, CI, clean-vault integration, and PR review are green.
- Preserve production `data.json`, `config.json`, state, logs, LaunchAgent configuration, and user notes.
- Merge first, then create the final `0.2.0` tag from the merged release commit.
