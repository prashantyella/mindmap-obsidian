import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizePath } from "../engine/contracts";
import { compareScored } from "./cosineIndex";
import { selectTopK } from "./topK";
import type { ScoredNote } from "./vectorTypes";

void test("selectTopK exactly matches full sort for ties and seeded corpora", () => {
  let state = 0x12345678;
  const items: ScoredNote[] = [];
  for (let index = 0; index < 500; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    items.push({ path: canonicalizePath(`N-${String(index).padStart(4, "0")}.md`), score: (state % 13) / 13 });
  }
  for (const limit of [0, 1, 7, 100, 600]) {
    assert.deepEqual(selectTopK(items, limit), [...items].sort(compareScored).slice(0, limit));
  }
});

void test("selectTopK handles empty iterables and rejects invalid limits", () => {
  assert.deepEqual(selectTopK([], 3), []);
  assert.throws(() => selectTopK([], -1));
  assert.throws(() => selectTopK([], 1.5));
});
