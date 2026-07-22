// Shared date helper for the "Активные" and "История" card lists
// (ActiveBetsScreen.tsx, HistoryScreen.tsx) — a single fixed-width numeric
// DD.MM.YY format, deliberately not relative ("Today"/"Yesterday") and not a
// localized month name, so it never wraps to a second line and never
// mismatches between server/client locale.
//
// Uses the Date object's local getDate/getMonth/getFullYear (matches how
// every other date helper in this project already reads dates — no UTC
// conversion), so the displayed date follows whatever timezone the app is
// already running under.
const INVALID_DATE_FALLBACK = "—";

export function formatBetDate(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return INVALID_DATE_FALLBACK;

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear() % 100).padStart(2, "0");

  return `${day}.${month}.${year}`;
}
