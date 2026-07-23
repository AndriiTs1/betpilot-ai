import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
// Same reason as settle.route.test.ts / confirm.route.test.ts: node
// --test's file matcher can't select a file living inside a Next.js
// "[id]" bracket directory, so this test file lives flat under
// app/api/bets/ and imports the real route.ts via a normal relative ESM
// path, which has no such restriction.
import { handleBetReject, type HandleBetRejectOptions } from "./[id]/reject/route";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";

const OPERATOR_SECRET = "test-operator-secret";
const PLAYER_ID = "player-1";
const BET_ID = "bet-1";

interface FakeBetRow {
  id: string;
  status: BetStatus;
  playerId: string;
  event: string | null;
  outcome: string | null;
  stake: Prisma.Decimal;
}

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
}

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
    code: "P2025",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

function fakeBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: BET_ID,
    status: "PENDING",
    playerId: PLAYER_ID,
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: new Prisma.Decimal(100),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written convention as
// confirm.route.test.ts. No credit logic or row locking involved: reject
// only ever flips one bet's own status via the same guarded conditional
// update confirm already uses, which fully serializes concurrent requests
// for the *same* bet without needing a lock.
// ---------------------------------------------------------------------

function createFakeDb(seed: { bet?: FakeBetRow | null; telegramId?: string | null } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  let betUpdateAttemptCount = 0;

  const initialBet = seed.bet === null ? null : (seed.bet ?? fakeBet());
  if (initialBet) {
    bets.set(initialBet.id, { ...initialBet });
    players.set(initialBet.playerId, {
      id: initialBet.playerId,
      telegramId: seed.telegramId === undefined ? "555000111" : seed.telegramId,
    });
  }

  return {
    bet: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bet = bets.get(where.id);
        if (!bet) return null;
        const p = players.get(bet.playerId);
        return { ...bet, player: p ? { ...p } : null };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string; status: BetStatus };
        data: { status: BetStatus };
      }) => {
        betUpdateAttemptCount += 1;
        const bet = bets.get(where.id);
        if (!bet || bet.status !== where.status) throw p2025();
        bet.status = data.status;
        return { ...bet };
      },
    },
    _debug: {
      getBet: (id: string) => bets.get(id),
      betUpdateAttemptCount: () => betUpdateAttemptCount,
    },
  };
}

function fakeOptions(fake: ReturnType<typeof createFakeDb>): HandleBetRejectOptions {
  return { db: fake as unknown as PrismaClient };
}

function rejectRequest(
  betId: string | undefined,
  authHeader: string | null = `Bearer ${OPERATOR_SECRET}`,
): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;

  return new NextRequest(`http://localhost/api/bets/${betId ?? "x"}/reject`, {
    method: "POST",
    headers,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const originalSecret = process.env.OPERATOR_SECRET;
const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
const originalFetch = global.fetch;

let sentTelegramMessages: Array<{ chatId: string; text: string }> = [];

test.beforeEach(() => {
  process.env.OPERATOR_SECRET = OPERATOR_SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  sentTelegramMessages = [];
  global.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; text: string };
    sentTelegramMessages.push({ chatId: body.chat_id, text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});
test.after(() => {
  process.env.OPERATOR_SECRET = originalSecret;
  process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------
// Authorization / not found
// ---------------------------------------------------------------------

test("reject route: unauthorized request (no header) is rejected with 401", async () => {
  const fake = createFakeDb();
  const res = await handleBetReject(rejectRequest(BET_ID, null), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 401);
});

test("reject route: unknown bet id returns 404", async () => {
  const fake = createFakeDb({ bet: null });
  const res = await handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------
// ✓ successful reject
// ---------------------------------------------------------------------

test("reject route: a PENDING bet is rejected successfully", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const res = await handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bet as Record<string, unknown>).status, "REJECTED");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "REJECTED");
});

test("reject route: successful reject notifies the player on Telegram", async () => {
  const fake = createFakeDb({ bet: fakeBet(), telegramId: "555000111" });
  await handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(sentTelegramMessages.length, 1);
  assert.equal(sentTelegramMessages[0].chatId, "555000111");
  assert.match(sentTelegramMessages[0].text, /отклонена/);
});

// ---------------------------------------------------------------------
// ✓ already confirmed / ✓ already rejected
// ---------------------------------------------------------------------

test("reject route: a bet that is already CONFIRMED cannot be rejected (409)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "CONFIRMED" }) });
  const res = await handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error as string, /not pending/);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("reject route: a bet that is already REJECTED cannot be rejected again (409)", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "REJECTED" }) });
  const res = await handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error as string, /not pending/);
});

// ---------------------------------------------------------------------
// ✓ concurrent confirmation/rejection of the SAME bet
// ---------------------------------------------------------------------

test("reject route: two concurrent rejects of the same bet — exactly one succeeds, the other loses the race with 409", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const [resA, resB] = await Promise.all([
    handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake)),
    handleBetReject(rejectRequest(BET_ID), BET_ID, fakeOptions(fake)),
  ]);

  const statuses = [resA.status, resB.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "REJECTED");
  assert.equal(fake._debug.betUpdateAttemptCount(), 2);
});
