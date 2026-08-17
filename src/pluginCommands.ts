import type MindmapPlugin from "./main";

export function registerMindmapCommands(plugin: MindmapPlugin): void {
  plugin.addCommand({
    id: "mindmap-open-view",
    name: "Open Mindmap",
    callback: () => {
      void plugin.openMindmapView();
    },
  });

  plugin.addCommand({
    id: "mindmap-open-lookup",
    name: "Open Mindmap lookup",
    callback: () => {
      void plugin.openMindmapLookup();
    },
  });

  plugin.addCommand({
    id: "mindmap-run-now",
    name: "Run mindmap (current scope)",
    callback: () => {
      void plugin.runMindmap("manual", "current");
    },
  });

  plugin.addCommand({
    id: "mindmap-run-active-note",
    name: "Run Mindmap for active note",
    callback: () => {
      void plugin.runActiveNote();
    },
  });

  plugin.addCommand({
    id: "mindmap-run-all",
    name: "Run mindmap (all scopes)",
    callback: () => {
      void plugin.runMindmap("manual", "all");
    },
  });

  plugin.addCommand({
    id: "mindmap-refresh-all",
    name: "Run mindmap full refresh (all notes)",
    callback: () => {
      void plugin.runMindmap("manual", "refreshAll");
    },
  });

  plugin.addCommand({
    id: "mindmap-refresh-metadata-all",
    name: "Run mindmap metadata refresh (all notes)",
    callback: () => {
      void plugin.runMindmap("manual", "metadataAll");
    },
  });

  plugin.addCommand({
    id: "mindmap-rebuild-all",
    name: "Run mindmap full rebuild (all notes)",
    callback: () => {
      void plugin.runMindmap("manual", "rebuildAll");
    },
  });

  plugin.addCommand({
    id: "mindmap-enable-scheduler",
    name: "Enable mindmap interval scheduler",
    callback: () => {
      void plugin.setSchedulerMode("interval");
    },
  });

  plugin.addCommand({
    id: "mindmap-enable-launchagent-scheduler",
    name: "Enable mindmap LaunchAgent scheduler",
    callback: () => {
      void plugin.setSchedulerMode("launchAgent");
    },
  });

  plugin.addCommand({
    id: "mindmap-disable-scheduler",
    name: "Disable mindmap schedulers",
    callback: () => {
      void plugin.setSchedulerMode("manual");
    },
  });

  plugin.addCommand({
    id: "mindmap-open-status",
    name: "Show mindmap status",
    callback: () => {
      plugin.showStatusSummary();
    },
  });

  plugin.addCommand({
    id: "mindmap-validate-runtime",
    name: "Run mindmap preflight checks",
    callback: () => {
      void plugin.runPreflight("manual");
    },
  });

  plugin.addCommand({
    id: "mindmap-start-semantic-environment",
    name: "Start Mindmap semantic environment",
    callback: () => {
      void plugin.startSemanticEnvironment(true);
    },
  });
}
