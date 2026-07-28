// Single source of truth for the settlement-period boundary logic.
// Previously duplicated as a local getZurichToday()/getNextSettlementDate()
// pair inside app/api/dashboard/players/route.ts — extracted here so the
// Period P/L calculation (which needs the *start* of the current period,
// not just the next boundary) can share the exact same calendar-date logic
// instead of drifting from it.
//
// Pure and dependency-free (only Intl/Date) — safe to import from a server
// route or a "use client" component, same convention as
// lib/bets/mapBetForDisplay.ts.

const SETTLEMENT_TIME_ZONE = "Europe/Zurich";

export interface ZurichCalendarDate {
  year: number;
  month: number; // 0-indexed, matches Date.UTC's month argument
  day: number;
}

export function getZurichCalendarDate(now: Date = new Date()): ZurichCalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SETTLEMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month) - 1,
    day: Number(map.day),
  };
}

export function calendarDateToUtcMidnight(date: ZurichCalendarDate): Date {
  return new Date(Date.UTC(date.year, date.month, date.day));
}

// Settlement runs on the 15th and on the last day of the month. Boundaries
// are built from Europe/Zurich's calendar date (via Intl.DateTimeFormat, not
// the server's UTC clock), then represented as UTC midnight of that date —
// simpler than resolving the exact CET/CEST instant, at the cost of up to a
// ~1-2h imprecision right at the boundary (Zurich midnight isn't UTC
// midnight). Acceptable for a "next settlement date" display; would need a
// real offset calculation if bet-level precision at the boundary hour ever
// matters.
export function getNextSettlementDate(now: Date = new Date()): Date {
  const { year, month, day } = getZurichCalendarDate(now);

  if (day <= 15) {
    return calendarDateToUtcMidnight({ year, month, day: 15 });
  }

  // Day 0 of next month = last calendar day of this month; Date handles
  // 28/29/30/31 and the December-into-January rollover on its own.
  return new Date(Date.UTC(year, month + 1, 0));
}

// The start of the settlement period `now` currently falls in — the
// counterpart to getNextSettlementDate(). Same two-window model: the 1st if
// today is on/before the 15th, otherwise the 16th.
export function getCurrentSettlementPeriodStart(now: Date = new Date()): Date {
  const { year, month, day } = getZurichCalendarDate(now);

  if (day <= 15) {
    return calendarDateToUtcMidnight({ year, month, day: 1 });
  }

  return calendarDateToUtcMidnight({ year, month, day: 16 });
}

export function getCurrentSettlementPeriodBounds(now: Date = new Date()): {
  start: Date;
  nextSettlementDate: Date;
} {
  return {
    start: getCurrentSettlementPeriodStart(now),
    nextSettlementDate: getNextSettlementDate(now),
  };
}
