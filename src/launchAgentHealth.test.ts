import test from "node:test";
import assert from "node:assert/strict";

import { buildLaunchAgentCatchUpStatus } from "./launchAgentHealth";
import type { PendingSnapshot } from "./pendingScan";

function pendingSnapshot(allTotal: number): PendingSnapshot {
  return {
    available: true,
    reason: "ok",
    current: { total: 0, items: [] },
    all: { total: allTotal, items: [] },
    metrics: { durationMs: 0, filesListed: 0, filesScanned: 0, filesUpdated: 0, totalTracked: 0, dirtyPaths: 0, stateReloaded: false, configReloaded: false },
    lastUpdatedAt: Date.now(),
  };
}

void test("buildLaunchAgentCatchUpStatus offers catch-up only when the scheduler is in launchAgent mode, health is overdue/failing, and all-scope notes are pending", () => {
  assert.equal(buildLaunchAgentCatchUpStatus("launchAgent", "overdue", pendingSnapshot(3)).available, true);
  assert.equal(buildLaunchAgentCatchUpStatus("launchAgent", "failing", pendingSnapshot(1)).available, true);
  assert.equal(buildLaunchAgentCatchUpStatus("launchAgent", "healthy", pendingSnapshot(3)).available, false);
  assert.equal(buildLaunchAgentCatchUpStatus("launchAgent", "overdue", pendingSnapshot(0)).available, false);
  assert.equal(buildLaunchAgentCatchUpStatus("manual", "overdue", pendingSnapshot(3)).available, false);
  assert.equal(buildLaunchAgentCatchUpStatus("interval", "overdue", pendingSnapshot(3)).available, false);
});

void test("buildLaunchAgentCatchUpStatus message reflects the pending count when offered, and a fixed explanation otherwise", () => {
  const offered = buildLaunchAgentCatchUpStatus("launchAgent", "overdue", pendingSnapshot(1));
  assert.match(offered.message, /overdue/);
  assert.match(offered.message, /1 all-scope note remain/);

  const notOffered = buildLaunchAgentCatchUpStatus("manual", "overdue", pendingSnapshot(1));
  assert.match(notOffered.message, /offered only when/);
});
