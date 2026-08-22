export type SchedulerMode = "manual" | "interval" | "launchAgent";
export type ReadingModeSetting = "standard" | "reading";
export type WebResearchModeSetting = "off" | "manual" | "automatic-reading";

export interface MindmapSettings {
  pythonCommand: string;
  scriptPath: string;
  configPath: string;
  readingMode: ReadingModeSetting;
  webResearchMode: WebResearchModeSetting;
  schedulerMode: SchedulerMode;
  schedulerIntervalMinutes: number;
  launchAgentDailyHour: number;
  launchAgentDailyMinute: number;
  launchAgentWeeklyEnabled: boolean;
  launchAgentWeeklyHour: number;
  launchAgentWeeklyMinute: number;
  liveSemanticLookupEnabled: boolean;
  liveSemanticEnsureActiveNoteIndexed: boolean;
  pinnedConnections: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: MindmapSettings = {
  pythonCommand: "python3",
  scriptPath: "",
  configPath: "",
  readingMode: "standard",
  webResearchMode: "off",
  schedulerMode: "manual",
  schedulerIntervalMinutes: 60,
  launchAgentDailyHour: 2,
  launchAgentDailyMinute: 30,
  launchAgentWeeklyEnabled: true,
  launchAgentWeeklyHour: 3,
  launchAgentWeeklyMinute: 0,
  liveSemanticLookupEnabled: true,
  liveSemanticEnsureActiveNoteIndexed: true,
  pinnedConnections: {},
};

export type RuntimeField = "pythonCommand" | "scriptPath" | "configPath";
