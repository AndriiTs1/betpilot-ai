import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { serializeBet } from "@/lib/bets/serialize";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";

class InsufficientCreditError extends Error {}
class BetNoLongerPendingError extends Error {}

function isRecordNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

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

    const stake = existing.stake;

    const result = await prisma.$transaction(async (tx) => {
      // Exposure = sum of stake across this player's other CONFIRMED bets.
      // The bet being confirmed here is still PENDING at this point, so it's
      // naturally excluded without an explicit id filter.
      const exposureAgg = await tx.bet.aggregate({
        where: { playerId: existing.playerId, status: "CONFIRMED" },
        _sum: { stake: true },
      });
      const exposure = exposureAgg._sum.stake ?? new Prisma.Decimal(0);

      const remainingCredit = existing.player.currentCredit.lt(0)
        ? existing.player.creditLimit.plus(existing.player.currentCredit)
        : existing.player.creditLimit;

      const available = remainingCredit.minus(exposure);

      if (available.lt(stake)) {
        throw new InsufficientCreditError();
      }

      // Atomic conditional status flip: guards against a concurrent
      // confirm/reject request that already moved this bet off PENDING.
      let updatedBet;
      try {
        updatedBet = await tx.bet.update({
          where: { id: existing.id, status: "PENDING" },
          data: { status: "CONFIRMED" },
        });
      } catch (err) {
        if (isRecordNotFoundError(err)) throw new BetNoLongerPendingError();
        throw err;
      }

      // Available credit after this bet joins CONFIRMED exposure.
      const remainingCreditAfter = available.minus(stake);

      return { bet: updatedBet, remainingCreditAfter };
    });

    if (existing.player.telegramId) {
      try {
        await sendTelegramMessage(
          existing.player.telegramId,
          `Ваша ставка подтверждена! ${existing.event} — ${existing.outcome}, ставка ${existing.stake.toString()}`,
        );
      } catch (err) {
        console.error(`POST /api/bets/${id}/confirm: failed to notify player via Telegram`, err);
      }
    }

    return NextResponse.json({
      bet: serializeBet(result.bet),
      remainingCredit: result.remainingCreditAfter.toString(),
    });
  } catch (err) {
    if (err instanceof InsufficientCreditError) {
      return NextResponse.json(
        { error: "Недостаточно доступного кредита" },
        { status: 409 },
      );
    }

    if (err instanceof BetNoLongerPendingError) {
      return NextResponse.json(
        { error: "Bet status changed concurrently and is no longer pending" },
        { status: 409 },
      );
    }

    console.error(`POST /api/bets/${id}/confirm failed:`, err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
