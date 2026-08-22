# Zero-Terminal Runtime Setup Design

## Goal

A public macOS user must be able to install Mindmap, enable the plugin, and reach a passing preflight without locating a Python executable or running a terminal command. Mindmap should reuse a compatible local environment when one already exists and otherwise offer an explicit one-click setup for a private, shared runtime.

The plugin remains desktop-only. This release supports automated runtime setup on macOS. Windows and Linux retain the advanced manual runtime override until a later release.

## User Experience

On first load, Mindmap silently checks runtime readiness.

1. If the saved interpreter is an explicit custom path, Mindmap validates it and never replaces it automatically.
2. If the setting is blank or the default `python3`, Mindmap probes the versioned Mindmap runtime and common macOS Python installations.
3. If a compatible interpreter already has the required packages, Mindmap selects its absolute path, persists it, and reruns preflight without requiring a restart.
4. If Python is available but dependencies are not, the status bar and settings show **Runtime setup required** with a **Set up Mindmap runtime** action.
5. The setup confirmation explains that Mindmap will create a private environment, download pinned Python packages from PyPI, store them outside the vault, and may take several minutes.
6. Setup exposes clear preparing, installing, verifying, ready, failed, and cancelled states. Failure leaves the existing interpreter and vault untouched and offers retry.

Users are never asked to paste an interpreter path. The existing Python/script/config fields remain under Advanced settings for expert overrides and troubleshooting.

## Runtime Location and Reuse

Managed environments live outside every vault under:

`~/Library/Application Support/Mindmap AI/runtime/<requirements-fingerprint>/venv`

The fingerprint derives from the shipped requirements bytes and supported Python runtime contract. A successful environment is reusable across Obsidian vaults. A new dependency set creates a new versioned environment beside the old one; the old environment remains usable until the replacement verifies successfully. Automatic cleanup of old versions is outside this release.

Staging occurs in an explicit sibling directory owned by Mindmap. The final directory is installed through an atomic rename only after verification. Cancellation or failure may remove only that exact staging directory.

## Discovery

An explicit saved interpreter is validated alone and always wins; automatic discovery never replaces it. When the setting is blank or the default, discovery is deterministic and bounded. Candidate order is:

1. the current requirements-fingerprinted Mindmap environment;
2. Python Framework installations for supported versions;
3. Apple Silicon and Intel Homebrew locations;
4. absolute paths returned for `python3` by the process environment;
5. the macOS/Xcode interpreter as a bootstrap candidate only when it meets the supported version and `venv` requirements.

Candidates are normalized, deduplicated, required to be executable files, and invoked only through argument-array process APIs. Discovery never invokes a shell.

A ready probe verifies:

- Python 3.11 through 3.13;
- `ruamel.yaml` is importable at the required version;
- embedded `chromadb` is importable at the exact supported version;
- Mindmap's bundled preflight succeeds with the current bundled config.

A bootstrap probe verifies only the supported Python version plus `venv`/`ensurepip` capability. An interpreter that can read Apple Books but lacks Mindmap dependencies is not reported as fully ready.

## Installation

After explicit confirmation, Mindmap runs a serialized managed setup job:

1. create a staging virtual environment with the selected bootstrap interpreter;
2. run the staging interpreter's pip module with the shipped requirements file;
3. verify package versions and execute structured Mindmap preflight;
4. atomically rename staging to the fingerprinted final directory;
5. persist the final absolute interpreter path;
6. refresh pending/runtime health and scheduler state without restarting Obsidian.

Only one setup job may run. Conflicting Mindmap, Reading processing, scheduler, and runtime setup actions are disabled while it runs. Plugin unload cancels the child process and prevents later state updates.

The requirements file pins all direct runtime dependencies. Installation uses PyPI over TLS and never forwards note content, provider credentials, Apple Books data, or vault paths. Logs include phase, exit code, and bounded redacted stderr, never environment values or authentication headers.

If no compatible bootstrap interpreter exists, Mindmap explains that Python 3.11–3.13 is required and links to the official Python macOS installer. It does not download or execute a system installer itself.

## Reading and Scheduler Boundaries

The standard-library Apple Books reader may preview and import annotations before the full Mindmap runtime is ready. Historical and live Qwen processing remain pending until setup passes. The first-import backlog confirmation must not offer to process immediately when runtime setup is required; it points to the setup action instead.

Manual runs, automatic Reading processing, semantic worker startup, and LaunchAgent installation are blocked until the managed runtime is ready. Once setup succeeds, existing pending Reading notes can be processed explicitly or by the daily schedule.

## State Model

Runtime setup state is ephemeral except for the selected absolute `pythonCommand` and the environment on disk. The UI state contains:

- phase: `discovering`, `setup-required`, `confirming`, `creating`, `installing`, `verifying`, `ready`, `failed`, or `cancelled`;
- selected/discovered interpreter path;
- bounded user-facing message;
- whether setup/retry/cancel is currently actionable.

No provider key, note text, raw process environment, or unbounded subprocess output enters plugin settings.

An explicit custom `pythonCommand` always wins. Resetting it to default re-enables automatic discovery.

## Failure Handling

- Candidate missing or incompatible: continue to the next candidate.
- Dependency probe fails: retain it only as a possible bootstrap interpreter.
- Virtual environment creation fails: report the bounded error and preserve all prior runtime state.
- pip fails or network is unavailable: retain no final environment; offer retry.
- Verification fails: do not select or rename the staging environment.
- Persistence fails after a verified install: retain the verified environment for rediscovery, roll back the in-memory setting, and report the error.
- Cancellation or unload: terminate the owned child, clean only the validated staging path, and suppress later callbacks.
- Existing verified shared runtime: reuse it without network access or confirmation.

## Security

- No shell execution or command-string interpolation.
- Only allowlisted interpreter candidates and the plugin-owned managed environment are auto-selected.
- All process arguments are fixed or resolved local paths.
- The target and staging directories are validated descendants of the Mindmap application-support root before creation, rename, or cleanup.
- Setup requires explicit consent before network access.
- Runtime package installation cannot modify Apple Books or vault notes.
- Advanced custom paths retain the existing caution trust state and are never overwritten.

## Verification

Automated coverage must include:

- deterministic candidate ordering, normalization, and deduplication;
- explicit custom interpreter preservation;
- Xcode Python with missing packages becomes setup-required rather than selected;
- automatic selection and persistence of an already-ready interpreter;
- shared managed runtime reuse across vault contexts;
- one setup job, cancellation, unload, timeout, and retry;
- argument-array process calls with no shell;
- staging cleanup boundaries and atomic final rename;
- pip/create/verify/persist failure rollback;
- no secret or note content in logs/settings;
- Reading import allowed while processing remains blocked;
- scheduler and semantic startup remain blocked until ready;
- a fresh disposable vault reaches passing preflight without editing Python settings.

The final integration gate repeats the current fixture-vault workflow from a truly empty `data.json`, confirms automatic discovery or one-click setup, imports one annotation without processing it, then verifies explicit backlog processing.
