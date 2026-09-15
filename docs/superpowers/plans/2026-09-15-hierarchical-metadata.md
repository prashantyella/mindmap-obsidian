# Hierarchical metadata implementation plan

## Contract and scope

- Preserve `MetadataOutputV1` exactly (`summary`, `tags`, `concepts`, `related`) and keep the existing short-note path a single metadata request with byte-compatible normalization, aliases, filtering, and limits.
- Keep `NoteJobRunner`'s final source-freshness check, atomic note/overlay writes, related selection, generated-footer behavior, and sidebar/query/workspace behavior unchanged. Do not change the queue document schema.
- Bump `PRODUCTION_PIPELINE_VERSION` from `1` to `2` at the existing production-engine seam only to prevent coalescing old in-flight job semantics. It does not mark index records stale or reprocess completed metadata; the pending run is expected to include the three known failures and may also include any genuinely changed or unindexed notes. Never promise an exactly-three-note run. Do not bump `PRODUCTION_RELATED_VERSION` or trigger a full rerun.

## Bounded hierarchical pipeline

1. In `src/engine/metadataBudget.ts`, add a pure estimator with shared validated `contextTokens` (optional metadata config, conservative default `4096`). Resolve `contextTokens` once for `runMetadataPipeline` and the provider request. The hard request formula is: `UTF8_BYTES(fully constructed system + user messages) + explicit chat-template reserve + node output allowance <= resolved contextTokens`, where the output allowance is `256` for leaf/intermediate reductions and configured `maxTokens` for the root. UTF-8 byte length is the conservative upper bound on input tokens; soft word/character estimates may optimize packing only after this hard byte-bound check passes. Recheck every final constructed request immediately before `provider.complete`. Route a short note through the existing single-call function only when that exact constructed request fits.
2. In `src/engine/metadataChunker.ts`, add a Markdown-aware, non-overlapping chunker: split headings, paragraphs, lists, and fenced blocks, then fall back sentence-wise, word-wise, and finally UTF-8-safe hard blocks. Source body bytes/regions occur exactly once with no body overlap; repeated heading breadcrumbs are metadata context only and count against the same request budget.
3. In `src/engine/metadataReducer.ts`, use only the minimal intermediate `{ summary, tags, concepts }`; identity, excerpt, status, and related input stay outside prompts. Recursively reduce validated intermediates, repacking to the same budget until one root. Each intermediate field/record is bounded, and every reduction group must strictly decrease in size until exactly one root; if it cannot decrease, fail closed with `METADATA_CONFIG_INVALID`. Apply existing normalization, aliases, filtering, and limits exactly once to the final `MetadataOutputV1`.
4. Give the long-lived production `NoteMetadataSeam` in `src/engine/productionProviderSeams.ts` concrete bounded in-memory cache ownership. Key entries by stable identity key, source hash, model, and relevant config fingerprint; cache completed leaf/reduction nodes so retries resume failed nodes. Bound by entry count and bytes, clear on success/cancel/source/config change, and never persist to the queue.

## Exact seams and tests

- Extend `src/engine/metadataPipeline.ts` with estimator/chunk/reduction orchestration while retaining `MetadataInferenceRequest`, `MetadataInferenceProvider`, `parseMetadataResponse`, and `runMetadataPipeline` compatibility. Add optional `contextTokens` to the metadata configuration and pass the resolved `num_ctx`/`num_predict` budget to `src/engine/localMetadataProvider.ts`; Ollama sends `options: { num_ctx, num_predict }`, while the OpenAI-compatible body remains unchanged and uses the same orchestration budget. Keep `src/jobs/noteJob.ts`'s seam and final write phases unchanged.
- Retry each map/reduce node at most once, and only for `METADATA_RESPONSE_INVALID`; timeout/provider errors propagate to `JobEngine`, and cancellation never retries.
- Add focused tests in `src/engine/metadataPipeline.test.ts`, `metadataChunker.test.ts`, `metadataReducer.test.ts`, `metadataBudget.test.ts`, and `localMetadataProvider.test.ts`; extend `src/jobs/noteJob.test.ts` for cancellation, cache invalidation, stale-source/no-partial-persistence, and short-note compatibility.
- Cover synthetic 20K, 30K, 55K, 250K, and 2M inputs; Unicode, nested Markdown headings/lists, fenced code, tables, and long atomic blocks; exact once-only body-region coverage; requests never exceeding the token estimate/context; multi-level reductions; malformed-JSON retry; cancellation; bounded cache hits/eviction and source/config invalidation. The 2M case must remain bounded and fast with a fake provider. Pin that the short path makes exactly the existing single call and preserves exact output.
- Extend `src/engine/productionEngine.test.ts`/pending-run tests for `PRODUCTION_PIPELINE_VERSION` invalidation and the three-note pending recovery without a related-version bump or full rerun. Add regression assertions in `src/statusBarState.test.ts`, `statusBarMenu.test.ts`, `workspaceViewState.test.ts`, `src/engine/noteWriter.test.ts`, and related/footer suites proving unchanged sidebar, related frontmatter, and footer behavior.

## Verification

Run targeted suites first:

```sh
npx tsx --import ./scripts/test-setup.mjs --test \
  src/engine/metadataBudget.test.ts src/engine/metadataChunker.test.ts \
  src/engine/metadataReducer.test.ts src/engine/metadataPipeline.test.ts \
  src/engine/localMetadataProvider.test.ts src/jobs/noteJob.test.ts \
  src/engine/productionEngine.test.ts src/engine/productionPendingScan.test.ts \
  src/statusBarState.test.ts src/statusBarMenu.test.ts \
  src/workspaceViewState.test.ts src/engine/noteWriter.test.ts
```

Then run `npm run check`, `npm run build`, `npm run validate`, and `git diff --check`. No release/version files, deployment, queue edits, vault writes, or Obsidian actions belong to this checkpoint.
