# Mindmap 0.2.1 Product UI Cleanup Design

## Goal

Make Mindmap feel like a quiet native Obsidian capability rather than an operations console. Fix the Reading-to-Standard mode transition, reduce the status menu to everyday actions, remove generated Reading artifacts from the ordinary queue, and move technical diagnostics behind progressive disclosure.

The user is writing or reviewing a note and glances at Mindmap for one quick action. The active note must remain visually primary. Mindmap follows the current Obsidian theme and native component vocabulary; this release does not introduce custom colors, typography, cards, or decorative motion.

## Product Principles

- Healthy state is concise. Detail appears only when action is required.
- Reading notes are a separate workflow, not ordinary pending notes.
- Both modes are explicit radio choices, not a hidden toggle interaction.
- Technical paths, commands, process state, and logs are troubleshooting data.
- Every removed control remains available in the appropriate settings section, command palette, or Mindmap sidebar.
- Native keyboard behavior, focus, ARIA, theme tokens, and reduced motion remain intact.

## Status Menu

The native menu contains at most five compact groups. Empty or irrelevant groups are omitted.

### Mode

- **Standard Mode**
- **Reading Mode**

Both rows behave as radio choices. The current mode is checked and disabled; the other mode is actionable. Selecting Standard immediately disables the Reading watcher, cancels queued Reading work through the existing controller, persists the mode, and refreshes the status bar. Selecting Reading retains the current preview and consent flow.

### Run

- **Run active note**, only when an eligible active note exists
- **Run current scope**
- **Process pending notes (N)**, when ordinary pending notes exist

The menu no longer lists individual pending paths or separate Open/Process pairs. Individual note work remains available from the active-note action, command palette, and Mindmap sidebar.

### Reading

Visible only in Reading Mode:

- **Sync Reading now**
- **Process Reading backlog (N)**, when pending Reading annotations exist

A healthy Reading status, pending count, unresearchable count, and last-sync timestamp are not repeated as passive rows. Errors or pauses appear through the conditional recovery group.

### Research

- **Manual research**, checked when enabled or included by Automatic
- **Automatic for Reading**, checked when enabled

Selected-text, active-note, and research-plus-reprocess actions leave the status menu. They remain command-palette actions. Automatic usage and retry appear only when a limit or recoverable pause needs attention.

### Navigation and Recovery

- **Open Mindmap**
- **Settings**

Runtime setup, failed preflight, Reading errors, research pauses, or scheduler failures add one concise recovery row at the top, with the relevant action. Healthy runtime, scheduler, semantic, and preflight details do not appear.

The status-bar label remains compact. It shows current mode plus one useful count, busy activity, or highest-priority warning.

## Queue Separation

Ordinary current/all pending counts exclude all Mindmap-managed Apple Books artifacts:

- notes with `type: apple-books-annotation`;
- generated book `Index.md` notes containing the complete Apple Books index marker pair.

This exclusion applies to the TypeScript pending scanner and normal Python current/all runs, even when `Books` or the vault root is part of configured scope.

Reading annotations enter Python only through:

- explicit individual-note processing;
- explicit **Process Reading backlog**;
- the daily `--include-reading-pending` maintenance profile.

Book indexes are never embedded, tagged, queued, or processed. Existing Python state/vector rows for generated indexes are removed safely during the next covered maintenance pass. This preserves the boundary that manual and weekly runs never implicitly consume Reading work.

## Settings Information Architecture

The settings tab becomes a linear product surface:

1. **Overview**
2. **Reading and Research**
3. **Scope**
4. **Schedule**
5. **Local AI**
6. **Troubleshooting** (collapsed)

### Overview

One compact native setting row summarizes the product state:

- **Ready** when runtime, scope, and provider checks are usable;
- a short actionable message when setup or recovery is required.

Primary actions are **Open Mindmap** and, only when relevant, **Run checks** or **Set up runtime**. It never prints command lines, interpreter paths, config paths, trust internals, log lines, or LaunchAgent plist paths.

### Reading and Research

Reading Mode becomes an explicit toggle with plain-language import/processing behavior. Manual and Automatic research controls sit directly below it. Usage limits and errors appear only when relevant.

### Scope

Keep the existing folder selector, because scope is genuinely two-dimensional. Remove the duplicate status card and repeated “configured” sentence. Show selected Current and All chips once, followed by the searchable folder table and a single Save action.

Generated Reading folders may remain selectable for ordinary notes under `Books`, but managed Apple Books annotations and indexes are excluded by type/marker rather than by broad folder exclusion.

### Schedule

Show only controls relevant to the selected scheduler mode:

- Manual: mode selector only
- Interval: interval minutes
- LaunchAgent: daily time, weekly toggle, and weekly time only when enabled

Healthy scheduler internals are hidden. A failed/overdue scheduler shows one recovery row and action.

### Local AI

Provider, base URL, model, API key, output limit, and thinking remain available. Remove the visible config path. Text inputs persist on blur or Enter rather than every keystroke, preventing partial URL/model/key writes on the UI thread.

### Troubleshooting

A native collapsed disclosure contains:

- Run preflight
- one-line latest result
- Copy diagnostics
- advanced Python/script/config overrides

**Copy diagnostics** creates a bounded technical report containing runtime command, paths, trust, provider/preflight checks, scheduler state, and recent plugin logs. These details are copied on demand, not rendered as a large settings card.

## Error and Loading Behavior

- Healthy sections do not display status prose.
- Errors state what failed and the next action in one or two sentences.
- Runtime installation keeps its current progress phases and Cancel action.
- Status-menu actions are immediate; no menu animation is added.
- Settings use native Obsidian controls and the existing loader icon only for real work.
- Switching Standard/Reading is idempotent and rollback-safe if persistence fails.

## Accessibility

- Mode and research choices expose checked state and clear text labels.
- Disabled actions explain the blocking reason in their title.
- Troubleshooting disclosure is keyboard-operable through native `<details>/<summary>` behavior.
- Copy diagnostics confirms success with a concise Notice.
- Narrow settings windows stack controls without horizontal overflow.
- The existing reduced-motion rule remains for continuous loader animation.

## Official Obsidian Distribution

`mindmap-ai` is not currently listed in `obsidianmd/obsidian-releases/community-plugins.json`, and no submission PR exists. GitHub release `0.2.0` therefore cannot update through Obsidian’s Community Plugins browser.

After this cleanup ships as `0.2.1`, submit one plugin-registration PR to `obsidianmd/obsidian-releases`. The release must include `manifest.json`, `main.js`, and `styles.css` under a tag matching the manifest version. `mindmap-python.zip` remains an additional release asset; the installed plugin also contains the bundled runtime assets inside `main.js`.

## Verification

Automated coverage must include:

- Standard and Reading radio actions, persistence rollback, watcher shutdown, and re-enable;
- compact menu item budget and conditional groups;
- no individual note paths or healthy technical details in the menu;
- generated index and annotation exclusion from ordinary pending scans;
- normal Python current/all exclusion versus individual/daily Reading inclusion;
- compact Overview copy with no runtime paths or command dumps;
- collapsed troubleshooting details and bounded Copy diagnostics output;
- conditional scheduler controls;
- provider text persistence on blur/Enter;
- keyboard/ARIA/status precedence and narrow-window behavior;
- full existing Reading, scheduler, research, runtime, and release regressions.

Integration verification uses the production-like disposable vault, confirms Standard can be selected after Reading, verifies ordinary pending counts no longer include the 645 Reading annotations or generated indexes, and checks both settings and status menu against the approved screenshots.
