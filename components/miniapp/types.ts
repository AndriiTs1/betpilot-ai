export type MiniAppTab = "bet" | "active" | "history" | "balance";

export interface MiniAppBetSelection {
  id: string;
  betId: string;
  sport: string;
  event: string;
  outcome: string;
  odds: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecentBet {
  id: string;
  // Already present on every real API response (serializeBet spreads the
  // raw Bet row, which includes `type`) — just not previously declared here.
  type: string;
  sport: string;
  // Stage 12.2 — nullable to match the real Prisma contract: Bet.event/
  // outcome are `String?`, and are genuinely null for every EXPRESS bet
  // (event/outcome live per-leg on selections[] instead). Never read
  // directly by UI — see lib/bets/mapBetForDisplay.ts, the one place this
  // nullability is actually handled.
  event: string | null;
  outcome: string | null;
  stake: string;
  odds: string | null;
  status: string;
  createdAt: string;
  totalOdds: string | null;
  selections: MiniAppBetSelection[];
}

export interface MeResponse {
  player: { id: string; name: string };
  creditLimit: string;
  currentCredit: string;
  remainingCredit: string;
  exposure: string;
  pendingExposure: string;
  availableCredit: string;
  recentBets: RecentBet[];
}
