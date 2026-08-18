import test from "node:test";
import assert from "node:assert/strict";

import { isSafeManualResearchPath } from "./manualResearchGuard";

test("manual research path guard allows vault-relative notes without imposing scope and blocks internals", () => {
  assert.equal(isSafeManualResearchPath("Elsewhere/-draft.md"), true);
  assert.equal(isSafeManualResearchPath(".obsidian/plugins/mindmap-ai/data.md"), false);
  assert.equal(isSafeManualResearchPath("../outside.md"), false);
  assert.equal(isSafeManualResearchPath("/absolute.md"), false);
});
