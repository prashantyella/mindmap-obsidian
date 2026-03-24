export type SchedulerMode = "manual" | "interval";

export interface MindmapSettings {
  pythonCommand: string;
  scriptPath: string;
  configPath: string;
  schedulerMode: SchedulerMode;
  schedulerIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  pythonCommand: "python3",
  scriptPath: "",
  configPath: "",
  schedulerMode: "manual",
  schedulerIntervalMinutes: 60,
};

export type RuntimeField = "pythonCommand" | "scriptPath" | "configPath";
