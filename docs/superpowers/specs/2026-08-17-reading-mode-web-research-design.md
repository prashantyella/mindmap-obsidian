# Mindmap Reading Mode and Web Research Design

## Objective

Add an experimental Reading Mode inside Mindmap that monitors Apple Books annotations while Obsidian is open, imports each annotation as a source note, optionally enriches it with grounded web research, and processes it with the existing local Qwen workflow.

Web Research is an independent capability available to Reading Mode and ordinary Mindmap notes. It never runs as part of scheduled daily or full-vault maintenance.

## Product Model

Mindmap has two independent settings:

- Mode: `standard` or `reading`.
- Web Research: `off`, `manual`, or `automatic-reading`.

Standard Mode preserves current behavior. Reading Mode adds Apple Books monitoring, import, and sequential processing without changing existing daily or weekly schedules.

Both experimental capabilities are desktop-only and macOS-only for the first release.

## Scope

### Included

- Persistent Reading Mode toggle in the status menu.
- Distinct Standard and Reading Mode icons.
- Read-only Apple Books annotation discovery and normalization.
- One Markdown note per annotation and one index per book.
- Stable annotation IDs, content hashes, and resumable state.
- Sequential local Qwen processing of imported notes.
- Individual-note Mindmap runs.
- Manual Web Research for selected text and active notes.
- Optional automatic research for new Reading Mode annotations.
- Exa as the first web-search provider.
- Grounded local-Qwen synthesis with stored source citations.
- Operations and recovery controls through the status menu and a detailed view.

### Deferred

- Processing while Obsidian is closed.
- Full book-text ingestion.
- Writes back into Apple Books.
- Automatic deletion of imported notes.
- Multiple web-search providers.
- Mastra, MCP, Anthropic, or OpenAI runtime embedding.
- Web research during daily, weekly, or full-vault maintenance.

## Architecture

### Status and mode controller

The existing status-bar item becomes an interactive control. It owns no processing logic; it renders state and opens a native Obsidian menu.

The mode setting is persisted in plugin settings. Enabling Reading Mode starts the controller after preflight succeeds. Disabling it cancels timers and prevents future annotation scans without interrupting an already-committing note write.

### Apple Books reader

Copy only the useful database discovery, schema adaptation, and annotation normalization behavior from `books-obsidian-agent`.

Implement the reader in bundled Python using standard-library `sqlite3`:

- Locate Apple Books annotation and library databases.
- Open sources read-only.
- Use SQLite backup into an in-memory or temporary snapshot for consistency with WAL activity.
- Normalize book, author, annotation ID, quote, user note, chapter, location, and timestamps.
- Emit structured JSON to stdout.
- Never write to Apple Books files.

The TypeScript plugin invokes the reader and performs all vault writes through Obsidian's Vault API. The unsafe filesystem MCP server and Mastra runtime are not copied.

### Annotation importer

Each annotation maps to:

`Books/Apple Books/<Author>/<Book>/Annotations/<date>-<short-id>.md`

The importer sanitizes every path segment, prevents traversal, and resolves collisions deterministically. An annotation ID maps permanently to one note path.

Frontmatter:

```yaml
type: apple-books-annotation
source: apple-books
annotation_id: <stable-id>
book_title: <title>
book_author: <author>
chapter: <chapter>
created_at: <ISO timestamp>
imported_at: <ISO timestamp>
research_status: off
```

The note body contains an immutable source section for the quote, annotation note, location, and chapter. Managed research content is stored separately below the source section.

Each book receives an index note linking its imported annotations. The importer does not create inferred concept notes; Mindmap owns summaries, tags, concepts, and related-note links.

Apple Books annotations use a dedicated minimum of eight normalized words across the quote and user note. Shorter annotations are still imported but marked `too-short` and are not sent to Qwen or Web Research. This avoids silently excluding useful annotations under the ordinary 30-word vault-note threshold.

### Annotation state

Use a small atomic JSON state file under plugin runtime data. Do not introduce another database or queue framework.

State schema:

```json
{
  "version": 1,
  "lastSyncAt": null,
  "annotations": {
    "<id>": {
      "contentHash": "...",
      "notePath": "...",
      "importedAt": "...",
      "researchStatus": "off",
      "processedAt": null
    }
  }
}
```

Persist state only after the corresponding vault write succeeds. Never delete a note automatically when an annotation disappears from Apple Books.

### Reading Mode controller

On activation:

1. Run Apple Books access preflight.
2. Perform an immediate sync.
3. Record database and WAL modification times.
4. Poll modification times while Obsidian is open.
5. Query SQLite only after timestamps change and activity settles.
6. Import new or changed annotations.
7. Optionally research them.
8. Queue sequential single-note Mindmap runs.
9. Refresh book indexes, pending state, and UI status.

Only one watcher, debounce timer, import, research request, and Qwen process may be active at a time. Repeated triggers coalesce into one follow-up pass.

Default polling interval is 60 seconds. Database changes debounce for 10 seconds. Both values remain internal constants for the experiment unless field evidence requires settings.

### Individual-note processing

Add a validated `--note <vault-relative-path>` Python option and corresponding plugin run profile.

Requirements:

- Accept one existing Markdown note inside the current vault.
- Reject absolute paths, traversal, non-Markdown paths, plugin runtime files, and paths outside configured scope.
- Update only the selected note.
- Query related candidates from the existing full index.
- Reuse provider startup, state safety, error isolation, and the single-process guard.
- Keep failed or incomplete notes pending.
- Apply the eight-word Reading Mode threshold only to notes identified by `type: apple-books-annotation`; ordinary notes keep the configured vault threshold.

Expose commands for the active note and pending-note menu items. Disable actions with a reason when a note is empty, below the minimum word count, outside scope, or another run is active.

## Status-Bar UX

The status item is a keyboard-accessible menu button with a state-aware label, tooltip, hover, active, and focus-visible styles.

Icons:

- `orbit`: Standard Mode.
- `book-open`: Reading Mode.
- spinner: current import, research, or processing activity.
- warning icon: actionable permission, provider, import, or scheduler failure.
- `globe-2`: Web Research is enabled.

Compact labels:

- `Mindmap · 0`
- `Reading · 3`
- `Reading · syncing`
- `Reading · research paused`

Menu groups:

1. Mode: Standard or Reading.
2. Queue: active-note eligibility, recent pending notes, run active, process pending.
3. Reading: sync now, last sync, imported count, open book index.
4. Web Research: current mode, research active note, usage, last error.
5. Health: preflight, daily and weekly agents, open Operations view.

Use a native Obsidian `Menu`, not a modal. Click, Enter, or Space opens it. The menu remains useful when there are zero pending notes.

## Scheduler Health Semantics

Represent each scheduled agent separately:

- waiting for first run;
- healthy;
- running;
- overdue;
- failing;
- disabled.

A newly reconciled agent is not overdue until its first scheduled opportunity plus grace time. The compact status bar displays only an actionable aggregate. Detailed daily and weekly states remain in the menu and Operations view.

## Web Research

### Capability modes

- `off`: no network requests.
- `manual`: user-triggered research for selected text, the active note, or an annotation.
- `automatic-reading`: research new Reading Mode annotations before Mindmap processing.

Automatic research requires separate explicit consent after Reading Mode is enabled.

### Provider

Implement a small provider interface with Exa as the only first-release implementation. Call the HTTP API directly rather than adding an SDK dependency.

Search behavior:

- Local Qwen derives one or two focused queries.
- Send only the selected annotation or note excerpt, book metadata when applicable, and derived queries.
- Request at most five sources and bounded extractive highlights.
- Enable provider moderation where available.
- Preserve title, URL, author, publication date, and retrieval timestamp.
- Local Qwen performs all synthesis.

The provider API key is retrieved from macOS Keychain in production. A dedicated environment-variable override is allowed only for development and automated tests. The key is never committed, written to frontmatter, included in diagnostics, or logged. The specification contains no credential value.

### Research content

Research content is idempotently replaced between managed markers below the immutable source content:

```markdown
<!-- mindmap:research:start -->
## Research

Grounded synthesis with source references.

### Sources

1. [Source title](https://example.com)
   Retrieved: <timestamp>
<!-- mindmap:research:end -->
```

Every generated source reference must resolve to a stored source. If no usable sources remain after validation, do not generate a research synthesis.

### Regular Mindmap commands

- Research selected text.
- Research active note.
- Research and reprocess active note.

Do not enable autonomous research for scheduled current-scope or full-vault runs. A future Vault/Web switch in lookup is outside the initial experiment.

### Privacy and usage limits

- Web Research is off by default.
- First enablement previews the exact data categories sent externally.
- Never send unrelated vault content.
- Automatic research processes at most five annotations per sync and ten per day by default.
- Quota or network failures pause automatic research without stopping local imports.
- Manual research remains separately retryable when permitted by the provider.

## Failure Handling

- Apple Books access denied: pause Reading Mode, keep its toggle state, and show repair guidance.
- Database unavailable or changing: retain last successful state and retry after debounce.
- Import write failure: do not advance the annotation state.
- Import succeeds but research fails: retain the note and mark research retryable.
- Research succeeds but Mindmap fails: preserve research and leave the note pending.
- Network unavailable: continue local importing and processing.
- Provider quota reached: pause automatic research for the day.
- Duplicate annotation: no-op unless its normalized content hash changes.
- Deleted source annotation: retain the vault note.
- Rapid mode changes: prevent duplicate watchers and timers.
- Obsidian closes: stop cleanly and resume from stable IDs when reopened.

## Accessibility and Visual Requirements

- Status control exposes button semantics, menu state, and a descriptive accessible label.
- All actions are keyboard reachable with visible focus.
- Icons never carry meaning without text or an accessible label.
- State contrast meets WCAG AA against the active Obsidian theme.
- Narrow windows collapse optional status text before truncating the current mode.
- Reduced-motion mode disables continuous spinner animation.
- Use Obsidian design tokens and native menus; do not add custom card grids or decorative motion.

## Testing

### Apple Books

- Fixture databases covering supported schema variants.
- Consistent reads during WAL activity.
- Missing database and permission-denied behavior.
- No writes to source databases.
- Path traversal, malformed title/author, and collision handling.
- New, duplicate, edited, and deleted annotations.
- Eight-word Reading Mode eligibility and `too-short` handling.

### Import and state

- Atomic state updates after successful vault writes.
- Stable ID-to-path mapping.
- Idempotent book-index generation.
- Rapid sync trigger coalescing.
- Resume after plugin reload.

### Individual-note processing

- Valid and invalid note paths.
- Scope and minimum-word enforcement.
- Full-index related candidates with a single write target.
- Provider or write failure leaves the note pending.
- Existing process guard prevents overlap.

### Web Research

- Mocked Exa success, empty results, quota, timeout, and malformed responses.
- No request while research is off.
- Outbound payload contains only approved fields.
- Credentials never appear in logs or persisted plugin/vault data.
- Citation validation and idempotent marker replacement.
- Automatic daily and per-sync limits.

### UI and regression

- Mode persists across reloads.
- Status menu supports mouse and keyboard.
- Reading Mode starts and stops one watcher.
- Reduced motion disables continuous animation.
- Existing pending scans, semantic lookup, daily scheduling, and weekly scheduling remain unaffected.
- Ten consecutive annotation-import cycles complete without duplicate notes or lost state.

## Delivery Sequence

1. Interactive status menu and explicit scheduler-health states.
2. Individual-note processing.
3. Secure Python Apple Books reader and fixtures.
4. Annotation importer, state, and book index.
5. Reading Mode controller and status integration.
6. Manual Exa Web Research.
7. Automatic Reading Mode research with privacy and usage controls.
8. Operations view, accessibility, and visual polish.
9. End-to-end deployment and recovery verification.

Each coding task is bounded and delegated to `gpt-5.6-luna` with high reasoning. The primary agent owns sequencing, scope review, security review, tests, commits, deployment, and progress reporting. No task may include unrelated refactoring.

## Success Criteria

- Reading Mode is visibly distinct, persistent, and controllable from the status bar.
- New Apple Books annotations appear once, in deterministic notes, without source database writes.
- Imported annotations are locally processed in sequence and recover safely from partial failures.
- Web Research never runs without explicit enablement and always preserves inspectable sources.
- Ordinary notes can use manual Web Research without enabling Reading Mode.
- No secrets or private unrelated vault content leave the machine.
- Existing Mindmap scheduling and pending counts remain correct.
- All new paths have focused automated tests and pass the full release suite.
