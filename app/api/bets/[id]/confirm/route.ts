import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { serializeBet } from "@/lib/bets/serialize";
import { sendTelegramMessage } from "@/lib/telegram/sendMessage";
import { escapeHtml } from "@/lib/telegram/escapeHtml";
import { computeRemainingCredit } from "@/lib/players/credit";

class InsufficientCreditError extends Error {}
class BetNoLongerPendingError extends Error {}
class PlayerNotFoundError extends Error {}

function isRecordNotFoundError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

export interface HandleBetConfirmOptions {
  db?: PrismaClient;
}

// Exported and DI-friendly (same shape as
// app/api/bets/[id]/settle/route.ts's handleSettleBet) so a route test can
// inject an in-memory fake instead of hitting the real, single shared
// database. POST itself always calls this with no overrides.
export async function handleBetConfirm(
  request: NextRequest,
  id: string,
  options: HandleBetConfirmOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = options.db ?? prisma;

  try {
    const existing = await db.bet.findUnique({
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

    const result = await db.$transaction(async (tx) => {
      // Row lock on this player, held for the rest of this transaction —
      // closes a write-skew race where two concurrent confirms for two
      // *different* PENDING bets belonging to the same player could each
      // compute exposure before the other commits, both pass the credit
      // check, and both commit even though their combined stake exceeds
      // the limit (the previous single-bet conditional update below only
      // ever guarded the *same* bet against a double-confirm, not this).
      // Prisma has no query-builder API for `SELECT ... FOR UPDATE`, so
      // this one line is raw SQL; a second concurrent transaction's own
      // lock acquisition for the same player blocks here until this
      // transaction commits or rolls back, so by the time it reads
      // exposure below, it already reflects this transaction's outcome.
      const [lockedPlayer] = await tx.$queryRaw<
        { id: string; creditLimit: Prisma.Decimal; currentCredit: Prisma.Decimal }[]
      >`SELECT id, "creditLimit", "currentCredit" FROM "Player" WHERE id = ${existing.playerId} FOR UPDATE`;

      if (!lockedPlayer) throw new PlayerNotFoundError();

      // Exposure = sum of stake across this player's other CONFIRMED bets.
      // The bet being confirmed here is still PENDING at this point, so
      // it's naturally excluded without an explicit id filter. Read after
      // acquiring the lock above, so a concurrent confirm that was waiting
      // on it is now guaranteed to be fully committed (or rolled back) —
      // never a stale, pre-commit snapshot.
      const exposureAgg = await tx.bet.aggregate({
        where: { playerId: existing.playerId, status: "CONFIRMED" },
        _sum: { stake: true },
      });
      const exposure = exposureAgg._sum.stake ?? new Prisma.Decimal(0);

      const remainingCredit = computeRemainingCredit(lockedPlayer);

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
          // Stage 12 — event/outcome are nullable as of this migration (an
          // EXPRESS bet has no single event/outcome), but nothing creates an
          // EXPRESS bet yet, so every real row still has both set. The
          // fallback exists only to satisfy the now-nullable type, not
          // because this path is expected to hit it today.
          `🟢 <b>Ставка подтверждена!</b>\n⚽ ${escapeHtml(existing.event ?? "—")}\n🎯 ${escapeHtml(existing.outcome ?? "—")}\n💰 Ставка: ${existing.stake.toString()}`,
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return handleBetConfirm(request, id);
}
