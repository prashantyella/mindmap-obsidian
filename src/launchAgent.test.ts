import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyCalendarIntervals,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  buildLaunchAgentSpec,
  buildWeeklyCalendarInterval,
  formatClockTime,
  normalizeHour,
  normalizeMinute,
} from "./launchAgent";

void test("normalizes launch agent clock values", () => {
  assert.equal(normalizeHour(99), 23);
  assert.equal(normalizeHour(-1), 0);
  assert.equal(normalizeMinute(99), 59);
  assert.equal(normalizeMinute(-1), 0);
  assert.equal(formatClockTime({ hour: 2, minute: 5 }), "02:05");
});

void test("builds Mon-Sat daily calendar intervals", () => {
  const intervals = buildDailyCalendarIntervals({ hour: 2, minute: 30 });

  assert.deepEqual(intervals.map((interval) => interval.weekday), [1, 2, 3, 4, 5, 6]);
  assert.equal(intervals[0].hour, 2);
  assert.equal(intervals[0].minute, 30);
});

void test("builds Sunday weekly calendar interval", () => {
  assert.deepEqual(buildWeeklyCalendarInterval({ hour: 3, minute: 0 }), {
    weekday: 7,
    hour: 3,
    minute: 0,
  });
});

void test("uses env launcher for bare python commands", () => {
  const args = buildLaunchAgentProgramArguments(
    {
      command: "python3",
      args: ["/vault/.obsidian/plugins/mindmap-ai/python/mindmap.py", "--config", "/vault/.obsidian/plugins/mindmap-ai/python/config.json"],
      cwd: "/vault/.obsidian/plugins/mindmap-ai/python",
    },
    ["--all", "--apply"],
  );

  assert.deepEqual(args.slice(0, 2), ["/usr/bin/env", "python3"]);
  assert.deepEqual(args.slice(-2), ["--all", "--apply"]);
});

void test("renders launch agent plist with plugin runtime source", () => {
  const spec = buildLaunchAgentSpec({
    label: "com.mindmap.daily",
    plistPath: "/Users/me/Library/LaunchAgents/com.mindmap.daily.plist",
    command: {
      command: "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
      args: ["/vault/.obsidian/plugins/mindmap-ai/python/mindmap.py", "--config", "/vault/.obsidian/plugins/mindmap-ai/python/config.json"],
      cwd: "/vault/.obsidian/plugins/mindmap-ai/python",
    },
    extraArgs: ["--all", "--apply"],
    stdoutPath: "/vault/.obsidian/plugins/mindmap-ai/python/_logs/launchagent.out",
    stderrPath: "/vault/.obsidian/plugins/mindmap-ai/python/_logs/launchagent.err",
    startCalendarInterval: buildDailyCalendarIntervals({ hour: 2, minute: 30 }),
    pathEnvironment: "/usr/bin:/bin",
  });

  const plist = buildLaunchAgentPlist(spec);

  assert.match(plist, /<string>com\.mindmap\.daily<\/string>/);
  assert.match(plist, /<string>obsidian-plugin-launchagent<\/string>/);
  assert.match(plist, /<string>--all<\/string>/);
  assert.match(plist, /<string>--apply<\/string>/);
  assert.match(plist, /<integer>6<\/integer>/);
});
