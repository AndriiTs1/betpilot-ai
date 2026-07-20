import "dotenv/config";
import { PrismaClient, Prisma } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";

// Stage 6.1 — resets the shared database down to a single clean player
// (Andrii) so the full bet lifecycle can be exercised end to end against a
// known-empty starting state. This project has one shared Neon database, no
// separate test/staging copy (see docs/decisions/ADR-0001-project-history.md)
// — this script is deliberately narrow about exactly what it keeps rather
// than a generic "wipe everything" reset, and aborts without writing
// anything if its one safety check doesn't match.
//
// Keeps: exactly the one Player matched below (name + phone, not name
// alone — Player.name isn't a unique column), with creditLimit=10000 /
// currentCredit=0 and its existing telegramId/phoneNumber untouched.
// Deletes: every other Player, every Bet (any status), and every
// OddsSnapshot / BetSelection / Transaction / Message / Wallet row.
// Operator rows are never touched — this environment already has exactly
// one, per a prior read-only check.
//
// Usage:
//   npx tsx scripts/reset-test-data.ts --dry-run   (report only, no writes)
//   npx tsx scripts/reset-test-data.ts             (real run)

const KEEP_PLAYER_NAME = "Andrii";
const KEEP_PLAYER_PHONE = "+380984833888";
const RESET_CREDIT_LIMIT = "10000";
const RESET_CURRENT_CREDIT = "0";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  const keepPlayer = await prisma.player.findFirst({
    where: { name: KEEP_PLAYER_NAME, phoneNumber: KEEP_PLAYER_PHONE },
  });

  if (!keepPlayer) {
    console.error(
      `Could not find the player to keep (name="${KEEP_PLAYER_NAME}", phone="${KEEP_PLAYER_PHONE}") — aborting without making any changes.`,
    );
    process.exitCode = 1;
    return;
  }

  const otherPlayers = await prisma.player.findMany({
    where: { id: { not: keepPlayer.id } },
    select: { id: true, name: true },
  });

  const [betsCount, oddsSnapshotsCount, betSelectionsCount, transactionsCount, messagesCount, walletsCount] =
    await Promise.all([
      prisma.bet.count(),
      prisma.oddsSnapshot.count(),
      prisma.betSelection.count(),
      prisma.transaction.count(),
      prisma.message.count(),
      prisma.wallet.count(),
    ]);

  console.log(`Keeping player: ${keepPlayer.name} (${keepPlayer.id}, phone ${keepPlayer.phoneNumber})`);
  console.log(
    `Players to delete (${otherPlayers.length}): ${otherPlayers.map((p) => `${p.name} (${p.id})`).join(", ") || "none"}`,
  );
  console.log(
    `Will delete: ${betsCount} bets, ${oddsSnapshotsCount} odds snapshots, ${betSelectionsCount} bet selections, ` +
      `${transactionsCount} transactions, ${messagesCount} messages, ${walletsCount} wallets.`,
  );
  console.log(`Will reset ${keepPlayer.name}: creditLimit=${RESET_CREDIT_LIMIT}, currentCredit=${RESET_CURRENT_CREDIT}.`);

  if (isDryRun) {
    console.log("Dry run — no changes made.");
    return;
  }

  // Single all-or-nothing transaction, ordered child-before-parent so no
  // step can fail on a foreign-key constraint (BetSelection/OddsSnapshot ->
  // Bet, Transaction/Message/Wallet -> Player, Bet -> Player).
  await prisma.$transaction([
    prisma.oddsSnapshot.deleteMany({}),
    prisma.betSelection.deleteMany({}),
    prisma.transaction.deleteMany({}),
    prisma.message.deleteMany({}),
    prisma.bet.deleteMany({}),
    prisma.wallet.deleteMany({}),
    prisma.player.deleteMany({ where: { id: { not: keepPlayer.id } } }),
    prisma.player.update({
      where: { id: keepPlayer.id },
      data: {
        creditLimit: new Prisma.Decimal(RESET_CREDIT_LIMIT),
        currentCredit: new Prisma.Decimal(RESET_CURRENT_CREDIT),
      },
    }),
  ]);

  console.log("Cleanup complete.");
}

main()
  .catch((err) => {
    console.error("reset-test-data failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
