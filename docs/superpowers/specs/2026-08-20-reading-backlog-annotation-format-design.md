# Reading Backlog and Annotation Format Design

## Goal

Make Reading Mode safe to activate against a large Apple Books history while keeping newly created annotations responsive. Replace opaque annotation filenames and noisy generated notes with a minimal, human-readable format.

## Processing Model

Reading Mode maintains two distinct classes of work.

### Activation backlog

On first enablement, Mindmap reads Apple Books and imports every annotation into the vault. It does not immediately run Qwen across the historical backlog.

After import, the user may explicitly confirm a separate **Process imported backlog now** action. If they do not, pending Reading notes remain visible in the status menu and are processed by the regular daily Mindmap schedule.

The daily schedule includes pending Apple Books annotation notes when Reading Mode consent is active. The weekly refresh/rebuild schedule remains unchanged and does not gain the Reading root implicitly.

### Live Reading queue

After activation completes, newly detected or changed Apple Books annotations are imported and processed immediately, sequentially, while Obsidian is open. The existing 60-second poll, 10-second activity debounce, process guard, and retry behavior remain.

Failure to process a new annotation leaves it pending. It may be retried manually or by the next daily scheduled run. A failure must not trigger an immediate unbounded retry loop.

## Human-Readable Paths

The book and author folders already provide context, so annotation filenames use a short title derived from the quote rather than a date or opaque identifier.

Example:

`Behavior is hard to teach.md`

The title uses the first meaningful phrase from the quote, normalized for a safe vault path and bounded to a reasonable filename length. If the quote cannot produce a title, fallbacks are the Apple Books note, chapter, location, then `Annotation`.

Collisions use the smallest deterministic numeric suffix:

- `Behavior is hard to teach.md`
- `Behavior is hard to teach · 2.md`

The stable Apple annotation ID remains in frontmatter and Reading state. Once allocated, a path remains stable across imports.

Production has not imported Reading notes yet, so no production migration is required. Existing marker-based notes in disposable/test vaults are migrated idempotently.

## Note Format

The body contains only the annotation as a leading Markdown blockquote. There is no `Annotation` heading and no visible technical marker.

```markdown
> And behavior is hard to teach, even to really smart people.
```

When Apple Books includes a user note, it appears in the same leading blockquote after a blank quoted line. Mindmap owns only this leading blockquote and preserves all content following it.

Concepts and related notes remain in frontmatter as readable Obsidian wikilinks:

```yaml
concepts:
  - "[[Behavior change]]"
  - "[[Teaching]]"
related:
  - "[[Books/Apple Books/Michael Gervais/The First Rule of Mastery/Annotations/Overcoming ingrained habits|Overcoming ingrained habits]]"
```

Generated summary and tags are not written to Apple Books annotation frontmatter. Raw vault paths are not displayed as related-property text. Source identity and synchronization fields remain in frontmatter/state because they are required for safe adoption and recovery.

## Migration and Preservation

For existing marker-based Reading notes, the importer removes the old managed source markers and replaces that source block with the leading blockquote. It moves generated concepts and related notes into readable frontmatter wikilinks and removes obsolete generated annotation summary/tag fields.

Migration preserves:

- the stable annotation-to-path mapping unless the note still uses the old opaque generated filename;
- user content outside the old managed source/research regions;
- valid managed Web Research content;
- source identity, timestamps, and processing/research state;
- unrelated frontmatter.

Opaque test-vault filenames may be migrated to the new readable allocation. Collisions are resolved before rename, and state plus book indexes are updated only after the vault rename succeeds.

## Status and Controls

After first import, the status menu shows the imported backlog count and exposes:

- **Process imported backlog now**, with explicit confirmation and an honest note-count warning;
- existing individual-note processing actions;
- normal Reading sync and health details.

The first-use confirmation distinguishes importing from processing. It must not imply that confirming import also starts the historical Qwen backlog.

New annotations require no additional prompt after Reading Mode is active; they are processed automatically.

## Scheduling Boundary

Daily Mindmap maintenance may process pending Reading annotation notes when Reading Mode consent is active. This is a targeted pending-note addition, not a mutation of the user's configured all-scope folders.

Weekly refresh/rebuild remains limited to its existing configured scope. Scheduled maintenance never starts Web Research.

## Failure Handling

- Import failure: do not start backlog or live processing for the failed annotation.
- Qwen failure: retain the note as pending for manual/daily retry.
- Rename collision or failure: keep the prior stable path and state.
- State-save failure after a vault write: adopt the durable note/frontmatter state on the next sync.
- Plugin unload: stop polling and prevent later queued work from starting.
- Repeated triggers: coalesce through the existing Reading controller guard.

## Verification

Automated coverage must include:

- first activation imports all notes but processes zero historical notes automatically;
- explicit backlog confirmation processes pending annotations;
- daily scheduling includes pending Reading notes while weekly scheduling does not;
- a new annotation after activation is processed immediately;
- failed live processing remains pending without a tight retry loop;
- readable filename derivation, fallbacks, collision numbering, and stable reuse;
- marker-based migration to the clean blockquote format;
- preservation of user content, Web Research content, unrelated frontmatter, state, and indexes;
- concepts and related notes serialize as readable wikilinks;
- ten repeated imports remain idempotent with no duplicate notes.

Integration verification uses a fresh disposable vault before any production deployment.
