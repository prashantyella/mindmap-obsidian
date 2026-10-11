import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SETTINGS } from "./settings";
import { cloneSettings } from "./settingsEffects";
import { applyProviderDraft, CommittedValue, SettingsViewState, updateProviderApplyUi } from "./settingsViewState";

void test("required sections expand and disclosure state survives saved-setting sync", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.scopeAllPaths = [];
  settings.scopeCurrentPaths = [];
  const state = new SettingsViewState(settings, false);
  assert.equal(state.disclosures.folders, true);
  state.disclosures.automation = true;
  state.syncSavedSettings(settings);
  assert.equal(state.disclosures.automation, true);
});

void test("provider and scope drafts survive unrelated setting updates", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.scopeCurrentPaths = ["Notes"];
  settings.scopeAllPaths = ["Notes"];
  const state = new SettingsViewState(settings, true);
  state.providerDraft.embedModel = "custom-model";
  state.providerDirty = true;
  state.scope.draft.currentPaths = ["Drafts"];
  state.scope.dirty = true;
  state.scope.query = "dra";
  const updated = cloneSettings(settings);
  updated.liveSemanticLookupEnabled = false;
  state.syncSavedSettings(updated);
  assert.equal(state.providerDraft.embedModel, "custom-model");
  assert.deepEqual(state.scope.draft.currentPaths, ["Drafts"]);
  assert.equal(state.scope.query, "dra");
});

void test("distinct saved scopes and provider addresses remain distinct", () => {
  const settings = cloneSettings(DEFAULT_SETTINGS);
  settings.scopeCurrentPaths = ["Inbox"];
  settings.scopeAllPaths = ["Archive"];
  settings.embedBaseUrl = "http://embed";
  settings.llmBaseUrl = "http://metadata";
  const state = new SettingsViewState(settings, true);
  assert.equal(state.scope.separateQuickRun, true);
  assert.deepEqual(state.scope.draft, { currentPaths: ["Inbox"], allPaths: ["Archive"] });
  assert.equal(state.providerDraft.embedBaseUrl, "http://embed");
  assert.equal(state.providerDraft.llmBaseUrl, "http://metadata");
});

void test("mounted Apply UI enables on edit and a failed awaited save retains the draft", async () => {
  const state = new SettingsViewState(cloneSettings(DEFAULT_SETTINGS), true);
  const button = { disabled: true, textContent: "Apply" as string | null };
  const status = { textContent: "" as string | null };
  state.providerDraft.embedModel = "draft-model";
  state.markProviderChanged();
  updateProviderApplyUi(state, button, status);
  assert.equal(button.disabled, false);
  const applied = await applyProviderDraft(state, async () => { throw new Error("Activation failed. Try another model."); });
  updateProviderApplyUi(state, button, status);
  assert.equal(applied, false);
  assert.equal(state.providerDirty, true);
  assert.equal(state.providerDraft.embedModel, "draft-model");
  assert.equal(button.disabled, false);
  assert.match(status.textContent ?? "", /Activation failed/);
});

void test("edits arriving during Apply are not discarded by the older completion", async () => {
  const state = new SettingsViewState(cloneSettings(DEFAULT_SETTINGS), true);
  state.providerDraft.embedModel = "first";
  state.markProviderChanged();
  let finish!: () => void;
  const applying = applyProviderDraft(state, async () => await new Promise<void>((resolve) => { finish = resolve; }));
  state.providerDraft.embedModel = "second";
  state.markProviderChanged();
  finish();
  await applying;
  assert.equal(state.providerDirty, true);
  assert.equal(state.providerDraft.embedModel, "second");
  assert.match(state.providerMessage, /newer draft/);
});

void test("field rollback uses the latest successful commit after a later save fails", () => {
  const committed = new CommittedValue("rendered");
  committed.set("first save");
  assert.equal(committed.get(), "first save");
});
