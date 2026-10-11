import type { ScopeSelection } from "./onboarding";
import type { MindmapSettings } from "./settings";
import { cloneSettings } from "./settingsEffects";

export type SettingsSection = "localAi" | "folders" | "automation" | "integrations" | "advanced";

export interface LocalAiDraft {
  embedBaseUrl: string;
  embedModel: string;
  embedDimension: number;
  llmBaseUrl: string;
  llmModel: string;
  llmMaxTokens: number;
}

export interface ScopeEditorState {
  draft: ScopeSelection;
  query: string;
  expanded: Set<string>;
  separateQuickRun: boolean;
  dirty: boolean;
}

function localAiDraft(settings: MindmapSettings): LocalAiDraft {
  return {
    embedBaseUrl: settings.embedBaseUrl,
    embedModel: settings.embedModel,
    embedDimension: settings.embedDimension,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    llmMaxTokens: settings.llmMaxTokens,
  };
}

export class SettingsViewState {
  readonly disclosures: Record<SettingsSection, boolean>;
  providerDraft: LocalAiDraft;
  providerDirty = false;
  providerRevision = 0;
  providerStatus: "idle" | "saving" | "saved" | "error" = "idle";
  providerMessage = "";
  readonly scope: ScopeEditorState;

  constructor(settings: MindmapSettings, setupReady: boolean) {
    this.disclosures = {
      localAi: !settings.embedBaseUrl.trim() || !settings.embedModel.trim() || !settings.llmBaseUrl.trim() || !settings.llmModel.trim(),
      folders: !setupReady,
      automation: false,
      integrations: false,
      advanced: false,
    };
    this.providerDraft = localAiDraft(settings);
    this.scope = {
      draft: { currentPaths: [...settings.scopeCurrentPaths], allPaths: [...settings.scopeAllPaths] },
      query: "",
      expanded: new Set<string>(),
      separateQuickRun: !samePaths(settings.scopeCurrentPaths, settings.scopeAllPaths),
      dirty: false,
    };
  }

  syncSavedSettings(settings: MindmapSettings): void {
    if (!this.providerDirty) this.providerDraft = localAiDraft(settings);
    if (!this.scope.dirty) {
      this.scope.draft = { currentPaths: [...settings.scopeCurrentPaths], allPaths: [...settings.scopeAllPaths] };
      this.scope.separateQuickRun = !samePaths(settings.scopeCurrentPaths, settings.scopeAllPaths);
    }
  }

  snapshotProviderSettings(settings: MindmapSettings): MindmapSettings {
    return {
      ...cloneSettings(settings),
      ...this.providerDraft,
    };
  }

  markProviderChanged(): void {
    this.providerDirty = true;
    this.providerRevision += 1;
    this.providerStatus = "idle";
    this.providerMessage = "Draft not applied.";
  }
}

export async function applyProviderDraft(
  state: SettingsViewState,
  save: (draft: LocalAiDraft) => Promise<void>,
): Promise<boolean> {
  const revision = state.providerRevision;
  const draft = { ...state.providerDraft };
  state.providerStatus = "saving";
  state.providerMessage = "Applying local AI settings…";
  try {
    await save(draft);
    if (state.providerRevision === revision) {
      state.providerDirty = false;
      state.providerStatus = "saved";
      state.providerMessage = "Local AI settings applied.";
    } else {
      state.providerDirty = true;
      state.providerStatus = "idle";
      state.providerMessage = "Earlier changes applied. Your newer draft still needs Apply.";
    }
    return true;
  } catch (error) {
    state.providerDirty = true;
    state.providerStatus = "error";
    state.providerMessage = error instanceof Error ? error.message : "Local AI settings could not be activated. Review the values and try again.";
    return false;
  }
}

export function updateProviderApplyUi(state: SettingsViewState, button: { disabled: boolean; textContent: string | null }, status: { textContent: string | null }): void {
  button.disabled = state.providerStatus === "saving" || !state.providerDirty;
  button.textContent = state.providerStatus === "saving" ? "Applying…" : "Apply";
  status.textContent = state.providerMessage || "Changes stay as a draft until applied.";
}

export function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
