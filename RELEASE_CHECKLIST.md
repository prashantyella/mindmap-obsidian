# Release checklist: 0.3.14

Status: candidate preparation; not published.

## 0.3.14 scope and acceptance

- Resume shutdown-interrupted bulk enqueue and avoid duplicate children on restart.
- Cancel uncommitted queued children of failed/cancelled bulk roots atomically; repair stranded legacy children while preserving committed work and operator pause.
- Report unrelated running work accurately while preserving bulk-run exclusion.

- [x] Synchronize manifest/package/lockfile/compatibility map to 0.3.14 and document user-visible changes.
- [x] Pass local lint, Obsidian lint, typecheck, unit tests, lifecycle gates, build, and release validation on the versioned candidate: 2,368 unit/regression tests and two integration tests passed; four optional unit benchmarks skipped, zero integration skips. Existing Obsidian lint warnings remain; no lint errors.
- [x] Pass `npm run release:prepare`, including both mandatory integration tests again, and prepare exactly `main.js`, `manifest.json`, and `styles.css`; all three match `dist/` byte-for-byte.
- [ ] Complete isolated live Obsidian acceptance and record results and limitations.
- [ ] Pass CI on the final candidate before merging or tagging.
- [ ] Merge the approved candidate, tag 0.3.14, and pass the release workflow.
- [ ] Download all published assets, compare them with the tested package, and verify attestations against the repository, tag, merge commit, workflow, and GitHub-hosted runner policy.

Private benchmark reports and personal-vault data are excluded. No live-vault repair is part of this release.

Candidate asset SHA-256 checksums:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `main.js` | 698093 | `0d089203e3bf0178c2894443321d6f5d70838e856b6d1b3b819a70bf4c703213` |
| `manifest.json` | 329 | `ed0851b5525832fd3f9f3f6bf865dc385c0871f6052d3eaa3c254701e208a16d` |
| `styles.css` | 21240 | `c2cf12f2140e24bd7d7a3db8a64290c098a82b81a9754ab8babe4c42b450829f` |

## 0.3.13 publication record

Status: published as [0.3.13](https://github.com/prashantyella/mindmap-obsidian/releases/tag/0.3.13) on 2026-10-21 UTC. No live-vault repair was performed during this release operation.

## 0.3.13 scope and acceptance

- Preserve optional connection freshness through generation serialization, verification, compaction, and restart adoption; unknown markers remain unknown.
- Prevent matching queued/active refreshes from appearing as newly pending work.
- Strengthen unit/integration coverage, typed pending-scan fixtures, portable discovery, and non-optional release gates.
- [x] Source candidate `6de3fbd3fec9acda10f10df0bfcc25bb885ce014` passed CI `39545491078`: 2,363 unit/regression tests plus two integration tests passed; four optional unit benchmarks skipped.
- [x] Replayed a copied 944-note pre-rebuild index: all freshness markers preserved, zero unnecessarily pending notes, repeated compaction preserved the catalog. Live vault unchanged.
- [x] Synchronize manifest/package/lockfile/compatibility map to 0.3.13 and document affected-index recovery limits.
- [x] Final versioned candidate `d1c4675f9991f45daa7d57c3fe960ae4e92ee0bf` passed local checks/packaging and CI `39612040877`: 2,365 tests passed, four optional unit benchmarks skipped, zero integration skips.
- [x] Merge PR #35 as `b33b906fdb65055d96fef031374e6cc57a66d823` (tree identical to the tested candidate), tag 0.3.13, and pass release workflow `39612645735` on that tag.
- [x] Download exactly three published assets, compare them byte-for-byte with the tested package, and verify all attestations against the repository, tag, merge commit, release workflow, and GitHub-hosted runner policy.

Published asset SHA-256 checksums:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `main.js` | 697452 | `354ec062ee162b6dedc41950d6c5744e56e650558d1012d1f7ec043b5da1edcc` |
| `manifest.json` | 329 | `f8ac96ebab604737c206863e28a3c9fdff758ca69ac76cafbcc830298ea0d118` |
| `styles.css` | 21240 | `c2cf12f2140e24bd7d7a3db8a64290c098a82b81a9754ab8babe4c42b450829f` |

The 0.3.12 Obsidian clean-initialization/cold-reopen smoke and plugin-disabled Force Reload limitation are recorded below. This patch has no UI changes; no new foreground/background performance parity or live recovery claim is made.

## 0.3.12 publication record

Status: published as [0.3.12](https://github.com/prashantyella/mindmap-obsidian/releases/tag/0.3.12) on 2026-10-21 UTC after the automated gates and isolated-vault checks below. The host Force Reload limitation is recorded explicitly.

## 0.3.12 scope and acceptance

- Recover duplicate logical paths in mixed annotation/path index records.
- Resume persisted retries automatically without window events, respecting editing protection and pause/unload.
- Preserve verified generations and concurrent updates during interrupted cleanup.
- Report rebuild/retry state truthfully using existing status surfaces; no font or layout changes.
- Enforce the on-disk lifecycle gate in CI and release preparation.

- [x] Synchronize manifest/package/lockfile/compatibility map to 0.3.12 and document changes.
- [x] Pass local lint, Obsidian lint, typecheck, unit tests, lifecycle tests, build, and release validation: 2,287 passed, four optional benchmarks skipped; no lifecycle skips.
- [x] Verify the local recovery build in the existing vault: stuck job completed, 944 unique indexed notes, no pending jobs; previous generation retained and verified.
- [x] Verify clean installation, index initialization, and cold reopen in an isolated Obsidian 1.13.7 vault: one synthetic note embedded, generation 1 verified/activated, saved model/scope preserved, plugin ready after reopening.
- [x] Commit candidate `6dbe3db09f903742f71630591f8804c4d1f39a30`, open PR #34, and pass CI run `39536143236` on that exact candidate.
- [x] Merge as `ca6444117137a2f6ba371cb3b1a25aae80ecbc2d` (identical candidate tree), tag 0.3.12, and pass release workflow `39536369341`.
- [x] Download all three published assets, compare byte-for-byte with the tested package, and verify each attestation against the repository, tag, merge commit, release workflow, and GitHub-hosted runner policy.

Published asset SHA-256 checksums:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `main.js` | 696491 | `da4fe7123fbb8377233e8f382771330ec84989e6efbe3997736d92dcf8ea548a` |
| `manifest.json` | 329 | `e95357e15e64332dd16e945ff43fca8a6d9e63a5db4c57c5e3165d995c01dfff` |
| `styles.css` | 21240 | `c2cf12f2140e24bd7d7a3db8a64290c098a82b81a9754ab8babe4c42b450829f` |

The existing-vault recovery check used the same runtime source before the version bump. The isolated-vault smoke check uses the 0.3.12 bundle. Neither check establishes equal foreground/background performance or completes the broader outstanding 0.3.11 soak tests below.

Smoke-test limitation (2026-10-20 local): the native Force Reload command left the test window blank. The same behavior reproduced with every community plugin disabled; closing and reopening the vault worked with 0.3.12 enabled. Treat Force Reload as an unresolved host/environment limitation, not a passed reload check or an established Mindmap regression. Clean initialization, persisted-index reopening, and the automated restart/retry gates passed. Synthetic test data stayed outside the repository; no personal notes were used in this smoke test.

## Mandatory gates for subsequent releases

These requirements were added after 0.3.11; they do not retroactively validate that release.

- Pass `npm run check`: unit regressions plus the on-disk lifecycle gate (`npm run test:release`).
- The lifecycle gate must cover fresh initialization, a synthetic 944-note mixed-identity upgrade, persisted retry/restart without window activity, interrupted cleanup, verified activation, and preservation of the previous generation.
- Keep retry/pause/unload, identity conflicts, concurrent updates, and truthful status regressions in the default unit suite. Do not skip these as optional benchmarks.
- CI runs the lifecycle gate explicitly. `npm run release:prepare` reruns it before packaging; the release workflow cannot attest/upload/publish assets if it fails.
- Obsidian foreground/background, editing, and visual acceptance checks remain required separately: the Node integration gate is not an Electron/UI test.

## 0.3.11 publication record

Status: published as [0.3.11](https://github.com/prashantyella/mindmap-obsidian/releases/tag/0.3.11), following release-owner authorization on 2026-10-20 after the outstanding live checks were disclosed. Automated validation passed. The unchecked live checks below remain follow-up work and are not represented as completed.

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
- [x] Pass CI on the source candidate (`bcd1479`, run `39514289921`) and final approval commit (`b20d740`, run `39518338275`), using Node 20.

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
- [x] Merge approved PR #33 into `main` after automated CI passes (`3271707a75035e3545c0ecc882956b9ed70af817`).
- [x] Verify that commit's manifest is 0.3.11 and build the assets from that exact commit; its tree matches the approved candidate.
- [x] Create and push tag `0.3.11` on the approved commit.
- [x] Verify release workflow `39518681346`, download and compare all three assets byte-for-byte, verify all attestations against the tag/commit and GitHub-hosted release workflow, and publish the release notes.
- [ ] Test installation/update from the published release.

Publication approval does not change the status of the unfinished live validation. Complete and record those checks separately; do not claim foreground/background performance parity from isolated benchmarks.
