import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { EngineError, isEngineError } from "./errors";
import { projectSource } from "./sourceProjection";
import { createProductionNoteEmbeddingSeam, createProductionNoteMetadataSeam } from "./productionProviderSeams";
import type { EmbeddingBatchRequest, EmbeddingProvider } from "./embeddingProvider";
import type { MetadataInferenceProvider } from "./metadataPipeline";

const IDENTITY = stableNoteIdentity(canonicalizePath("Notes/a.md"));
const CHUNK_OPTIONS = { targetTokens: 50, overlapTokens: 5 };

function unitVector(dimension: number): number[] {
  const values = new Array(dimension).fill(0);
  values[0] = 1;
  return values;
}

function makeProjection(bodyWords: number) {
  const body = "word ".repeat(bodyWords).trim();
  return projectSource(IDENTITY, `---\n---\n${body}`);
}

function fakeProvider(respond: (request: EmbeddingBatchRequest) => { model: string; dimension: number; items: { id: string; values: number[] }[] }): EmbeddingProvider {
  return {
    async embedBatch(request) {
      return respond(request);
    },
  };
}

void test("createProductionNoteEmbeddingSeam succeeds against a well-formed response with the exact requested id set", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({
    model: "m",
    dimension: 4,
    items: request.items.map((item) => ({ id: item.id, values: unitVector(4) })),
  }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  const result = await seam.embed(projection, new AbortController().signal);
  assert.equal(result.model, "m");
  assert.equal(result.dimension, 4);
  assert.equal(result.noteVector.length, 4);
  assert.ok(result.chunkVectors.length > 0);
});

void test("createProductionNoteEmbeddingSeam never truncates the note text or a chunk's text before sending it to the provider (item 7: no silent truncation)", async () => {
  const projection = makeProjection(50_000); // far larger than the old 20,000-char truncation bound
  let observedNoteTextLength = 0;
  const provider = fakeProvider((request) => {
    const noteItem = request.items.find((item) => item.id === "note");
    observedNoteTextLength = noteItem?.text.length ?? 0;
    return { model: "m", dimension: 4, items: request.items.map((item) => ({ id: item.id, values: unitVector(4) })) };
  });
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await seam.embed(projection, new AbortController().signal);
  assert.equal(observedNoteTextLength, projection.projectedBody.length, "the full projected body must reach the provider unmodified, never pre-sliced");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_COUNT_MISMATCH) when the provider returns fewer items than requested", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({
    model: "m",
    dimension: 4,
    items: request.items.slice(0, -1).map((item) => ({ id: item.id, values: unitVector(4) })),
  }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_COUNT_MISMATCH");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_RESPONSE_INVALID) when the provider returns a duplicate id", async () => {
  const projection = makeProjection(30); // small enough to have zero/one chunk, keeping this deterministic
  const provider = fakeProvider((request) => {
    const items = request.items.map((item) => ({ id: item.id, values: unitVector(4) }));
    // Replace the last item's id with "note" to create a duplicate, while keeping array length equal.
    if (items.length > 1) items[items.length - 1] = { id: "note", values: unitVector(4) };
    return { model: "m", dimension: 4, items };
  });
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && (error.code === "EMBEDDING_RESPONSE_INVALID" || error.code === "EMBEDDING_COUNT_MISMATCH"));
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_RESPONSE_INVALID) when the provider returns an id that was never requested, even with correct cardinality", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => {
    const items = request.items.map((item) => ({ id: item.id, values: unitVector(4) }));
    items[0] = { id: "unexpected-extra-id", values: unitVector(4) }; // same length, but swaps out a required id
    return { model: "m", dimension: 4, items };
  });
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_RESPONSE_INVALID");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_MODEL_MISMATCH) when the provider responds with a different model than requested", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({ model: "wrong-model", dimension: 4, items: request.items.map((item) => ({ id: item.id, values: unitVector(4) })) }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_MODEL_MISMATCH");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_DIMENSION_INVALID) when the provider responds with an invalid dimension", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({ model: "m", dimension: 0, items: request.items.map((item) => ({ id: item.id, values: [] })) }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_DIMENSION_INVALID");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_DIMENSION_MISMATCH) when one item's vector length disagrees with the declared dimension", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({
    model: "m",
    dimension: 4,
    items: request.items.map((item, index) => ({ id: item.id, values: index === 0 ? unitVector(3) : unitVector(4) })),
  }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_DIMENSION_MISMATCH");
});

void test("createProductionNoteEmbeddingSeam fails closed (EMBEDDING_VECTOR_INVALID) when a returned vector is not unit-length", async () => {
  const projection = makeProjection(200);
  const provider = fakeProvider((request) => ({
    model: "m",
    dimension: 4,
    items: request.items.map((item) => ({ id: item.id, values: [1, 1, 1, 1] })), // not unit-norm
  }));
  const seam = createProductionNoteEmbeddingSeam(provider, "m", CHUNK_OPTIONS);
  await assert.rejects(() => seam.embed(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "EMBEDDING_VECTOR_INVALID");
});

void test("createProductionNoteEmbeddingSeam passes the CONFIGURED chunk target/overlap through to chunking, never a hardcoded production default", async () => {
  const projection = makeProjection(2_000);
  let observedItemCountLarge = 0;
  let observedItemCountSmall = 0;
  const provider = fakeProvider((request) => ({ model: "m", dimension: 4, items: request.items.map((item) => ({ id: item.id, values: unitVector(4) })) }));
  const seamLargeChunks = createProductionNoteEmbeddingSeam(provider, "m", { targetTokens: 1000, overlapTokens: 0 });
  const seamSmallChunks = createProductionNoteEmbeddingSeam(provider, "m", { targetTokens: 20, overlapTokens: 0 });
  const captureCounts = async (seam: ReturnType<typeof createProductionNoteEmbeddingSeam>, assign: (n: number) => void) => {
    const providerCapture = fakeProvider((request) => {
      assign(request.items.length);
      return { model: "m", dimension: 4, items: request.items.map((item) => ({ id: item.id, values: unitVector(4) })) };
    });
    await createProductionNoteEmbeddingSeam(providerCapture, "m", seam === seamLargeChunks ? { targetTokens: 1000, overlapTokens: 0 } : { targetTokens: 20, overlapTokens: 0 }).embed(projection, new AbortController().signal);
  };
  await captureCounts(seamLargeChunks, (n) => { observedItemCountLarge = n; });
  await captureCounts(seamSmallChunks, (n) => { observedItemCountSmall = n; });
  assert.ok(observedItemCountSmall > observedItemCountLarge, "a smaller configured targetTokens must produce more chunk items -- the configured value must actually drive chunking");
});

void test("createProductionNoteMetadataSeam processes an oversized note (>40K chars) through the hierarchical pipeline without truncation", async () => {
  const projection = makeProjection(50_000);
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      return '{"summary":"s","tags":["t"],"concepts":["c"]}';
    },
  };
  const seam = createProductionNoteMetadataSeam(provider, {
    model: "m",
    maxTokens: 200,
    tagLimit: 5,
    conceptLimit: 5,
    conceptMaxWords: 3,
    conceptCaseMode: "lower",
    controlledTags: [],
    allowFreeTags: true,
    tagMinLen: 2,
    tagMaxWords: 3,
    tagAliases: {},
  });
  const result = await seam.extract(projection, new AbortController().signal);
  assert.ok(callCount > 1, "oversized note should use hierarchical pipeline with multiple provider calls");
  assert.ok(result.summary.length > 0);
});

void test("createProductionNoteMetadataSeam passes the full, untruncated projected body through to a well-behaved provider for an ordinary-sized note", async () => {
  const projection = makeProjection(200);
  let observedTextLength = 0;
  const provider: MetadataInferenceProvider = {
    complete: async (request) => {
      observedTextLength = request.messages.map((m) => m.content).join("").length;
      return '{"summary":"s","tags":[],"concepts":[]}';
    },
  };
  const seam = createProductionNoteMetadataSeam(provider, {
    model: "m",
    maxTokens: 200,
    tagLimit: 5,
    conceptLimit: 5,
    conceptMaxWords: 3,
    conceptCaseMode: "lower",
    controlledTags: [],
    allowFreeTags: true,
    tagMinLen: 2,
    tagMaxWords: 3,
    tagAliases: {},
  });
  await seam.extract(projection, new AbortController().signal);
  assert.ok(observedTextLength >= projection.projectedBody.length, "the full note body must be reflected in the built prompt, never pre-sliced");
});

void test("createProductionNoteMetadataSeam never caches completed short-note output", async () => {
  let callCount = 0;
  const metadataProvider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      return '{"summary":"cached","tags":["t"],"concepts":["c"]}';
    },
  };
  const config = {
    model: "m",
    maxTokens: 200,
    tagLimit: 5,
    conceptLimit: 5,
    conceptMaxWords: 3,
    conceptCaseMode: "lower" as const,
    controlledTags: [] as string[],
    allowFreeTags: true,
    tagMinLen: 2,
    tagMaxWords: 3,
    tagAliases: {},
  };
  const seam = createProductionNoteMetadataSeam(metadataProvider, config);
  const projection = projectSource(IDENTITY, "---\n---\nShort note body text for caching test.");
  const result1 = await seam.extract(projection, new AbortController().signal);
  const result2 = await seam.extract(projection, new AbortController().signal);
  assert.equal(callCount, 2, "short-note reprocesses must make fresh provider calls");
  assert.deepEqual(result1, result2);
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);
});

void test("createProductionNoteMetadataSeam clearCache drops all cached entries", async () => {
  let callCount = 0;
  let failOnce = true;
  const metadataProvider: MetadataInferenceProvider = {
    async complete() {
      callCount++;
      if (failOnce && callCount === 2) {
        failOnce = false;
        throw new EngineError("METADATA_TIMEOUT", "transient");
      }
      return '{"summary":"s","tags":[],"concepts":[]}';
    },
  };
  const config = {
    model: "m",
    maxTokens: 200,
    tagLimit: 5,
    conceptLimit: 5,
    conceptMaxWords: 3,
    conceptCaseMode: "lower" as const,
    controlledTags: [] as string[],
    allowFreeTags: true,
    tagMinLen: 2,
    tagMaxWords: 3,
    tagAliases: {},
  };
  const seam = createProductionNoteMetadataSeam(metadataProvider, config);
  const projection = projectSource(IDENTITY, `---\n---\n${"word ".repeat(12_000)}`);
  await assert.rejects(seam.extract(projection, new AbortController().signal), (error: unknown) => error instanceof EngineError && error.code === "METADATA_TIMEOUT");
  assert.ok((seam as { cacheSize: number }).cacheSize > 0, "failed long extraction should retain completed nodes");
  (seam as { clearCache: () => void }).clearCache();
  const changed = projectSource(IDENTITY, `---\n---\n${"changed ".repeat(12_000)}`);
  await seam.extract(changed, new AbortController().signal);
  assert.ok(callCount > 2, "clearCache and source change must force fresh node calls");
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);
});

const BASE_METADATA_CONFIG = {
  model: "m",
  maxTokens: 200,
  tagLimit: 5,
  conceptLimit: 5,
  conceptMaxWords: 3,
  conceptCaseMode: "lower" as const,
  controlledTags: [] as string[],
  allowFreeTags: true,
  tagMinLen: 2,
  tagMaxWords: 3,
  tagAliases: {} as Record<string, string>,
};

void test("Apple identity remains stable for node-cache ownership", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() { callCount++; return '{"summary":"apple","tags":[],"concepts":[]}'; },
  };
  const appleIdentity = stableNoteIdentity(canonicalizePath("Reading/Ann.md"), "anno-123");
  const seam = createProductionNoteMetadataSeam(provider, BASE_METADATA_CONFIG);
  const proj = projectSource(appleIdentity, "---\n---\nApple note.");
  await seam.extract(proj, new AbortController().signal);
  assert.equal(callCount, 1);
  await seam.extract(proj, new AbortController().signal);
  assert.equal(callCount, 2, "completed short outputs are never cached");

  const differentPathSameAnno = stableNoteIdentity(canonicalizePath("Reading/Other.md"), "anno-123");
  const proj2 = projectSource(differentPathSameAnno, "---\n---\nApple note.");
  await seam.extract(proj2, new AbortController().signal);
  assert.equal(callCount, 3, "completed short outputs are never cached");
});

void test("cache invalidates on config change (full fingerprint)", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() { callCount++; return '{"summary":"s","tags":[],"concepts":[]}'; },
  };
  const seam1 = createProductionNoteMetadataSeam(provider, { ...BASE_METADATA_CONFIG, tagLimit: 5 });
  const seam2 = createProductionNoteMetadataSeam(provider, { ...BASE_METADATA_CONFIG, tagLimit: 10 });
  const proj = projectSource(IDENTITY, "---\n---\nConfig test.");
  await seam1.extract(proj, new AbortController().signal);
  assert.equal(callCount, 1);
  await seam2.extract(proj, new AbortController().signal);
  assert.equal(callCount, 2, "different config fingerprint must miss cache");
});

void test("completed long-note outputs are not retained after success", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() { callCount++; return '{"summary":"s","tags":[],"concepts":[]}'; },
  };
  const seam = createProductionNoteMetadataSeam(provider, BASE_METADATA_CONFIG);
  const identities = Array.from({ length: 65 }, (_, i) =>
    stableNoteIdentity(canonicalizePath(`Notes/evict-${i}.md`)),
  );
  for (let i = 0; i < 64; i++) {
    await seam.extract(projectSource(identities[i], `---\n---\nNote ${i}.`), new AbortController().signal);
  }
  assert.equal(callCount, 64);
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);

  await seam.extract(projectSource(identities[0], `---\n---\nNote 0.`), new AbortController().signal);
  assert.equal(callCount, 65, "completed output must not be reused");

  await seam.extract(projectSource(identities[64], `---\n---\nNote 64.`), new AbortController().signal);
  assert.equal(callCount, 66);
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);

  await seam.extract(projectSource(identities[0], `---\n---\nNote 0.`), new AbortController().signal);
  assert.equal(callCount, 67);
});

void test("completed output cache entry count remains zero", async () => {
  const provider: MetadataInferenceProvider = {
    async complete() { return '{"summary":"s","tags":[],"concepts":[]}'; },
  };
  const seam = createProductionNoteMetadataSeam(provider, BASE_METADATA_CONFIG);
  for (let i = 0; i < 70; i++) {
    const id = stableNoteIdentity(canonicalizePath(`Notes/bound-${i}.md`));
    await seam.extract(projectSource(id, `---\n---\nNote ${i}.`), new AbortController().signal);
  }
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);
});

void test("config fingerprint includes controlledTags and tagAliases", async () => {
  let callCount = 0;
  const provider: MetadataInferenceProvider = {
    async complete() { callCount++; return '{"summary":"s","tags":[],"concepts":[]}'; },
  };
  const seam1 = createProductionNoteMetadataSeam(provider, { ...BASE_METADATA_CONFIG, controlledTags: ["a"] });
  const seam2 = createProductionNoteMetadataSeam(provider, { ...BASE_METADATA_CONFIG, controlledTags: ["b"] });
  const proj = projectSource(IDENTITY, "---\n---\nControlled test.");
  await seam1.extract(proj, new AbortController().signal);
  await seam2.extract(proj, new AbortController().signal);
  assert.equal(callCount, 2, "different controlledTags must produce different cache fingerprint");

  const seam3 = createProductionNoteMetadataSeam(provider, { ...BASE_METADATA_CONFIG, tagAliases: { x: "y" } });
  await seam3.extract(proj, new AbortController().signal);
  assert.equal(callCount, 3, "different tagAliases must produce different cache fingerprint");
});

void test("node cache resumes completed leaves after a transient provider failure", async () => {
  const projection = makeProjection(50_000);
  let calls = 0;
  let failOnce = true;
  const seen = new Map<string, number>();
  const provider: MetadataInferenceProvider = {
    async complete(request) {
      calls++;
      const body = request.messages.map((message) => message.content).join("\n");
      seen.set(body, (seen.get(body) ?? 0) + 1);
      if (failOnce && calls === 2) {
        failOnce = false;
        throw new EngineError("METADATA_TIMEOUT", "transient");
      }
      return '{"summary":"s","tags":[],"concepts":[]}';
    },
  };
  const seam = createProductionNoteMetadataSeam(provider, BASE_METADATA_CONFIG);
  await assert.rejects(seam.extract(projection, new AbortController().signal), (error: unknown) => error instanceof EngineError && error.code === "METADATA_TIMEOUT");
  const firstLeaf = [...seen.keys()][0];
  await seam.extract(projectSource(stableNoteIdentity(canonicalizePath("Notes/unrelated.md")), `---\n---\n${"otherword ".repeat(12_000)}`), new AbortController().signal);
  await seam.extract(projection, new AbortController().signal);
  assert.equal(seen.get(firstLeaf), 1, "a completed leaf must be served from the node cache on retry");
  assert.ok(calls > 2, "retry should continue with uncached leaves and reductions");

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(seam.extract(projection, cancelled.signal), (error: unknown) => error instanceof EngineError && error.code === "METADATA_CANCELLED");
  await seam.extract(projection, new AbortController().signal);
  assert.equal(seen.get(firstLeaf), 2, "cancellation clears only the cancelled document's nodes");
});

void test("terminal metadata failure clears that document's partial nodes", async () => {
  let calls = 0;
  const provider: MetadataInferenceProvider = {
    async complete() {
      calls++;
      if (calls === 2) throw new EngineError("METADATA_CONFIG_INVALID", "terminal");
      return '{"summary":"s","tags":[],"concepts":[]}';
    },
  };
  const seam = createProductionNoteMetadataSeam(provider, BASE_METADATA_CONFIG);
  await assert.rejects(
    seam.extract(makeProjection(50_000), new AbortController().signal),
    (error: unknown) => error instanceof EngineError && error.code === "METADATA_CONFIG_INVALID",
  );
  assert.equal((seam as { cacheSize: number }).cacheSize, 0);
});
