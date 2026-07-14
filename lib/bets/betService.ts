import { Message } from "@/types/message";
import { handleIncomingBet } from "@/lib/telegram/betHandler";
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

  // 2. Находим игрока

  let player;

  try {
    player = await prisma.player.findUnique({
      where: { id: message.playerId },
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

  const stake = new Prisma.Decimal(bet.stake);

  // 3. Создаём Bet + OddsSnapshot атомарно.
  //
  // Проверка кредитного лимита сюда не входит: оператор должен видеть даже
  // рискованные заявки в очереди. Лимит проверяется при подтверждении
  // (см. app/api/bets/[id]/confirm/route.ts).

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
