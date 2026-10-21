import test from "node:test";
import assert from "node:assert/strict";
import { extendWithLargeSample, LARGE_SAMPLE_FAMILIES } from "../../scripts/fixtures/large-embedding-sample";
import type { ConnectionQualityFixture } from "./connectionQuality";

void test("large sample contains forty distinct labelled families without self references or duplicate short texts", () => {
  const fixture: ConnectionQualityFixture = { notes: [], queries: [] };
  const lookups = extendWithLargeSample(fixture);
  assert.equal(LARGE_SAMPLE_FAMILIES.length, 40);
  assert.equal(fixture.notes.length, 240);
  assert.equal(fixture.queries.length, 160);
  assert.equal(lookups.length, 40);
  const paths = new Set(fixture.notes.map((note) => note.path));
  assert.equal(paths.size, 240);
  assert.equal(new Set(fixture.notes.filter((n) => !/Long reflection/.test(n.path)).map((n) => n.text)).size, 200);
  for (const query of fixture.queries) {
    assert.equal(query.relevant.length, 3);
    assert.ok(!query.relevant.includes(query.path));
    assert.ok(query.relevant.every((p) => paths.has(p)));
  }
  for (const lookup of lookups) assert.ok(lookup.relevant.length === 4 && lookup.relevant.every((p) => paths.has(p)));
});
