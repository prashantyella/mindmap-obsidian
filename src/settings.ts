export interface MindmapSettings {
  pythonCommand: string;
  scriptPath: string;
  configPath: string;
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  pythonCommand: "python3",
  scriptPath: "",
  configPath: "",
};

export type RuntimeField = keyof MindmapSettings;
