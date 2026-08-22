# Mindmap 0.2.1 Product UI Cleanup Plan

## Constraints

- Follow `docs/superpowers/specs/2026-08-22-product-ui-cleanup-design.md`.
- Preserve native Obsidian controls, themes, keyboard behavior, and reduced motion.
- Do not add custom cards, colors, fonts, decorative animation, or a second navigation system.
- Healthy state stays concise; technical details require explicit disclosure or Copy diagnostics.
- Reading annotations and generated book indexes must not leak into ordinary queues.
- The visible `mindmap-coder` worker may edit source/tests but may not commit, push, release, deploy, change production vault data, or submit the official plugin PR.
- The manager owns reviews, commits, disposable/production integration, releases, and external PR actions.

## 1. Reading Mode Transition and Queue Boundaries

Likely files:

- `src/main.ts`
- `src/readingMode.ts` and tests
- `src/statusBarState.ts`
- `src/pendingScan.ts` and tests
- `python/mindmap.py`
- Python queue/scope tests

Work:

- Replace the one-sided Reading toggle contract with explicit Standard/Reading mode selection.
- Make selecting Standard stop watcher/debounce/queued Reading work, persist safely, and refresh UI.
- Preserve rollback if settings persistence fails.
- Define a shared generated-Reading-artifact classifier:
  - Apple annotation frontmatter type;
  - book `Index.md` path plus complete managed index markers.
- Exclude managed Reading artifacts from ordinary TypeScript pending current/all counts.
- Exclude them from normal Python current/all/manual/weekly note universes even when `Books` or `.` is configured.
- Preserve explicit Reading individual-note runs and daily `--include-reading-pending` processing.
- Remove stale generated-index Python state/vector rows during a covered maintenance pass.

Tests:

- Reading to Standard and Standard to Reading;
- disable during sync/process and persistence rollback;
- annotations/indexes excluded from ordinary counts;
- ordinary Books notes remain eligible;
- Python current/all/weekly exclusion, daily inclusion, explicit note inclusion;
- no scope mutation or duplicate scan.

Checkpoint:

- Manager reviews state transitions and every queue boundary before visual cleanup.

## 2. Distilled Status Menu

Likely files:

- `src/statusBarState.ts`
- `src/statusBarMenu.ts`
- `src/statusBarIntegration.ts`
- focused tests

Work:

- Make Standard and Reading radio rows explicit and actionable when inactive.
- Limit healthy-state groups to Mode, Run, conditional Reading, Research, and navigation.
- Remove individual path rows, duplicate counts, healthy timestamps, scheduler details, semantic state, and healthy runtime/preflight rows.
- Omit empty actions and groups.
- Keep runtime setup and one highest-priority recovery action only when needed.
- Keep command-palette access for removed research and individual-note actions.
- Define and test a healthy menu item budget.
- Preserve loader/warning precedence, ARIA, keyboard activation, and native icons.

Tests:

- exact healthy Standard and Reading item sets;
- item-count budget;
- both mode transitions;
- conditional Reading/research/recovery rows;
- no raw paths/timestamps/runtime/scheduler diagnostics;
- narrow labels and accessibility.

Checkpoint:

- Manager compares the native menu against the approved screenshot brief.

## 3. Product Settings and Progressive Diagnostics

Likely files:

- `src/settingsTab.ts`
- `src/scopeManager.ts`
- `src/pluginSummaries.ts`
- a new pure product-status/diagnostics formatter with tests
- minimal `styles.css` cleanup

Work:

- Reorder sections: Overview, Reading and Research, Scope, Schedule, Local AI, Troubleshooting.
- Add a compact Overview with user-facing readiness and only relevant actions.
- Remove duplicate scope status/guidance; retain selected chips, searchable folder table, and Save.
- Render scheduler fields conditionally by mode.
- Remove provider config path and persist text fields on blur/Enter rather than each keystroke.
- Move preflight, advanced runtime overrides, paths, command previews, trust, scheduler internals, and recent logs into a collapsed native Troubleshooting disclosure.
- Replace rendered log dump with one-line latest result and Copy diagnostics.
- Build bounded diagnostics text on demand and confirm copy success.
- Use native theme tokens and linear spacing; remove redundant card styling only where Mindmap introduced it.

Tests:

- pure overview/readiness copy;
- bounded diagnostics with required detail and redaction;
- no raw paths/logs in default product surface;
- scheduler conditional rendering seams;
- provider commit-on-blur/Enter behavior;
- disclosure accessibility and subscription cleanup;
- scope UI retains all selections without duplicate summary content.

Checkpoint:

- Manager performs code-level UI audit and production-theme screenshot review.

## 4. Release, Integration, and Official Plugin Submission

Work:

- Bump manifest/package/versions/changelog consistently to `0.2.1`.
- Document queue separation and product UI changes.
- Run TypeScript/Python, lint, typecheck, build, validation, packaging, dependency, secret, and unsafe-process gates.
- Deploy to the disposable vault first and verify:
  - Standard can be selected after Reading;
  - ordinary pending count excludes annotations and book indexes;
  - compact status menu;
  - compact settings Overview;
  - Troubleshooting disclosure and Copy diagnostics.
- Run PR review and resolve all valid comments.
- Merge and release `0.2.1` before production deployment.
- After the GitHub release is green, submit one registration PR to `obsidianmd/obsidian-releases` for `mindmap-ai`.

Final gate:

- Production deployment requires explicit user authorization.
- Official Community Plugins availability is verified from `community-plugins.json` after the Obsidian review merges.
