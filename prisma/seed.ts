import "dotenv/config";
import { PrismaClient, Prisma } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const TEST_OPERATOR_PHONE = "+10000000000";

const NEW_PLAYERS = [
  { name: "Andrii", phoneNumber: "+380984833888" },
  { name: "Zegna", phoneNumber: "+41764757408" },
] as const;

// Cascade-delete a player and everything that references them, in FK-safe
// order (OddsSnapshot -> Transaction/Message -> Bet -> Wallet -> Player).
async function removePlayerByName(name: string) {
  const player = await prisma.player.findFirst({ where: { name } });
  if (!player) return;

  const bets = await prisma.bet.findMany({
    where: { playerId: player.id },
    select: { id: true },
  });
  const betIds = bets.map((bet) => bet.id);

  await prisma.oddsSnapshot.deleteMany({ where: { betId: { in: betIds } } });
  await prisma.transaction.deleteMany({ where: { playerId: player.id } });
  await prisma.message.deleteMany({ where: { playerId: player.id } });
  await prisma.bet.deleteMany({ where: { playerId: player.id } });
  await prisma.wallet.deleteMany({ where: { playerId: player.id } });
  await prisma.player.delete({ where: { id: player.id } });

  console.log(`Removed player "${name}" (${player.id}) and related records`);
}

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

  // Telegram-migration cleanup: Vadim was the WhatsApp-era fixture
  // (identified by whatsappId, which the schema no longer has). Remove him
  // and everything attached to him; a no-op once he's gone.
  await removePlayerByName("Vadim");

  // telegramId is unique but null for both players until they message the
  // bot, and phoneNumber has no unique constraint (informational only) —
  // neither works as an upsert key, so match by name instead, same as the
  // Vadim removal above.
  for (const { name, phoneNumber } of NEW_PLAYERS) {
    const existing = await prisma.player.findFirst({ where: { name } });

    const data = {
      name,
      phoneNumber,
      telegramId: null,
      creditLimit: new Prisma.Decimal("10000"),
      currentCredit: new Prisma.Decimal("0"),
    };

    const player = existing
      ? await prisma.player.update({ where: { id: existing.id }, data })
      : await prisma.player.create({ data: { ...data, operatorId: operator.id } });

    console.log(`Player ready: ${player.id} (${player.name})`);
  }
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
