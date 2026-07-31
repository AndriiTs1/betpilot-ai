// Shared by server and client display code — formats a provider
// commence_time (ISO 8601, always UTC) as "21 Aug 2026 • 20:00". Renders in
// UTC explicitly (not the viewer's local timezone): deterministic between
// server and client render (no hydration mismatch), and consistent between
// the Mini App (player) and Operator Dashboard (operator) regardless of
// either party's device timezone.
const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export function formatEventDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = MONTH_ABBREVIATIONS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return `${day} ${month} ${year} • ${hours}:${minutes}`;
}
