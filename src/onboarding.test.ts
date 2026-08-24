import test from "node:test";
import assert from "node:assert/strict";

import { isScopeSetupComplete, listVaultFolderOptions, validateScopeSelection } from "./onboarding";

void test("validateScopeSelection normalizes, dedupes, and sorts both scopes", () => {
  const selection = validateScopeSelection({
    currentPaths: ["Projects", "Journal"],
    allPaths: [".", "Projects", "Projects"],
  });

  assert.deepEqual(selection.currentPaths, ["Journal", "Projects"]);
  assert.deepEqual(selection.allPaths, [".", "Projects"]);
  assert.equal(isScopeSetupComplete(selection), true);
});

void test("validateScopeSelection throws when either scope would end up empty", () => {
  assert.throws(() => validateScopeSelection({ currentPaths: [], allPaths: ["Projects"] }));
  assert.throws(() => validateScopeSelection({ currentPaths: ["Projects"], allPaths: [] }));
});

void test("listVaultFolderOptions filters plugin internals and includes vault root", () => {
  const options = listVaultFolderOptions(["Projects", "config", "config/plugins", "Areas/Work"], "config");

  assert.deepEqual(options, [
    { value: ".", label: "Vault root" },
    { value: "Areas/Work", label: "Areas/Work" },
    { value: "Projects", label: "Projects" },
  ]);
});
