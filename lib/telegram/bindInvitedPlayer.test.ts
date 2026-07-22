import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { normalizeTelegramUsername, bindInvitedPlayerByTelegramUsername } from "./bindInvitedPlayer";

// Same hand-written-fake-db convention as
// app/api/miniapp/bets/text/confirm/route.test.ts — no mocking library.
// Only the two operations bindInvitedPlayerByTelegramUsername actually
// calls: player.findUnique (by telegramId) and player.updateMany (the
// atomic bind).

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
  telegramUsername: string | null;
}

function createFakeDb(initialPlayers: FakePlayerRow[]) {
  const players = new Map(initialPlayers.map((p) => [p.id, { ...p }]));

  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        for (const p of players.values()) {
          if (p.telegramId === where.telegramId) return { id: p.id };
        }
        return null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { telegramUsername: string; telegramId: null };
        data: { telegramId: string };
      }) => {
        let count = 0;
        for (const p of players.values()) {
          if (p.telegramUsername === where.telegramUsername && p.telegramId === where.telegramId) {
            p.telegramId = data.telegramId;
            count += 1;
          }
        }
        return { count };
      },
    },
    _debug: {
      get: (id: string) => players.get(id),
      all: () => [...players.values()],
    },
  };
}

function db(players: FakePlayerRow[]) {
  return createFakeDb(players) as unknown as PrismaClient & { _debug: ReturnType<typeof createFakeDb>["_debug"] };
}

const DENIS_ID = "player-denis";
const DENIS_USERNAME = "kda0508";
const DENIS_TELEGRAM_ID = "987654321";

function invitedDenis(): FakePlayerRow {
  return { id: DENIS_ID, telegramId: null, telegramUsername: DENIS_USERNAME };
}

// ---------------------------------------------------------------------
// normalizeTelegramUsername
// ---------------------------------------------------------------------

test("normalizeTelegramUsername: strips a leading @ and lowercases", () => {
  assert.equal(normalizeTelegramUsername("@KDA0508"), "kda0508");
  assert.equal(normalizeTelegramUsername("KDA0508"), "kda0508");
  assert.equal(normalizeTelegramUsername("  kda0508  "), "kda0508");
});

test("normalizeTelegramUsername: null/undefined/empty all normalize to null", () => {
  assert.equal(normalizeTelegramUsername(null), null);
  assert.equal(normalizeTelegramUsername(undefined), null);
  assert.equal(normalizeTelegramUsername(""), null);
  assert.equal(normalizeTelegramUsername("   "), null);
  assert.equal(normalizeTelegramUsername("@"), null);
});

// ---------------------------------------------------------------------
// bindInvitedPlayerByTelegramUsername
// ---------------------------------------------------------------------

test("Denis successfully binds on first /start", async () => {
  const fakeDb = db([invitedDenis()]);

  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME);

  assert.deepEqual(outcome, { kind: "bound", playerId: DENIS_ID });
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, DENIS_TELEGRAM_ID);
});

test("binding is case-insensitive on the incoming username", async () => {
  const fakeDb = db([invitedDenis()]);

  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, "@KDA0508");

  assert.deepEqual(outcome, { kind: "bound", playerId: DENIS_ID });
});

test("repeated /start from Denis is idempotent — no error, no change, same player recognized", async () => {
  const fakeDb = db([invitedDenis()]);

  const first = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME);
  const second = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME);

  assert.deepEqual(first, { kind: "bound", playerId: DENIS_ID });
  // Second call finds the player by telegramId already — never touches
  // updateMany again, never re-derives from username.
  assert.deepEqual(second, { kind: "already_bound_by_telegram_id", playerId: DENIS_ID });
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, DENIS_TELEGRAM_ID);
});

test("concurrent duplicate /start updates only bind once", async () => {
  const fakeDb = db([invitedDenis()]);

  const [a, b] = await Promise.all([
    bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME),
    bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME),
  ]);

  // Both calls' initial findUnique can legitimately race ahead of either
  // write (neither has bound anything yet), so the valid outcome pairs are
  // either ["already_bound_by_telegram_id", "bound"] (one call's read
  // happens after the other's full write) or ["bound", "no_invited_match"]
  // (both reads race ahead of both writes, so the actual atomicity
  // guarantee is enforced by updateMany's WHERE clause instead) — what
  // must hold regardless of interleaving is the real invariant: exactly
  // one call ever performs the bind, neither throws, and the row ends up
  // correctly bound exactly once. This mirrors what the real atomic
  // `WHERE telegramUsername = ? AND telegramId IS NULL` UPDATE guarantees
  // under genuine Postgres concurrency (only one UPDATE can ever match a
  // given row once telegramId stops being null).
  const kinds = [a.kind, b.kind];
  const boundCount = kinds.filter((k) => k === "bound").length;
  const otherKinds = kinds.filter((k) => k !== "bound");

  assert.equal(boundCount, 1, "exactly one of the two concurrent calls must perform the bind");
  assert.deepEqual(
    otherKinds,
    otherKinds[0] === "already_bound_by_telegram_id" ? ["already_bound_by_telegram_id"] : ["no_invited_match"],
  );
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, DENIS_TELEGRAM_ID);
});

test("wrong username does not bind Denis's invited row", async () => {
  const fakeDb = db([invitedDenis()]);

  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, "someone_else");

  assert.deepEqual(outcome, { kind: "no_invited_match" });
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, null);
});

test("missing username does not bind, and does not throw", async () => {
  const fakeDb = db([invitedDenis()]);

  assert.deepEqual(await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, undefined), {
    kind: "no_username",
  });
  assert.deepEqual(await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, null), {
    kind: "no_username",
  });
  assert.deepEqual(await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, ""), {
    kind: "no_username",
  });
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, null);
});

test("an already-bound player cannot be hijacked by a different Telegram account using the same username", async () => {
  const fakeDb = db([{ id: DENIS_ID, telegramId: DENIS_TELEGRAM_ID, telegramUsername: DENIS_USERNAME }]);

  const attackerTelegramId = "111111111";
  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, attackerTelegramId, DENIS_USERNAME);

  // Denis's row already has a non-null telegramId, so the WHERE clause's
  // `telegramId: null` condition excludes it — the attacker's call finds
  // no invited match, and Denis's real binding is untouched.
  assert.deepEqual(outcome, { kind: "no_invited_match" });
  assert.equal(fakeDb._debug.get(DENIS_ID)?.telegramId, DENIS_TELEGRAM_ID);
});

test("an existing non-invited player (telegramId already set some other way) short-circuits without touching username matching at all", async () => {
  const fakeDb = db([{ id: "player-andrii", telegramId: "370640496", telegramUsername: null }]);

  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, "370640496", "irrelevant_username");

  assert.deepEqual(outcome, { kind: "already_bound_by_telegram_id", playerId: "player-andrii" });
});

test("no invited player exists for this username at all — no arbitrary player is created", async () => {
  const fakeDb = db([]);

  const outcome = await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME);

  assert.deepEqual(outcome, { kind: "no_invited_match" });
  assert.equal(fakeDb._debug.all().length, 0);
});

// ---------------------------------------------------------------------
// Mini App auth still requires matching telegramId — proves username is
// never consulted by the actual authentication lookup, only by the
// one-time bind above. Mirrors exactly what GET /api/miniapp/me does:
// player.findUnique({ where: { telegramId: String(verification.user.id) } }).
// ---------------------------------------------------------------------

test("Mini App auth still requires an exact telegramId match after binding — username alone never authenticates", async () => {
  const fakeDb = db([invitedDenis()]);
  await bindInvitedPlayerByTelegramUsername(fakeDb, DENIS_TELEGRAM_ID, DENIS_USERNAME);

  const authenticateByTelegramId = (telegramId: string) => fakeDb.player.findUnique({ where: { telegramId } });

  assert.deepEqual(await authenticateByTelegramId(DENIS_TELEGRAM_ID), { id: DENIS_ID });
  // A different numeric id — even one that "knows" the username — is not
  // Denis and must not authenticate as him.
  assert.equal(await authenticateByTelegramId("999999999"), null);
});
