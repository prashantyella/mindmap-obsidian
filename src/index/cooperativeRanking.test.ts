import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizePath } from "../engine/contracts";
import { compareScored } from "./cosineIndex";
import { rankCompositeCooperatively } from "./cooperativeRanking";
import type { ScoredNote } from "./vectorTypes";

void test("cooperative ranking exactly matches synchronous sorting and yields between blocks", async () => {
  const items: ScoredNote[] = Array.from({ length: 100 }, (_, index) => ({
    path: canonicalizePath(`N-${String(index).padStart(3, "0")}.md`),
    score: (index * 17) % 11,
  }));
  let clock = 0;
  let yields = 0;
  const actual = await rankCompositeCooperatively(items.length, (index) => {
    clock += 1;
    return items[index];
  }, 13, { blockSize: 5, yieldAfterMs: 8, now: () => clock, yieldToEventLoop: async () => { yields += 1; } });
  assert.deepEqual(actual, [...items].sort(compareScored).slice(0, 13));
  assert.ok(yields > 0);
});

void test("cooperative ranking handles exclusions represented by null", async () => {
  const result = await rankCompositeCooperatively(5, (index) => index % 2 === 0 ? null : { path: canonicalizePath(`${index}.md`), score: index }, 5);
  assert.deepEqual(result.map((item) => item.path), [canonicalizePath("3.md"), canonicalizePath("1.md")]);
});
