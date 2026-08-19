import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized, getScopedOperatorId } from "@/lib/auth/operatorAuth";
import { serializeBet, serializeOddsSnapshot } from "@/lib/bets/serialize";

// Sector 0 (ADR-0002) — DI options exported so a route test can inject an
// in-memory fake db instead of hitting the real, single shared database,
// same shape as app/api/bets/[id]/confirm/route.ts's HandleBetConfirmOptions.
// GET itself always calls this with no overrides.
export interface HandleBetsPendingOptions {
  db?: PrismaClient;
}

export async function handleBetsPending(
  request: NextRequest,
  options: HandleBetsPendingOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sector 0 (ADR-0002) — scope to the calling operator when the trusted
  // dashboard proxy set one; see getScopedOperatorId's own comment for why
  // its absence (a hypothetical direct OPERATOR_SECRET caller) intentionally
  // preserves the prior unscoped behavior instead of failing.
  const scopedOperatorId = getScopedOperatorId(request);
  const db = options.db ?? prisma;

  try {
    const bets = await db.bet.findMany({
      where: {
        status: "PENDING",
        ...(scopedOperatorId !== null ? { player: { operatorId: scopedOperatorId } } : {}),
      },
      include: {
        player: { select: { id: true, name: true } },
        oddsSnapshot: true,
        // Stage 12.2 — deterministic leg order, oldest first (submission
        // order), same as GET /api/miniapp/me.
        selections: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });

    const serialized = bets.map(({ oddsSnapshot, ...bet }) => ({
      ...serializeBet(bet),
      oddsSnapshot: oddsSnapshot ? serializeOddsSnapshot(oddsSnapshot) : null,
    }));

    return NextResponse.json({ bets: serialized });
  } catch (err) {
    console.error("GET /api/bets/pending failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleBetsPending(request);
}
