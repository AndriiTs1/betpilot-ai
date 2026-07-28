import type { RecentBet } from "./types";

// Pure predicate — the single decision gate app/miniapp/page.tsx uses to
// decide whether background polling for an operator confirm/reject should
// be running at all. Deliberately checks every bet, not just the most
// recent one: a player can have more than one PENDING bet outstanding, and
// polling must keep running until none remain.
export function hasPendingBet(recentBets: readonly Pick<RecentBet, "status">[]): boolean {
  return recentBets.some((bet) => bet.status === "PENDING");
}
