export type SchedulerMode = "manual" | "interval" | "launchAgent";

export interface MindmapSettings {
  pythonCommand: string;
  scriptPath: string;
  configPath: string;
  schedulerMode: SchedulerMode;
  schedulerIntervalMinutes: number;
  launchAgentDailyHour: number;
  launchAgentDailyMinute: number;
  launchAgentWeeklyEnabled: boolean;
  launchAgentWeeklyHour: number;
  launchAgentWeeklyMinute: number;
  liveSemanticLookupEnabled: boolean;
  liveSemanticEnsureActiveNoteIndexed: boolean;
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  pythonCommand: "python3",
  scriptPath: "",
  configPath: "",
  schedulerMode: "manual",
  schedulerIntervalMinutes: 60,
  launchAgentDailyHour: 2,
  launchAgentDailyMinute: 30,
  launchAgentWeeklyEnabled: true,
  launchAgentWeeklyHour: 3,
  launchAgentWeeklyMinute: 0,
  liveSemanticLookupEnabled: true,
  liveSemanticEnsureActiveNoteIndexed: true,
};

export type RuntimeField = "pythonCommand" | "scriptPath" | "configPath";
