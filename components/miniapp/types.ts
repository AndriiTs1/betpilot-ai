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
  // Already present on every real API response (serializeBet spreads the
  // raw BetSelection row) — just not previously declared here. Optional so
  // the mergeConfirmedBet.ts optimistic-merge path (which doesn't set
  // these) stays valid without change.
  market?: string | null;
  currentOdds?: string | null;
  oddsStatus?: string | null;
  // Full event display metadata — already present on every real API
  // response (serializeBet spreads the raw BetSelection row, which
  // includes these columns) — declared here so mapBetForDisplay.ts's
  // "Home — Away" composition and SelectionRow's competition/date line
  // actually receive real data instead of reading past a narrower type.
  homeTeamName?: string | null;
  awayTeamName?: string | null;
  competitionName?: string | null;
  eventStartTime?: string | null;
  // Handicap Stage H2 — canonical SPREAD display data. Already present on
  // every real API response (serializeBet spreads the raw BetSelection row,
  // which includes these columns) — declared here, same as the fields
  // above, so BetSelectionsList.tsx can pass them to
  // normalizeSelectionToEnglish. Optional so mergeConfirmedBet.ts's
  // optimistic pre-reconciliation objects (which don't set these) stay
  // valid without change.
  canonicalMarketType?: string | null;
  canonicalParticipant?: string | null;
  line?: string | null;
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
  // Full event display metadata for a SINGLE bet (which has no
  // BetSelection row — see mapBetForDisplay.ts's own comment on
  // BetLikeForDisplay). Already present on every real API response; not
  // previously declared here.
  homeTeamName: string | null;
  awayTeamName: string | null;
  competitionName: string | null;
  eventStartTime: string | null;
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
