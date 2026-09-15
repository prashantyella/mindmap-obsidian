# Remove generated Mindmap footer implementation plan

1. Revert speculative batch-progress commits `25ffef7`, `db56367`, and `9a36415` with normal revert commits, resolving only conflicts required by current main.
2. Set `PRODUCTION_RELATED_VERSION` to `2` and update the production catalog freshness tests so version-1 records are stale and version-2 records are current.
3. Update `NoteJobRunner` ordinary-note writes to omit body related links and request removal; leave Apple annotation and related selection/index behavior unchanged.
4. Update `NoteWriter`/related-section handling to remove only the existing managed Mindmap/Related callout and owned divider, preserving frontmatter and user body content.
5. Add focused NoteWriter, NoteJob, production-engine, pending/catalog, and workspace/sidebar regressions from the design.
6. Run targeted tests, `npm run check`, build/validate, and `git diff --check`; inspect that only the intended frontmatter/output and internal freshness paths changed.

Constraints: keep plugin version `0.3.5`; no queue edits, release/tag changes, deployment, Obsidian actions, or vault processing in this implementation checkpoint.
