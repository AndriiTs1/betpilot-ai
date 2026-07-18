import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { verifyInitData } from "@/lib/telegram/verifyInitData";
import { computeRemainingCredit } from "@/lib/players/credit";
import { serializeBet } from "@/lib/bets/serialize";

const RECENT_BETS_LIMIT = 20;

function extractInitData(request: NextRequest): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "tma" || !value) return null;

  return value;
}

export async function GET(request: NextRequest) {
  const initData = extractInitData(request);
  if (!initData) {
    return NextResponse.json({ error: "malformed" }, { status: 401 });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("GET /api/miniapp/me: TELEGRAM_BOT_TOKEN is not set");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }

  const verification = verifyInitData(initData, botToken);

  if (!verification.ok) {
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  try {
    const player = await prisma.player.findUnique({
      where: { telegramId: String(verification.user.id) },
    });

    if (!player) {
      return NextResponse.json({ error: "PLAYER_NOT_FOUND" }, { status: 404 });
    }

    const [confirmedAgg, pendingAgg, recentBets] = await Promise.all([
      prisma.bet.aggregate({
        where: { playerId: player.id, status: "CONFIRMED" },
        _sum: { stake: true },
      }),
      prisma.bet.aggregate({
        where: { playerId: player.id, status: "PENDING" },
        _sum: { stake: true },
      }),
      prisma.bet.findMany({
        where: { playerId: player.id },
        orderBy: { createdAt: "desc" },
        take: RECENT_BETS_LIMIT,
        include: { selections: true },
      }),
    ]);

    const exposure = confirmedAgg._sum.stake ?? new Prisma.Decimal(0);
    // Sum of PENDING stakes — informational only ("awaiting review"), does
    // not factor into availableCredit; only CONFIRMED exposure counts
    // against the limit, same as in the confirm route.
    const pendingExposure = pendingAgg._sum.stake ?? new Prisma.Decimal(0);
    const remainingCredit = computeRemainingCredit(player);
    const availableCredit = remainingCredit.minus(exposure);

    return NextResponse.json({
      player: { id: player.id, name: player.name },
      creditLimit: player.creditLimit.toString(),
      currentCredit: player.currentCredit.toString(),
      remainingCredit: remainingCredit.toString(),
      exposure: exposure.toString(),
      pendingExposure: pendingExposure.toString(),
      availableCredit: availableCredit.toString(),
      recentBets: recentBets.map(serializeBet),
    });
  } catch (err) {
    console.error("GET /api/miniapp/me failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
