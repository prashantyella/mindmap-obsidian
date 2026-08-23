import test from "node:test";
import assert from "node:assert/strict";

import { isEngineError } from "../engine/errors";
import { assertValidIanaTimeZone, computeNextDueAfter, resolveLocalWallTime, type Cadence } from "./scheduleTime";

void test("assertValidIanaTimeZone accepts real IANA zones and UTC", () => {
  assert.doesNotThrow(() => assertValidIanaTimeZone("America/New_York"));
  assert.doesNotThrow(() => assertValidIanaTimeZone("Asia/Tokyo"));
  assert.doesNotThrow(() => assertValidIanaTimeZone("UTC"));
});

void test("assertValidIanaTimeZone rejects offsets, made-up names, and non-strings", () => {
  assert.throws(() => assertValidIanaTimeZone("+05:00"), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
  assert.throws(() => assertValidIanaTimeZone("Not/A_Zone"), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
  assert.throws(() => assertValidIanaTimeZone(""), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
  assert.throws(() => assertValidIanaTimeZone(42), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
});

void test("resolveLocalWallTime: normal wall time resolves to a single, exact instant", () => {
  const result = resolveLocalWallTime(2024, 6, 15, 9, 0, "America/New_York");
  assert.equal(result.kind, "normal");
  assert.equal(new Date(result.utcMs).toISOString(), "2024-06-15T13:00:00.000Z");
});

void test("resolveLocalWallTime: US spring-forward gap (2024-03-10 02:30 America/New_York does not exist) resolves to the first valid instant after the gap", () => {
  const result = resolveLocalWallTime(2024, 3, 10, 2, 30, "America/New_York");
  assert.equal(result.kind, "gap");
  // Clocks jump 02:00 EST -> 03:00 EDT; the first valid instant after the gap is exactly 03:00 EDT.
  assert.equal(new Date(result.utcMs).toISOString(), "2024-03-10T07:00:00.000Z");
});

void test("resolveLocalWallTime: US fall-back fold (2024-11-03 01:30 America/New_York occurs twice) resolves to the EARLIER occurrence", () => {
  const result = resolveLocalWallTime(2024, 11, 3, 1, 30, "America/New_York");
  assert.equal(result.kind, "fold");
  // 01:30 EDT (UTC-4) happens first, then 01:30 EST (UTC-5) an hour later; earlier wins.
  assert.equal(new Date(result.utcMs).toISOString(), "2024-11-03T05:30:00.000Z");
});

void test("resolveLocalWallTime: EU spring-forward gap (2024-03-31 01:30 Europe/London does not exist)", () => {
  const result = resolveLocalWallTime(2024, 3, 31, 1, 30, "Europe/London");
  assert.equal(result.kind, "gap");
  assert.equal(new Date(result.utcMs).toISOString(), "2024-03-31T01:00:00.000Z");
});

void test("resolveLocalWallTime: EU fall-back fold (2024-10-27 01:30 Europe/London occurs twice)", () => {
  const result = resolveLocalWallTime(2024, 10, 27, 1, 30, "Europe/London");
  assert.equal(result.kind, "fold");
  assert.equal(new Date(result.utcMs).toISOString(), "2024-10-27T00:30:00.000Z");
});

void test("resolveLocalWallTime: leap day (2024-02-29) resolves normally", () => {
  const result = resolveLocalWallTime(2024, 2, 29, 9, 0, "UTC");
  assert.equal(result.kind, "normal");
  assert.equal(new Date(result.utcMs).toISOString(), "2024-02-29T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): returns today's occurrence when still in the future", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 5, 15, 0, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-06-15T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): rolls to tomorrow when today's time already passed", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 5, 15, 12, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-06-16T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): crossing a DST spring-forward boundary lands at the post-transition local time, never cascading through the missed day", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  // Already past 9am on March 10 (the transition day) in New York.
  const after = Date.UTC(2024, 2, 10, 20, 0, 0);
  const next = computeNextDueAfter(cadence, "America/New_York", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-03-11T13:00:00.000Z"); // 9am EDT
});

void test("computeNextDueAfter (weekly): finds the next matching weekday within 7 days, not a cascade through every day", () => {
  const cadence: Cadence = { type: "weekly", weekday: 1, hour: 9, minute: 0 }; // Monday
  const after = Date.UTC(2024, 0, 3, 0, 0, 0); // Wednesday 2024-01-03
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-01-08T09:00:00.000Z"); // next Monday
});

void test("computeNextDueAfter (weekly): exact weekday match today but time already passed rolls to next week, not tomorrow", () => {
  const cadence: Cadence = { type: "weekly", weekday: 1, hour: 9, minute: 0 };
  const after = Date.UTC(2024, 0, 1, 12, 0, 0); // Monday 2024-01-01, 12:00 UTC (past 9am)
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-01-08T09:00:00.000Z");
});

void test("computeNextDueAfter (interval): first schedule (no prior due) is exactly one interval after now", () => {
  const cadence: Cadence = { type: "interval", intervalMinutes: 30 };
  const after = Date.UTC(2024, 0, 1, 0, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(next, after + 30 * 60_000);
});

void test("computeNextDueAfter (interval): after a long gap, jumps directly to the next FUTURE multiple of the persisted due instant -- no replay cascade", () => {
  const cadence: Cadence = { type: "interval", intervalMinutes: 60 };
  const priorDue = Date.UTC(2024, 0, 1, 0, 0, 0);
  const after = Date.UTC(2024, 0, 10, 3, 15, 0); // 9 days later
  const next = computeNextDueAfter(cadence, "UTC", after, priorDue);
  assert.ok(next > after);
  // Must remain phase-locked to the original due instant (no drift): (next - priorDue) is a whole number of intervals.
  assert.equal((next - priorDue) % (60 * 60_000), 0);
});

void test("computeNextDueAfter (interval): clock rollback never regresses -- computed next is still strictly greater than the (earlier) reference instant", () => {
  const cadence: Cadence = { type: "interval", intervalMinutes: 60 };
  const priorDue = Date.UTC(2024, 0, 5, 0, 0, 0);
  const after = Date.UTC(2024, 0, 1, 0, 0, 0); // rolled back before priorDue
  const next = computeNextDueAfter(cadence, "UTC", after, priorDue);
  assert.ok(next >= priorDue);
});

void test("computeNextDueAfter (daily): UTC+14 (Pacific/Kiritimati) does not skip today's still-future occurrence -- regression for the naive-UTC-noon re-zoning bug", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  // Local time at this instant is 2024-06-15 00:30 Kiritimati -- well before today's 09:00 due time.
  const after = Date.UTC(2024, 5, 14, 10, 30, 0);
  const next = computeNextDueAfter(cadence, "Pacific/Kiritimati", after, undefined);
  // Correct: today (06-15) 09:00 local = 06-14 19:00Z. The bug returned 06-16 09:00 local
  // (06-15 19:00Z) instead, silently skipping today's occurrence.
  assert.equal(new Date(next).toISOString(), "2024-06-14T19:00:00.000Z");
});

void test("computeNextDueAfter (weekly): UTC+13/+14 does not skip the matching weekday", () => {
  const cadence: Cadence = { type: "weekly", weekday: 6, hour: 9, minute: 0 }; // Saturday
  // Local time is 2024-06-15 (Saturday) 00:30 Kiritimati -- before today's 09:00 due time.
  const after = Date.UTC(2024, 5, 14, 10, 30, 0);
  const next = computeNextDueAfter(cadence, "Pacific/Kiritimati", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-06-14T19:00:00.000Z");
});

void test("computeNextDueAfter (daily): UTC-11 (Pacific/Pago_Pago, west side, no DST) resolves correctly", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 5, 15, 0, 0, 0); // 2024-06-14 13:00 local (UTC-11)
  const next = computeNextDueAfter(cadence, "Pacific/Pago_Pago", after, undefined);
  // Today's 09:00 already passed locally; rolls to 06-15 09:00 local = 06-15 20:00Z.
  assert.equal(new Date(next).toISOString(), "2024-06-15T20:00:00.000Z");
});

void test("computeNextDueAfter (daily): quarter-hour offset zone (Asia/Kathmandu, UTC+5:45)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 5, 15, 0, 0, 0); // 05:45 local
  const next = computeNextDueAfter(cadence, "Asia/Kathmandu", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-06-15T03:15:00.000Z"); // 09:00 local - 5:45
});

void test("computeNextDueAfter (daily): half-hour offset zone (Asia/Kolkata, UTC+5:30)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 5, 15, 0, 0, 0); // 05:30 local
  const next = computeNextDueAfter(cadence, "Asia/Kolkata", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-06-15T03:30:00.000Z");
});

void test("computeNextDueAfter (daily): month rollover (Jan 31 -> Feb 1)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 0, 31, 12, 0, 0); // past 9am on Jan 31
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-02-01T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): leap-year rollover (Feb 29 -> Mar 1, 2024)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 1, 29, 12, 0, 0); // past 9am on Feb 29 (leap day)
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2024-03-01T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): non-leap-year Feb rollover (Feb 28 -> Mar 1, 2023)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2023, 1, 28, 12, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2023-03-01T09:00:00.000Z");
});

void test("computeNextDueAfter (daily): year rollover (Dec 31 -> Jan 1)", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const after = Date.UTC(2024, 11, 31, 12, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", after, undefined);
  assert.equal(new Date(next).toISOString(), "2025-01-01T09:00:00.000Z");
});

void test("computeNextDueAfter: rejects non-finite/unsafe afterMs and priorDueMs", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  assert.throws(() => computeNextDueAfter(cadence, "UTC", Number.NaN, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  assert.throws(() => computeNextDueAfter(cadence, "UTC", Number.POSITIVE_INFINITY, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  assert.throws(() => computeNextDueAfter(cadence, "UTC", Number.MAX_SAFE_INTEGER + 10, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  assert.throws(() => computeNextDueAfter(cadence, "UTC", 1.5, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  assert.throws(() => computeNextDueAfter(cadence, "UTC", 0, Number.NaN), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
});

void test("computeNextDueAfter: rejects a casted-invalid cadence shape at runtime, not just at the type level", () => {
  const badHour = { type: "daily", hour: 24, minute: 0 } as unknown as Cadence;
  assert.throws(() => computeNextDueAfter(badHour, "UTC", 0, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  const badWeekday = { type: "weekly", weekday: 7, hour: 0, minute: 0 } as unknown as Cadence;
  assert.throws(() => computeNextDueAfter(badWeekday, "UTC", 0, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  const badInterval = { type: "interval", intervalMinutes: 1 } as unknown as Cadence;
  assert.throws(() => computeNextDueAfter(badInterval, "UTC", 0, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
  const badShape = null as unknown as Cadence;
  assert.throws(() => computeNextDueAfter(badShape, "UTC", 0, undefined), (e: unknown) => isEngineError(e) && e.code === "SCHEDULE_SHAPE_INVALID");
});

void test("computeNextDueAfter: extreme-but-valid dates (near year 9999 and just after the epoch) still resolve", () => {
  const cadence: Cadence = { type: "daily", hour: 9, minute: 0 };
  const nearEpoch = computeNextDueAfter(cadence, "UTC", 0, undefined);
  assert.ok(nearEpoch > 0);
  const farFuture = Date.UTC(9998, 11, 31, 12, 0, 0);
  const next = computeNextDueAfter(cadence, "UTC", farFuture, undefined);
  assert.ok(Number.isSafeInteger(next));
  assert.equal(new Date(next).toISOString(), "9999-01-01T09:00:00.000Z");
});

void test("assertValidIanaTimeZone: error messages never echo the offending value (value-free) and control bytes are rejected", () => {
  try {
    assertValidIanaTimeZone("Not/A_Zone_XYZ");
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(isEngineError(e));
    assert.ok(!e.message.includes("Not/A_Zone_XYZ"));
  }
  assert.throws(() => assertValidIanaTimeZone("UTC evil"), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
  assert.throws(() => assertValidIanaTimeZone("UTC\nInjected"), (e: unknown) => isEngineError(e) && e.code === "TIMEZONE_INVALID");
});

void test("computeNextDueAfter: every returned instant strictly exceeds the reference instant, across kinds", () => {
  const after = Date.UTC(2024, 5, 1, 0, 0, 0);
  const daily = computeNextDueAfter({ type: "daily", hour: 0, minute: 0 }, "UTC", after, undefined);
  const weekly = computeNextDueAfter({ type: "weekly", weekday: 6, hour: 0, minute: 0 }, "UTC", after, undefined);
  const interval = computeNextDueAfter({ type: "interval", intervalMinutes: 15 }, "UTC", after, undefined);
  assert.ok(daily > after);
  assert.ok(weekly > after);
  assert.ok(interval > after);
});

void test("(final-integration 13) source audit: computeNextDueAfterUnchecked's day-advance loop never reconstructs a fake noon-as-UTC instant", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "scheduleTime.ts"), "utf8");
  // The specific bug pattern this locks out: deriving a candidate day via
  // `naiveUtcMs(y, m, d, 12, 0) + dayOffset * MS_PER_DAY` (or any hardcoded-noon-plus-day-offset
  // shape) and re-zoning THAT through `timezone` -- the day advancement must instead come from
  // Date.UTC's own y/m/d rollover on the REAL target day, never a fabricated noon reading.
  assert.doesNotMatch(source, /naiveUtcMs\([^)]*,\s*12,\s*0\)/, "must never construct a naive-noon instant for day-advancement math");
  assert.doesNotMatch(source, /12,\s*0\)\s*\+\s*dayOffset/, "must never add a day offset to a fixed-noon instant");
  // Positive assertion: the actual (restored) mechanism is present.
  assert.match(source, /Date\.UTC\(startComponents\.year, startComponents\.month - 1, startComponents\.day \+ dayOffset\)/);
});
