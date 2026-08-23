import { EngineError } from "../engine/errors";

/**
 * Pure, injectable-clock time math for Checkpoint 8's scheduler. Nothing in
 * this module reads `Date.now()`/a real timer, touches the filesystem, or
 * imports Obsidian/jobs/background modules -- every function here is a
 * deterministic transform of (epoch-ms in, epoch-ms out), so the exact same
 * DST/day/week-rollover math that runs in production runs unchanged under a
 * fake clock in tests.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // one week

/** Codepoint check duplicated locally (this module stays leaf-level, no import from `src/jobs`) -- mirrors `hasControlOrNulCharacter` in `scheduleTypes.ts`. */
function hasControlOrNulCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates a real IANA timezone identifier -- rejects an offset-only string
 * ("+05:00"), a made-up name, or anything `Intl` cannot construct a
 * formatter for. Deliberately CONTROL-FREE (rejects embedded control/NUL
 * bytes before ever touching `Intl`) and VALUE-FREE on failure -- every
 * thrown message here is a fixed string, never the caller-supplied
 * `timezone` itself, so an attacker-controlled or corrupt persisted
 * timezone string can never round-trip into a log/error surface.
 */
export function assertValidIanaTimeZone(timezone: unknown): asserts timezone is string {
  if (typeof timezone !== "string" || timezone.trim().length === 0 || timezone.length > MAX_TIMEZONE_LENGTH || hasControlOrNulCharacter(timezone)) {
    throw new EngineError("TIMEZONE_INVALID", "timezone must be a short, bounded, control-free, non-empty string.", {});
  }
  try {
    // Constructing the formatter is a necessary check -- an unrecognized zone throws RangeError --
    // but NOT sufficient on its own: newer `Intl.DateTimeFormat` implementations also accept a raw
    // UTC-offset string ("+05:00") as a "custom time zone identifier", which is not an IANA zone
    // name and must still be rejected here. Deliberately NOT cross-checked against
    // `Intl.supportedValuesOf("timeZone")` either -- that list contains only each zone's single
    // CANONICAL spelling (e.g. "Asia/Calcutta", "Asia/Katmandu" in some ICU builds) and would
    // otherwise reject legitimate, currently-in-use tzdata aliases like "Asia/Kolkata"/
    // "Asia/Kathmandu" that the constructor itself accepts and correctly normalizes.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new EngineError("TIMEZONE_INVALID", "timezone is not a recognized IANA timezone.", {});
  }
  // Every real IANA zone identifier is either the single special case "UTC" or an "Area/Location"
  // name containing a slash; a bare offset ("+05:00") or other non-IANA custom identifier the
  // constructor above may loosely accept contains neither.
  if (timezone !== "UTC" && !timezone.includes("/")) {
    throw new EngineError("TIMEZONE_INVALID", "timezone is not a recognized IANA timezone.", {});
  }
}

export const MAX_TIMEZONE_LENGTH = 100;

/** A finite, integer, in-range-of-`Number.isSafeInteger` epoch millisecond value. Value-free on failure -- never echoes the offending number, which may be attacker/corruption-controlled. */
export function assertFiniteSafeEpochMs(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", `${field} must be a finite safe-integer epoch millisecond value.`, {});
  }
}

/** Runtime shape guard for a `Cadence` value that may arrive from an untrusted cast (e.g. a corrupt persisted document surviving past its own parse, or a direct call from a test/probe) -- never trusts the TypeScript type alone. */
function assertCadenceRuntimeShape(cadence: Cadence): void {
  if (typeof cadence !== "object" || cadence === null) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "cadence must be an object.", {});
  }
  if (cadence.type === "interval") {
    if (!Number.isInteger(cadence.intervalMinutes) || cadence.intervalMinutes < MIN_INTERVAL_MINUTES || cadence.intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new EngineError("SCHEDULE_SHAPE_INVALID", `cadence.intervalMinutes must be an integer in [${MIN_INTERVAL_MINUTES}, ${MAX_INTERVAL_MINUTES}].`, {});
    }
    return;
  }
  if (cadence.type !== "daily" && cadence.type !== "weekly") {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "cadence.type must be \"daily\", \"weekly\", or \"interval\".", {});
  }
  if (!Number.isInteger(cadence.hour) || cadence.hour < 0 || cadence.hour > 23) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "cadence.hour must be an integer in [0, 23].", {});
  }
  if (!Number.isInteger(cadence.minute) || cadence.minute < 0 || cadence.minute > 59) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "cadence.minute must be an integer in [0, 59].", {});
  }
  if (cadence.type === "weekly" && (!Number.isInteger(cadence.weekday) || cadence.weekday < 0 || cadence.weekday > 6)) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "cadence.weekday must be an integer in [0, 6].", {});
  }
}

/** Bounded per-timezone `Intl.DateTimeFormat` cache -- avoids rebuilding a formatter on every probe within `zonedComponents` (called repeatedly by `resolveLocalWallTime`'s bisection and `computeNextDueAfter`'s day loop). Capped at `MAX_CACHED_TIMEZONE_FORMATTERS` distinct timezones with FIFO eviction (insertion-order `Map`, delete-then-reinsert-newest is unnecessary here since entries are never re-hit-and-promoted -- a simple bounded cache, not a true LRU, is all this needs: schedules only ever use a handful of distinct timezones at once). */
const MAX_CACHED_TIMEZONE_FORMATTERS = 64;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getCachedFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  if (formatterCache.size >= MAX_CACHED_TIMEZONE_FORMATTERS) {
    const oldestKey = formatterCache.keys().next().value;
    if (oldestKey !== undefined) formatterCache.delete(oldestKey);
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

interface ZonedComponents {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 (Sunday) - 6 (Saturday)
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock date/time this timezone shows at `utcMs`, plus the local weekday. */
function zonedComponents(timezone: string, utcMs: number): ZonedComponents {
  const dtf = getCachedFormatter(timezone);
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** This timezone's offset (minutes, local-minus-UTC) in effect at `utcMs`. */
function offsetMinutesAt(timezone: string, utcMs: number): number {
  const z = zonedComponents(timezone, utcMs);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - utcMs) / MS_PER_MINUTE);
}

/** `Date.UTC` equivalent of a local (y, m, d, h, mi) wall-clock reading, treated as if it were UTC -- used only as a fixed reference point for offset arithmetic, never persisted or returned directly. */
function naiveUtcMs(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0);
}

/** Finds the exact instant (within 1ms) where this timezone's offset changes, searching `[loMs, hiMs]` where the offset is known to differ at the two ends. Bounded to 60 iterations (well under 1ms precision over any realistic search window) so this can never loop unboundedly. */
function findOffsetTransition(timezone: string, loMs: number, hiMs: number): number {
  let lo = loMs;
  let hi = hiMs;
  const loOffset = offsetMinutesAt(timezone, lo);
  for (let i = 0; i < 60 && hi - lo > 1; i += 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (offsetMinutesAt(timezone, mid) === loOffset) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

export type LocalTimeResolutionKind = "normal" | "gap" | "fold";

export interface LocalTimeResolution {
  utcMs: number;
  kind: LocalTimeResolutionKind;
}

/**
 * Resolves one local wall-clock reading (year/month/day/hour/minute, `00`
 * seconds) in `timezone` to a UTC instant, applying this scheduler's fixed
 * DST policy deterministically:
 *  - `"normal"`: the wall time occurs exactly once; that instant is returned.
 *  - `"gap"` (spring-forward): the wall time never occurs; the FIRST VALID
 *    instant after the gap (the transition instant itself) is returned.
 *  - `"fold"` (fall-back): the wall time occurs twice; the EARLIER of the
 *    two instants is returned.
 */
export function resolveLocalWallTime(year: number, month: number, day: number, hour: number, minute: number, timezone: string): LocalTimeResolution {
  const naive = naiveUtcMs(year, month, day, hour, minute);

  // Two-step fixed-point iteration: refine the UTC guess using the offset actually in effect at
  // the previous guess, which converges immediately away from any transition and takes exactly
  // one extra step to detect one nearby.
  const offsetGuess1 = offsetMinutesAt(timezone, naive);
  const candidate1 = naive - offsetGuess1 * MS_PER_MINUTE;
  const offsetGuess2 = offsetMinutesAt(timezone, candidate1);
  const candidate2 = naive - offsetGuess2 * MS_PER_MINUTE;
  const offsetAtCandidate2 = offsetMinutesAt(timezone, candidate2);

  if (offsetGuess2 === offsetAtCandidate2) {
    // candidate2 is a fixed point: reconstructing its wall time from its own actual offset
    // reproduces the requested reading exactly, so this is (at least) a valid instant.
    const reconstructed = candidate2 + offsetAtCandidate2 * MS_PER_MINUTE;
    if (reconstructed === naive) {
      // Check for a fold: does the OTHER nearby offset regime also produce this same wall time?
      const altOffsetBefore = offsetMinutesAt(timezone, candidate2 - 2 * 60 * MS_PER_MINUTE);
      const altOffsetAfter = offsetMinutesAt(timezone, candidate2 + 2 * 60 * MS_PER_MINUTE);
      for (const altOffset of [altOffsetBefore, altOffsetAfter]) {
        if (altOffset === offsetAtCandidate2) continue;
        const altCandidate = naive - altOffset * MS_PER_MINUTE;
        if (offsetMinutesAt(timezone, altCandidate) === altOffset) {
          const earlier = Math.min(candidate2, altCandidate);
          return { utcMs: earlier, kind: "fold" };
        }
      }
      return { utcMs: candidate2, kind: "normal" };
    }
  }

  // Neither guess reproduced the requested wall time: it falls in a spring-forward gap. Find the
  // exact transition instant between the two differing offset regimes and return it -- the first
  // valid instant after the gap, per policy.
  const lowOffset = Math.min(offsetGuess1, offsetGuess2);
  const highOffset = Math.max(offsetGuess1, offsetGuess2);
  const searchLo = naive - highOffset * MS_PER_MINUTE - MS_PER_DAY;
  const searchHi = naive - lowOffset * MS_PER_MINUTE + MS_PER_DAY;
  const transition = findOffsetTransition(timezone, searchLo, searchHi);
  return { utcMs: transition, kind: "gap" };
}

export interface DailyCadence {
  type: "daily";
  hour: number;
  minute: number;
}

export interface WeeklyCadence {
  type: "weekly";
  weekday: number; // 0 (Sunday) - 6 (Saturday)
  hour: number;
  minute: number;
}

export interface IntervalCadence {
  type: "interval";
  intervalMinutes: number;
}

export type Cadence = DailyCadence | WeeklyCadence | IntervalCadence;

/**
 * Computes the smallest due instant strictly greater than `afterMs`, for the
 * given cadence -- a single closed-form lookup (bounded to at most 7 daily
 * candidates for a weekly cadence, a single computation for daily/interval),
 * never a loop that steps through every missed period. This is what
 * guarantees "no replay cascade": whether the previous due instant was 5
 * minutes or 5 months ago, computing the next one costs the same.
 */
export function computeNextDueAfter(cadence: Cadence, timezone: string, afterMs: number, priorDueMs: number | undefined): number {
  assertValidIanaTimeZone(timezone);
  assertCadenceRuntimeShape(cadence);
  assertFiniteSafeEpochMs(afterMs, "afterMs");
  if (priorDueMs !== undefined) assertFiniteSafeEpochMs(priorDueMs, "priorDueMs");

  const result = computeNextDueAfterUnchecked(cadence, timezone, afterMs, priorDueMs);

  assertFiniteSafeEpochMs(result, "computeNextDueAfter result");
  if (result <= afterMs) {
    throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeNextDueAfter: computed result did not strictly advance past afterMs.", {});
  }
  return result;
}

function computeNextDueAfterUnchecked(cadence: Cadence, timezone: string, afterMs: number, priorDueMs: number | undefined): number {
  if (cadence.type === "interval") {
    const intervalMs = cadence.intervalMinutes * MS_PER_MINUTE;
    const base = priorDueMs ?? afterMs;
    if (base > afterMs) return base;
    const periods = Math.floor((afterMs - base) / intervalMs) + 1;
    return base + periods * intervalMs;
  }

  // Advance the LOCAL Gregorian calendar date using UTC calendar arithmetic ONLY -- Date.UTC's
  // day/month/year rollover (leap years included) is exactly the Gregorian calendar's rollover,
  // completely independent of any timezone. `startComponents` supplies the anchor Y/M/D actually
  // showing in `timezone` right now; every candidate day after that is this same Y/M/D plus a
  // plain integer day offset, counted in calendar space -- never by re-zoning a fabricated UTC
  // instant through `timezone` (the bug this replaces: treating "local Y/M/D at noon" as if it
  // were itself a UTC reading shifts the apparent day by a full 24h for any zone whose offset
  // pushes noon-as-UTC across a further day boundary once re-zoned -- e.g. UTC+13/+14, where the
  // very first candidate day silently became tomorrow, skipping today's still-future due time).
  // Only the FINAL step -- turning one candidate (year, month, day, hour, minute) into a real UTC
  // instant -- ever calls into `timezone` for date math, via `resolveLocalWallTime`.
  const startComponents = zonedComponents(timezone, afterMs);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const advanced = new Date(Date.UTC(startComponents.year, startComponents.month - 1, startComponents.day + dayOffset));
    const year = advanced.getUTCFullYear();
    const month = advanced.getUTCMonth() + 1;
    const day = advanced.getUTCDate();
    const weekday = advanced.getUTCDay();
    if (cadence.type === "weekly" && weekday !== cadence.weekday) continue;
    const resolved = resolveLocalWallTime(year, month, day, cadence.hour, cadence.minute, timezone);
    if (resolved.utcMs > afterMs) return resolved.utcMs;
  }
  // Unreachable for any well-formed cadence (a daily/weekly wall-clock reading always recurs
  // within 8 days), but fail loudly rather than silently returning a stale/incorrect instant.
  throw new EngineError("SCHEDULE_SHAPE_INVALID", "computeNextDueAfter: no due instant found within 8 days -- cadence is malformed.", {});
}
