// UI-polish for the "Активные" card list (ActiveBetsScreen.tsx) — no
// existing helper in the project does relative ("Today"/"Yesterday")
// formatting; every other formatDate (HistoryScreen.tsx, BetTicket.tsx,
// PlayerCard.tsx) is a plain long-form date, left untouched. `now` is an
// explicit parameter (not read internally via `new Date()`) purely so
// tests can pin "today" deterministically without monkey-patching
// Date.now. English output labels regardless of the surrounding screen's
// Russian copy — Today/Yesterday/short month are what this task's spec
// itself gives as the target strings, not a translation of the day-name
// condition.
//
// Invalid-date fallback matches the existing project convention
// (BetTicket.tsx's formatDate/formatTime already return "—" for a date
// that fails to parse) rather than ever rendering "Invalid Date".
const INVALID_DATE_FALLBACK = "—";

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatCompactDate(input: Date | string, now: Date = new Date()): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return INVALID_DATE_FALLBACK;

  if (isSameCalendarDay(date, now)) return "Today";

  // Date's constructor correctly rolls a day-of-month of 0 (or negative)
  // back into the previous month/year on its own — this naturally handles
  // both a plain day boundary and a year boundary (e.g. now = Jan 1 ->
  // yesterday = Dec 31 of the previous year) without any special-casing.
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) return "Yesterday";

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" as const }),
  });
}
