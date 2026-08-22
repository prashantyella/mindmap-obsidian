import test from "node:test";
import assert from "node:assert/strict";

import { IndexManifestError, parseVectorIndexManifestV1 } from "./indexManifest";

const VALID_CHECKSUM = "a".repeat(64);
const VALID_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generationId: 1,
    generationCreatedAt: VALID_TIMESTAMP,
    embeddingProvider: "ollama",
    embeddingModel: "mxbai-embed-large",
    dimension: 1024,
    noteCount: 2,
    chunkCount: 3,
    codecVersion: 1,
    noteMatrixChecksum: VALID_CHECKSUM,
    chunkShards: [
      { schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM },
    ],
    ...overrides,
  };
}

void test("parseVectorIndexManifestV1 accepts a well-formed manifest and returns an equivalent value", () => {
  const parsed = parseVectorIndexManifestV1(validManifest());
  assert.equal(parsed.embeddingProvider, "ollama");
  assert.equal(parsed.dimension, 1024);
  assert.equal(parsed.chunkShards.length, 1);
});

void test("parseVectorIndexManifestV1 rejects a non-object value", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    assert.throws(() => parseVectorIndexManifestV1(bad), IndexManifestError);
  }
});

void test("parseVectorIndexManifestV1 rejects a missing/mismatched schemaVersion", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ schemaVersion: 2 })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ schemaVersion: undefined })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 rejects an unsupported embeddingProvider", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ embeddingProvider: "openai" })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 rejects an out-of-bound dimension", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ dimension: 0 })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ dimension: 100000 })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ dimension: 1.5 })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 rejects a malformed checksum", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ noteMatrixChecksum: "not-hex" })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ noteMatrixChecksum: "A".repeat(64) })), IndexManifestError, "must be lowercase");
});

void test("parseVectorIndexManifestV1 rejects a malformed/impossible generationCreatedAt timestamp", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ generationCreatedAt: "not-a-date" })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ generationCreatedAt: "2026-02-30T00:00:00.000Z" })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 rejects chunkShards that are not an array", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ chunkShards: "not-an-array" })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 rejects a duplicate shardId", () => {
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({
          chunkCount: 6,
          chunkShards: [
            { schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM },
            { schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM },
          ],
        }),
      ),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 rejects when shard counts do not sum to chunkCount", () => {
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({
          chunkCount: 10,
          chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM }],
        }),
      ),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 rejects a shard with a malformed checksum or a bad schemaVersion", () => {
  assert.throws(
    () => parseVectorIndexManifestV1(validManifest({ chunkShards: [{ schemaVersion: 1, shardId: "s", count: 3, checksum: "bad" }] })),
    IndexManifestError,
  );
  assert.throws(
    () => parseVectorIndexManifestV1(validManifest({ chunkShards: [{ schemaVersion: 2, shardId: "s", count: 3, checksum: VALID_CHECKSUM }] })),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 accepts zero notes/chunks/shards (a freshly-initialized empty index)", () => {
  const parsed = parseVectorIndexManifestV1(
    validManifest({ noteCount: 0, chunkCount: 0, chunkShards: [] }),
  );
  assert.equal(parsed.noteCount, 0);
  assert.equal(parsed.chunkShards.length, 0);
});

void test("parseVectorIndexManifestV1 rejects a codecVersion other than the exactly-one supported version", () => {
  for (const bad of [0, 2, 1000, 1.5, "1"]) {
    assert.throws(() => parseVectorIndexManifestV1(validManifest({ codecVersion: bad })), IndexManifestError);
  }
});

void test("parseVectorIndexManifestV1 rejects an embeddingModel/shardId containing a control character", () => {
  const controlChar = String.fromCharCode(1);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ embeddingModel: `model${controlChar}name` })), IndexManifestError);
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({ chunkShards: [{ schemaVersion: 1, shardId: `shard${controlChar}0`, count: 3, checksum: VALID_CHECKSUM }] }),
      ),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 normalizes (trims) embeddingModel/shardId", () => {
  const parsed = parseVectorIndexManifestV1(validManifest({ embeddingModel: "  mxbai-embed-large  " }));
  assert.equal(parsed.embeddingModel, "mxbai-embed-large");
});

void test("parseVectorIndexManifestV1 rejects a nonempty shard with a zero or negative count", () => {
  assert.throws(
    () => parseVectorIndexManifestV1(validManifest({ chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: 0, checksum: VALID_CHECKSUM }] })),
    IndexManifestError,
  );
  assert.throws(
    () =>
      parseVectorIndexManifestV1(validManifest({ chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: -1, checksum: VALID_CHECKSUM }] })),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 rejects a nonzero chunkCount with zero shards, and a zero chunkCount with nonempty shards", () => {
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ chunkCount: 3, chunkShards: [] })), IndexManifestError);
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({ chunkCount: 0, chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM }] }),
      ),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 rejects duplicate shardIds that only differ by surrounding whitespace (after normalization)", () => {
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({
          chunkCount: 6,
          chunkShards: [
            { schemaVersion: 1, shardId: "shard-0", count: 3, checksum: VALID_CHECKSUM },
            { schemaVersion: 1, shardId: "  shard-0  ", count: 3, checksum: VALID_CHECKSUM },
          ],
        }),
      ),
    IndexManifestError,
  );
});

void test("parseVectorIndexManifestV1 rejects a shape that fits the codec's raw 512MB byte budget but exceeds the executable steady-state memory budget (128MB)", () => {
  // 10,000 notes x 8192 dims individually clears every field-range check (MAX_DIMENSION,
  // MAX_MANIFEST_NOTE_COUNT) AND the codec's own 512MB encoded-matrix ceiling (~327MB) -- but
  // decoding that note matrix alone into steady-state memory (~327MB) blows the approved 128MB
  // steady-state budget on its own. The memory/disk budgets are executable invariants
  // independent of (and tighter than) the per-field/per-matrix bounds above.
  assert.throws(
    () => parseVectorIndexManifestV1(validManifest({ dimension: 8192, noteCount: 10_000, chunkCount: 0, chunkShards: [] })),
    (error: unknown) => error instanceof IndexManifestError && /steady-state memory/.test(error.message),
  );
});

void test("parseVectorIndexManifestV1 accepts the ordinary approved target shape (10,000 notes / 100,000 chunks across ten 10,000-row shards / 1,024 dims) within all three memory/disk budgets", () => {
  const parsed = parseVectorIndexManifestV1(
    validManifest({
      dimension: 1024,
      noteCount: 10_000,
      chunkCount: 100_000,
      chunkShards: Array.from({ length: 10 }, (_, i) => ({ schemaVersion: 1, shardId: `shard-${i}`, count: 10_000, checksum: VALID_CHECKSUM })),
    }),
  );
  assert.equal(parsed.noteCount, 10_000);
  assert.equal(parsed.chunkCount, 100_000);
  assert.equal(parsed.chunkShards.length, 10);
});

void test("parseVectorIndexManifestV1 enforces the exact 10,000-note / 100,000-chunk committed-generation ceiling (accepts the boundary, rejects one past it)", () => {
  assert.doesNotThrow(() =>
    parseVectorIndexManifestV1(validManifest({ noteCount: 10_000, chunkCount: 0, chunkShards: [] })),
  );
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ noteCount: 10_001 })), IndexManifestError);

  assert.doesNotThrow(() =>
    parseVectorIndexManifestV1(
      validManifest({
        noteCount: 0,
        chunkCount: 100_000,
        chunkShards: Array.from({ length: 10 }, (_, i) => ({ schemaVersion: 1, shardId: `shard-${i}`, count: 10_000, checksum: VALID_CHECKSUM })),
      }),
    ),
  );
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ chunkCount: 100_001 })), IndexManifestError);

  // Confirms this is a tight, exact-target ceiling, not merely "below the raw codec ceiling"
  // (which independently permits up to 2,000,000).
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ noteCount: 1_000_000 })), IndexManifestError);
  assert.throws(() => parseVectorIndexManifestV1(validManifest({ chunkCount: 1_000_000 })), IndexManifestError);
});

void test("parseVectorIndexManifestV1 enforces the exact MAX_MANIFEST_SHARD_ROW_COUNT (10,000) per-shard cap (accepts the boundary, rejects one past it, even though the codec's own 512MB ceiling would allow far more)", () => {
  assert.doesNotThrow(() =>
    parseVectorIndexManifestV1(
      validManifest({ noteCount: 0, chunkCount: 10_000, chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: 10_000, checksum: VALID_CHECKSUM }] }),
    ),
  );
  assert.throws(
    () =>
      parseVectorIndexManifestV1(
        validManifest({
          noteCount: 0,
          chunkCount: 10_001,
          chunkShards: [{ schemaVersion: 1, shardId: "shard-0", count: 10_001, checksum: VALID_CHECKSUM }],
        }),
      ),
    IndexManifestError,
  );
});
