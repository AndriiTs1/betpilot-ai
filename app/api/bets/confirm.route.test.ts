import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
// Same reason as settle.route.test.ts: node --test's file matcher can't
// select a file living inside a Next.js "[id]" bracket directory, so this
// test file lives flat under app/api/bets/ and imports the real route.ts
// via a normal relative ESM path, which has no such restriction.
import { handleBetConfirm, type HandleBetConfirmOptions } from "./[id]/confirm/route";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";

const OPERATOR_SECRET = "test-operator-secret";
const PLAYER_ID = "player-1";
const BET_ID = "bet-1";
const BET_ID_2 = "bet-2";

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
  creditLimit: Prisma.Decimal;
  currentCredit: Prisma.Decimal;
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

function fakePlayer(overrides: Partial<FakePlayerRow> = {}): FakePlayerRow {
  return {
    id: PLAYER_ID,
    creditLimit: new Prisma.Decimal(1000),
    currentCredit: new Prisma.Decimal(0),
    telegramId: "555000111",
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written convention as
// lib/bets/settleBet.test.ts / app/api/bets/settle.route.test.ts.
//
// $transaction here additionally simulates a real `SELECT ... FOR UPDATE`
// row lock: tx.$queryRaw (the fix's lock acquisition) queues behind any
// earlier, still-in-flight lock on the same player and only resolves once
// that earlier transaction's callback has fully settled — the same
// blocking guarantee a real Postgres row lock provides, which is exactly
// what handleBetConfirm's fix now depends on to be correct.
// ---------------------------------------------------------------------

function createFakeDb(seed: { bets?: FakeBetRow[]; player?: FakePlayerRow } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  const lockTails = new Map<string, Promise<void>>();
  let betUpdateAttemptCount = 0;
  let lockAcquireCount = 0;

  for (const bet of seed.bets ?? [fakeBet()]) {
    bets.set(bet.id, { ...bet });
  }
  const player = seed.player ?? fakePlayer();
  players.set(player.id, { ...player });

  const fakeDb = {
    bet: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bet = bets.get(where.id);
        if (!bet) return null;
        const p = players.get(bet.playerId);
        return { ...bet, player: p ? { ...p } : null };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const lockHandle: { release: (() => void) | null } = { release: null };

      const tx = {
        $queryRaw: async (
          _strings: TemplateStringsArray,
          ...values: unknown[]
        ): Promise<{ id: string; creditLimit: Prisma.Decimal; currentCredit: Prisma.Decimal }[]> => {
          lockAcquireCount += 1;
          const playerId = values[0] as string;
          const p = players.get(playerId);
          if (!p) return [];

          const previousTail = lockTails.get(playerId) ?? Promise.resolve();
          const thisLock = new Promise<void>((resolve) => {
            lockHandle.release = () => resolve();
          });
          lockTails.set(playerId, previousTail.then(() => thisLock));
          await previousTail; // block until whoever held the lock before us releases

          // Fresh read, taken only after the lock is actually held.
          const fresh = players.get(playerId)!;
          return [{ id: fresh.id, creditLimit: fresh.creditLimit, currentCredit: fresh.currentCredit }];
        },
        bet: {
          aggregate: async ({ where }: { where: { playerId: string; status: BetStatus } }) => {
            const matching = [...bets.values()].filter(
              (b) => b.playerId === where.playerId && b.status === where.status,
            );
            if (matching.length === 0) return { _sum: { stake: null } };
            const sum = matching.reduce((acc, b) => acc.plus(b.stake), new Prisma.Decimal(0));
            return { _sum: { stake: sum } };
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
      };

      try {
        return await fn(tx);
      } finally {
        lockHandle.release?.();
      }
    },
    _debug: {
      getBet: (id: string) => bets.get(id),
      getPlayer: (id: string) => players.get(id),
      betUpdateAttemptCount: () => betUpdateAttemptCount,
      lockAcquireCount: () => lockAcquireCount,
    },
  };

  return fakeDb;
}

function fakeOptions(fake: ReturnType<typeof createFakeDb>): HandleBetConfirmOptions {
  return { db: fake as unknown as PrismaClient };
}

function confirmRequest(
  betId: string | undefined,
  authHeader: string | null = `Bearer ${OPERATOR_SECRET}`,
): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;

  return new NextRequest(`http://localhost/api/bets/${betId ?? "x"}/confirm`, {
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

// Same reasoning as settle.route.test.ts: sendTelegramMessage no-ops
// without TELEGRAM_BOT_TOKEN, so a fake token + capturing fetch stub is
// installed per test.
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

test("confirm route: unauthorized request (no header) is rejected with 401", async () => {
  const fake = createFakeDb();
  const res = await handleBetConfirm(confirmRequest(BET_ID, null), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 401);
});

test("confirm route: unknown bet id returns 404", async () => {
  const fake = createFakeDb();
  const res = await handleBetConfirm(confirmRequest("missing"), "missing", fakeOptions(fake));
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------
// ✓ successful confirm
// ---------------------------------------------------------------------

test("confirm route: a PENDING bet within credit is confirmed successfully", async () => {
  const fake = createFakeDb({
    bets: [fakeBet({ stake: new Prisma.Decimal(100) })],
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000), currentCredit: new Prisma.Decimal(0) }),
  });

  const res = await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal((body.bet as Record<string, unknown>).status, "CONFIRMED");
  assert.equal(body.remainingCredit, "900"); // 1000 - 100
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("confirm route: successful confirm notifies the player on Telegram", async () => {
  const fake = createFakeDb({ bets: [fakeBet()], player: fakePlayer({ telegramId: "555000111" }) });
  await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(sentTelegramMessages.length, 1);
  assert.equal(sentTelegramMessages[0].chatId, "555000111");
  assert.match(sentTelegramMessages[0].text, /подтверждена/);
});

// ---------------------------------------------------------------------
// ✓ insufficient credit
// ---------------------------------------------------------------------

test("confirm route: a bet whose stake exceeds remaining credit is rejected with 409, unchanged status", async () => {
  const fake = createFakeDb({
    bets: [fakeBet({ stake: new Prisma.Decimal(500) })],
    // remaining = 1000 + (-600) = 400 < 500
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000), currentCredit: new Prisma.Decimal(-600) }),
  });

  const res = await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error as string, /кредита/);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "PENDING");
});

test("confirm route: existing CONFIRMED exposure from other bets counts against the credit check", async () => {
  const fake = createFakeDb({
    bets: [
      fakeBet({ id: BET_ID, stake: new Prisma.Decimal(300), status: "PENDING" }),
      fakeBet({ id: BET_ID_2, stake: new Prisma.Decimal(800), status: "CONFIRMED" }),
    ],
    // remaining=1000, existing CONFIRMED exposure=800, available=200 < 300
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000), currentCredit: new Prisma.Decimal(0) }),
  });

  const res = await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 409);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "PENDING");
});

// ---------------------------------------------------------------------
// ✓ already confirmed / ✓ already rejected
// ---------------------------------------------------------------------

test("confirm route: a bet that is already CONFIRMED cannot be confirmed again (409)", async () => {
  const fake = createFakeDb({ bets: [fakeBet({ status: "CONFIRMED" })] });
  const res = await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error as string, /not pending/);
});

test("confirm route: a bet that is already REJECTED cannot be confirmed (409)", async () => {
  const fake = createFakeDb({ bets: [fakeBet({ status: "REJECTED" })] });
  const res = await handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.match(body.error as string, /not pending/);
});

// ---------------------------------------------------------------------
// ✓ concurrent confirmation of the SAME bet
// ---------------------------------------------------------------------

test("confirm route: two concurrent confirms of the same bet — exactly one succeeds, the other loses the race with 409", async () => {
  const fake = createFakeDb({
    bets: [fakeBet({ stake: new Prisma.Decimal(100) })],
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000) }),
  });

  const [resA, resB] = await Promise.all([
    handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake)),
    handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake)),
  ]);

  const statuses = [resA.status, resB.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  // The guarded update was attempted twice (once per request) even though
  // only one could ever win — proves the existing same-bet race guard is
  // still intact after the locking fix, not bypassed by it.
  assert.equal(fake._debug.betUpdateAttemptCount(), 2);
});

// ---------------------------------------------------------------------
// ✓ concurrent confirmation of two DIFFERENT bets for the same player —
// the C1 fix. Must prove the credit limit can no longer be exceeded.
// ---------------------------------------------------------------------

test("confirm route: concurrent confirmation of two different bets for the same player never lets combined exposure exceed the credit limit", async () => {
  // Credit limit 1000. Two PENDING bets, 600 and 500 — each individually
  // fits, but 600 + 500 = 1100 exceeds the limit. Before the fix, both
  // transactions could read "0 CONFIRMED exposure" before either committed
  // and both would have been approved (the write-skew race this fixes).
  const fake = createFakeDb({
    bets: [
      fakeBet({ id: BET_ID, stake: new Prisma.Decimal(600) }),
      fakeBet({ id: BET_ID_2, stake: new Prisma.Decimal(500) }),
    ],
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000), currentCredit: new Prisma.Decimal(0) }),
  });

  const [resA, resB] = await Promise.all([
    handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake)),
    handleBetConfirm(confirmRequest(BET_ID_2), BET_ID_2, fakeOptions(fake)),
  ]);

  const statuses = [resA.status, resB.status];
  const successCount = statuses.filter((s) => s === 200).length;
  const rejectedCount = statuses.filter((s) => s === 409).length;

  assert.equal(successCount, 1, `expected exactly one confirm to succeed, got statuses ${JSON.stringify(statuses)}`);
  assert.equal(rejectedCount, 1, `expected exactly one confirm to be rejected, got statuses ${JSON.stringify(statuses)}`);

  // The actual invariant this test exists to prove: combined CONFIRMED
  // exposure must never exceed the credit limit, regardless of which
  // request happened to win the race.
  const confirmedExposure = [fake._debug.getBet(BET_ID), fake._debug.getBet(BET_ID_2)]
    .filter((b) => b?.status === "CONFIRMED")
    .reduce((sum, b) => sum.plus(b!.stake), new Prisma.Decimal(0));

  assert.ok(
    confirmedExposure.lte(1000),
    `combined confirmed exposure ${confirmedExposure.toString()} exceeds the credit limit of 1000 — the race was not prevented`,
  );

  // Both requests really did contend for the same lock — otherwise this
  // test would trivially pass without exercising the fix at all.
  assert.equal(fake._debug.lockAcquireCount(), 2);
});

test("confirm route: concurrent confirmation of two different bets that together still fit is allowed to confirm both (the lock is not overly conservative)", async () => {
  const fake = createFakeDb({
    bets: [
      fakeBet({ id: BET_ID, stake: new Prisma.Decimal(200) }),
      fakeBet({ id: BET_ID_2, stake: new Prisma.Decimal(300) }),
    ],
    player: fakePlayer({ creditLimit: new Prisma.Decimal(1000), currentCredit: new Prisma.Decimal(0) }),
  });

  const [resA, resB] = await Promise.all([
    handleBetConfirm(confirmRequest(BET_ID), BET_ID, fakeOptions(fake)),
    handleBetConfirm(confirmRequest(BET_ID_2), BET_ID_2, fakeOptions(fake)),
  ]);

  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  assert.equal(fake._debug.getBet(BET_ID_2)?.status, "CONFIRMED");
});
