import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized, getScopedOperatorId } from "@/lib/auth/operatorAuth";
import { serializeBet, serializeOddsSnapshot } from "@/lib/bets/serialize";

// Sector 0 (ADR-0002) — same DI shape as
// app/api/bets/pending/route.ts's HandleBetsPendingOptions.
export interface HandleBetsHistoryOptions {
  db?: PrismaClient;
}

export async function handleBetsHistory(
  request: NextRequest,
  options: HandleBetsHistoryOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sector 0 (ADR-0002) — see app/api/bets/pending/route.ts's identical
  // comment on getScopedOperatorId.
  const scopedOperatorId = getScopedOperatorId(request);
  const db = options.db ?? prisma;

  try {
    const bets = await db.bet.findMany({
      where: {
        status: { not: "PENDING" },
        ...(scopedOperatorId !== null ? { player: { operatorId: scopedOperatorId } } : {}),
      },
      include: {
        player: { select: { id: true, name: true } },
        oddsSnapshot: true,
        // Stage 12.2 — deterministic leg order, oldest first (submission
        // order), same as GET /api/miniapp/me.
        selections: { orderBy: { createdAt: "asc" } },
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleBetsHistory(request);
}
