import test from "node:test";
import assert from "node:assert/strict";

import { prepareActiveNoteResearchInput } from "./researchInput";

test("strips frontmatter and prior research while retaining Apple source content within bounds", () => {
  const input = "---\nannotation_id: private\nsecret: no\n---\n<!-- mindmap:apple-books-source:start -->\nUseful quote\n<!-- mindmap:apple-books-source:end -->\n<!-- mindmap:research:start -->\nold research\n<!-- mindmap:research:end -->\nUser body";
  const output = prepareActiveNoteResearchInput(input, 20);
  assert.match(output, /Useful quote/);
  assert.doesNotMatch(output, /annotation_id|secret|old research|mindmap:/);
  assert.ok(output.length <= 20);
});
