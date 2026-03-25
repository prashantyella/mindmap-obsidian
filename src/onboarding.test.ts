import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { isScopeSetupComplete, listVaultFolderOptions, readScopeSelection, updateScopeSelection } from "./onboarding";

void test("config template uses neutral empty scope defaults", () => {
  const template = JSON.parse(fs.readFileSync(path.join(process.cwd(), "python", "config.template.json"), "utf8")) as Record<string, unknown>;

  assert.equal(template.vault_root, "../../../../");
  assert.deepEqual(template.notes_paths, []);
  assert.deepEqual(template.notes_paths_current, []);
  assert.deepEqual(template.notes_paths_all, []);
});

void test("updateScopeSelection preserves unrelated config keys and writes valid JSON", () => {
  const rawConfig = JSON.stringify({
    vault_root: "../..",
    embed_model: "mxbai-embed-large",
    notes_paths: [],
    notes_paths_current: [],
    notes_paths_all: [],
    custom_flag: true,
  });

  const updated = updateScopeSelection(rawConfig, {
    currentPaths: ["Projects", "Journal"],
    allPaths: [".", "Projects"],
  });
  const parsed = JSON.parse(updated) as Record<string, unknown>;

  assert.deepEqual(parsed.notes_paths, ["Journal", "Projects"]);
  assert.deepEqual(parsed.notes_paths_current, ["Journal", "Projects"]);
  assert.deepEqual(parsed.notes_paths_all, [".", "Projects"]);
  assert.equal(parsed.custom_flag, true);
});

void test("readScopeSelection and completion reflect configured folders", () => {
  const selection = readScopeSelection(JSON.stringify({
    notes_paths_current: ["Projects"],
    notes_paths_all: [".", "Projects"],
  }));

  assert.deepEqual(selection.currentPaths, ["Projects"]);
  assert.deepEqual(selection.allPaths, [".", "Projects"]);
  assert.equal(isScopeSetupComplete(selection), true);
});

void test("listVaultFolderOptions filters plugin internals and includes vault root", () => {
  const options = listVaultFolderOptions(["Projects", "config", "config/plugins", "Areas/Work"], "config");

  assert.deepEqual(options, [
    { value: ".", label: "Vault root" },
    { value: "Areas/Work", label: "Areas/Work" },
    { value: "Projects", label: "Projects" },
  ]);
});
