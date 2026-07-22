import "dotenv/config";
import { PrismaClient } from "../lib/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { normalizeTelegramUsername } from "../lib/telegram/bindInvitedPlayer";

// Closed-demo player onboarding — creates an "invited" Player row before
// they've ever opened the bot: telegramId stays null until they actually
// send /start with a matching Telegram username, at which point
// lib/telegram/bindInvitedPlayer.ts binds it permanently (see that file's
// own comment for why this is safe and race-free). Manual, one-off — same
// "run locally with production DATABASE_URL access, adds no new
// internet-facing attack surface" reasoning as scripts/create-operator.ts.
//
// Safe to re-run: upserts by the unique telegramUsername, and the update
// branch never touches telegramId — an already-bound player can't be
// unbound or reassigned by re-running this script.
//
// Usage:
//   PLAYER_NAME="Denis" PLAYER_TELEGRAM_USERNAME="kda0508" \
//   PLAYER_PHONE="+380676210203" OPERATOR_PHONE="+10000000000" \
//   npm run player:invite
//
// PLAYER_CREDIT_LIMIT / PLAYER_CURRENT_CREDIT are optional, defaulting to
// this project's existing standard demo values (10000 / 0 — see
// Player.creditLimit/.currentCredit's own @default in prisma/schema.prisma).

const DEFAULT_CREDIT_LIMIT = "10000";
const DEFAULT_CURRENT_CREDIT = "0";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const name = process.env.PLAYER_NAME?.trim();
  const rawUsername = process.env.PLAYER_TELEGRAM_USERNAME?.trim();
  const phoneNumber = process.env.PLAYER_PHONE?.trim();
  const operatorPhone = process.env.OPERATOR_PHONE?.trim();
  const creditLimit = process.env.PLAYER_CREDIT_LIMIT?.trim() || DEFAULT_CREDIT_LIMIT;
  const currentCredit = process.env.PLAYER_CURRENT_CREDIT?.trim() || DEFAULT_CURRENT_CREDIT;

  if (!name || !rawUsername || !phoneNumber || !operatorPhone) {
    console.error(
      "Missing required environment variables. Set PLAYER_NAME, PLAYER_TELEGRAM_USERNAME, PLAYER_PHONE, and OPERATOR_PHONE.",
    );
    process.exitCode = 1;
    return;
  }

  const telegramUsername = normalizeTelegramUsername(rawUsername);
  if (!telegramUsername) {
    console.error(`PLAYER_TELEGRAM_USERNAME "${rawUsername}" normalized to empty — not a valid Telegram username.`);
    process.exitCode = 1;
    return;
  }

  const operator = await prisma.operator.findUnique({ where: { phone: operatorPhone } });
  if (!operator) {
    console.error(`No operator found with phone "${operatorPhone}" — create one first (npm run operator:create).`);
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.player.findUnique({ where: { telegramUsername } });

  const player = await prisma.player.upsert({
    where: { telegramUsername },
    // telegramId intentionally omitted from both branches: create leaves it
    // at its schema default (null, i.e. "invited, not yet bound"); update
    // never touches it, so a player who already bound via /start can never
    // be un-bound or reassigned by re-running this script.
    create: {
      operatorId: operator.id,
      name,
      telegramUsername,
      phoneNumber,
      creditLimit,
      currentCredit,
    },
    update: {
      name,
      phoneNumber,
      creditLimit,
      currentCredit,
    },
  });

  console.log(
    existing
      ? `Updated existing invited player "${player.name}" (@${telegramUsername}, id ${player.id}). telegramId: ${player.telegramId ?? "still unbound"}.`
      : `Invited new player "${player.name}" (@${telegramUsername}, id ${player.id}). Awaiting their first /start to bind telegramId.`,
  );
}

main()
  .catch((err) => {
    console.error("player:invite failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
