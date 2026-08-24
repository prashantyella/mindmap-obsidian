import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import {
  computeMetadataChecksumHex,
  GenerationMetadataError,
  identityKey,
  parseNoteMetadataArrayV1,
  parseNoteRowMetadataV1,
  parseShardOffsetsArrayV1,
} from "./generationMetadata";

const HASH = "a".repeat(64);
const MODEL = "mxbai-embed-large";

function noteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identity: stableNoteIdentity(canonicalizePath("A.md")),
    sourceHash: HASH,
    embeddingModel: MODEL,
    chunkCount: 2,
    rowIndex: 0,
    shardId: "shard-0",
    ...overrides,
  };
}

void test("identityKey: path identities key by canonical path; apple-annotation identities key by annotation id, not path", () => {
  const a = stableNoteIdentity(canonicalizePath("A.md"));
  const b = stableNoteIdentity(canonicalizePath("A.md"));
  assert.equal(identityKey(a), identityKey(b));

  const ann1 = stableNoteIdentity(canonicalizePath("A.md"), "note-1");
  const ann2 = stableNoteIdentity(canonicalizePath("B.md"), "note-1");
  assert.equal(identityKey(ann1), identityKey(ann2), "same annotation id, different path -> same identity key");

  const ann3 = stableNoteIdentity(canonicalizePath("A.md"), "note-2");
  assert.notEqual(identityKey(ann1), identityKey(ann3));
});

void test("computeMetadataChecksumHex is deterministic and content-sensitive", () => {
  const a = computeMetadataChecksumHex([{ x: 1 }]);
  const b = computeMetadataChecksumHex([{ x: 1 }]);
  const c = computeMetadataChecksumHex([{ x: 2 }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

void test("parseNoteRowMetadataV1 accepts a well-formed row and rejects a missing/fractional/negative rowIndex", () => {
  const parsed = parseNoteRowMetadataV1(noteRow());
  assert.equal(parsed.rowIndex, 0);
  assert.throws(() => parseNoteRowMetadataV1(noteRow({ rowIndex: undefined })), GenerationMetadataError);
  assert.throws(() => parseNoteRowMetadataV1(noteRow({ rowIndex: 1.5 })), GenerationMetadataError);
  assert.throws(() => parseNoteRowMetadataV1(noteRow({ rowIndex: -1 })), GenerationMetadataError);
});

void test("parseNoteRowMetadataV1 wraps an IndexRecordV1 validation failure (e.g. malformed sourceHash)", () => {
  assert.throws(() => parseNoteRowMetadataV1(noteRow({ sourceHash: "not-hex" })), GenerationMetadataError);
});

void test("parseNoteMetadataArrayV1 accepts a well-formed array and returns it sorted by rowIndex", () => {
  const rows = [
    noteRow({ identity: stableNoteIdentity(canonicalizePath("B.md")), rowIndex: 1 }),
    noteRow({ identity: stableNoteIdentity(canonicalizePath("A.md")), rowIndex: 0 }),
  ];
  const parsed = parseNoteMetadataArrayV1(rows, 2, MODEL);
  assert.deepEqual(
    parsed.map((r) => r.rowIndex),
    [0, 1],
  );
  assert.equal(parsed[0].identity.canonicalPath, "A.md");
});

void test("parseNoteMetadataArrayV1 rejects a non-array value and a length mismatch", () => {
  assert.throws(() => parseNoteMetadataArrayV1("not-an-array", 1, MODEL), GenerationMetadataError);
  assert.throws(() => parseNoteMetadataArrayV1([noteRow()], 2, MODEL), GenerationMetadataError);
});

void test("parseNoteMetadataArrayV1 rejects an embeddingModel mismatch against the generation's own model", () => {
  assert.throws(() => parseNoteMetadataArrayV1([noteRow({ embeddingModel: "other-model" })], 1, MODEL), GenerationMetadataError);
});

void test("parseNoteMetadataArrayV1 rejects a duplicate rowIndex and a rowIndex gap (not an exact permutation)", () => {
  assert.throws(
    () =>
      parseNoteMetadataArrayV1(
        [
          noteRow({ identity: stableNoteIdentity(canonicalizePath("A.md")), rowIndex: 0 }),
          noteRow({ identity: stableNoteIdentity(canonicalizePath("B.md")), rowIndex: 0 }),
        ],
        2,
        MODEL,
      ),
    GenerationMetadataError,
  );
  assert.throws(
    () =>
      parseNoteMetadataArrayV1(
        [
          noteRow({ identity: stableNoteIdentity(canonicalizePath("A.md")), rowIndex: 0 }),
          noteRow({ identity: stableNoteIdentity(canonicalizePath("B.md")), rowIndex: 2 }),
        ],
        2,
        MODEL,
      ),
    GenerationMetadataError,
  );
});

void test("parseNoteMetadataArrayV1 rejects a duplicate note identity even at distinct rowIndex values", () => {
  assert.throws(
    () =>
      parseNoteMetadataArrayV1(
        [
          noteRow({ identity: stableNoteIdentity(canonicalizePath("A.md")), rowIndex: 0 }),
          noteRow({ identity: stableNoteIdentity(canonicalizePath("A.md")), rowIndex: 1 }),
        ],
        2,
        MODEL,
      ),
    GenerationMetadataError,
  );
});

function offset(path: string, start: number, length: number): Record<string, unknown> {
  return { identity: stableNoteIdentity(canonicalizePath(path)), start, length };
}

void test("parseShardOffsetsArrayV1 accepts an exact partition and returns it sorted by start", () => {
  const parsed = parseShardOffsetsArrayV1([offset("B.md", 2, 1), offset("A.md", 0, 2)], 3);
  assert.deepEqual(
    parsed.map((o) => o.identity.canonicalPath),
    ["A.md", "B.md"],
  );
});

void test("parseShardOffsetsArrayV1 accepts a zero-row shard with an empty array", () => {
  const parsed = parseShardOffsetsArrayV1([], 0);
  assert.deepEqual(parsed, []);
});

void test("parseShardOffsetsArrayV1 rejects a non-array value and a malformed entry", () => {
  assert.throws(() => parseShardOffsetsArrayV1("nope", 0), GenerationMetadataError);
  assert.throws(() => parseShardOffsetsArrayV1([{ identity: stableNoteIdentity(canonicalizePath("A.md")), start: 0, length: 0 }], 0), GenerationMetadataError);
  assert.throws(() => parseShardOffsetsArrayV1([{ identity: stableNoteIdentity(canonicalizePath("A.md")), start: -1, length: 1 }], 0), GenerationMetadataError);
});

void test("parseShardOffsetsArrayV1 rejects a gap in row coverage", () => {
  assert.throws(() => parseShardOffsetsArrayV1([offset("A.md", 0, 1), offset("B.md", 2, 1)], 3), GenerationMetadataError);
});

void test("parseShardOffsetsArrayV1 rejects overlapping ranges", () => {
  assert.throws(() => parseShardOffsetsArrayV1([offset("A.md", 0, 2), offset("B.md", 1, 2)], 3), GenerationMetadataError);
});

void test("parseShardOffsetsArrayV1 rejects coverage that ends short of, or past, the declared shard row count", () => {
  assert.throws(() => parseShardOffsetsArrayV1([offset("A.md", 0, 2)], 3), GenerationMetadataError);
  assert.throws(() => parseShardOffsetsArrayV1([offset("A.md", 0, 4)], 3), GenerationMetadataError);
});

void test("parseShardOffsetsArrayV1 rejects a duplicate note identity across two ranges", () => {
  assert.throws(
    () => parseShardOffsetsArrayV1([offset("A.md", 0, 1), { identity: stableNoteIdentity(canonicalizePath("A.md")), start: 1, length: 1 }], 2),
    GenerationMetadataError,
  );
});
