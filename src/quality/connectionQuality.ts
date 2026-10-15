import { canonicalizePath, stableNoteIdentity } from "../engine/contracts";
import { selectRelatedCandidates, type RelatedSelectionOptions } from "../engine/relatedSelector";
import { rankNotes, refineWithChunks } from "../index/cosineIndex";
import type { VectorMatrix } from "../index/vectorCodec";
import type { ChunkShardNoteOffset } from "../index/vectorTypes";

export interface QualityNote {
  path: string;
  theme: string;
  text: string;
  /** Models notes that production discovery would not place in the index. */
  excluded?: boolean;
}

export interface QualityQuery {
  path: string;
  relevant: string[];
}

export interface ConnectionQualityFixture {
  notes: QualityNote[];
  queries: QualityQuery[];
}

export interface QualityEmbedding {
  noteVector: Float32Array;
  chunkVectors: Float32Array[];
}

export interface QueryQualityResult {
  path: string;
  returned: string[];
  coreReturned: string[];
  diversityReturned: string[];
  relevantReturned: string[];
  precisionAtK: number;
  expectedCoverage: number;
  labeledCorePrecision: number;
  recallAtK: number;
  reciprocalRank: number;
  selfHit: boolean;
}

export interface ConnectionQualityResult {
  queryCount: number;
  k: number;
  precisionAtK: number;
  expectedCoverage: number;
  labeledCorePrecision: number;
  recallAtK: number;
  meanReciprocalRank: number;
  selfHits: number;
  queries: QueryQualityResult[];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function matrix(kind: "note" | "chunk", dimension: number, rows: readonly Float32Array[]): VectorMatrix {
  const data = new Float32Array(rows.length * dimension);
  rows.forEach((row, index) => data.set(row, index * dimension));
  return { kind, dimension, count: rows.length, data };
}

/**
 * Evaluates the same two-tier exact retrieval and final related-selection
 * functions used by ProductionEngine. Embeddings are deliberately injected:
 * deterministic unit vectors keep default tests offline, while the opt-in
 * runner supplies real local-Ollama vectors for semantic evaluation.
 */
export function evaluateConnectionQuality(
  fixture: ConnectionQualityFixture,
  embeddings: ReadonlyMap<string, QualityEmbedding>,
  options: Omit<RelatedSelectionOptions, "selfPath"> & { candidateLimit: number },
): ConnectionQualityResult {
  const paths = fixture.notes.filter((note) => !note.excluded).map((note) => canonicalizePath(note.path));
  if (new Set(paths).size !== paths.length) throw new Error("quality fixture contains duplicate note paths");
  const first = embeddings.get(paths[0]);
  if (!first) throw new Error(`missing embedding for ${paths[0]}`);
  const dimension = first.noteVector.length;
  const noteRows = paths.map((path) => {
    const embedding = embeddings.get(path);
    if (!embedding) throw new Error(`missing embedding for ${path}`);
    if (embedding.noteVector.length !== dimension) throw new Error(`embedding dimension mismatch for ${path}`);
    return embedding.noteVector;
  });
  const chunkRows: Float32Array[] = [];
  const offsets: ChunkShardNoteOffset[] = [];
  for (const path of paths) {
    const chunks = embeddings.get(path)?.chunkVectors ?? [];
    if (chunks.length === 0) continue;
    const start = chunkRows.length;
    for (const chunk of chunks) {
      if (chunk.length !== dimension) throw new Error(`chunk embedding dimension mismatch for ${path}`);
      chunkRows.push(chunk);
    }
    offsets.push({ identity: stableNoteIdentity(path), start, length: chunks.length });
  }
  const noteMatrix = matrix("note", dimension, noteRows);
  const chunkMatrix = matrix("chunk", dimension, chunkRows);

  const queryResults = fixture.queries.map((query): QueryQualityResult => {
    const selfPath = canonicalizePath(query.path);
    const embedding = embeddings.get(selfPath);
    if (!embedding) throw new Error(`missing query embedding for ${selfPath}`);
    let ranked = rankNotes({ queryVector: embedding.noteVector, matrix: noteMatrix, ids: paths, excludePath: selfPath, limit: options.candidateLimit });
    if (embedding.chunkVectors.length > 0 && chunkRows.length > 0) {
      ranked = refineWithChunks({ queryChunkVectors: embedding.chunkVectors, candidates: ranked, chunkMatrix, noteOffsets: offsets, limit: options.candidateLimit });
    }
    const selected = selectRelatedCandidates(ranked, { ...options, selfPath });
    const returned = selected.map((item) => item.path as string);
    const coreReturned = selected.filter((item) => item.kind === "core").map((item) => item.path as string);
    const diversityReturned = selected.filter((item) => item.kind !== "core").map((item) => item.path as string);
    const relevant = new Set(query.relevant);
    const relevantReturned = returned.filter((path) => relevant.has(path));
    const relevantCore = coreReturned.filter((path) => relevant.has(path));
    const firstRelevant = returned.findIndex((path) => relevant.has(path));
    return {
      path: selfPath,
      returned,
      coreReturned,
      diversityReturned,
      relevantReturned,
      precisionAtK: relevantReturned.length / options.relatedLimit,
      expectedCoverage: relevantReturned.length / Math.min(options.relatedLimit, relevant.size),
      labeledCorePrecision: coreReturned.length === 0 ? 1 : relevantCore.length / coreReturned.length,
      recallAtK: relevant.size === 0 ? 1 : relevantReturned.length / relevant.size,
      reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1),
      selfHit: returned.includes(selfPath),
    };
  });

  return {
    queryCount: queryResults.length,
    k: options.relatedLimit,
    precisionAtK: mean(queryResults.map((result) => result.precisionAtK)),
    expectedCoverage: mean(queryResults.map((result) => result.expectedCoverage)),
    labeledCorePrecision: mean(queryResults.map((result) => result.labeledCorePrecision)),
    recallAtK: mean(queryResults.map((result) => result.recallAtK)),
    meanReciprocalRank: mean(queryResults.map((result) => result.reciprocalRank)),
    selfHits: queryResults.filter((result) => result.selfHit).length,
    queries: queryResults,
  };
}
