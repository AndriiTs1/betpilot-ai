import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { computeRemainingCredit, clampAvailableForDisplay } from "@/lib/players/credit";
import { requireOperatorApi } from "@/lib/auth/requireOperator";
import type { OperatorSessionStore } from "@/lib/auth/operatorSession";
import { getCurrentSettlementPeriodBounds } from "@/lib/dashboard/settlementPeriod";

// Sector 0 (ADR-0002) — same DI shape as
// app/api/dashboard/players/route.ts's HandleDashboardPlayersOptions.
export interface HandleDashboardOverviewOptions {
  db?: PrismaClient;
  operatorSessionStore?: OperatorSessionStore;
}

export async function handleDashboardOverview(
  request: NextRequest,
  options: HandleDashboardOverviewOptions = {},
): Promise<NextResponse> {
  const auth = await requireOperatorApi(request, options.operatorSessionStore);
  if (!auth.ok) return auth.response;

  const prismaClient = options.db ?? prisma;

  try {
    // Deliberately computed in JS, not as a single SQL aggregate: the
    // per-player "remaining credit" branches on the sign of currentCredit,
    // and this figure is correctness-critical (it's a credit exposure
    // total). An explicit loop is easier to verify than a conditional-sum
    // Prisma/SQL expression, and player counts here are small.
    const players = await prismaClient.player.findMany({
      // Sector 0 (ADR-0002) — cross-operator IDOR fix: scope to the
      // authenticated caller's own operator instead of returning every
      // operator's players.
      where: { operatorId: auth.operator.operatorId },
      select: { id: true, creditLimit: true, currentCredit: true },
    });

    const totalRemainingCredit = players.reduce(
      (total, player) => total.plus(computeRemainingCredit(player)),
      new Prisma.Decimal(0),
    );

    // Sector 0 (ADR-0002) — same operator scope as the players query above,
    // applied to every bet/transaction query below.
    const pendingBetsCount = await prismaClient.bet.count({
      where: { status: "PENDING", player: { operatorId: auth.operator.operatorId } },
    });

    // Same explicit-reduce approach as totalRemainingCredit above, for
    // consistency: this particular sum has no per-row branching, so
    // aggregate({_sum}) would also be correct and simpler, but keeping one
    // pattern for "sum of a correctness-sensitive money figure" across this
    // file is easier to audit than mixing SQL-aggregate and JS-reduce sums.
    const pendingBets = await prismaClient.bet.findMany({
      where: { status: "PENDING", player: { operatorId: auth.operator.operatorId } },
      select: { stake: true },
    });

    const pendingBetsSum = pendingBets.reduce(
      (total, bet) => total.plus(bet.stake),
      new Prisma.Decimal(0),
    );

    // "Played"/"Not Played" here is a temporary simplification:
    // CONFIRMED = "played", PENDING = "not played". That's not actually
    // whether the underlying match has finished — it will be revisited once
    // settlement (determining win/loss from the real match result) exists.
    const confirmedBets = await prismaClient.bet.findMany({
      where: { status: "CONFIRMED", player: { operatorId: auth.operator.operatorId } },
      select: { playerId: true, stake: true },
    });

    const confirmedCount = confirmedBets.length;
    const confirmedSum = confirmedBets.reduce(
      (total, bet) => total.plus(bet.stake),
      new Prisma.Decimal(0),
    );

    // Exposure grouped per player — needed to compute each player's own
    // Available the same way GET /api/dashboard/players does, so this
    // aggregate total matches "add up every PlayerCard's Available" exactly,
    // rather than a total-minus-total shortcut that could silently diverge
    // from the per-player figures if any single player's raw available ever
    // went negative (see clampAvailableForDisplay).
    const exposureByPlayerId = confirmedBets.reduce((map, bet) => {
      const current = map.get(bet.playerId) ?? new Prisma.Decimal(0);
      map.set(bet.playerId, current.plus(bet.stake));
      return map;
    }, new Map<string, Prisma.Decimal>());

    const totalAvailable = players.reduce((total, player) => {
      const exposure = exposureByPlayerId.get(player.id) ?? new Prisma.Decimal(0);
      const rawAvailable = computeRemainingCredit(player).minus(exposure);
      const clamped = clampAvailableForDisplay(rawAvailable, `player:${player.id}`);
      return total.plus(clamped);
    }, new Prisma.Decimal(0));

    // Period P/L — sum of every Transaction (BET_PAYOUT/BET_STAKE/
    // ADJUSTMENT, written only by lib/bets/settleBet.ts) created since the
    // current settlement period started. Transaction.amount already carries
    // the correctly-signed delta (+netProfit for a win, -stake for a loss,
    // 0 for a void) — this is a straight sum, no re-derivation of the
    // WIN/LOSS/VOID math, which stays exclusively in settleBet.ts.
    const { start: periodStart, nextSettlementDate } = getCurrentSettlementPeriodBounds();

    const periodTransactions = await prismaClient.transaction.findMany({
      where: { createdAt: { gte: periodStart }, player: { operatorId: auth.operator.operatorId } },
      select: { amount: true },
    });

    const periodPnl = periodTransactions.reduce(
      (total, transaction) => total.plus(transaction.amount),
      new Prisma.Decimal(0),
    );

    return NextResponse.json({
      activePlayers: players.length,
      totalRemainingCredit: totalRemainingCredit.toString(),
      totalAvailable: totalAvailable.toString(),
      pendingBetsCount,
      pendingBetsSum: pendingBetsSum.toString(),
      confirmedCount,
      confirmedSum: confirmedSum.toString(),
      periodPnl: periodPnl.toString(),
      settlementPeriod: {
        start: periodStart.toISOString(),
        nextSettlementDate: nextSettlementDate.toISOString(),
      },
    });
  } catch (err) {
    console.error("GET /api/dashboard/overview failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleDashboardOverview(request);
}
