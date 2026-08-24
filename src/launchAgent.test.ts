import test from "node:test";
import assert from "node:assert/strict";

import { normalizeHour, normalizeMinute, shouldOfferLaunchAgentCatchUp } from "./launchAgent";

void test("normalizes launch agent clock values", () => {
  assert.equal(normalizeHour(99), 23);
  assert.equal(normalizeHour(-1), 0);
  assert.equal(normalizeHour(Number.NaN), 0);
  assert.equal(normalizeMinute(99), 59);
  assert.equal(normalizeMinute(-1), 0);
  assert.equal(normalizeMinute(Number.NaN), 0);
});

void test("offers catch-up only for overdue or failing agents with pending all-scope notes", () => {
  assert.equal(shouldOfferLaunchAgentCatchUp("overdue", 1), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("failing", 2), true);
  assert.equal(shouldOfferLaunchAgentCatchUp("healthy", 2), false);
  assert.equal(shouldOfferLaunchAgentCatchUp("overdue", 0), false);
  assert.equal(shouldOfferLaunchAgentCatchUp(null, 2), false);
});
