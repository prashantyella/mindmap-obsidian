import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyCalendarIntervals,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  buildLaunchAgentSpec,
  buildWeeklyCalendarInterval,
  classifyLaunchAgentHealth,
  formatClockTime,
  getMostRecentScheduledOccurrence,
  normalizeHour,
  normalizeMinute,
  parseLaunchctlPrintOutput,
  shouldOfferLaunchAgentCatchUp,
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

void test("parses loaded launchctl state and exit code", () => {
  assert.deepEqual(
    parseLaunchctlPrintOutput("gui/501/com.mindmap.daily = {\n\tstate = exited\n\tlast exit code = 0\n}"),
    { loaded: true, state: "exited", lastExitCode: 0 },
  );
  assert.deepEqual(parseLaunchctlPrintOutput("", "Could not find service"), {
    loaded: false,
    state: null,
    lastExitCode: null,
  });
});

void test("parses launchctl exit codes with descriptive suffixes", () => {
  const status = parseLaunchctlPrintOutput(
    "gui/501/com.mindmap.daily = {\n\tstate = exited\n\tlast exit code = 78: EX_CONFIG\n}",
  );

  assert.equal(status.loaded, true);
  assert.equal(status.lastExitCode, 78);
});

function localTime(day: number, hour: number, minute = 0): number {
  return new Date(2026, 7, day, hour, minute, 0, 0).getTime();
}

void test("finds the Mon-Sat occurrence across Sunday and Monday edges", () => {
  const schedule = buildDailyCalendarIntervals({ hour: 2, minute: 30 });

  assert.equal(new Date(getMostRecentScheduledOccurrence(schedule, localTime(16, 1))!).getDate(), 15);
  assert.equal(new Date(getMostRecentScheduledOccurrence(schedule, localTime(17, 1))!).getDate(), 15);
  assert.equal(new Date(getMostRecentScheduledOccurrence(schedule, localTime(17, 3))!).getDate(), 17);
});

void test("finds Sunday weekly occurrence independently of Mon-Sat schedule", () => {
  const schedule = buildWeeklyCalendarInterval({ hour: 3, minute: 0 });

  assert.equal(new Date(getMostRecentScheduledOccurrence(schedule, localTime(16, 2, 59))!).getDate(), 9);
  assert.equal(new Date(getMostRecentScheduledOccurrence(schedule, localTime(16, 3))!).getDate(), 16);
});

void test("classifies a recent heartbeat as healthy and an overdue one as stale", () => {
  const now = localTime(17, 4);
  const expectedAt = getMostRecentScheduledOccurrence(buildDailyCalendarIntervals({ hour: 2, minute: 30 }), now)!;
  const launchctl = { loaded: true, state: "exited", lastExitCode: 0 };

  assert.equal(classifyLaunchAgentHealth({
    launchctl,
    schedule: buildDailyCalendarIntervals({ hour: 2, minute: 30 }),
    lastSuccessfulRunAt: expectedAt,
    now,
  }), "healthy");
  assert.equal(classifyLaunchAgentHealth({
    launchctl,
    schedule: buildDailyCalendarIntervals({ hour: 2, minute: 30 }),
    lastSuccessfulRunAt: expectedAt - 1,
    now,
    graceMinutes: 15,
  }), "stale");
});

void test("classifies exit 78 as failing even with a fresh heartbeat", () => {
  const now = localTime(17, 4);
  assert.equal(classifyLaunchAgentHealth({
    launchctl: { loaded: true, state: "exited", lastExitCode: 78 },
    schedule: buildDailyCalendarIntervals({ hour: 2, minute: 30 }),
    lastSuccessfulRunAt: now,
    now,
  }), "failing");
});

void test("classifies a long-running scheduled job as healthy before its first heartbeat", () => {
  assert.equal(classifyLaunchAgentHealth({
    launchctl: { loaded: true, state: "running", lastExitCode: null },
    schedule: buildDailyCalendarIntervals({ hour: 2, minute: 30 }),
    lastSuccessfulRunAt: null,
    now: localTime(17, 4),
  }), "healthy");
});

void test("offers catch-up only for stale or failing agents with pending all-scope notes", () => {
  assert.equal(shouldOfferLaunchAgentCatchUp("stale", 1), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("failing", 2), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("healthy", 2), false);
  assert.equal(shouldOfferLaunchAgentCatchUp("stale", 0), false);
  assert.equal(shouldOfferLaunchAgentCatchUp(null, 2), false);
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
