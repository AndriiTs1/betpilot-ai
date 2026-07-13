import "dotenv/config";
import { PrismaClient, Prisma } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TEST_OPERATOR_PHONE = "+10000000000";
const TEST_PLAYER_1_WHATSAPP_ID = "test-player-1";
const TEST_PLAYER_2_WHATSAPP_ID = "test-player-2";
const TEST_BET_RAW_MESSAGE = "Реал Мадрид победа 2.1 ставлю 50";

async function main() {
  const operator = await prisma.operator.upsert({
    where: { phone: TEST_OPERATOR_PHONE },
    update: {},
    create: {
      name: "Test Operator",
      phone: TEST_OPERATOR_PHONE,
    },
  });

  console.log(`Operator ready: ${operator.id}`);

  const player1 = await prisma.player.upsert({
    where: { whatsappId: TEST_PLAYER_1_WHATSAPP_ID },
    update: {},
    create: {
      name: "Test Player 1",
      whatsappId: TEST_PLAYER_1_WHATSAPP_ID,
      operatorId: operator.id,
    },
  });

  const player2 = await prisma.player.upsert({
    where: { whatsappId: TEST_PLAYER_2_WHATSAPP_ID },
    update: {},
    create: {
      name: "Test Player 2",
      whatsappId: TEST_PLAYER_2_WHATSAPP_ID,
      operatorId: operator.id,
    },
  });

  console.log(`Players ready: ${player1.id}, ${player2.id}`);

  // Reset both wallets to 500 USDC on every run, so the fixture below is
  // always testable from a known balance regardless of prior manual
  // Confirm/Reject runs against it.
  for (const player of [player1, player2]) {
    await prisma.wallet.upsert({
      where: { playerId: player.id },
      update: { balance: new Prisma.Decimal("500") },
      create: {
        playerId: player.id,
        balance: new Prisma.Decimal("500"),
      },
    });
  }

  console.log("Wallets ready: 500 USDC each");

  // Bet has no natural unique key to upsert on, so identify the seeded test
  // bet by (playerId, rawMessage) and reset it back to PENDING on every run.
  // This makes the script both idempotent and repeatable for manual
  // Confirm/Reject testing: run it again after confirming/rejecting via the
  // dashboard to get the same bet back in a fresh PENDING state.
  const existingBet = await prisma.bet.findFirst({
    where: { playerId: player1.id, rawMessage: TEST_BET_RAW_MESSAGE },
  });

  const betData = {
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    odds: new Prisma.Decimal("2.10"),
    stake: new Prisma.Decimal("50"),
    status: "PENDING" as const,
    rawMessage: TEST_BET_RAW_MESSAGE,
  };

  const bet = existingBet
    ? await prisma.bet.update({ where: { id: existingBet.id }, data: betData })
    : await prisma.bet.create({ data: { ...betData, playerId: player1.id } });

  await prisma.oddsSnapshot.upsert({
    where: { betId: bet.id },
    update: {
      sourceOdds: new Prisma.Decimal("2.05"),
      submittedOdds: new Prisma.Decimal("2.10"),
      matched: false,
    },
    create: {
      betId: bet.id,
      sourceOdds: new Prisma.Decimal("2.05"),
      submittedOdds: new Prisma.Decimal("2.10"),
      matched: false,
    },
  });

  console.log(`Bet ready: ${bet.id} (status: PENDING)`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
