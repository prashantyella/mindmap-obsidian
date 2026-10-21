# Mindmap AI

Connect notes and ideas with local AI. Discover meaningful connections while you write, read, and explore your vault.

- Generate summaries, tags, and concepts from your notes.
- Explore related notes in a sidebar with a connection graph.
- Search your indexed notes with natural-language questions.
- Import Apple Books highlights and connect them to your ideas.
- Research notes and highlights with optional web research.

Mindmap is desktop-only and uses Ollama for note processing. Apple Books import and web research require macOS.

## Requirements

- Obsidian Desktop 1.7.2 or newer.
- Ollama running with an embedding model and a text-generation model.

## Install

1. Open **Settings → Community plugins → Browse**, find **Mindmap AI**, and install and enable it.
2. Install the default models, or choose models you already use:

```bash
ollama pull embeddinggemma-2:270m
ollama pull llama3.1:8b
```

## First Run

1. In Mindmap settings, open **Local AI**, confirm your Ollama address and models, then choose **Test draft → Apply**.
2. Under **Included folders**, choose which folders Mindmap can process and select **Save folders**.
3. Choose **Check setup**, resolve any reported issues, then run **Run Mindmap (all scopes)** from the command palette to process your notes.

## Everyday use

Open the Mindmap sidebar to explore connections or search across indexed notes. Connections refresh automatically; saved active notes are prioritized after typing settles, without interrupting your writing.

Summaries are expanded by default. Use a note's collapse button to toggle its summary, or Alt/Option-click it to expand or collapse all visible summaries.

Use the status menu to pause or resume processing. Under **Automation**, choose manual runs, periodic processing while Obsidian is open, or scheduled processing on macOS.

Summaries, tags, concepts, and related-note links are stored in note properties. To keep them out of the reading area, choose **Obsidian Settings → Editor → Properties in document → Hidden**. This hides the properties without deleting them.

## Apple Books and research

Use the **Apple Books import** toggle in settings or the status menu to bring highlights into your vault as readable annotation notes. The first import lets you choose whether to process existing highlights; new highlights are processed automatically while import is enabled and Obsidian is open.

The separate **Internet research** toggle is off unless you enable it with consent. Enabling starts in **Manual** mode for selected text or an active note; choose **Automatic for Apple Books** in settings for eligible highlights. Research results for highlights are saved in separate companion notes, keeping the original annotations intact.

## Privacy

- Note processing uses your configured Ollama server, which defaults to your own machine.
- Web research requires consent and sends derived search queries to Exa, not raw notes or highlights. The Exa API key is stored in macOS Keychain.
- Apple Books access is read-only; Mindmap never modifies the source database.
- Copied diagnostics redact credentials and other secret-shaped values.

## Troubleshooting

Open **Advanced and troubleshooting → Check setup** for actionable checks. Confirm Ollama is running, both models are available, and your included folders are saved. Use **Copy diagnostics** when reporting a problem.

If an upgrade requires a migration, follow the status menu's guidance. **Retry migration** resumes interrupted progress. Applying a different embedding model or dimension automatically re-embeds notes into a staged index. The prior generation remains on disk until the replacement is verified and activated; ordinary processing waits so embedding spaces cannot mix. A failure leaves the prior generation intact and offers a retry. **Run Mindmap full rebuild (all notes)** compacts existing vectors; it does not change embedding models.

## Technical details

Mindmap is written in TypeScript and bundled into the plugin. Runtime data stays under `.obsidian/plugins/mindmap-ai/data/`. Apple Books uses `/usr/bin/sqlite3`; Keychain access uses `/usr/bin/security`. The optional macOS LaunchAgent uses `/bin/launchctl` and `/usr/bin/open` to open the vault, not process notes while Obsidian is closed. These integrations use fixed arguments with `shell: false`.

Plugin version and compatibility are defined in `manifest.json` and `versions.json`. See [Contributing](CONTRIBUTING.md) for development instructions and [Changelog](CHANGELOG.md) for release history.
