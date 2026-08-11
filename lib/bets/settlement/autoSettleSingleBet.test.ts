import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma, type BetStatus, type PrismaClient } from "@/lib/generated/prisma/client";
import { autoSettleSingleBet, validateAutoSettlementEligibility, type AutoSettleSingleBetInput } from "./autoSettleSingleBet";
import type { CanonicalEventResult } from "./eventResultDomain";

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written, no-mocking-library
// convention as lib/bets/settleBet.test.ts. Extends that file's own fake
// shape with the extra columns autoSettleSingleBet's own findUnique reads
// (type/provider*/canonical*) — the SAME bets Map backs both this
// service's own read and settleBet()'s internal read+transactional write,
// exactly as production shares one `db`.
// ---------------------------------------------------------------------

interface FakeBetRow {
  id: string;
  type: string;
  status: BetStatus;
  playerId: string;
  stake: Prisma.Decimal;
  totalOdds: Prisma.Decimal | null;
  odds: Prisma.Decimal | null;
  providerName: string | null;
  providerEventId: string | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  // H4-B2 — threaded through to mapSingleBetToCanonicalSelection(); null by
  // default (matches every pre-existing MONEYLINE fixture, which has no
  // line concept) unless a test overrides it for a SPREAD scenario.
  line: Prisma.Decimal | null;
}

interface FakePlayerRow {
  id: string;
  currentCredit: Prisma.Decimal;
}

interface FakeTransactionRow {
  id: string;
  playerId: string;
  betId: string;
  type: string;
  amount: Prisma.Decimal;
  balanceAfter: Prisma.Decimal;
  createdAt: Date;
}

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("An operation failed because it depends on one or more records that were required but not found.", {
    code: "P2025",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

const PLAYER_ID = "player-1";
const BET_ID = "bet-1";
const PROVIDER_EVENT_ID = "evt-123";

function fakeBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: BET_ID,
    type: "SINGLE",
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("2.10"),
    odds: new Prisma.Decimal("2.10"),
    providerName: "THE_ODDS_API",
    providerEventId: PROVIDER_EVENT_ID,
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    line: null,
    ...overrides,
  };
}

function createFakeDb(seed: { bet?: FakeBetRow | null; playerCurrentCredit?: Prisma.Decimal } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  const transactions: FakeTransactionRow[] = [];
  let nextTxId = 1;
  let playerUpdateCallCount = 0;
  let transactionCreateCallCount = 0;

  const initialBet = seed.bet === undefined ? fakeBet() : seed.bet;
  if (initialBet) {
    bets.set(initialBet.id, { ...initialBet });
    players.set(initialBet.playerId, {
      id: initialBet.playerId,
      currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0),
    });
  }

  const findUnique = async ({ where }: { where: { id: string } }) => {
    const bet = bets.get(where.id);
    return bet ? { ...bet } : null;
  };

  const tx = {
    bet: {
      findUnique,
      update: async ({ where, data }: { where: { id: string; status: BetStatus }; data: { status: BetStatus } }) => {
        const bet = bets.get(where.id);
        if (!bet) throw p2025();
        if (bet.status !== where.status) throw p2025();
        bet.status = data.status;
        return { ...bet };
      },
    },
    player: {
      update: async ({ where, data }: { where: { id: string }; data: { currentCredit: { increment: Prisma.Decimal } } }) => {
        playerUpdateCallCount += 1;
        const player = players.get(where.id);
        if (!player) throw p2025();
        player.currentCredit = player.currentCredit.plus(data.currentCredit.increment);
        return { ...player };
      },
    },
    transaction: {
      create: async ({ data }: { data: Omit<FakeTransactionRow, "id" | "createdAt"> }) => {
        transactionCreateCallCount += 1;
        const row: FakeTransactionRow = { id: `tx-${nextTxId++}`, createdAt: new Date(), ...data };
        transactions.push(row);
        return row;
      },
    },
  };

  return {
    bet: { findUnique },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      getBet: (id: string) => bets.get(id),
      getPlayer: (id: string) => players.get(id),
      transactions: () => transactions,
      playerUpdateCallCount: () => playerUpdateCallCount,
      transactionCreateCallCount: () => transactionCreateCallCount,
    },
  };
}

function db(fake: ReturnType<typeof createFakeDb>): PrismaClient {
  return fake as unknown as PrismaClient;
}

function homeWinResult(overrides: Partial<CanonicalEventResult> = {}): CanonicalEventResult {
  return {
    status: "COMPLETED",
    homeParticipant: { name: "Arsenal" },
    awayParticipant: { name: "Chelsea" },
    homeScore: 2,
    awayScore: 1,
    ...overrides,
  };
}

function input(overrides: Partial<AutoSettleSingleBetInput> = {}): AutoSettleSingleBetInput {
  return {
    betId: BET_ID,
    eventResult: homeWinResult(),
    expectedProviderEventId: PROVIDER_EVENT_ID,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* A. Successful settlement                                                   */
/* -------------------------------------------------------------------------- */

test("A: SINGLE HOME WIN settles via settleBet", async () => {
  const fake = createFakeDb();
  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.finalStatus, "SETTLED_WIN");
  assert.equal(result.idempotent, false);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("A: SINGLE HOME LOSS settles as LOSS", async () => {
  const fake = createFakeDb();
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ homeScore: 0, awayScore: 2 }) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "LOSS");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
});

test("A: SINGLE DRAW WIN in MONEYLINE_3WAY", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalSelectionType: "DRAW" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ homeScore: 1, awayScore: 1 }) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
});

test("A: SINGLE VOID on a MONEYLINE_2WAY draw", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalMarketType: "MONEYLINE_2WAY", canonicalSelectionType: "HOME" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ homeScore: 1, awayScore: 1 }) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "VOID");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "VOID");
  // VOID has zero delta but still a real, single Transaction row (matches
  // settleBet()'s own existing VOID behavior, unmodified here).
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

test("A: AWAY WIN", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalSelectionType: "AWAY" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ homeScore: 0, awayScore: 3 }) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
});

test("A: WIN balance/transaction figures come entirely from settleBet's own existing math", async () => {
  const fake = createFakeDb({ bet: fakeBet({ stake: new Prisma.Decimal(50), totalOdds: new Prisma.Decimal("3.00") }) });
  await autoSettleSingleBet(db(fake), input());

  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "100"); // netProfit 150-50
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "100");
});

// Stage 3.5C-FIX — production-like regression: a real bet exactly as
// production's own betting flow stores it (canonicalSelectionType
// PARTICIPANT, canonicalParticipant a free-text team name — see
// lib/odds/legacyOddsBridge.ts) now settles automatically end-to-end,
// instead of the pre-fix UNSUPPORTED_SELECTION/NO_ACTION dead end a live
// production audit confirmed for every real bet.
test("Stage 3.5C-FIX: production-like PARTICIPANT bet ('Fenerbahce Win') settles automatically", async () => {
  const fake = createFakeDb({
    bet: fakeBet({
      canonicalMarketType: "MONEYLINE_2WAY",
      canonicalSelectionType: "PARTICIPANT",
      canonicalParticipant: "Fenerbahce",
    }),
  });
  const result = await autoSettleSingleBet(
    db(fake),
    input({
      eventResult: {
        status: "COMPLETED",
        homeParticipant: { name: "Górnik Zabrze" },
        awayParticipant: { name: "Fenerbahce" },
        homeScore: 0,
        awayScore: 2,
      },
    }),
  );

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.finalStatus, "SETTLED_WIN");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
});

/* -------------------------------------------------------------------------- */
/* B. No-action evaluator outcomes                                            */
/* -------------------------------------------------------------------------- */

const NO_ACTION_STATUS_CASES: Array<[string, Partial<CanonicalEventResult>]> = [
  ["NOT_STARTED", { status: "NOT_STARTED", homeScore: null, awayScore: null }],
  ["IN_PROGRESS", { status: "IN_PROGRESS", homeScore: 1, awayScore: 0 }],
  ["POSTPONED", { status: "POSTPONED", homeScore: null, awayScore: null }],
  ["ABANDONED", { status: "ABANDONED", homeScore: 1, awayScore: 0 }],
  ["UNKNOWN", { status: "UNKNOWN", homeScore: null, awayScore: null }],
];

for (const [label, overrides] of NO_ACTION_STATUS_CASES) {
  test(`B: event status ${label} -> NO_ACTION, settleBet never invoked`, async () => {
    const fake = createFakeDb();
    const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult(overrides) }));

    assert.equal(result.kind, "NO_ACTION");
    assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
    assert.equal(fake._debug.transactionCreateCallCount(), 0);
  });
}

// H5-A2 — TOTALS is no longer UNSUPPORTED_MARKET (see the dedicated H5-A2
// section below for its own fail-closed coverage); BOTH_TEAMS_TO_SCORE
// (still genuinely out of scope) replaces it here so this test still
// proves what it always proved: a real, unmodeled market returns
// UNSUPPORTED_MARKET, unattempted.
test("B: UNSUPPORTED_MARKET -> NO_ACTION", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalMarketType: "BOTH_TEAMS_TO_SCORE", canonicalSelectionType: "YES" }) });
  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "UNSUPPORTED_MARKET");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("B: double-chance selection type (still genuinely unsupported) -> NO_ACTION", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalSelectionType: "HOME_OR_DRAW" }) });
  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "UNSUPPORTED_SELECTION");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("B: INVALID_DATA (missing score on COMPLETED) -> NO_ACTION", async () => {
  const fake = createFakeDb();
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ homeScore: null }) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "MISSING_SCORE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* H4-B6 — SINGLE SPREAD auto-settlement ENABLED. The H4-B2/H4-B5 deferral   */
/* guard is gone; every WIN/LOSS/VOID/HALF_WIN/HALF_LOSS outcome the         */
/* evaluator can produce for SPREAD now reaches real settleBet() financial   */
/* settlement, exactly like every other market.                             */
/* -------------------------------------------------------------------------- */

function spreadBet(line: string, overrides: Partial<FakeBetRow> = {}) {
  return fakeBet({
    canonicalMarketType: "SPREAD",
    canonicalSelectionType: "PARTICIPANT",
    canonicalParticipant: "Arsenal",
    line: new Prisma.Decimal(line),
    ...overrides,
  });
}

// Arsenal (home) vs Coventry City (away) — the fixture this whole H4-B5.x
// production investigation used throughout, reused here for continuity.
function arsenalCoventryResult(homeScore: number, awayScore: number): CanonicalEventResult {
  return {
    status: "COMPLETED",
    homeParticipant: { name: "Arsenal" },
    awayParticipant: { name: "Coventry City" },
    homeScore,
    awayScore,
  };
}

function coventryBet(line: string, overrides: Partial<FakeBetRow> = {}) {
  return spreadBet(line, { canonicalParticipant: "Coventry City", ...overrides });
}

async function assertSpreadSettles(
  fakeDbBet: FakeBetRow,
  homeScore: number,
  awayScore: number,
  expectedStatus: BetStatus,
  expectedOutcome: "WIN" | "LOSS" | "VOID" | "HALF_WIN" | "HALF_LOSS",
) {
  const fake = createFakeDb({ bet: fakeDbBet });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(homeScore, awayScore) }));

  assert.equal(result.kind, "SETTLED", `expected SETTLED, got ${JSON.stringify(result)}`);
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, expectedOutcome);
  assert.equal(result.finalStatus, expectedStatus);
  assert.equal(fake._debug.getBet(BET_ID)?.status, expectedStatus);
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
}

/* --- Standard lines --------------------------------------------------- */

test("H4-B6 standard: Arsenal -1.5, wins by 2 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(spreadBet("-1.5"), 2, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 standard: Arsenal -1.5, wins by 1 -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(spreadBet("-1.5"), 1, 0, "SETTLED_LOSS", "LOSS");
});

test("H4-B6 standard: Arsenal -1, wins by 2 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(spreadBet("-1"), 2, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 standard: Arsenal -1, wins by 1 -> VOID (push)", async () => {
  await assertSpreadSettles(spreadBet("-1"), 1, 0, "VOID", "VOID");
});

test("H4-B6 standard: Arsenal -1, draw -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(spreadBet("-1"), 0, 0, "SETTLED_LOSS", "LOSS");
});

test("H4-B6 standard: Coventry +1.5, loses by 1 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(coventryBet("1.5"), 1, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 standard: Coventry +1.5, loses by 2 -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(coventryBet("1.5"), 2, 0, "SETTLED_LOSS", "LOSS");
});

/* --- Quarter lines ------------------------------------------------------ */

test("H4-B6 quarter: Arsenal -1.25, wins by 2 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(spreadBet("-1.25"), 2, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 quarter: Arsenal -1.25, wins by 1 -> SETTLED_HALF_LOSS", async () => {
  await assertSpreadSettles(spreadBet("-1.25"), 1, 0, "SETTLED_HALF_LOSS", "HALF_LOSS");
});

test("H4-B6 quarter: Arsenal -1.25, draw -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(spreadBet("-1.25"), 0, 0, "SETTLED_LOSS", "LOSS");
});

test("H4-B6 quarter: Arsenal -0.75, wins by 2 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(spreadBet("-0.75"), 2, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 quarter: Arsenal -0.75, wins by 1 -> SETTLED_HALF_WIN", async () => {
  await assertSpreadSettles(spreadBet("-0.75"), 1, 0, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H4-B6 quarter: Arsenal -0.75, draw -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(spreadBet("-0.75"), 0, 0, "SETTLED_LOSS", "LOSS");
});

test("H4-B6 quarter: Coventry +1.25, loses by 1 -> SETTLED_HALF_WIN", async () => {
  await assertSpreadSettles(coventryBet("1.25"), 1, 0, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H4-B6 quarter: Coventry +1.25, loses by 2 -> SETTLED_LOSS", async () => {
  await assertSpreadSettles(coventryBet("1.25"), 2, 0, "SETTLED_LOSS", "LOSS");
});

test("H4-B6 quarter: Coventry +1.25, draw -> SETTLED_WIN", async () => {
  await assertSpreadSettles(coventryBet("1.25"), 0, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 quarter: Coventry +1.25, Coventry wins by 1 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(coventryBet("1.25"), 0, 1, "SETTLED_WIN", "WIN");
});

test("H4-B6 quarter: Coventry +0.75, loses by 1 -> SETTLED_HALF_LOSS", async () => {
  await assertSpreadSettles(coventryBet("0.75"), 1, 0, "SETTLED_HALF_LOSS", "HALF_LOSS");
});

test("H4-B6 quarter: Coventry +0.75, draw -> SETTLED_WIN", async () => {
  await assertSpreadSettles(coventryBet("0.75"), 0, 0, "SETTLED_WIN", "WIN");
});

/* --- Additional quarter-grid regression: ±0.25, ±1.75 ------------------- */

test("H4-B6 quarter-grid: Arsenal -0.25, wins by 1 -> SETTLED_WIN", async () => {
  await assertSpreadSettles(spreadBet("-0.25"), 1, 0, "SETTLED_WIN", "WIN");
});

test("H4-B6 quarter-grid: Coventry +0.25, draw -> SETTLED_HALF_WIN", async () => {
  await assertSpreadSettles(coventryBet("0.25"), 0, 0, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H4-B6 quarter-grid: Arsenal -1.75, wins by 2 -> SETTLED_HALF_WIN", async () => {
  await assertSpreadSettles(spreadBet("-1.75"), 2, 0, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H4-B6 quarter-grid: Coventry +1.75, loses by 2 -> SETTLED_HALF_LOSS", async () => {
  await assertSpreadSettles(coventryBet("1.75"), 2, 0, "SETTLED_HALF_LOSS", "HALF_LOSS");
});

/* -------------------------------------------------------------------------- */
/* H4-B6 — financial integration proofs. Not merely which target was        */
/* requested: the actual settleBet()-computed credit delta and Transaction   */
/* row, reached end-to-end through autoSettleSingleBet(), for the exact      */
/* worked examples this stage's own task spec names.                        */
/* -------------------------------------------------------------------------- */

test("H4-B6 financial: stake 100 @ 2.00, HALF_WIN -> credit delta +50, Transaction BET_PAYOUT +50", async () => {
  const fake = createFakeDb({
    bet: spreadBet("-0.75", { stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00"), odds: new Prisma.Decimal("2.00") }),
  });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(1, 0) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_HALF_WIN");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "50");
  assert.equal(fake._debug.transactions()[0]?.type, "BET_PAYOUT");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "50");
});

test("H4-B6 financial: stake 100, HALF_LOSS -> credit delta -50, Transaction BET_STAKE -50", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.25", { stake: new Prisma.Decimal(100) }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(1, 0) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_HALF_LOSS");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-50");
  assert.equal(fake._debug.transactions()[0]?.type, "BET_STAKE");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-50");
});

test("H4-B6 financial: full WIN/LOSS/VOID SPREAD outcomes continue using existing settleBet financial behavior unchanged", async () => {
  // WIN: stake 100 @ 2.10 (fakeBet's own default odds) -> netProfit 110.
  const winFake = createFakeDb({ bet: spreadBet("-1.5", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(winFake), input({ eventResult: arsenalCoventryResult(2, 0) }));
  assert.equal(winFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "110");
  assert.equal(winFake._debug.transactions()[0]?.type, "BET_PAYOUT");

  // LOSS: stake deducted in full, negative delta.
  const lossFake = createFakeDb({ bet: spreadBet("-1.5", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(lossFake), input({ eventResult: arsenalCoventryResult(1, 0) }));
  assert.equal(lossFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-100");
  assert.equal(lossFake._debug.transactions()[0]?.type, "BET_STAKE");

  // VOID: zero delta, but a real Transaction row still exists for audit.
  const voidFake = createFakeDb({ bet: spreadBet("-1", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(voidFake), input({ eventResult: arsenalCoventryResult(1, 0) }));
  assert.equal(voidFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
  assert.equal(voidFake._debug.transactionCreateCallCount(), 1);
});

/* -------------------------------------------------------------------------- */
/* H4-B6 — idempotency: repeated settlement of a HALF_WIN/HALF_LOSS SPREAD   */
/* bet produces zero duplicate Transaction rows and zero double balance      */
/* mutation, exactly like the pre-existing WIN idempotency proof.            */
/* -------------------------------------------------------------------------- */

test("H4-B6 idempotency: a HALF_WIN SPREAD bet settled twice creates exactly one Transaction and one balance mutation", async () => {
  const fake = createFakeDb({ bet: spreadBet("-0.75", { stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  const eventResult = arsenalCoventryResult(1, 0);

  const first = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;
  assert.equal(first.idempotent, false);

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactionCreateCallCount();

  const second = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);
  assert.equal(second.finalStatus, "SETTLED_HALF_WIN");

  assert.equal(fake._debug.transactionCreateCallCount(), txCountAfterFirst);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

test("H4-B6 idempotency: a HALF_LOSS SPREAD bet settled twice creates exactly one Transaction and one balance mutation", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.25", { stake: new Prisma.Decimal(100) }) });
  const eventResult = arsenalCoventryResult(1, 0);

  const first = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactionCreateCallCount();

  const second = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);

  assert.equal(fake._debug.transactionCreateCallCount(), txCountAfterFirst);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

/* -------------------------------------------------------------------------- */
/* H4-B6 — fail-closed: every evaluator INVALID_DATA/UNSUPPORTED reason for  */
/* SPREAD must still produce ZERO financial writes, exactly as it already    */
/* does for MONEYLINE. Never guess a result.                                 */
/* -------------------------------------------------------------------------- */

test("H4-B6 fail-closed: missing line -> NO_ACTION MISSING_LINE, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1", { line: null }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 0) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "MISSING_LINE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("H4-B6 fail-closed: off-grid line (-1.33) -> NO_ACTION INVALID_LINE, zero writes, never rounded to the nearest supported line", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.33") });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 0) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "INVALID_LINE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H4-B6 fail-closed: participant mismatch (canonicalParticipant matches neither team) -> NO_ACTION PARTICIPANT_MISMATCH, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.5", { canonicalParticipant: "Real Madrid" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 0) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "PARTICIPANT_MISMATCH");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H4-B6 fail-closed: ambiguous participant (name overlaps both teams) -> NO_ACTION AMBIGUOUS_PARTICIPANT_MATCH, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.5", { canonicalParticipant: "City" }) });
  const result = await autoSettleSingleBet(
    db(fake),
    input({
      eventResult: {
        status: "COMPLETED",
        homeParticipant: { name: "Manchester City" },
        awayParticipant: { name: "Coventry City" },
        homeScore: 2,
        awayScore: 0,
      },
    }),
  );

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "AMBIGUOUS_PARTICIPANT_MATCH");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H4-B6 fail-closed: invalid score (missing) on a SPREAD bet -> NO_ACTION MISSING_SCORE, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.5") });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: { ...arsenalCoventryResult(2, 0), homeScore: null } }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "MISSING_SCORE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H4-B6 fail-closed: invalid event result (blank participant names) on a SPREAD bet -> NO_ACTION INVALID_EVENT_RESULT, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.5") });
  const result = await autoSettleSingleBet(
    db(fake),
    input({
      eventResult: { status: "COMPLETED", homeParticipant: { name: "" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 0 },
    }),
  );

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "INVALID_EVENT_RESULT");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H4-B6 fail-closed: SPREAD with an unsupported selectionType (not PARTICIPANT) -> NO_ACTION UNSUPPORTED_SELECTION, zero writes", async () => {
  const fake = createFakeDb({ bet: spreadBet("-1.5", { canonicalSelectionType: "HOME" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 0) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "UNSUPPORTED_SELECTION");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* C. Eligibility                                                             */
/* -------------------------------------------------------------------------- */

test("C: Bet not found -> NOT_FOUND", async () => {
  const fake = createFakeDb({ bet: null });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "NOT_FOUND", betId: BET_ID });
});

test("C: EXPRESS bet rejected -> NOT_SINGLE", async () => {
  const fake = createFakeDb({ bet: fakeBet({ type: "EXPRESS" }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "NOT_SINGLE" });
});

test("C: PENDING bet rejected -> UNSUPPORTED_BET_STATUS", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "PENDING" }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "UNSUPPORTED_BET_STATUS" });
});

test("C: REJECTED bet rejected -> UNSUPPORTED_BET_STATUS", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "REJECTED" }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "UNSUPPORTED_BET_STATUS" });
});

test("C: missing providerEventId -> MISSING_PROVIDER_REFERENCE", async () => {
  const fake = createFakeDb({ bet: fakeBet({ providerEventId: null, providerName: null }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_PROVIDER_REFERENCE" });
});

test("C: missing canonicalMarketType -> MISSING_CANONICAL_METADATA", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalMarketType: null }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_CANONICAL_METADATA" });
});

test("C: missing canonicalSelectionType -> MISSING_CANONICAL_METADATA", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalSelectionType: null }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_CANONICAL_METADATA" });
});

test("C: missing canonicalPeriod -> MISSING_CANONICAL_METADATA", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalPeriod: null }) });
  const result = await autoSettleSingleBet(db(fake), input());
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_CANONICAL_METADATA" });
});

test("C: provider event mismatch -> PROVIDER_EVENT_MISMATCH", async () => {
  const fake = createFakeDb();
  const result = await autoSettleSingleBet(db(fake), input({ expectedProviderEventId: "some-other-event" }));
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "PROVIDER_EVENT_MISMATCH" });
});

test("C: validateAutoSettlementEligibility is a pure function usable standalone", () => {
  const ok = validateAutoSettlementEligibility(
    { type: "SINGLE", status: "CONFIRMED", providerName: "THE_ODDS_API", providerEventId: "e1" },
    "e1",
  );
  assert.deepEqual(ok, { ok: true });

  const rejected = validateAutoSettlementEligibility(
    { type: "EXPRESS", status: "CONFIRMED", providerName: "THE_ODDS_API", providerEventId: "e1" },
    "e1",
  );
  assert.deepEqual(rejected, { ok: false, reasonCode: "NOT_SINGLE" });
});

/* -------------------------------------------------------------------------- */
/* D. Mapping (covered directly in mapSingleBetToCanonicalSelection.test.ts;  */
/* here only the end-to-end wiring is asserted)                               */
/* -------------------------------------------------------------------------- */

test("D: canonicalParticipant flows through to a real PARTICIPANT_MISMATCH check", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalSelectionType: "HOME", canonicalParticipant: "Chelsea" }) });
  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "PARTICIPANT_MISMATCH");
});

/* -------------------------------------------------------------------------- */
/* E. Idempotency                                                             */
/* -------------------------------------------------------------------------- */

test("E: second call for an already-settled bet is idempotent — no second Transaction, no double balance change", async () => {
  const fake = createFakeDb();

  const first = await autoSettleSingleBet(db(fake), input());
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;
  assert.equal(first.idempotent, false);

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactionCreateCallCount();

  const second = await autoSettleSingleBet(db(fake), input());
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);
  assert.equal(second.finalStatus, "SETTLED_WIN");

  assert.equal(fake._debug.transactionCreateCallCount(), txCountAfterFirst); // no second Transaction
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst); // balance unchanged
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN"); // status remains final
});

test("E: a bet already settled to a DIFFERENT outcome than this evaluation produces CONFLICT, not a silent overwrite", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "SETTLED_LOSS" }) });

  // Eligibility allows already-settled statuses through so settleBet()'s
  // own conflict detection can run — evaluator here says WIN, but the bet
  // is already finally SETTLED_LOSS.
  const result = await autoSettleSingleBet(db(fake), input());

  assert.deepEqual(result, { kind: "CONFLICT", betId: BET_ID, reasonCode: "ALREADY_SETTLED" });
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS"); // untouched
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("E: a bet already settled to the SAME outcome this evaluation produces is a clean idempotent SETTLED, not a conflict", async () => {
  const fake = createFakeDb({ bet: fakeBet({ status: "SETTLED_WIN" }) });

  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.idempotent, true);
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* F. Failure handling                                                        */
/* -------------------------------------------------------------------------- */

test("F: MissingSettlementOddsError from settleBet is surfaced as a structured FAILED, not swallowed as success", async () => {
  const fake = createFakeDb({ bet: fakeBet({ totalOdds: null, odds: null }) });

  const result = await autoSettleSingleBet(db(fake), input());

  assert.equal(result.kind, "FAILED");
  if (result.kind !== "FAILED") return;
  assert.equal(result.reasonCode, "MISSING_SETTLEMENT_ODDS");
  assert.equal(fake._debug.transactionCreateCallCount(), 0); // no partial balance update
});

/* -------------------------------------------------------------------------- */
/* G. Purity boundaries                                                       */
/* -------------------------------------------------------------------------- */

test("G: NO_ACTION path never touches the database", async () => {
  const fake = createFakeDb();
  await autoSettleSingleBet(db(fake), input({ eventResult: homeWinResult({ status: "IN_PROGRESS" }) }));

  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("G: REJECTED path never touches the database", async () => {
  const fake = createFakeDb({ bet: fakeBet({ type: "EXPRESS" }) });
  await autoSettleSingleBet(db(fake), input());

  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
});

test("G: the input eventResult object is not mutated", async () => {
  const fake = createFakeDb();
  const theInput = input();
  const eventResultCopy = { ...theInput.eventResult };

  await autoSettleSingleBet(db(fake), theInput);

  assert.deepEqual(theInput.eventResult, eventResultCopy);
});

/* -------------------------------------------------------------------------- */
/* H5-A2 — SINGLE TOTALS auto-settlement ENABLED. Same generic pipeline as   */
/* SPREAD (H4-B6) — no TOTALS-specific code exists anywhere in                */
/* autoSettleSingleBet.ts; every WIN/LOSS/VOID/HALF_WIN/HALF_LOSS outcome    */
/* the evaluator can now produce for TOTALS reaches real settleBet()         */
/* financial settlement through the exact same generic mapping.             */
/* -------------------------------------------------------------------------- */

function totalsBet(direction: "OVER" | "UNDER", line: string, overrides: Partial<FakeBetRow> = {}) {
  return fakeBet({
    canonicalMarketType: "TOTALS",
    canonicalSelectionType: direction,
    canonicalParticipant: null,
    line: new Prisma.Decimal(line),
    ...overrides,
  });
}

async function assertTotalsSettles(
  fakeDbBet: FakeBetRow,
  homeScore: number,
  awayScore: number,
  expectedStatus: BetStatus,
  expectedOutcome: "WIN" | "LOSS" | "VOID" | "HALF_WIN" | "HALF_LOSS",
) {
  const fake = createFakeDb({ bet: fakeDbBet });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(homeScore, awayScore) }));

  assert.equal(result.kind, "SETTLED", `expected SETTLED, got ${JSON.stringify(result)}`);
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, expectedOutcome);
  assert.equal(result.finalStatus, expectedStatus);
  assert.equal(fake._debug.getBet(BET_ID)?.status, expectedStatus);
  assert.equal(fake._debug.transactionCreateCallCount(), 1);
}

/* --- Standard (whole/half) lines ----------------------------------------- */

test("H5-A2 standard: Over 2.5, 3 total goals -> SETTLED_WIN", async () => {
  await assertTotalsSettles(totalsBet("OVER", "2.5"), 2, 1, "SETTLED_WIN", "WIN");
});

test("H5-A2 standard: Under 2.5, 3 total goals -> SETTLED_LOSS", async () => {
  await assertTotalsSettles(totalsBet("UNDER", "2.5"), 2, 1, "SETTLED_LOSS", "LOSS");
});

test("H5-A2 standard: Over 3, exactly 3 total goals -> VOID (push)", async () => {
  await assertTotalsSettles(totalsBet("OVER", "3"), 2, 1, "VOID", "VOID");
});

/* --- Quarter lines --------------------------------------------------------*/

test("H5-A2 quarter: Over 2.25, 3 total goals -> SETTLED_WIN", async () => {
  await assertTotalsSettles(totalsBet("OVER", "2.25"), 2, 1, "SETTLED_WIN", "WIN");
});

test("H5-A2 quarter: Over 2.25, 2 total goals -> SETTLED_HALF_LOSS", async () => {
  await assertTotalsSettles(totalsBet("OVER", "2.25"), 1, 1, "SETTLED_HALF_LOSS", "HALF_LOSS");
});

test("H5-A2 quarter: Under 2.25, 2 total goals -> SETTLED_HALF_WIN", async () => {
  await assertTotalsSettles(totalsBet("UNDER", "2.25"), 1, 1, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H5-A2 quarter: Over 2.75, 3 total goals -> SETTLED_HALF_WIN", async () => {
  await assertTotalsSettles(totalsBet("OVER", "2.75"), 2, 1, "SETTLED_HALF_WIN", "HALF_WIN");
});

test("H5-A2 quarter: Under 2.75, 3 total goals -> SETTLED_HALF_LOSS", async () => {
  await assertTotalsSettles(totalsBet("UNDER", "2.75"), 2, 1, "SETTLED_HALF_LOSS", "HALF_LOSS");
});

/* --- Financial integration proofs, exact worked examples ----------------- */

test("H5-A2 financial: stake 100 @ 2.00, HALF_WIN -> credit delta +50, Transaction BET_PAYOUT +50", async () => {
  const fake = createFakeDb({
    bet: totalsBet("OVER", "2.75", { stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00"), odds: new Prisma.Decimal("2.00") }),
  });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_HALF_WIN");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "50");
  assert.equal(fake._debug.transactions()[0]?.type, "BET_PAYOUT");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "50");
});

test("H5-A2 financial: stake 100, HALF_LOSS -> credit delta -50, Transaction BET_STAKE -50", async () => {
  const fake = createFakeDb({ bet: totalsBet("UNDER", "2.75", { stake: new Prisma.Decimal(100) }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_HALF_LOSS");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-50");
  assert.equal(fake._debug.transactions()[0]?.type, "BET_STAKE");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-50");
});

test("H5-A2 financial: full WIN/LOSS/VOID TOTALS outcomes reuse existing settleBet financial behavior unchanged", async () => {
  // WIN: stake 100 @ 2.10 (fakeBet's own default odds) -> netProfit 110.
  const winFake = createFakeDb({ bet: totalsBet("OVER", "2.5", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(winFake), input({ eventResult: arsenalCoventryResult(2, 1) }));
  assert.equal(winFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "110");
  assert.equal(winFake._debug.transactions()[0]?.type, "BET_PAYOUT");

  // LOSS: stake deducted in full, negative delta.
  const lossFake = createFakeDb({ bet: totalsBet("UNDER", "2.5", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(lossFake), input({ eventResult: arsenalCoventryResult(2, 1) }));
  assert.equal(lossFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-100");
  assert.equal(lossFake._debug.transactions()[0]?.type, "BET_STAKE");

  // VOID: zero delta, but a real Transaction row still exists for audit.
  const voidFake = createFakeDb({ bet: totalsBet("OVER", "3", { stake: new Prisma.Decimal(100) }) });
  await autoSettleSingleBet(db(voidFake), input({ eventResult: arsenalCoventryResult(2, 1) }));
  assert.equal(voidFake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
  assert.equal(voidFake._debug.transactionCreateCallCount(), 1);
});

/* --- Idempotency ----------------------------------------------------------*/

test("H5-A2 idempotency: a HALF_WIN TOTALS bet settled twice creates exactly one Transaction and one balance mutation", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.75", { stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("2.00") }) });
  const eventResult = arsenalCoventryResult(2, 1);

  const first = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;
  assert.equal(first.idempotent, false);

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactionCreateCallCount();

  const second = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);
  assert.equal(second.finalStatus, "SETTLED_HALF_WIN");

  assert.equal(fake._debug.transactionCreateCallCount(), txCountAfterFirst);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

test("H5-A2 idempotency: a HALF_LOSS TOTALS bet settled twice creates exactly one Transaction and one balance mutation", async () => {
  const fake = createFakeDb({ bet: totalsBet("UNDER", "2.75", { stake: new Prisma.Decimal(100) }) });
  const eventResult = arsenalCoventryResult(2, 1);

  const first = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactionCreateCallCount();

  const second = await autoSettleSingleBet(db(fake), input({ eventResult }));
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);

  assert.equal(fake._debug.transactionCreateCallCount(), txCountAfterFirst);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

/* --- Fail-closed ------------------------------------------------------- */

test("H5-A2 fail-closed: missing line -> NO_ACTION MISSING_LINE, zero writes", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.5", { line: null }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "MISSING_LINE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
  assert.equal(fake._debug.playerUpdateCallCount(), 0);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
});

test("H5-A2 fail-closed: off-grid line (2.33) -> NO_ACTION INVALID_LINE, zero writes, never rounded to the nearest supported line", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.33") });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "INVALID_LINE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H5-A2 fail-closed: invalid selectionType (PARTICIPANT, not OVER/UNDER) -> NO_ACTION UNSUPPORTED_SELECTION, zero writes", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.5", { canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Arsenal" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "UNSUPPORTED_SELECTION");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H5-A2 fail-closed: missing score -> NO_ACTION MISSING_SCORE, zero writes", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.5") });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: { ...arsenalCoventryResult(2, 1), homeScore: null } }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "MISSING_SCORE");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H5-A2 fail-closed: invalid event result (blank participant name) -> NO_ACTION INVALID_EVENT_RESULT, zero writes", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.5") });
  const result = await autoSettleSingleBet(
    db(fake),
    input({
      eventResult: { status: "COMPLETED", homeParticipant: { name: "" }, awayParticipant: { name: "Coventry City" }, homeScore: 2, awayScore: 1 },
    }),
  );

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "INVALID_EVENT_RESULT");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("H5-A2 fail-closed: wrong period -> NO_ACTION UNSUPPORTED_PERIOD, zero writes", async () => {
  const fake = createFakeDb({ bet: totalsBet("OVER", "2.5", { canonicalPeriod: "FIRST_HALF" }) });
  const result = await autoSettleSingleBet(db(fake), input({ eventResult: arsenalCoventryResult(2, 1) }));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.reasonCode, "UNSUPPORTED_PERIOD");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});
