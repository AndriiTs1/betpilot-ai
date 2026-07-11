import { Message } from "@/types/message";
import { handleIncomingBet } from "@/lib/whatsapp/betHandler";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/lib/generated/prisma/client";

export async function processBet(message: Message) {
  // 1. Получаем и анализируем ставку
  const result = await handleIncomingBet(message);

  const { bet, oddsCheck } = result;

  // 1a. AI не смогла распознать ставку в сообщении

  if (!bet.valid) {
    return {
      status: "PARSE_FAILED",

      error: bet.error,
    };
  }

  // 2. Находим игрока и его кошелёк

  let player;

  try {
    player = await prisma.player.findUnique({
      where: { id: message.playerId },
      include: { wallet: true },
    });
  } catch (err) {
    return {
      status: "DB_ERROR",

      error: err instanceof Error ? err.message : "Unknown database error",
    };
  }

  if (!player) {
    return { status: "PLAYER_NOT_FOUND" };
  }

  if (!player.wallet) {
    return {
      status: "DB_ERROR",

      error: `Player ${player.id} has no wallet`,
    };
  }

  // 3. Проверяем баланс — сравнение через Prisma Decimal (decimal.js),
  // без приведения к number, чтобы не терять точность.

  const stake = new Prisma.Decimal(bet.stake);
  const hasBalance = player.wallet.balance.gte(stake);

  if (!hasBalance) {
    return { status: "INSUFFICIENT_BALANCE" };
  }

  // 4. Создаём Bet + OddsSnapshot атомарно.
  //
  // Баланс не списываем и Transaction (BET_STAKE) не создаём здесь: по
  // MVP.md баланс обновляется после подтверждения оператором
  // ("Admin Confirmation -> Bet Saved -> Balance Updated"), а не на приёме
  // заявки — эта функция только сохраняет заявку в статусе PENDING.

  try {
    const { createdBet, createdSnapshot } = await prisma.$transaction(async (tx) => {
      const createdBet = await tx.bet.create({
        data: {
          playerId: player.id,
          sport: bet.sport,
          event: bet.event,
          outcome: bet.selection,
          odds: bet.odds !== null ? new Prisma.Decimal(bet.odds) : null,
          stake,
          status: "PENDING",
          rawMessage: message.text,
        },
      });

      const createdSnapshot = oddsCheck
        ? await tx.oddsSnapshot.create({
            data: {
              betId: createdBet.id,
              sourceOdds:
                oddsCheck.sourceOdds !== null ? new Prisma.Decimal(oddsCheck.sourceOdds) : null,
              submittedOdds: new Prisma.Decimal(oddsCheck.submittedOdds),
              matched: oddsCheck.matched,
            },
          })
        : null;

      return { createdBet, createdSnapshot };
    });

    return {
      status: "WAITING_CONFIRMATION",

      bet: createdBet,

      oddsSnapshot: createdSnapshot,

      oddsCheck,
    };
  } catch (err) {
    return {
      status: "DB_ERROR",

      error: err instanceof Error ? err.message : "Unknown database error",
    };
  }
}
