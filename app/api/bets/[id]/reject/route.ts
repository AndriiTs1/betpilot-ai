import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { serializeBet } from "@/lib/bets/serialize";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { escapeHtml } from "@/lib/telegram/escapeHtml";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const existing = await prisma.bet.findUnique({
      where: { id },
      include: { player: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Bet not found" }, { status: 404 });
    }

    if (existing.status !== "PENDING") {
      return NextResponse.json(
        { error: `Bet is not pending (current status: ${existing.status})` },
        { status: 409 },
      );
    }

    let updatedBet;

    try {
      updatedBet = await prisma.bet.update({
        where: { id, status: "PENDING" },
        data: { status: "REJECTED" },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return NextResponse.json(
          { error: "Bet status changed concurrently and is no longer pending" },
          { status: 409 },
        );
      }
      throw err;
    }

    if (existing.player.telegramId) {
      try {
        await sendTelegramMessage(
          existing.player.telegramId,
          // Stage 12 — event/outcome are nullable as of this migration (an
          // EXPRESS bet has no single event/outcome), but nothing creates an
          // EXPRESS bet yet, so every real row still has both set. The
          // fallback exists only to satisfy the now-nullable type, not
          // because this path is expected to hit it today.
          `🔴 <b>Ставка отклонена</b>\n⚽ ${escapeHtml(existing.event ?? "—")}\n🎯 ${escapeHtml(existing.outcome ?? "—")}`,
        );
      } catch (err) {
        console.error(`POST /api/bets/${id}/reject: failed to notify player via Telegram`, err);
      }
    }

    return NextResponse.json({ bet: serializeBet(updatedBet) });
  } catch (err) {
    console.error(`POST /api/bets/${id}/reject failed:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
