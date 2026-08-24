import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "./contracts";
import { isEngineError } from "./errors";
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

void test("createProductionNoteMetadataSeam never truncates the note text before running the pipeline -- an oversized note fails closed with METADATA_PROMPT_TOO_LARGE rather than being silently cut", async () => {
  const projection = makeProjection(50_000); // exceeds runMetadataPipeline's own 40,000-char bound
  const provider: MetadataInferenceProvider = { complete: async () => '{"summary":"s","tags":[],"concepts":[]}' };
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
  await assert.rejects(() => seam.extract(projection, new AbortController().signal), (error: unknown) => isEngineError(error) && error.code === "METADATA_PROMPT_TOO_LARGE");
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
