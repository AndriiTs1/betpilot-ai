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

test("B: UNSUPPORTED_MARKET -> NO_ACTION", async () => {
  const fake = createFakeDb({ bet: fakeBet({ canonicalMarketType: "TOTALS", canonicalSelectionType: "OVER" }) });
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
