# Release checklist: 0.3.11

Status: publication authorized by the release owner on 2026-10-20 after the outstanding live checks were disclosed. Automated validation passed. The unchecked live checks below remain follow-up work and are not represented as completed.

## Scope

- Background-safe processing yields and bounded parallel index-prefix reads.
- Compact queue JSON with full job history retained.
- Safe embedding-model migration and Gemma 2 defaults for new installations.
- Blank summaries when no summary exists; no typography or layout changes.
- Excludes job-history archival and metadata chunking changes.

## Automated preparation

- [x] Confirm the latest public release is 0.3.10 and prepare 0.3.11.
- [x] Synchronize manifest, package, lockfile, and version compatibility map.
- [x] Document user-visible changes and model-change behavior in the changelog.
- [x] Include all required runtime, test, and benchmark source files in the candidate; exclude private benchmark inputs and reports.
- [x] Pass lint, official Obsidian lint, typecheck, tests, build, and release validation (2,272 passed; four opt-in benchmarks skipped).
- [x] Pass the isolated real-Ollama migration smoke test: cutover, resume, failure recovery, wrong-model rejection, overlay retirement, and switch-back.
- [x] Prepare exactly `main.js`, `manifest.json`, and `styles.css` in `release/`.
- [x] Verify packaged files match the tested build and record their checksums.
- [x] Pass CI on the source release candidate commit (`bcd1479`, GitHub Actions run `39514289921`, Node 20).

Validated locally on 2026-10-20 with Node 22.19.0. Existing lint warnings remain; there are no lint errors. CI uses Node 20. No candidate was installed into the personal vault during this preparation.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `main.js` | 692662 | `73913c012dc69f02a125e0bef091dfee0b2c2a621427e8604a11be5bb829fc53` |
| `manifest.json` | 329 | `6e7e06218dab8b4a8ee1a4a16bd8540cb21da26ce20353dbd5f0b94b13866213` |
| `styles.css` | 21240 | `c2cf12f2140e24bd7d7a3db8a64290c098a82b81a9754ab8babe4c42b450829f` |

## Outstanding live validation

- [ ] Verify cold start and reload with the candidate in Obsidian under normal memory pressure.
- [ ] Confirm the existing vault's saved model selection and all job records survive the upgrade.
- [ ] Exercise the same workload foregrounded and unfocused for at least six minutes per condition, with Developer Tools closed. Record indexing, persistence, and model-inference timings separately.
- [ ] Check editing responsiveness, saved-note prioritization, cancellation/unload, and queue recovery after restart.
- [ ] Verify model-change migration, interrupted resume, failure recovery, and mixed-model rejection in an isolated test vault.
- [ ] Confirm sidebar fonts/layout are unchanged and missing summaries remain blank.
- [ ] Confirm rollback to the prior plugin can read the compact queue; preserve the vault and index backup until validation finishes.

Previous validation: the background-yield fix completed notes with Obsidian unfocused. The later index/queue optimization trial encountered a blank vault during severe system memory pressure and was rolled back. Its startup failure was not conclusively attributed to the plugin or the environment. That trial does not satisfy this candidate's live acceptance gates.

## Publication

- [x] Receive explicit approval to publish with the outstanding live checks recorded (2026-10-20).
- [ ] Merge the approved candidate into `main` after automated CI passes.
- [ ] Verify the final commit's manifest is 0.3.11 and build the assets from that exact commit.
- [ ] Create and push tag `0.3.11` on the approved commit.
- [ ] Verify the release workflow, three published assets, attestation, and release notes.
- [ ] Test installation/update from the published release.

Publication approval does not change the status of the unfinished live validation. Complete and record those checks separately; do not claim foreground/background performance parity from isolated benchmarks.
