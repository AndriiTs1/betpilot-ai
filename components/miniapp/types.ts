export type MiniAppTab = "bet" | "active" | "history" | "balance";

export interface RecentBet {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  stake: string;
  odds: string | null;
  status: string;
  createdAt: string;
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
