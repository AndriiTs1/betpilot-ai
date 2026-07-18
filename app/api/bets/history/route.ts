import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { serializeBet, serializeOddsSnapshot } from "@/lib/bets/serialize";

export async function GET(request: NextRequest) {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const bets = await prisma.bet.findMany({
      where: { status: { not: "PENDING" } },
      include: {
        player: { select: { id: true, name: true } },
        oddsSnapshot: true,
        selections: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });

    const serialized = bets.map(({ oddsSnapshot, ...bet }) => ({
      ...serializeBet(bet),
      oddsSnapshot: oddsSnapshot ? serializeOddsSnapshot(oddsSnapshot) : null,
    }));

    return NextResponse.json({ bets: serialized });
  } catch (err) {
    console.error("GET /api/bets/history failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
