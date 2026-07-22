// Stage 12.2 — the one canonical read model every bet-display consumer goes
// through. Root cause this fixes: ActiveBetsScreen.tsx/HistoryScreen.tsx/
// BetScreen.tsx all read `bet.event`/`bet.outcome` directly — fields that
// are genuinely `null` on any real EXPRESS row (Bet.event/outcome are
// nullable in Prisma; only BetSelection carries per-leg event/outcome for
// EXPRESS) and on the 2 currently-existing legacy SINGLE rows with zero
// BetSelection rows. Every UI consumer now reads `.displayTitle`/
// `.displaySubtitle`/`.selections` from this mapper instead of touching
// `bet.event`/`bet.outcome` itself — the legacy fallback lives here, once,
// not duplicated per screen.
//
// Pure and dependency-free (no Prisma import, no Node-only API) so it's
// safe to call from both a server route and a "use client" component —
// operates on the already-serialized (Decimal -> string) shape every
// consumer already receives over JSON, matching RecentBet/PendingBet/
// PlayerBet's existing field conventions exactly.

export interface DisplaySelection {
  id: string;
  sport: string;
  event: string;
  outcome: string;
  odds: string | null;
  // Optional — present on a real EXPRESS leg (BetSelection.market/
  // currentOdds/oddsStatus), absent on a legacy-fallback-synthesized
  // selection. Only ever read by a decision-context SelectionRow (Preview,
  // Confirmation Ticket, Pending Queue); never required.
  market?: string | null;
  currentOdds?: string | null;
  oddsStatus?: string | null;
}

// Only the fields the mapper actually needs — a structural subset every
// existing bet-like shape (RecentBet, PendingBet's future selections-aware
// version, dashboard PlayerBet) already satisfies, so no consumer needs its
// own adapter type.
export interface BetLikeForDisplay {
  id: string;
  type: string;
  status: string;
  stake: string;
  odds: string | null;
  totalOdds: string | null;
  createdAt: string;
  // Legacy scalar fields — read ONLY inside this mapper's fallback branch,
  // never by a UI component directly (see this file's own header comment).
  sport: string;
  event: string | null;
  outcome: string | null;
  selections: readonly DisplaySelection[];
}

export interface DisplayBet {
  id: string;
  type: string;
  status: string;
  stake: string;
  totalOdds: string | null;
  // Derived, not a schema column (no Bet.potentialPayout exists) — stake x
  // (totalOdds ?? odds), matching the same arithmetic BetTicket.tsx and
  // PlayerCard.tsx's computePotentialPayout() already do ad hoc. null
  // whenever neither odds figure is known yet.
  potentialPayout: string | null;
  createdAt: string;
  selections: DisplaySelection[];
  selectionCount: number;
  // The single-line, always-non-null headline for a card's title row.
  // SINGLE (or any bet with exactly one selection, including a
  // legacy-fallback-synthesized one): that selection's event. EXPRESS:
  // "Экспресс ×N · <first leg's event>" — the exact format
  // BetScreen.tsx's Home list already used before this fix, just no longer
  // reading the always-null legacy Bet.event for the second half.
  displayTitle: string;
  // The subtitle/outcome row's content — first selection's outcome, or
  // null if there are genuinely no selections to show (only reachable for
  // a legacy row with zero BetSelection rows AND a null legacy outcome,
  // i.e. corrupt/incomplete data).
  displaySubtitle: string | null;
}

const NO_TITLE_FALLBACK = "—";

function toLegacyFallbackSelections(bet: BetLikeForDisplay): DisplaySelection[] {
  // TODO(Stage 12.8): remove this branch once every Bet row is confirmed to
  // have at least one BetSelection. Not true today — a read-only audit
  // against production found 2 legacy SINGLE rows with zero selections
  // (created after the one-time scripts/backfill-bet-selections.ts run) —
  // so this fallback is currently load-bearing, not theoretical.
  if (bet.event === null || bet.outcome === null) {
    // Genuinely nothing to show — a bet with no selections AND no legacy
    // event/outcome either. Never fabricates placeholder text here; the
    // caller (displayTitle/displaySubtitle below) applies the one shared
    // "—" fallback instead.
    return [];
  }

  return [
    {
      id: bet.id,
      sport: bet.sport,
      event: bet.event,
      outcome: bet.outcome,
      odds: bet.odds,
    },
  ];
}

export function mapBetForDisplay(bet: BetLikeForDisplay): DisplayBet {
  const selections = bet.selections.length > 0 ? [...bet.selections] : toLegacyFallbackSelections(bet);

  const selectionCount = selections.length;
  const first = selections[0] ?? null;

  const displayTitle =
    first === null
      ? NO_TITLE_FALLBACK
      : selectionCount > 1
        ? `Экспресс ×${selectionCount} · ${first.event}`
        : first.event;

  const displaySubtitle = first?.outcome ?? null;

  const effectiveOdds = bet.totalOdds ?? bet.odds;
  const stakeNum = Number(bet.stake);
  const oddsNum = effectiveOdds !== null ? Number(effectiveOdds) : null;
  const potentialPayout =
    oddsNum !== null && Number.isFinite(stakeNum) && Number.isFinite(oddsNum)
      ? (stakeNum * oddsNum).toFixed(2)
      : null;

  return {
    id: bet.id,
    type: bet.type,
    status: bet.status,
    stake: bet.stake,
    totalOdds: bet.totalOdds,
    potentialPayout,
    createdAt: bet.createdAt,
    selections,
    selectionCount,
    displayTitle,
    displaySubtitle,
  };
}
