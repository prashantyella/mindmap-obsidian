import test from "node:test";
import assert from "node:assert/strict";

import { MAX_EMBEDDING_DIMENSION } from "../engine/embeddingLimits";
import { MAX_DIMENSION } from "./vectorCodec";

/**
 * `src/engine/embeddingLimits.ts`'s `MAX_EMBEDDING_DIMENSION` is a
 * deliberately duplicated mirror of this module's own `MAX_DIMENSION`
 * (engine inference modules must never import the index/persistence
 * layer -- see `checkpoint6Isolation.test.ts`). This cross-check lives here
 * rather than in `src/engine` because `src/index` already depends on
 * `src/engine` elsewhere; the reverse import would violate that layering.
 */
void test("MAX_EMBEDDING_DIMENSION (engine) and MAX_DIMENSION (index) stay numerically equal", () => {
  assert.equal(MAX_EMBEDDING_DIMENSION, MAX_DIMENSION);
});
