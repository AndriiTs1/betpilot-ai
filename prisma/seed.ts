import "dotenv/config";
import { PrismaClient, Prisma } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TEST_OPERATOR_PHONE = "+10000000000";
// whatsappId is now shown in the UI ("WhatsApp-контакт"), so it needs to be
// a real-looking number rather than the old placeholder key.
const OLD_VADIM_WHATSAPP_ID = "test-player-1";
const VADIM_WHATSAPP_ID = "+393892037766";
const LEGACY_PLAYER_2_WHATSAPP_ID = "test-player-2";
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

  // One-time migration: if a player still has the old placeholder
  // whatsappId, rename it in place. The upsert below only matches on the
  // *new* id, so without this step, re-running the seed after changing
  // VADIM_WHATSAPP_ID would create a second player instead of updating the
  // existing one.
  const legacyVadim = await prisma.player.findUnique({
    where: { whatsappId: OLD_VADIM_WHATSAPP_ID },
  });

  if (legacyVadim) {
    await prisma.player.update({
      where: { id: legacyVadim.id },
      data: { whatsappId: VADIM_WHATSAPP_ID },
    });

    console.log(
      `Migrated Vadim's whatsappId from "${OLD_VADIM_WHATSAPP_ID}" to "${VADIM_WHATSAPP_ID}"`,
    );
  }

  const vadim = await prisma.player.upsert({
    where: { whatsappId: VADIM_WHATSAPP_ID },
    update: {
      name: "Vadim",
      creditLimit: new Prisma.Decimal("10000"),
      currentCredit: new Prisma.Decimal("0"),
    },
    create: {
      name: "Vadim",
      whatsappId: VADIM_WHATSAPP_ID,
      operatorId: operator.id,
      creditLimit: new Prisma.Decimal("10000"),
      currentCredit: new Prisma.Decimal("0"),
    },
  });

  console.log(`Player ready: ${vadim.id} (${vadim.name})`);

  // Clean up a legacy "Test Player 2" from earlier seed runs, if present, so
  // the fixture is a single-player state. Deletes in FK-safe order — bets
  // may have an odds snapshot and this player may have transactions/messages
  // from earlier manual dashboard testing.
  const legacyPlayer2 = await prisma.player.findUnique({
    where: { whatsappId: LEGACY_PLAYER_2_WHATSAPP_ID },
  });

  if (legacyPlayer2) {
    const legacyBets = await prisma.bet.findMany({
      where: { playerId: legacyPlayer2.id },
      select: { id: true },
    });
    const legacyBetIds = legacyBets.map((bet) => bet.id);

    await prisma.oddsSnapshot.deleteMany({ where: { betId: { in: legacyBetIds } } });
    await prisma.transaction.deleteMany({ where: { playerId: legacyPlayer2.id } });
    await prisma.message.deleteMany({ where: { playerId: legacyPlayer2.id } });
    await prisma.bet.deleteMany({ where: { playerId: legacyPlayer2.id } });
    await prisma.wallet.deleteMany({ where: { playerId: legacyPlayer2.id } });
    await prisma.player.delete({ where: { id: legacyPlayer2.id } });

    console.log(`Removed legacy Test Player 2 (${legacyPlayer2.id}) and related records`);
  }

  // Reset the wallet to 500 USDC on every run, so the fixture is always
  // testable from a known balance regardless of prior manual
  // Confirm/Reject runs against it.
  await prisma.wallet.upsert({
    where: { playerId: vadim.id },
    update: { balance: new Prisma.Decimal("500") },
    create: {
      playerId: vadim.id,
      balance: new Prisma.Decimal("500"),
    },
  });

  console.log("Wallet ready: 500 USDC");

  // Bet has no natural unique key to upsert on, so identify the seeded test
  // bet by (playerId, rawMessage) and reset it back to PENDING on every run.
  // This makes the script both idempotent and repeatable for manual
  // Confirm/Reject testing: run it again after confirming/rejecting via the
  // dashboard to get the same bet back in a fresh PENDING state.
  const existingBet = await prisma.bet.findFirst({
    where: { playerId: vadim.id, rawMessage: TEST_BET_RAW_MESSAGE },
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
    : await prisma.bet.create({ data: { ...betData, playerId: vadim.id } });

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
