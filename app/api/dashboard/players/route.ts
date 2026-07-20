import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { requireOperatorApi } from "@/lib/auth/requireOperator";
import { computeRemainingCredit } from "@/lib/players/credit";

const SETTLEMENT_TIME_ZONE = "Europe/Zurich";

function getZurichToday(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SETTLEMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month) - 1, // 0-indexed, to match Date's month argument
    day: Number(map.day),
  };
}

// Settlement runs on the 15th and on the last day of the month. Boundaries
// are built from Europe/Zurich's calendar date (via Intl.DateTimeFormat, not
// the server's UTC clock), then represented as UTC midnight of that date —
// simpler than resolving the exact CET/CEST instant, at the cost of up to a
// ~1-2h imprecision right at the boundary (Zurich midnight isn't UTC
// midnight). Acceptable for a "next settlement date" display; would need a
// real offset calculation if bet-level precision at the boundary hour ever
// matters. Stage 6.1: this date is display-only (shown on the player card)
// — it no longer bounds which bets are returned (see below).
function getNextSettlementDate(): Date {
  const { year, month, day } = getZurichToday();

  if (day <= 15) {
    return new Date(Date.UTC(year, month, 15));
  }

  // Day 0 of next month = last calendar day of this month; Date handles
  // 28/29/30/31 and the December-into-January rollover on its own.
  return new Date(Date.UTC(year, month + 1, 0));
}

export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  try {
    const nextSettlementDate = getNextSettlementDate();

    // Stage 6.1: the player card shows "Active Bets" (CONFIRMED) and
    // "History" (everything else already resolved) as two tabs — PENDING is
    // deliberately excluded at the query level (`status: { not: "PENDING" }`)
    // so it can never appear in the player card no matter what the UI does
    // with it; PENDING only ever shows in the separate Pending Bets queue
    // (GET /api/dashboard/bets/pending). No longer bounded by the current
    // settlement period — the card is meant to show the player's real
    // lifecycle end to end, not just this period's activity.
    const players = await prisma.player.findMany({
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
            selections: true,
          },
        },
      },
    });

    // Exposure = sum of stake across a player's CONFIRMED bets ("in play"
    // money) — also doubles as each player's Active Bets count. One query
    // for all players, grouped by playerId via reduce — same explicit-sum
    // approach as the correctness-sensitive totals in
    // /api/dashboard/overview, not a SQL groupBy/aggregate.
    const confirmedBets = await prisma.bet.findMany({
      where: { status: "CONFIRMED" },
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

    const serialized = players.map((player) => {
      const exposure = exposureByPlayerId.get(player.id) ?? new Prisma.Decimal(0);
      const available = computeRemainingCredit(player).minus(exposure);

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
        nextSettlementDate: nextSettlementDate.toISOString(),
        activeBets: player.bets.filter((bet) => bet.status === "CONFIRMED").map(serializeBet),
        history: player.bets.filter((bet) => bet.status !== "CONFIRMED").map(serializeBet),
      };
    });

    return NextResponse.json({ players: serialized });
  } catch (err) {
    console.error("GET /api/dashboard/players failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
