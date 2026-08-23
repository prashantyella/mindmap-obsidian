/**
 * Mirrors `MAX_DIMENSION` in `src/index/vectorCodec.ts` (the vector-index
 * persistence layer's own bound on stored embedding dimension).
 * Deliberately duplicated, never imported: engine inference modules must
 * never import the index/persistence layer (`checkpoint6Isolation.test.ts`
 * audits this). Keep the two constants numerically equal --
 * `src/index/embeddingLimitsParity.test.ts` cross-checks them (that
 * direction is safe: `src/index` already depends on `src/engine`
 * elsewhere, never the reverse).
 */
export const MAX_EMBEDDING_DIMENSION = 8192;
