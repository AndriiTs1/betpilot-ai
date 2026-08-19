import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { requireOperatorApi } from "@/lib/auth/requireOperator";
import type { OperatorSessionStore } from "@/lib/auth/operatorSession";
import { computeRemainingCredit, clampAvailableForDisplay } from "@/lib/players/credit";
import { getCurrentSettlementPeriodBounds } from "@/lib/dashboard/settlementPeriod";

// Sector 0 (ADR-0002) — DI options exported so a route test can inject an
// in-memory fake db/session store instead of hitting the real, single
// shared database, same shape as app/api/dashboard/debug/screenshot-preview/
// route.ts's operatorSessionStore option and app/api/bets/[id]/confirm/
// route.ts's db option. GET itself always calls this with no overrides.
export interface HandleDashboardPlayersOptions {
  db?: PrismaClient;
  operatorSessionStore?: OperatorSessionStore;
}

export async function handleDashboardPlayers(
  request: NextRequest,
  options: HandleDashboardPlayersOptions = {},
): Promise<NextResponse> {
  const auth = await requireOperatorApi(request, options.operatorSessionStore);
  if (!auth.ok) return auth.response;

  const prismaClient = options.db ?? prisma;

  try {
    const { start: periodStart, nextSettlementDate } = getCurrentSettlementPeriodBounds();

    // Stage 6.1: the player card shows "Active Bets" (CONFIRMED) and
    // "History" (everything else already resolved) as two tabs — PENDING is
    // deliberately excluded at the query level (`status: { not: "PENDING" }`)
    // so it can never appear in the player card no matter what the UI does
    // with it; PENDING only ever shows in the separate Pending Bets queue
    // (GET /api/dashboard/bets/pending). No longer bounded by the current
    // settlement period — the card is meant to show the player's real
    // lifecycle end to end, not just this period's activity.
    const players = await prismaClient.player.findMany({
      // Sector 0 (ADR-0002) — cross-operator IDOR fix: scope to the
      // authenticated caller's own operator instead of returning every
      // operator's players.
      where: { operatorId: auth.operator.operatorId },
      select: {
        id: true,
        name: true,
        telegramId: true,
        phoneNumber: true,
        creditLimit: true,
        currentCredit: true,
        bets: {
          where: { status: { not: "PENDING" } },
          orderBy: { updatedAt: "desc" },
          select: {
            id: true,
            sport: true,
            event: true,
            outcome: true,
            stake: true,
            odds: true,
            totalOdds: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            // Full event display metadata for a SINGLE bet (no
            // BetSelection row — see mapBetForDisplay.ts's own comment).
            // eventStartTime was never selected here before either — this
            // route is the one query in the codebase that hand-picks
            // columns instead of returning every scalar field.
            homeTeamName: true,
            awayTeamName: true,
            competitionName: true,
            eventStartTime: true,
            // Betting Markets V1, Phase 2 — same "this route hand-picks
            // columns" gap as eventStartTime's own comment above. Nothing
            // populates this yet (no market classification changes in this
            // phase), but the column must not be silently excluded once
            // something eventually does. selections below has no explicit
            // select, so BetSelection.line already rides along automatically.
            line: true,
            // Stage 12.2 — deterministic leg order, oldest first
            // (submission order), same as GET /api/miniapp/me.
            selections: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });

    // Exposure = sum of stake across a player's CONFIRMED bets ("in play"
    // money) — also doubles as each player's Active Bets count. One query
    // for all players, grouped by playerId via reduce — same explicit-sum
    // approach as the correctness-sensitive totals in
    // /api/dashboard/overview, not a SQL groupBy/aggregate.
    const confirmedBets = await prismaClient.bet.findMany({
      // Sector 0 (ADR-0002) — same operator scope as the players query above.
      where: { status: "CONFIRMED", player: { operatorId: auth.operator.operatorId } },
      select: { playerId: true, stake: true },
    });

    const exposureByPlayerId = confirmedBets.reduce((map, bet) => {
      const current = map.get(bet.playerId) ?? new Prisma.Decimal(0);
      map.set(bet.playerId, current.plus(bet.stake));
      return map;
    }, new Map<string, Prisma.Decimal>());

    const activeBetsCountByPlayerId = confirmedBets.reduce((map, bet) => {
      map.set(bet.playerId, (map.get(bet.playerId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());

    // Pending Bets are excluded from the `players` query above (see comment
    // there), so they need their own count per player — used only for the
    // header status pill ("Pending Bets"); the pending bet's own full
    // detail still lives exclusively in GET /api/dashboard/bets/pending.
    const pendingBets = await prismaClient.bet.findMany({
      // Sector 0 (ADR-0002) — same operator scope as the players query above.
      where: { status: "PENDING", player: { operatorId: auth.operator.operatorId } },
      select: { playerId: true },
    });

    const pendingBetsCountByPlayerId = pendingBets.reduce((map, bet) => {
      map.set(bet.playerId, (map.get(bet.playerId) ?? 0) + 1);
      return map;
    }, new Map<string, number>());

    // Period P/L per player — sum of this player's Transaction rows
    // (written only by lib/bets/settleBet.ts) since the current settlement
    // period started. Same Transaction.amount convention as
    // GET /api/dashboard/overview's total figure — a straight sum, no
    // re-derivation of the WIN/LOSS/VOID math.
    const periodTransactions = await prismaClient.transaction.findMany({
      // Sector 0 (ADR-0002) — same operator scope as the players query above.
      where: { createdAt: { gte: periodStart }, player: { operatorId: auth.operator.operatorId } },
      select: { playerId: true, amount: true },
    });

    const periodPnlByPlayerId = periodTransactions.reduce((map, transaction) => {
      const current = map.get(transaction.playerId) ?? new Prisma.Decimal(0);
      map.set(transaction.playerId, current.plus(transaction.amount));
      return map;
    }, new Map<string, Prisma.Decimal>());

    const serialized = players.map((player) => {
      const exposure = exposureByPlayerId.get(player.id) ?? new Prisma.Decimal(0);
      const rawAvailable = computeRemainingCredit(player).minus(exposure);
      const available = clampAvailableForDisplay(rawAvailable, `player:${player.id}`);
      const periodPnl = periodPnlByPlayerId.get(player.id) ?? new Prisma.Decimal(0);

      const serializeBet = (bet: (typeof player.bets)[number]) => ({
        id: bet.id,
        sport: bet.sport,
        event: bet.event,
        outcome: bet.outcome,
        stake: bet.stake.toString(),
        odds: bet.odds ? bet.odds.toString() : null,
        totalOdds: bet.totalOdds ? bet.totalOdds.toString() : null,
        status: bet.status,
        createdAt: bet.createdAt.toISOString(),
        updatedAt: bet.updatedAt.toISOString(),
        homeTeamName: bet.homeTeamName,
        awayTeamName: bet.awayTeamName,
        competitionName: bet.competitionName,
        eventStartTime: bet.eventStartTime ? bet.eventStartTime.toISOString() : null,
        line: bet.line ? bet.line.toString() : null,
        selections: bet.selections,
      });

      return {
        id: player.id,
        name: player.name,
        telegramId: player.telegramId,
        phoneNumber: player.phoneNumber,
        creditLimit: player.creditLimit.toString(),
        currentCredit: player.currentCredit.toString(),
        available: available.toString(),
        exposure: exposure.toString(),
        activeBetsCount: activeBetsCountByPlayerId.get(player.id) ?? 0,
        pendingBetsCount: pendingBetsCountByPlayerId.get(player.id) ?? 0,
        periodPnl: periodPnl.toString(),
        nextSettlementDate: nextSettlementDate.toISOString(),
        activeBets: player.bets.filter((bet) => bet.status === "CONFIRMED").map(serializeBet),
        history: player.bets.filter((bet) => bet.status !== "CONFIRMED").map(serializeBet),
      };
    });

    return NextResponse.json({
      players: serialized,
      settlementPeriod: {
        start: periodStart.toISOString(),
        nextSettlementDate: nextSettlementDate.toISOString(),
      },
    });
  } catch (err) {
    console.error("GET /api/dashboard/players failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleDashboardPlayers(request);
}
