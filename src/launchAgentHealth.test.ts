import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  aggregateLaunchAgentHealth,
  buildPluginLaunchAgentSpecs,
  getSuccessfulRunAt,
  type LaunchAgentObservation,
} from "./launchAgentHealth";

void test("only treats a log mtime as a successful heartbeat after exit 0", () => {
  assert.equal(getSuccessfulRunAt(0, 1234), 1234);
  assert.equal(getSuccessfulRunAt(1, 1234), null);
  assert.equal(getSuccessfulRunAt(null, 1234), null);
  assert.equal(getSuccessfulRunAt(0, null), null);
});

void test("plugin-managed agents use protected-independent working and log paths", () => {
  const command = {
    command: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    args: ["/vault/.obsidian/plugins/mindmap-ai/python/mindmap.py", "--config", "/vault/.obsidian/plugins/mindmap-ai/python/config.json"],
    cwd: "/vault/.obsidian/plugins/mindmap-ai/python",
  };
  const homeDirectory = "/Users/me";
  const specs = buildPluginLaunchAgentSpecs({
    command,
    homeDirectory,
    plistDirectory: path.join(homeDirectory, "Library", "LaunchAgents"),
    pathEnvironment: "/usr/bin:/bin",
    settings: {
      launchAgentDailyHour: 2,
      launchAgentDailyMinute: 30,
      launchAgentWeeklyEnabled: true,
      launchAgentWeeklyHour: 3,
      launchAgentWeeklyMinute: 0,
    },
  });

  assert.equal(specs.length, 2);
  for (const spec of specs) {
    assert.equal(spec.workingDirectory, path.join(homeDirectory, "Library", "Application Support", "Mindmap"));
    assert.notEqual(spec.workingDirectory, command.cwd);
    assert.equal(path.dirname(spec.stdoutPath), path.join(homeDirectory, "Library", "Logs", "Mindmap"));
    assert.equal(path.dirname(spec.stderrPath), path.join(homeDirectory, "Library", "Logs", "Mindmap"));
    assert.notEqual(spec.stdoutPath, path.join(command.cwd, "_logs", "launchagent.out"));
    assert.notEqual(spec.stderrPath, path.join(command.cwd, "_logs", "launchagent.err"));
  }
  assert.notEqual(specs[0].stdoutPath, specs[1].stdoutPath);
  assert.notEqual(specs[0].stderrPath, specs[1].stderrPath);
});

void test("aggregates agent health and keeps the latest successful heartbeat", () => {
  const observations: LaunchAgentObservation[] = [
    {
      label: "com.mindmap.daily",
      launchctl: { loaded: true, state: "exited", lastExitCode: 0 },
      health: "healthy",
      lastSuccessfulRunAt: 100,
    },
    {
      label: "com.mindmap.weekly",
      launchctl: { loaded: false, state: null, lastExitCode: 78 },
      health: "failing",
      lastSuccessfulRunAt: null,
    },
  ];

  const summary = aggregateLaunchAgentHealth(observations);
  assert.equal(summary.health, "failing");
  assert.equal(summary.lastSuccessfulRunAt, 100);
  assert.equal(summary.lastExitCode, 78);
  assert.match(summary.message, /com\.mindmap\.weekly: failing, not loaded, exit 78/);
});
