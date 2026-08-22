import test from "node:test";
import assert from "node:assert/strict";

import { isSafeManualResearchPath } from "./manualResearchGuard";

test("manual research path guard allows vault-relative notes without imposing scope and blocks internals", () => {
  assert.equal(isSafeManualResearchPath("Elsewhere/-draft.md", ".obsidian"), true);
  assert.equal(isSafeManualResearchPath(".obsidian/plugins/mindmap-ai/data.md", ".obsidian"), false);
  assert.equal(isSafeManualResearchPath("../outside.md", ".obsidian"), false);
  assert.equal(isSafeManualResearchPath("/absolute.md", ".obsidian"), false);
});

test("manual research path guard uses the real configDir, not a blanket dot-prefix guess", () => {
  assert.equal(isSafeManualResearchPath("Config/plugins/mindmap-ai/data.md", "Config"), false);
  // A hidden-looking folder unrelated to the actual configDir stays allowed.
  assert.equal(isSafeManualResearchPath(".journal/Note.md", "Config"), true);
});
