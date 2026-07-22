import type { PrismaClient } from "@/lib/generated/prisma/client";

// Closed-demo onboarding: an operator invites a player by creating a Player
// row up front with a known telegramUsername and telegramId left null (see
// scripts/invite-player.ts). The very first time that real Telegram account
// sends /start, this module binds the two together permanently. From then
// on, Mini App authentication (GET /api/miniapp/me) never looks at
// telegramUsername again — it only ever matches signed initData's user.id
// against telegramId, exactly as it did before this feature existed.

// Telegram usernames are case-insensitive and never include the leading
// "@" in from.username (Bot API sends it bare) — this strips one defensively
// anyway, since a human-entered value (e.g. an operator's invite script
// input) commonly does include it.
export function normalizeTelegramUsername(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

export type BindInvitedPlayerOutcome =
  // This exact Telegram account is already linked to a Player (either it
  // was just bound by an earlier /start, or it always had a telegramId,
  // e.g. an operator-created non-invited player). Nothing was written.
  | { kind: "already_bound_by_telegram_id"; playerId: string }
  // No username on the incoming update (or it normalized to empty) — never
  // reachable through legitimate Telegram Bot API messages, but from.username
  // is genuinely optional, so this is a real, expected case.
  | { kind: "no_username" }
  // Username didn't match any invited (telegramId: null) Player row — either
  // nobody was invited under that username, or a row exists but is already
  // bound to a different Telegram account (never re-bindable, by design).
  | { kind: "no_invited_match" }
  // Bound just now.
  | { kind: "bound"; playerId: string };

// The one write this module performs is a single UPDATE with both
// telegramUsername and telegramId: null in its WHERE clause — that's what
// makes the bind atomic and race-safe without a $transaction: two concurrent
// calls for the same real Telegram account both race the same row, but
// Postgres serializes the two UPDATEs, so only the first actually matches
// (telegramId is no longer null by the time the second runs) and the second
// naturally updates zero rows. Same reasoning rules out ever reassigning an
// already-bound row to a different Telegram account — the WHERE clause
// simply stops matching once telegramId is set, permanently.
export async function bindInvitedPlayerByTelegramUsername(
  db: PrismaClient,
  telegramId: string,
  rawUsername: string | null | undefined,
): Promise<BindInvitedPlayerOutcome> {
  const existing = await db.player.findUnique({ where: { telegramId }, select: { id: true } });
  if (existing) {
    return { kind: "already_bound_by_telegram_id", playerId: existing.id };
  }

  const username = normalizeTelegramUsername(rawUsername);
  if (!username) {
    return { kind: "no_username" };
  }

  const result = await db.player.updateMany({
    where: { telegramUsername: username, telegramId: null },
    data: { telegramId },
  });

  if (result.count === 0) {
    return { kind: "no_invited_match" };
  }

  // updateMany doesn't return the row(s) it touched — a second read is the
  // simplest way to hand the caller a playerId, and by now telegramId is
  // exactly this value on at most one row (telegramId is @unique).
  const bound = await db.player.findUnique({ where: { telegramId }, select: { id: true } });

  // Not expected to be null (the updateMany above just set it), but typed
  // as nullable by Prisma regardless — treat the impossible case the same
  // as "match found and bound" rather than asserting.
  return { kind: "bound", playerId: bound?.id ?? "" };
}
