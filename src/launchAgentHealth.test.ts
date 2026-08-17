import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateLaunchAgentHealth,
  getSuccessfulRunAt,
  type LaunchAgentObservation,
} from "./launchAgentHealth";

void test("only treats a log mtime as a successful heartbeat after exit 0", () => {
  assert.equal(getSuccessfulRunAt(0, 1234), 1234);
  assert.equal(getSuccessfulRunAt(1, 1234), null);
  assert.equal(getSuccessfulRunAt(null, 1234), null);
  assert.equal(getSuccessfulRunAt(0, null), null);
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
