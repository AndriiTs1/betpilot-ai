// Stage 6.1 — a plain browser CustomEvent, not a new state-management
// library: BetQueue/BetQueueItem, DashboardOverview, and PlayerList are
// three independent client components under the same Server Component page
// (app/page.tsx isn't a client component, so it can't hold shared React
// state for them). Confirming or rejecting a pending bet changes numbers
// all three of them show (Pending Bets, Exposure, Available, the player's
// Active Bets/History) — dispatching this event lets them refresh
// immediately instead of waiting for a manual reload or a polling interval.
export const DASHBOARD_REFRESH_EVENT = "betpilot-dashboard:refresh";

export function dispatchDashboardRefresh(): void {
  window.dispatchEvent(new Event(DASHBOARD_REFRESH_EVENT));
}
