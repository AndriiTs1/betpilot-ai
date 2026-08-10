import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
// Node's built-in test runner CLI can't select a test file that lives
// inside a Next.js "[id]" bracket-named directory — its file/glob matcher
// always parses "[...]" as a character class with no literal-bracket
// escape (confirmed directly: even an exact, non-wildcard path to a file
// inside a bracket dir matches zero files). ESM import resolution has no
// such problem — importing *into* app/api/bets/[id]/settle/route.ts works
// completely normally, as this line proves — so this test file lives one
// level up, flat under app/api/bets/, purely so `node --test` can find it
// at all; route.ts itself must stay exactly where Next.js's routing
// convention requires it.
import {
  handleSettleBet,
  buildSettlementMessage,
  type HandleSettleBetOptions,
  type AppliedSettleResult,
  type SettledBetDisplayFields,
} from "./[id]/settle/route";
import { Prisma, type PrismaClient, type BetStatus } from "@/lib/generated/prisma/client";

// ---------------------------------------------------------------------
// Same hand-written in-memory fake Prisma client convention as
// lib/bets/settleBet.test.ts — this route delegates all settlement logic
// to settleBet(), so this file's fake db only needs the exact same surface
// that file's own fake already implements.
// ---------------------------------------------------------------------

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
  totalOdds: Prisma.Decimal | null;
  odds: Prisma.Decimal | null;
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
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("2.10"),
    odds: new Prisma.Decimal("2.10"),
    ...overrides,
  };
}

function createFakeDb(
  seed: { bet?: FakeBetRow | null; playerCurrentCredit?: Prisma.Decimal; playerTelegramId?: string | null } = {},
) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, { id: string; currentCredit: Prisma.Decimal; telegramId: string | null }>();
  const transactions: Array<Record<string, unknown>> = [];
  let nextTxId = 1;

  const initialBet = seed.bet === null ? null : (seed.bet ?? fakeBet());
  if (initialBet) {
    bets.set(initialBet.id, { ...initialBet });
    players.set(initialBet.playerId, {
      id: initialBet.playerId,
      currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0),
      telegramId: seed.playerTelegramId === undefined ? "555000111" : seed.playerTelegramId,
    });
  }

  const tx = {
    bet: {
      update: async ({ where, data }: { where: { id: string; status: BetStatus }; data: { status: BetStatus } }) => {
        const bet = bets.get(where.id);
        if (!bet || bet.status !== where.status) throw p2025();
        bet.status = data.status;
        return { ...bet };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bet = bets.get(where.id);
        return bet ? { ...bet } : null;
      },
    },
    player: {
      update: async ({ where, data }: { where: { id: string }; data: { currentCredit: { increment: Prisma.Decimal } } }) => {
        const player = players.get(where.id)!;
        player.currentCredit = player.currentCredit.plus(data.currentCredit.increment);
        return { ...player };
      },
    },
    transaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `tx-${nextTxId++}`, createdAt: new Date(), ...data };
        transactions.push(row);
        return row;
      },
    },
  };

  return {
    bet: {
      // Top-level (non-transactional) read — used both by settleBet.ts's
      // own pre-check and by the settle route's post-settlement
      // notification lookup. Always includes the nested `player` shape a
      // `select: { player: { select: { telegramId: true } } }` query would
      // ask for; a real Prisma call only returns what was selected, but a
      // fake returning a superset is harmless here (consuming code only
      // ever reads the fields it named).
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bet = bets.get(where.id);
        if (!bet) return null;
        const player = players.get(bet.playerId);
        return { ...bet, player: { telegramId: player?.telegramId ?? null } };
      },
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      transactions: () => transactions,
      getBet: (id: string) => bets.get(id),
    },
  };
}

function fakeOptions(fake: ReturnType<typeof createFakeDb>): HandleSettleBetOptions {
  return { db: fake as unknown as PrismaClient };
}

function settleRequest(
  betId: string | undefined,
  body: unknown,
  authHeader: string | null = `Bearer ${OPERATOR_SECRET}`,
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== null) headers.Authorization = authHeader;

  return new NextRequest(`http://localhost/api/bets/${betId ?? "x"}/settle`, {
    method: "POST",
    headers,
    body: body === undefined ? "not json{{{" : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

const originalSecret = process.env.OPERATOR_SECRET;
const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
const originalFetch = global.fetch;

// sendTelegramMessage (lib/telegram/sendMessage.ts) short-circuits to a
// no-op the moment TELEGRAM_BOT_TOKEN is unset — which it is by default in
// this test run (no dotenv loaded) — so a real bot token must be set here
// for the notification tests to actually reach the fetch() call they need
// to inspect. Each test that cares about notifications installs its own
// capturing fetch stub; sentTelegramMessages is reset per test via
// beforeEach so nothing leaks between them.
let sentTelegramMessages: Array<{ chatId: string; text: string }> = [];

test.beforeEach(() => {
  process.env.OPERATOR_SECRET = OPERATOR_SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  sentTelegramMessages = [];
  global.fetch = (async (url: string | URL, init?: RequestInit) => {
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
// Authorization
// ---------------------------------------------------------------------

test("settle route: unauthorized request (no header) is rejected with 401", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }, null), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 401);
  const body = await json(res);
  assert.equal(body.success, false);
  assert.equal((body.error as { code: string }).code, "UNAUTHORIZED");
});

test("settle route: unauthorized request (wrong secret) is rejected with 401", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(
    settleRequest(BET_ID, { status: "SETTLED_WIN" }, "Bearer wrong-secret"),
    BET_ID,
    fakeOptions(fake),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------

test("settle route: malformed JSON body is rejected with 400", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(settleRequest(BET_ID, undefined), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "INVALID_JSON");
});

test("settle route: missing status is rejected with 422 INVALID_SETTLEMENT_TARGET", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(settleRequest(BET_ID, {}), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 422);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "INVALID_SETTLEMENT_TARGET");
});

test("settle route: invalid status value is rejected with 422", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_DRAW" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 422);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "INVALID_SETTLEMENT_TARGET");
  assert.equal((body.error as { requestedStatus: string }).requestedStatus, "SETTLED_DRAW");
});

// H4-B3 — settleBet()/decideSettlementTransition can now execute
// SETTLED_HALF_WIN/SETTLED_HALF_LOSS internally (real financial math
// exists), but the public settle route's own pre-check
// (isSettlementTarget, unchanged by H4-B3) must still reject both exactly
// like any other unsupported status — proving the internal-primitive
// widening never leaked into the public API surface.
for (const halfStatus of ["SETTLED_HALF_WIN", "SETTLED_HALF_LOSS"]) {
  test(`settle route: ${halfStatus} is still rejected with 422 INVALID_SETTLEMENT_TARGET after H4-B3 — public API unchanged`, async () => {
    const fake = createFakeDb();
    const res = await handleSettleBet(settleRequest(BET_ID, { status: halfStatus }), BET_ID, fakeOptions(fake));
    assert.equal(res.status, 422);
    const body = await json(res);
    assert.equal((body.error as { code: string }).code, "INVALID_SETTLEMENT_TARGET");
    assert.equal((body.error as { requestedStatus: string }).requestedStatus, halfStatus);
    assert.equal(
      (body.error as { message: string }).message,
      "status must be one of SETTLED_WIN, SETTLED_LOSS, VOID",
    );
  });
}

test("settle route: REJECTED as a requested status is rejected with 422, not silently treated as a lifecycle action", async () => {
  const fake = createFakeDb();
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "REJECTED" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 422);
});

// ---------------------------------------------------------------------
// Successful settlement
// ---------------------------------------------------------------------

test("settle route: successful WIN returns 200 with Decimal fields serialized as strings", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }) });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  const result = body.result as Record<string, unknown>;
  assert.equal(result.kind, "APPLIED");
  assert.equal(result.status, "SETTLED_WIN");
  assert.equal(result.betId, BET_ID);
  assert.equal(result.playerId, PLAYER_ID);
  assert.equal(typeof result.transactionId, "string");
  assert.equal(typeof result.amount, "string");
  assert.equal(result.amount, "110"); // net profit: 210 - 100
  assert.equal(typeof result.balanceAfter, "string");
  assert.equal(typeof result.grossPayout, "string");
  assert.equal(result.grossPayout, "210");
  assert.equal(typeof result.netProfit, "string");
  assert.equal(result.netProfit, "110");
});

test("settle route: successful LOSS returns 200, amount is a negative-stake string, no grossPayout/netProfit fields", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(60) }) });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_LOSS" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  const result = body.result as Record<string, unknown>;
  assert.equal(result.kind, "APPLIED");
  assert.equal(result.status, "SETTLED_LOSS");
  assert.equal(result.amount, "-60");
  assert.equal("grossPayout" in result, false);
  assert.equal("netProfit" in result, false);
});

test("settle route: successful VOID returns 200 with a zero amount", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "VOID" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  const result = body.result as Record<string, unknown>;
  assert.equal(result.kind, "APPLIED");
  assert.equal(result.status, "VOID");
  assert.equal(result.amount, "0");
});

// ---------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------

test("settle route: repeated identical settlement returns 200 IDEMPOTENT and creates no duplicate financial write", async () => {
  const fake = createFakeDb({ bet: fakeBet() });

  const first = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
  const second = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const secondBody = await json(second);
  assert.deepEqual(secondBody, {
    success: true,
    result: { kind: "IDEMPOTENT", betId: BET_ID, status: "SETTLED_WIN" },
  });
  assert.equal(fake._debug.transactions().length, 1);
});

// ---------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------

test("settle route: bet not found returns 404", async () => {
  const fake = createFakeDb({ bet: null });
  const res = await handleSettleBet(settleRequest("does-not-exist", { status: "SETTLED_WIN" }), "does-not-exist", fakeOptions(fake));

  assert.equal(res.status, 404);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "BET_NOT_FOUND_FOR_SETTLEMENT");
  assert.equal((body.error as { betId: string }).betId, "does-not-exist");
});

test("settle route: PENDING bet cannot settle — 409", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "PENDING" }) });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "BET_NOT_CONFIRMED_FOR_SETTLEMENT");
  assert.equal((body.error as { currentStatus: string }).currentStatus, "PENDING");
});

test("settle route: REJECTED bet cannot settle — 409", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "REJECTED" }) });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "BET_ALREADY_REJECTED");
});

test("settle route: conflicting final settlement returns 409 SETTLEMENT_CONFLICT with current/requested status", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_LOSS" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "SETTLEMENT_CONFLICT");
  assert.equal((body.error as { currentStatus: string }).currentStatus, "SETTLED_WIN");
  assert.equal((body.error as { requestedStatus: string }).requestedStatus, "SETTLED_LOSS");
});

test("settle route: WIN with no odds available returns 422 MISSING_SETTLEMENT_ODDS", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });
  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 422);
  const body = await json(res);
  assert.equal((body.error as { code: string }).code, "MISSING_SETTLEMENT_ODDS");
  assert.equal((body.error as { betId: string }).betId, BET_ID);
});

test("settle route: an unexpected service/database error returns 500 with no stack trace or internals exposed", async () => {
  const throwingDb = {
    bet: {
      findUnique: async () => {
        throw new Error("simulated unexpected database failure with internal details");
      },
    },
  } as unknown as PrismaClient;

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, { db: throwingDb });

  assert.equal(res.status, 500);
  const body = await json(res);
  assert.deepEqual(body, { success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
});

// ---------------------------------------------------------------------
// Service invocation contract
// ---------------------------------------------------------------------

test("settle route: settleBet is called with exactly the route's bet id and the validated status", async () => {
  const fake = createFakeDb({ bet: fakeBet({ id: "specific-bet-id" }) });
  const res = await handleSettleBet(settleRequest("specific-bet-id", { status: "SETTLED_LOSS" }), "specific-bet-id", fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  const result = body.result as Record<string, unknown>;
  assert.equal(result.betId, "specific-bet-id");
  assert.equal(result.status, "SETTLED_LOSS");
});

test("settle route: extra/unrelated body fields are ignored — only status is consulted", async () => {
  const fake = createFakeDb({ bet: fakeBet() });
  const res = await handleSettleBet(
    settleRequest(BET_ID, { status: "SETTLED_WIN", amount: 999999, betId: "forged-id", playerId: "forged-player" }),
    BET_ID,
    fakeOptions(fake),
  );

  assert.equal(res.status, 200);
  const body = await json(res);
  const result = body.result as Record<string, unknown>;
  assert.equal(result.betId, BET_ID); // route param wins, not the forged body field
  assert.equal(result.playerId, PLAYER_ID); // from the real Bet row, not the forged field
});

// ---------------------------------------------------------------------
// Stage 13.6 — Telegram settlement notifications
// ---------------------------------------------------------------------

test("settle route: WIN does NOT send a Telegram notification (bet status notifications disabled by default), settlement itself still applies", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win", stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }),
    playerTelegramId: "555000111",
  });

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 200);

  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: LOSS does NOT send a Telegram notification, settlement itself still applies", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ event: "Chelsea vs Arsenal", outcome: "Chelsea Win", stake: new Prisma.Decimal(60) }),
    playerTelegramId: "555000111",
  });

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_LOSS" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 200);

  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: VOID does NOT send a Telegram notification, settlement itself still applies", async () => {
  const fake = createFakeDb({
    bet: fakeBet({ event: "Liverpool vs Everton", outcome: "Liverpool Win", stake: new Prisma.Decimal(25) }),
    playerTelegramId: "555000111",
  });

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "VOID" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 200);

  assert.equal(fake._debug.getBet(BET_ID)?.status, "VOID");
  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: with BET_TELEGRAM_NOTIFICATIONS_ENABLED=true, WIN still sends the correct notification (architecture preserved for future re-enable)", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "true";
  try {
    const fake = createFakeDb({
      bet: fakeBet({ event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win", stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.10") }),
      playerTelegramId: "555000111",
    });

    const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
    assert.equal(res.status, 200);

    assert.equal(sentTelegramMessages.length, 1);
    const [msg] = sentTelegramMessages;
    assert.equal(msg.chatId, "555000111");
    assert.match(msg.text, /Ставка выиграла/);
    assert.match(msg.text, /Real Madrid vs Barcelona/);
    assert.match(msg.text, /Выплата: 210/);
    assert.match(msg.text, /Баланс: 110/);
  } finally {
    delete process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED;
  }
});

// ---------------------------------------------------------------------
// H4-B4 — buildSettlementMessage() safety for SETTLED_HALF_WIN/
// SETTLED_HALF_LOSS. Neither is reachable through handleSettleBet() itself
// (the public route still rejects both with 422 — see the "H4-B3" test
// block above), so these call the exported formatter directly, matching
// Section 6's own requirement: unreachable in production today, but must
// not throw, mislabel, or omit the result if a future stage ever makes it
// reachable.
// ---------------------------------------------------------------------

function halfWinResult(overrides: Partial<AppliedSettleResult> = {}): AppliedSettleResult {
  return {
    kind: "APPLIED",
    betId: BET_ID,
    status: "SETTLED_HALF_WIN",
    playerId: PLAYER_ID,
    transactionId: "tx-1",
    amount: new Prisma.Decimal("50"),
    balanceAfter: new Prisma.Decimal("1050"),
    grossPayout: new Prisma.Decimal("100"),
    netProfit: new Prisma.Decimal("50"),
    ...overrides,
  };
}

function halfLossResult(overrides: Partial<AppliedSettleResult> = {}): AppliedSettleResult {
  return {
    kind: "APPLIED",
    betId: BET_ID,
    status: "SETTLED_HALF_LOSS",
    playerId: PLAYER_ID,
    transactionId: "tx-1",
    amount: new Prisma.Decimal("-50"),
    balanceAfter: new Prisma.Decimal("950"),
    ...overrides,
  };
}

function displayFields(overrides: Partial<SettledBetDisplayFields> = {}): SettledBetDisplayFields {
  return {
    sport: "Football",
    event: "Arsenal vs Coventry City",
    outcome: "Arsenal -0.75",
    odds: new Prisma.Decimal("1.90"),
    totalOdds: new Prisma.Decimal("1.90"),
    stake: new Prisma.Decimal("100"),
    ...overrides,
  };
}

test("buildSettlementMessage: SETTLED_HALF_WIN never throws and never says the full 'Ставка выиграла!' — it uses the distinct half-win label", () => {
  const text = buildSettlementMessage(halfWinResult(), displayFields());

  assert.match(text, /наполовину/);
  assert.doesNotMatch(text, /Ставка выиграла!/);
  assert.doesNotMatch(text, /аннулирована/);
});

test("buildSettlementMessage: SETTLED_HALF_LOSS never throws and never says the full 'Ставка не зашла' — it uses the distinct half-loss label", () => {
  const text = buildSettlementMessage(halfLossResult(), displayFields());

  assert.match(text, /наполовину/);
  assert.doesNotMatch(text, /Ставка не зашла/);
  assert.doesNotMatch(text, /аннулирована/);
});

test("buildSettlementMessage: SETTLED_HALF_WIN reports the real half-stake payout/profit figures from settleBet's own result, never recomputed", () => {
  const text = buildSettlementMessage(halfWinResult({ grossPayout: new Prisma.Decimal("100"), netProfit: new Prisma.Decimal("50") }), displayFields());

  assert.match(text, /Выплата: 100/);
  assert.match(text, /Чистая прибыль: 50/);
  assert.match(text, /Баланс: 1050/);
});

test("buildSettlementMessage: SETTLED_HALF_LOSS reports the actual half-stake loss amount from result.amount, never the full original stake", () => {
  // stake is 100, but the actual HALF_LOSS delta (result.amount) is -50 —
  // the displayed loss figure must reflect the real half-stake delta, not
  // bet.stake (which would wrongly show 100).
  const text = buildSettlementMessage(halfLossResult({ amount: new Prisma.Decimal("-50") }), displayFields({ stake: new Prisma.Decimal("100") }));

  assert.match(text, /Проигрыш: 50/);
  assert.doesNotMatch(text, /Проигрыш: 100/);
  assert.match(text, /Баланс: 950/);
});

test("buildSettlementMessage: the result text is never empty/omitted for either HALF_* status", () => {
  assert.ok(buildSettlementMessage(halfWinResult(), displayFields()).length > 0);
  assert.ok(buildSettlementMessage(halfLossResult(), displayFields()).length > 0);
});

test("settle route: an IDEMPOTENT repeated settlement sends no notification (already zero, since notifications are disabled by default)", async () => {
  const fake = createFakeDb({ bet: fakeBet(), playerTelegramId: "555000111" });

  await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
  assert.equal(sentTelegramMessages.length, 0);

  const second = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
  assert.equal(second.status, 200);
  const secondBody = await json(second);
  assert.equal((secondBody.result as { kind: string }).kind, "IDEMPOTENT");

  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: a conflicting settlement request sends no notification", async () => {
  const fake = createFakeDb({ bet: fakeBet(), playerTelegramId: "555000111" });

  await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));
  assert.equal(sentTelegramMessages.length, 0);

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_LOSS" }), BET_ID, fakeOptions(fake));
  assert.equal(res.status, 409);

  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: an error response (bet not found) sends no notification", async () => {
  const fake = createFakeDb({ bet: null });
  await handleSettleBet(settleRequest("missing", { status: "SETTLED_WIN" }), "missing", fakeOptions(fake));
  assert.equal(sentTelegramMessages.length, 0);
});

test("settle route: with BET_TELEGRAM_NOTIFICATIONS_ENABLED=true, a Telegram send failure still does not fail settlement — the API still returns success", async () => {
  process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED = "true";
  try {
    const fake = createFakeDb({ bet: fakeBet(), playerTelegramId: "555000111" });
    global.fetch = (async () => {
      throw new Error("simulated Telegram API network failure");
    }) as typeof fetch;

    const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.success, true);
    assert.equal((body.result as { kind: string }).kind, "APPLIED");
    // The Bet/Player/Transaction writes already committed before the
    // (failed) notification attempt — settlement itself is unaffected.
    assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
    assert.equal(fake._debug.transactions().length, 1);
  } finally {
    delete process.env.BET_TELEGRAM_NOTIFICATIONS_ENABLED;
  }
});

test("settle route: a player with no telegramId still settles successfully, with no notification attempt", async () => {
  const fake = createFakeDb({ bet: fakeBet(), playerTelegramId: null });

  const res = await handleSettleBet(settleRequest(BET_ID, { status: "SETTLED_WIN" }), BET_ID, fakeOptions(fake));

  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.success, true);
  assert.equal((body.result as { kind: string }).kind, "APPLIED");
  assert.equal(sentTelegramMessages.length, 0);
});
