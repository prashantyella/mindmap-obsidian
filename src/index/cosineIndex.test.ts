import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import {
  CosineIndexError,
  dotProduct,
  l2Norm,
  MAX_RANKING_LIMIT,
  normalizeVector,
  rankNotes,
  refineWithChunks,
} from "./cosineIndex";
import type { VectorMatrix } from "./vectorCodec";
import type { ChunkShardNoteOffset } from "./vectorTypes";

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

function noteMatrix(dimension: number, rows: number[][]): VectorMatrix {
  const data = new Float32Array(rows.length * dimension);
  rows.forEach((row, i) => data.set(row, i * dimension));
  return { kind: "note", dimension, count: rows.length, data };
}

function chunkMatrix(dimension: number, rows: number[][]): VectorMatrix {
  const data = new Float32Array(rows.length * dimension);
  rows.forEach((row, i) => data.set(row, i * dimension));
  return { kind: "chunk", dimension, count: rows.length, data };
}

function offsetFor(path: string, start: number, length: number): ChunkShardNoteOffset {
  return { identity: stableNoteIdentity(canonicalizePath(path)), start, length };
}

void test("l2Norm/normalizeVector: a normalized vector has unit norm and preserves direction", () => {
  const v = vec(3, 4);
  assert.equal(l2Norm(v), 5);
  const normalized = normalizeVector(v);
  assert.ok(Math.abs(l2Norm(normalized) - 1) < 1e-6);
  assert.ok(Math.abs(normalized[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(normalized[1] - 0.8) < 1e-6);
});

void test("normalizeVector throws on a zero vector rather than silently returning it", () => {
  assert.throws(() => normalizeVector(vec(0, 0, 0)), CosineIndexError);
});

void test("normalizeVector throws on a non-finite component", () => {
  assert.throws(() => normalizeVector(vec(1, Number.NaN)), CosineIndexError);
  assert.throws(() => normalizeVector(vec(Number.POSITIVE_INFINITY, 1)), CosineIndexError);
});

void test("dotProduct of two normalized identical vectors is 1; of two orthogonal vectors is 0", () => {
  const a = normalizeVector(vec(1, 2, 3));
  assert.ok(Math.abs(dotProduct(a, a) - 1) < 1e-6);
  const x = vec(1, 0);
  const y = vec(0, 1);
  assert.equal(dotProduct(x, y), 0);
});

void test("rankNotes returns exact cosine scores in descending order", () => {
  const query = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [
    [...normalizeVector(vec(1, 0))], // identical -> score 1
    [...normalizeVector(vec(0, 1))], // orthogonal -> score 0
    [...normalizeVector(vec(1, 1))], // 45 degrees -> score ~0.707
  ]);
  const ids = [canonicalizePath("A.md"), canonicalizePath("B.md"), canonicalizePath("C.md")];
  const results = rankNotes({ queryVector: query, matrix, ids, limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["A.md", "C.md", "B.md"]);
  assert.ok(Math.abs(results[0].score - 1) < 1e-6);
  assert.ok(Math.abs(results[1].score - Math.SQRT1_2) < 1e-4);
  assert.ok(Math.abs(results[2].score - 0) < 1e-6);
});

void test("rankNotes excludes the given self path entirely, even when it would otherwise score highest", () => {
  const query = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...normalizeVector(vec(1, 0))], [...normalizeVector(vec(0.9, 0.1))]]);
  const ids = [canonicalizePath("Self.md"), canonicalizePath("Other.md")];
  const results = rankNotes({ queryVector: query, matrix, ids, excludePath: canonicalizePath("Self.md"), limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["Other.md"]);
});

void test("rankNotes breaks an exact score tie by ascending canonical path, deterministically", () => {
  const v = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...v], [...v], [...v]]);
  const ids = [canonicalizePath("Zeta.md"), canonicalizePath("Alpha.md"), canonicalizePath("Mid.md")];
  const results = rankNotes({ queryVector: v, matrix, ids, limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["Alpha.md", "Mid.md", "Zeta.md"]);
});

void test("rankNotes bounds output to the given limit", () => {
  const v = normalizeVector(vec(1, 0));
  const rows = Array.from({ length: 20 }, () => [...v]);
  const matrix = noteMatrix(2, rows);
  const ids = rows.map((_, i) => canonicalizePath(`N${i}.md`));
  const results = rankNotes({ queryVector: v, matrix, ids, limit: 5 });
  assert.equal(results.length, 5);
});

void test("rankNotes rejects a limit of 0, a negative limit, and a limit above the hard ceiling", () => {
  const v = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...v]]);
  const ids = [canonicalizePath("A.md")];
  for (const badLimit of [0, -1, 1.5, MAX_RANKING_LIMIT + 1]) {
    assert.throws(() => rankNotes({ queryVector: v, matrix, ids, limit: badLimit }), CosineIndexError);
  }
});

void test("rankNotes rejects a query/matrix dimension mismatch and an ids/matrix.count mismatch", () => {
  const matrix = noteMatrix(2, [[1, 0]]);
  assert.throws(() => rankNotes({ queryVector: vec(1, 0, 0), matrix, ids: [canonicalizePath("A.md")], limit: 5 }), CosineIndexError);
  assert.throws(() => rankNotes({ queryVector: vec(1, 0), matrix, ids: [], limit: 5 }), CosineIndexError);
});

void test("rankNotes rejects a non-note matrix", () => {
  const matrix = chunkMatrix(2, [[1, 0]]);
  assert.throws(() => rankNotes({ queryVector: vec(1, 0), matrix, ids: [canonicalizePath("A.md")], limit: 5 }), CosineIndexError);
});

void test("rankNotes produces identical output across repeated calls (deterministic)", () => {
  const v = normalizeVector(vec(1, 2, 3));
  const rows = [[...normalizeVector(vec(1, 2, 3))], [...normalizeVector(vec(3, 2, 1))], [...normalizeVector(vec(1, 1, 1))]];
  const matrix = noteMatrix(3, rows);
  const ids = [canonicalizePath("A.md"), canonicalizePath("B.md"), canonicalizePath("C.md")];
  const first = rankNotes({ queryVector: v, matrix, ids, limit: 10 });
  const second = rankNotes({ queryVector: v, matrix, ids, limit: 10 });
  assert.deepEqual(first, second);
});

void test("refineWithChunks re-ranks candidates by max chunk-pair cosine similarity (max aggregation)", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [
    [...normalizeVector(vec(1, 0))], // A chunk 0: weak match to query
    [...normalizeVector(vec(0.99, 0.01))], // A chunk 1: near-perfect match to query
    [...normalizeVector(vec(0, 1))], // B chunk 0: orthogonal
  ]);
  const noteOffsets = [offsetFor("A.md", 0, 2), offsetFor("B.md", 2, 1)];
  const candidates = [
    { path: canonicalizePath("A.md"), score: 0.1 }, // note-level score is irrelevant to the refined result
    { path: canonicalizePath("B.md"), score: 0.9 },
  ];
  const query = normalizeVector(vec(1, 0));
  const results = refineWithChunks({ queryChunkVectors: [query], candidates, chunkMatrix: shard, noteOffsets, limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["A.md", "B.md"]);
  assert.ok(results[0].score > results[1].score);
  assert.ok(Math.abs(results[0].score - dotProduct(query, normalizeVector(vec(0.99, 0.01)))) < 1e-4);
});

void test("refineWithChunks can never admit a note outside the candidate set, even if its offset is supplied", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [
    [...normalizeVector(vec(0.5, 0.5))], // A: mediocre match
    [...normalizeVector(vec(1, 0))], // OUTSIDER: perfect match, but not a candidate
  ]);
  const noteOffsets = [offsetFor("A.md", 0, 1), offsetFor("Outsider.md", 1, 1)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  const query = normalizeVector(vec(1, 0));
  const results = refineWithChunks({ queryChunkVectors: [query], candidates, chunkMatrix: shard, noteOffsets, limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["A.md"]);
  assert.ok(!results.some((r) => r.path === "Outsider.md"));
});

void test("refineWithChunks drops a candidate with no chunk offset entry rather than throwing", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  const candidates = [
    { path: canonicalizePath("A.md"), score: 0.5 },
    { path: canonicalizePath("NoChunks.md"), score: 0.9 },
  ];
  const results = refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 });
  assert.deepEqual(results.map((r) => r.path), ["A.md"]);
});

void test("refineWithChunks bounds output to limit and ties break by ascending canonical path", () => {
  const dim = 2;
  const v = normalizeVector(vec(1, 0));
  const shard = chunkMatrix(dim, [[...v], [...v], [...v]]);
  const noteOffsets = [offsetFor("Zeta.md", 0, 1), offsetFor("Alpha.md", 1, 1), offsetFor("Mid.md", 2, 1)];
  const candidates = [
    { path: canonicalizePath("Zeta.md"), score: 1 },
    { path: canonicalizePath("Alpha.md"), score: 1 },
    { path: canonicalizePath("Mid.md"), score: 1 },
  ];
  const results = refineWithChunks({ queryChunkVectors: [v], candidates, chunkMatrix: shard, noteOffsets, limit: 2 });
  assert.deepEqual(results.map((r) => r.path), ["Alpha.md", "Mid.md"]);
});

void test("refineWithChunks rejects an out-of-bounds noteOffset rather than reading past the matrix", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[1, 0]]);
  const noteOffsets = [offsetFor("A.md", 0, 5)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects an empty queryChunkVectors array and a dimension mismatch", () => {
  const shard = chunkMatrix(2, [[1, 0]]);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(() => refineWithChunks({ queryChunkVectors: [], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }), CosineIndexError);
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [vec(1, 0, 0)], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("rankNotes rejects a duplicate runtime id", () => {
  const v = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...v], [...v]]);
  const ids = [canonicalizePath("A.md"), canonicalizePath("A.md")];
  assert.throws(() => rankNotes({ queryVector: v, matrix, ids, limit: 10 }), CosineIndexError);
});

void test("rankNotes rejects a noncanonical runtime id", () => {
  const v = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...v]]);
  const ids = ["./A.md" as unknown as ReturnType<typeof canonicalizePath>];
  assert.throws(() => rankNotes({ queryVector: v, matrix, ids, limit: 10 }), CosineIndexError);
});

void test("rankNotes rejects a non-normalized or non-finite queryVector", () => {
  const matrix = noteMatrix(2, [[...normalizeVector(vec(1, 0))]]);
  const ids = [canonicalizePath("A.md")];
  assert.throws(() => rankNotes({ queryVector: vec(1, 1), matrix, ids, limit: 10 }), CosineIndexError);
  assert.throws(() => rankNotes({ queryVector: vec(Number.NaN, 0), matrix, ids, limit: 10 }), CosineIndexError);
});

void test("rankNotes rejects a matrix whose data length does not match count * dimension, even when constructed directly", () => {
  const matrix: VectorMatrix = { kind: "note", dimension: 2, count: 2, data: Float32Array.from([1, 0]) };
  const ids = [canonicalizePath("A.md"), canonicalizePath("B.md")];
  assert.throws(() => rankNotes({ queryVector: normalizeVector(vec(1, 0)), matrix, ids, limit: 10 }), CosineIndexError);
});

void test("refineWithChunks rejects a duplicate candidate path", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  const candidates = [
    { path: canonicalizePath("A.md"), score: 0.5 },
    { path: canonicalizePath("A.md"), score: 0.4 },
  ];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a non-finite candidate score", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  const candidates = [{ path: canonicalizePath("A.md"), score: Number.NaN }];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a duplicate noteOffsets identity", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))], [...normalizeVector(vec(0, 1))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1), offsetFor("A.md", 1, 1)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a zero-length or negative-start noteOffset", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: shard,
        noteOffsets: [offsetFor("A.md", 0, 0)],
        limit: 10,
      }),
    CosineIndexError,
  );
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: shard,
        noteOffsets: [offsetFor("A.md", -1, 1)],
        limit: 10,
      }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects overlapping noteOffset ranges", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [
    [...normalizeVector(vec(1, 0))],
    [...normalizeVector(vec(0, 1))],
    [...normalizeVector(vec(1, 1))],
  ]);
  const noteOffsets = [offsetFor("A.md", 0, 2), offsetFor("B.md", 1, 2)];
  const candidates = [
    { path: canonicalizePath("A.md"), score: 0.5 },
    { path: canonicalizePath("B.md"), score: 0.4 },
  ];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a non-normalized or non-finite queryChunkVector", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [vec(1, 1)], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a chunkMatrix whose data length does not match count * dimension, even when constructed directly", () => {
  const shard: VectorMatrix = { kind: "chunk", dimension: 2, count: 2, data: Float32Array.from([1, 0]) };
  const noteOffsets = [offsetFor("A.md", 0, 2)];
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () => refineWithChunks({ queryChunkVectors: [normalizeVector(vec(1, 0))], candidates, chunkMatrix: shard, noteOffsets, limit: 10 }),
    CosineIndexError,
  );
});

void test("rankNotes wraps a canonicalizePath throw (e.g. a control character in an id) as CosineIndexError, not the underlying EngineError", () => {
  const v = normalizeVector(vec(1, 0));
  const matrix = noteMatrix(2, [[...v]]);
  const controlChar = String.fromCharCode(1);
  const ids = [`A${controlChar}.md` as unknown as ReturnType<typeof canonicalizePath>];
  assert.throws(() => rankNotes({ queryVector: v, matrix, ids, limit: 10 }), CosineIndexError);
});

void test("rankNotes rejects a matrix with a fractional or negative dimension/count, before any multiplication", () => {
  const v = normalizeVector(vec(1, 0));
  const ids = [canonicalizePath("A.md")];
  assert.throws(
    () => rankNotes({ queryVector: v, matrix: { kind: "note", dimension: 1.5, count: 1, data: vec(1, 0) }, ids, limit: 10 }),
    CosineIndexError,
  );
  assert.throws(
    () => rankNotes({ queryVector: v, matrix: { kind: "note", dimension: 2, count: -1, data: vec(1, 0) }, ids: [], limit: 10 }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a fractional noteOffset start/length", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))], [...normalizeVector(vec(0, 1))]]);
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: shard,
        noteOffsets: [offsetFor("A.md", 0.5, 1)],
        limit: 10,
      }),
    CosineIndexError,
  );
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: shard,
        noteOffsets: [offsetFor("A.md", 0, 1.5)],
        limit: 10,
      }),
    CosineIndexError,
  );
});

void test("refineWithChunks wraps a canonicalizePath throw for a candidate path or an offset identity as CosineIndexError", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))]]);
  const controlChar = String.fromCharCode(1);
  const noteOffsets = [offsetFor("A.md", 0, 1)];
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates: [{ path: `A${controlChar}.md` as unknown as ReturnType<typeof canonicalizePath>, score: 0.5 }],
        chunkMatrix: shard,
        noteOffsets,
        limit: 10,
      }),
    CosineIndexError,
  );
});

void test("refineWithChunks rejects a chunkMatrix with a fractional or negative dimension/count, before any multiplication", () => {
  const candidates = [{ path: canonicalizePath("A.md"), score: 0.5 }];
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: { kind: "chunk", dimension: 1.5, count: 1, data: vec(1, 0) },
        noteOffsets: [offsetFor("A.md", 0, 1)],
        limit: 10,
      }),
    CosineIndexError,
  );
  assert.throws(
    () =>
      refineWithChunks({
        queryChunkVectors: [normalizeVector(vec(1, 0))],
        candidates,
        chunkMatrix: { kind: "chunk", dimension: 2, count: -1, data: vec(1, 0) },
        noteOffsets: [],
        limit: 10,
      }),
    CosineIndexError,
  );
});

void test("refineWithChunks produces identical output across repeated calls (deterministic)", () => {
  const dim = 2;
  const shard = chunkMatrix(dim, [[...normalizeVector(vec(1, 0))], [...normalizeVector(vec(0, 1))]]);
  const noteOffsets = [offsetFor("A.md", 0, 1), offsetFor("B.md", 1, 1)];
  const candidates = [
    { path: canonicalizePath("A.md"), score: 0.5 },
    { path: canonicalizePath("B.md"), score: 0.4 },
  ];
  const query = [normalizeVector(vec(1, 0))];
  const first = refineWithChunks({ queryChunkVectors: query, candidates, chunkMatrix: shard, noteOffsets, limit: 10 });
  const second = refineWithChunks({ queryChunkVectors: query, candidates, chunkMatrix: shard, noteOffsets, limit: 10 });
  assert.deepEqual(first, second);
});
