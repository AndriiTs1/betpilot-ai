import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { serializeBet } from "@/lib/bets/serialize";

class InsufficientBalanceError extends Error {}
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
      include: { player: { include: { wallet: true } } },
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

    if (!existing.player.wallet) {
      console.error(`POST /api/bets/${id}/confirm: player ${existing.playerId} has no wallet`);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const stake = existing.stake;

    const result = await prisma.$transaction(async (tx) => {
      // Atomic conditional decrement: only succeeds if the balance is still
      // sufficient at this exact moment, closing the race window between the
      // pending/balance check above and this write.
      let wallet;
      try {
        wallet = await tx.wallet.update({
          where: { playerId: existing.playerId, balance: { gte: stake } },
          data: { balance: { decrement: stake } },
        });
      } catch (err) {
        if (isRecordNotFoundError(err)) throw new InsufficientBalanceError();
        throw err;
      }

      const transaction = await tx.transaction.create({
        data: {
          playerId: existing.playerId,
          betId: existing.id,
          type: "BET_STAKE",
          amount: stake.negated(),
          balanceAfter: wallet.balance,
        },
      });

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

      return { bet: updatedBet, wallet, transaction };
    });

    return NextResponse.json({
      bet: serializeBet(result.bet),
      balance: result.wallet.balance.toString(),
    });
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return NextResponse.json(
        { error: "Insufficient balance to confirm this bet" },
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
