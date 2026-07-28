// Secondary "N days left" / "due today" / "overdue by N days" text for a
// player's next settlement date. Kept separate from settlementPeriod.ts
// (which only knows how to compute boundaries) — this file additionally
// knows how to phrase a countdown relative to "now".
//
// Deliberately compares Zurich *calendar days*, not raw millisecond/24h
// buckets — nextSettlementDate is always a UTC-midnight representation of a
// Zurich calendar date (see settlementPeriod.ts), so "now" is converted to
// the same representation before diffing, or a DST transition day could tip
// the day-count off by one.
//
// Pure and dependency-free — safe to call from a "use client" component. No
// call site should ever pass a real "now" during server-side rendering of
// this component tree (PlayerCard is entirely client-fetched data, never
// SSR'd with a live date), so there is no hydration-mismatch risk in
// practice; the `now` parameter defaulting to `new Date()` only matters once
// the component is already mounted client-side.

import { getZurichCalendarDate, calendarDateToUtcMidnight } from "./settlementPeriod";

export type SettlementCountdownTone = "overdue" | "due-today" | "upcoming";

export interface SettlementCountdown {
  /** Positive = days until settlement, 0 = today, negative = overdue. */
  daysDiff: number;
  tone: SettlementCountdownTone;
  /** Secondary text, e.g. "3 days left" / "Settlement due today" / "Settlement overdue by 2 days". */
  label: string;
}

function utcMidnightFromIso(iso: string): Date {
  const parsed = new Date(iso);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function getSettlementCountdown(nextSettlementDateIso: string, now: Date = new Date()): SettlementCountdown {
  const target = utcMidnightFromIso(nextSettlementDateIso);
  const today = calendarDateToUtcMidnight(getZurichCalendarDate(now));

  const daysDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (daysDiff < 0) {
    const overdueDays = Math.abs(daysDiff);
    return {
      daysDiff,
      tone: "overdue",
      label: `Settlement overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}`,
    };
  }

  if (daysDiff === 0) {
    return { daysDiff, tone: "due-today", label: "Settlement due today" };
  }

  return { daysDiff, tone: "upcoming", label: `${daysDiff} day${daysDiff === 1 ? "" : "s"} left` };
}
