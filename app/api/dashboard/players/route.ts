import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { requireOperatorApi } from "@/lib/auth/requireOperator";

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
// midnight). Acceptable for a "which bets are in this period" display; would
// need a real offset calculation if bet-level precision at the boundary
// hour ever matters.
function getSettlementPeriod(): { periodStart: Date; nextSettlementDate: Date } {
  const { year, month, day } = getZurichToday();

  if (day <= 15) {
    return {
      periodStart: new Date(Date.UTC(year, month, 1)),
      nextSettlementDate: new Date(Date.UTC(year, month, 15)),
    };
  }

  return {
    periodStart: new Date(Date.UTC(year, month, 16)),
    // Day 0 of next month = last calendar day of this month; Date handles
    // 28/29/30/31 and the December-into-January rollover on its own.
    nextSettlementDate: new Date(Date.UTC(year, month + 1, 0)),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireOperatorApi(request);
  if (!auth.ok) return auth.response;

  try {
    const { periodStart, nextSettlementDate } = getSettlementPeriod();

    const players = await prisma.player.findMany({
      select: {
        id: true,
        name: true,
        telegramId: true,
        phoneNumber: true,
        creditLimit: true,
        currentCredit: true,
        _count: { select: { bets: true } },
        bets: {
          where: { createdAt: { gte: periodStart } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            sport: true,
            event: true,
            outcome: true,
            stake: true,
            odds: true,
            status: true,
            createdAt: true,
            selections: true,
          },
        },
      },
    });

    // Exposure = sum of stake across a player's CONFIRMED bets ("in play"
    // money). One query for all players, grouped by playerId via reduce —
    // same explicit-sum approach as the correctness-sensitive totals in
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

    const serialized = players.map((player) => ({
      id: player.id,
      name: player.name,
      telegramId: player.telegramId,
      phoneNumber: player.phoneNumber,
      creditLimit: player.creditLimit.toString(),
      currentCredit: player.currentCredit.toString(),
      totalBets: player._count.bets,
      exposure: (exposureByPlayerId.get(player.id) ?? new Prisma.Decimal(0)).toString(),
      nextSettlementDate: nextSettlementDate.toISOString(),
      recentBets: player.bets.map((bet) => ({
        id: bet.id,
        sport: bet.sport,
        event: bet.event,
        outcome: bet.outcome,
        stake: bet.stake.toString(),
        odds: bet.odds ? bet.odds.toString() : null,
        status: bet.status,
        createdAt: bet.createdAt.toISOString(),
        selections: bet.selections,
      })),
    }));

    return NextResponse.json({ players: serialized });
  } catch (err) {
    console.error("GET /api/dashboard/players failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
