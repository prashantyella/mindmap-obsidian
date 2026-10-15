# Connection quality fixture

`representative-notes.json` is synthetic and contains no vault data. Its 25
notes cover six themes, a near-duplicate pair, one deliberately short note,
and ten queries with explicit expected links. The relevance lists are useful
targets, not exhaustive declarations that every unlisted result is wrong.

The default unit test injects deterministic unit vectors and never contacts a
model. To evaluate the production two-tier retrieval and related-selection
functions with an already-installed, loopback Ollama model:

```sh
OLLAMA_MODEL=mxbai-embed-large:latest npm run quality:connections
```

Set `OLLAMA_METADATA_MODEL` to additionally print five source/summary pairs
for manual faithfulness review. The runner validates loopback endpoints, does
not download models, and is excluded from the default test suite.

## 2026-10-15 local sample

With `mxbai-embed-large:latest`, all 20 explicitly expected links were present
in the eight selected results (expected coverage and recall 1.00), MRR was
0.90, and self hits were zero. Expected-link precision at eight was 0.25, its
maximum for these intentionally sparse labels; this is not a judgment that
the four diversity slots are irrelevant. Among the four core slots, 47.5%
matched the sparse labels. The result supports keeping the current model and
selection settings, while showing that unlabelled and deliberately diverse
links need human judgment before any threshold change.

Five `qwen2.5:1.5b` summaries were manually inspected separately from link
retrieval. All were on-topic and concise with no direct contradiction; the
tomato result added a mild "fruit production" generalization and the training
result blurred why an easier week is used. As expected for short summaries,
all omitted some source detail. No prompt, model, ranking, or shipping threshold
was changed from this sample.
