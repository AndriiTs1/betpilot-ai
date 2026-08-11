import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma, type BetStatus, type PrismaClient } from "@/lib/generated/prisma/client";
import { autoSettleExpressBet, type AutoSettleExpressBetInput, type EventResultEntryInput } from "./autoSettleExpressBet";
import type { CanonicalEventResult } from "./eventResultDomain";

// ---------------------------------------------------------------------
// In-memory fake Prisma client — same hand-written, no-mocking-library
// convention as lib/bets/settleBet.test.ts / autoSettleSingleBet.test.ts.
// Extends the SINGLE fixture's shape with nested BetSelection rows — the
// SAME bets Map backs both this service's own read (Bet + selections) and
// settleBet()'s internal read+transactional write, exactly as production
// shares one `db`.
// ---------------------------------------------------------------------

interface FakeSelectionRow {
  id: string;
  betId: string;
  providerName: string | null;
  providerEventId: string | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  // X2 — BetSelection.line, mirroring the real Prisma select's now-widened
  // projection (autoSettleExpressBet.ts) so this fake DB's shape stays
  // truthful to production.
  line: Prisma.Decimal | null;
  odds: Prisma.Decimal | null;
}

interface FakeBetRow {
  id: string;
  type: string;
  status: BetStatus;
  playerId: string;
  stake: Prisma.Decimal;
  totalOdds: Prisma.Decimal | null;
  odds: Prisma.Decimal | null;
  selections: FakeSelectionRow[];
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
const EVENT_A = "evt-a";
const EVENT_B = "evt-b";

function fakeSelection(overrides: Partial<FakeSelectionRow> = {}): FakeSelectionRow {
  return {
    id: "sel-1",
    betId: BET_ID,
    providerName: "THE_ODDS_API",
    providerEventId: EVENT_A,
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    line: null,
    odds: new Prisma.Decimal("2.00"),
    ...overrides,
  };
}

function fakeExpressBet(overrides: Partial<FakeBetRow> = {}, selections?: FakeSelectionRow[]): FakeBetRow {
  return {
    id: BET_ID,
    type: "EXPRESS",
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("3.00"),
    odds: null,
    selections: selections ?? [
      fakeSelection({ id: "sel-1", providerEventId: EVENT_A, odds: new Prisma.Decimal("2.00") }),
      fakeSelection({ id: "sel-2", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.50") }),
    ],
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

  const initialBet = seed.bet === undefined ? fakeExpressBet() : seed.bet;
  if (initialBet) {
    bets.set(initialBet.id, { ...initialBet, selections: initialBet.selections.map((s) => ({ ...s })) });
    players.set(initialBet.playerId, {
      id: initialBet.playerId,
      currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0),
    });
  }

  const findUnique = async ({ where }: { where: { id: string } }) => {
    const bet = bets.get(where.id);
    return bet ? { ...bet, selections: bet.selections.map((s) => ({ ...s })) } : null;
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

function eventResult(overrides: Partial<CanonicalEventResult> = {}): CanonicalEventResult {
  return {
    status: "COMPLETED",
    homeParticipant: { name: "Home" },
    awayParticipant: { name: "Away" },
    homeScore: 2,
    awayScore: 0,
    ...overrides,
  };
}

function input(eventResults: readonly EventResultEntryInput[], betId = BET_ID): AutoSettleExpressBetInput {
  return { betId, eventResults };
}

const BOTH_WIN_RESULTS: EventResultEntryInput[] = [
  { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
  { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 3, awayScore: 1 }) },
];

/* -------------------------------------------------------------------------- */
/* ALL WIN                                                                    */
/* -------------------------------------------------------------------------- */

test("ALL WIN: settles via settleBet with the aggregated effectiveOdds", async () => {
  const fake = createFakeDb();
  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.effectiveOdds?.toString(), "3"); // 2.00 * 1.50
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  assert.equal(fake._debug.transactions().length, 1);
  const [tx] = fake._debug.transactions();
  assert.equal(tx.amount.toString(), "200"); // stake 100 * 3.00 - 100
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "200");
});

/* -------------------------------------------------------------------------- */
/* LOSS                                                                       */
/* -------------------------------------------------------------------------- */

test("LOSS: one losing leg settles the whole EXPRESS as LOSS", async () => {
  const fake = createFakeDb();
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 0, awayScore: 2 }) }, // HOME loses
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 3, awayScore: 1 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "LOSS");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
  const [tx] = fake._debug.transactions();
  assert.equal(tx.amount.toString(), "-100");
});

/* -------------------------------------------------------------------------- */
/* ALL VOID                                                                   */
/* -------------------------------------------------------------------------- */

test("ALL VOID: settles as VOID, stake untouched", async () => {
  const selections = [
    fakeSelection({ id: "sel-1", providerEventId: EVENT_A, canonicalMarketType: "MONEYLINE_2WAY", odds: new Prisma.Decimal("2.00") }),
    fakeSelection({ id: "sel-2", providerEventId: EVENT_B, canonicalMarketType: "MONEYLINE_2WAY", odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({}, selections), playerCurrentCredit: new Prisma.Decimal(50) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 1 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 2 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "VOID");
  assert.equal(result.effectiveOdds, undefined);
  assert.equal(fake._debug.getBet(BET_ID)?.status, "VOID");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "50"); // unchanged
});

/* -------------------------------------------------------------------------- */
/* WIN + VOID                                                                 */
/* -------------------------------------------------------------------------- */

test("WIN + VOID: exact worked example — settles WIN using the adjusted effectiveOdds, not stored totalOdds", async () => {
  const selections = [
    fakeSelection({ id: "A", providerEventId: EVENT_A, canonicalMarketType: "MONEYLINE_3WAY", odds: new Prisma.Decimal("2.00") }),
    fakeSelection({ id: "B", providerEventId: EVENT_B, canonicalMarketType: "MONEYLINE_2WAY", odds: new Prisma.Decimal("3.00") }),
  ];
  // Bet.totalOdds deliberately left at 6.00 (2.00 * 3.00) — must NOT be used.
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // 3-way HOME win
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 1, awayScore: 1 }) }, // 2-way draw -> VOID
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.effectiveOdds?.toString(), "2");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
  const [tx] = fake._debug.transactions();
  assert.equal(tx.amount.toString(), "100"); // 100 * 2.00 - 100, NOT 100 * 6.00 - 100
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "100");
});

/* -------------------------------------------------------------------------- */
/* Stage 3.5C-FIX — PARTICIPANT legs (production-like: two free-text        */
/* team-name selections, exactly how production's real betting flow stores  */
/* an EXPRESS today — see lib/odds/legacyOddsBridge.ts).                    */
/* -------------------------------------------------------------------------- */

function participantSelections(): FakeSelectionRow[] {
  return [
    fakeSelection({
      id: "leg-A",
      providerEventId: EVENT_A,
      canonicalMarketType: "MONEYLINE_2WAY",
      canonicalSelectionType: "PARTICIPANT",
      canonicalParticipant: "Górnik Zabrze",
      odds: new Prisma.Decimal("2.00"),
    }),
    fakeSelection({
      id: "leg-B",
      providerEventId: EVENT_B,
      canonicalMarketType: "MONEYLINE_2WAY",
      canonicalSelectionType: "PARTICIPANT",
      canonicalParticipant: "Fenerbahce",
      odds: new Prisma.Decimal("1.50"),
    }),
  ];
}

test("Stage 3.5C-FIX: two PARTICIPANT legs, both WIN -> EXPRESS WON", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({}, participantSelections()) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeParticipant: { name: "Górnik Zabrze" }, awayParticipant: { name: "FC Thun" }, homeScore: 2, awayScore: 0 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeParticipant: { name: "Real Betis" }, awayParticipant: { name: "Fenerbahce" }, homeScore: 0, awayScore: 1 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.effectiveOdds?.toString(), "3"); // 2.00 * 1.50
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
});

test("Stage 3.5C-FIX: one PARTICIPANT leg LOSS -> EXPRESS LOST", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({}, participantSelections()) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeParticipant: { name: "Górnik Zabrze" }, awayParticipant: { name: "FC Thun" }, homeScore: 2, awayScore: 0 }) },
    // Fenerbahce (away) loses this one.
    { providerEventId: EVENT_B, eventResult: eventResult({ homeParticipant: { name: "Real Betis" }, awayParticipant: { name: "Fenerbahce" }, homeScore: 2, awayScore: 0 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "LOSS");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
});

test("Stage 3.5C-FIX: one PARTICIPANT leg not yet completed -> EXPRESS stays unsettled (WAITING via NO_ACTION)", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({}, participantSelections()) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeParticipant: { name: "Górnik Zabrze" }, awayParticipant: { name: "FC Thun" }, homeScore: 2, awayScore: 0 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ status: "IN_PROGRESS", homeParticipant: { name: "Real Betis" }, awayParticipant: { name: "Fenerbahce" }, homeScore: 0, awayScore: 0 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.aggregate.kind, "WAITING");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  assert.equal(fake._debug.transactions().length, 0);
});

test("Stage 3.5C-FIX: PARTICIPANT WIN + PARTICIPANT VOID recomputes effectiveOdds correctly", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({}, participantSelections()) });
  const results: EventResultEntryInput[] = [
    // Górnik Zabrze (home) wins.
    { providerEventId: EVENT_A, eventResult: eventResult({ homeParticipant: { name: "Górnik Zabrze" }, awayParticipant: { name: "FC Thun" }, homeScore: 2, awayScore: 0 }) },
    // Fenerbahce leg: MONEYLINE_2WAY draw -> VOID, excluded from the product.
    { providerEventId: EVENT_B, eventResult: eventResult({ homeParticipant: { name: "Real Betis" }, awayParticipant: { name: "Fenerbahce" }, homeScore: 1, awayScore: 1 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.outcome, "WIN");
  assert.equal(result.effectiveOdds?.toString(), "2"); // only the winning 2.00 leg — VOID leg excluded
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_WIN");
});

/* -------------------------------------------------------------------------- */
/* WAITING / UNSUPPORTED / INVALID_DATA -> NO_ACTION, settleBet never called  */
/* -------------------------------------------------------------------------- */

test("WAITING: no LOSS, one leg not yet resolved -> NO_ACTION, no DB write", async () => {
  const fake = createFakeDb();
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
    // EVENT_B intentionally missing
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.aggregate.kind, "WAITING");
  assert.equal(fake._debug.getBet(BET_ID)?.status, "CONFIRMED");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("UNSUPPORTED: no LOSS, one leg's market unsupported -> NO_ACTION", async () => {
  // X3B — TOTALS is no longer a stand-in "unsupported market" example (it's
  // real, settleable EXPRESS market as of this stage); BOTH_TEAMS_TO_SCORE
  // (still genuinely out of scope) replaces it here, same substitution
  // aggregateExpressOutcome.test.ts's own equivalent test already made.
  const selections = [
    fakeSelection({ id: "sel-1", providerEventId: EVENT_A }),
    fakeSelection({ id: "sel-2", providerEventId: EVENT_B, canonicalMarketType: "BOTH_TEAMS_TO_SCORE", canonicalSelectionType: "YES" }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({}, selections) });

  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.aggregate.kind, "UNSUPPORTED");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* X3B — EXPRESS SPREAD/TOTALS settlement ENABLED. Financial integration     */
/* through the real autoSettleExpressBet -> settleBet path (X1's exact       */
/* per-leg factor math, X2's line read-wiring, X2.5's status semantics,      */
/* X3A's SETTLED_LOSS override primitive — all wired together here for the   */
/* first time). No credit delta is computed in this file — settleBet()       */
/* remains the only financial writer.                                        */
/* -------------------------------------------------------------------------- */

function spreadLeg(id: string, providerEventId: string, participant: string, line: string, odds: string): FakeSelectionRow {
  return fakeSelection({
    id,
    providerEventId,
    canonicalMarketType: "SPREAD",
    canonicalSelectionType: "PARTICIPANT",
    canonicalParticipant: participant,
    line: new Prisma.Decimal(line),
    odds: new Prisma.Decimal(odds),
  });
}

function totalsLeg(id: string, providerEventId: string, direction: "OVER" | "UNDER", line: string, odds: string): FakeSelectionRow {
  return fakeSelection({
    id,
    providerEventId,
    canonicalMarketType: "TOTALS",
    canonicalSelectionType: direction,
    canonicalParticipant: null,
    line: new Prisma.Decimal(line),
    odds: new Prisma.Decimal(odds),
  });
}

test("X3B financial integration (1): stake 100, E=2.25 (HALF_WIN + WIN) -> SETTLED_WIN, Transaction BET_PAYOUT +125", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "2.00"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) }, // -0.75 -> HALF_WIN
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // HOME WIN
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_WIN");
  assert.equal(result.exactDelta?.toString(), "125");
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.transactions()[0]?.type, "BET_PAYOUT");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "125");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "125");
});

test("X3B financial integration (2): stake 100, E=0.75 (HALF_LOSS + WIN) -> SETTLED_LOSS, Transaction BET_STAKE -25", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-1.25", "2.00"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) }, // -1.25 -> HALF_LOSS
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // HOME WIN
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_LOSS");
  assert.equal(result.exactDelta?.toString(), "-25");
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.transactions()[0]?.type, "BET_STAKE");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-25");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-25");
});

test("X3B financial integration (3): stake 100, E=0.25 (HALF_LOSS + HALF_LOSS) -> SETTLED_LOSS, -75", async () => {
  const selections = [
    spreadLeg("half1", EVENT_A, "Home", "-1.25", "2.00"),
    totalsLeg("half2", EVENT_B, "OVER", "2.25", "1.90"),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) }, // -1.25 -> HALF_LOSS
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 1, awayScore: 1 }) }, // Over 2.25, 2 goals -> HALF_LOSS
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_LOSS");
  assert.equal(result.exactDelta?.toString(), "-75");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-75");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-75");
});

test("X3B financial integration (4): E=1 (HALF_WIN factor 2.0 + HALF_LOSS factor 0.5) -> VOID, delta 0", async () => {
  const selections = [
    totalsLeg("half1", EVENT_A, "OVER", "2.75", "3.00"),
    totalsLeg("half2", EVENT_B, "OVER", "2.25", "1.90"),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) }, // Over 2.75, 3 goals -> HALF_WIN, factor 2.0
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 1, awayScore: 1 }) }, // Over 2.25, 2 goals -> HALF_LOSS, factor 0.5
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "VOID");
  assert.equal(result.effectiveOdds, undefined);
  assert.equal(fake._debug.transactions()[0]?.type, "ADJUSTMENT");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "0");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
});

test("X3B financial integration (5): E=0 (a real full LOSS leg alongside a HALF_WIN leg) -> SETTLED_LOSS, -100, no override", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "2.00"),
    fakeSelection({ id: "loser", providerEventId: EVENT_B, canonicalSelectionType: "AWAY", odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) }, // would be HALF_WIN
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // AWAY loses
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_LOSS");
  assert.equal(result.effectiveOdds, undefined); // no override — ordinary full-stake LOSS
  assert.equal(result.exactDelta, undefined);
  assert.equal(fake._debug.transactions()[0]?.type, "BET_STAKE");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-100");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-100");
});

/* -------------------------------------------------------------------------- */
/* X3E Phase 11 — end-to-end AWKWARD stake/odds financial proofs, through the */
/* real autoSettleExpressBet -> aggregateExpressOutcome -> settleBet path.   */
/* These are the exact X3C-reported divergence cases, now proven correct.    */
/* -------------------------------------------------------------------------- */

test("X3E awkward (1): stake 10, HALF_WIN@1.63 + WIN@2.49 -> SETTLED_WIN, Player delta +22.74, one BET_PAYOUT Transaction", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "1.63"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("2.49") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(10) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) }, // -0.75 -> HALF_WIN
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // HOME WIN
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_WIN");
  assert.equal(result.exactDelta?.toString(), "22.74");
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.transactions()[0]?.type, "BET_PAYOUT");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "22.74");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "22.74");
});

test("X3E awkward (2): stake 66.67, HALF_LOSS + WIN@1.91 -> SETTLED_LOSS, Player delta -3.00, one BET_STAKE Transaction", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-1.25", "2.00"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.91") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal("66.67") }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) }, // -1.25 -> HALF_LOSS
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // HOME WIN
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_LOSS");
  assert.equal(result.exactDelta?.toString(), "-3");
  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.transactions()[0]?.type, "BET_STAKE");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "-3");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-3");
});

test("X3E awkward (3): stake 33, HALF_WIN@2.05 + WIN@2.49 -> SETTLED_WIN, Player delta +92.31", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "2.05"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("2.49") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(33) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) }, // -0.75 -> HALF_WIN
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // HOME WIN
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED");
  if (result.kind !== "SETTLED") return;
  assert.equal(result.finalStatus, "SETTLED_WIN");
  assert.equal(result.exactDelta?.toString(), "92.31");
  assert.equal(fake._debug.transactions()[0]?.amount.toString(), "92.31");
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "92.31");
});

/* --- Idempotency: partial WIN, partial LOSS, full LOSS, VOID -------------- */

test("X3B idempotency: partial WIN (E=2.25) settled twice -> exactly one Transaction, one balance mutation, second call idempotent", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "2.00"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
  ];

  const first = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(first.kind, "SETTLED");
  if (first.kind === "SETTLED") assert.equal(first.idempotent, false);

  const second = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(second.kind, "SETTLED");
  if (second.kind === "SETTLED") {
    assert.equal(second.idempotent, true);
    assert.equal(second.finalStatus, "SETTLED_WIN");
  }

  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "125");
});

test("X3B idempotency: partial LOSS (E=0.75) settled twice -> exactly one Transaction, one balance mutation, second call idempotent", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-1.25", "2.00"),
    fakeSelection({ id: "win", providerEventId: EVENT_B, odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
  ];

  const first = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(first.kind, "SETTLED");

  const second = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(second.kind, "SETTLED");
  if (second.kind === "SETTLED") {
    assert.equal(second.idempotent, true);
    assert.equal(second.finalStatus, "SETTLED_LOSS");
  }

  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-25");
});

test("X3B idempotency: full LOSS (E=0) settled twice -> exactly one Transaction, one balance mutation, second call idempotent", async () => {
  const selections = [
    spreadLeg("half", EVENT_A, "Home", "-0.75", "2.00"),
    fakeSelection({ id: "loser", providerEventId: EVENT_B, canonicalSelectionType: "AWAY", odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 1, awayScore: 0 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
  ];

  const first = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(first.kind, "SETTLED");

  const second = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(second.kind, "SETTLED");
  if (second.kind === "SETTLED") assert.equal(second.idempotent, true);

  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "-100");
});

test("X3B idempotency: VOID (E=1, coincidental breakeven) settled twice -> exactly one Transaction, one balance mutation, second call idempotent", async () => {
  const selections = [
    totalsLeg("half1", EVENT_A, "OVER", "2.75", "3.00"),
    totalsLeg("half2", EVENT_B, "OVER", "2.25", "1.90"),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({ stake: new Prisma.Decimal(100) }, selections) });
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 1 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: 1, awayScore: 1 }) },
  ];

  const first = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(first.kind, "SETTLED");

  const second = await autoSettleExpressBet(db(fake), input(results));
  assert.equal(second.kind, "SETTLED");
  if (second.kind === "SETTLED") {
    assert.equal(second.idempotent, true);
    assert.equal(second.finalStatus, "VOID");
  }

  assert.equal(fake._debug.transactionCreateCallCount(), 1);
  assert.equal(fake._debug.playerUpdateCallCount(), 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "0");
});

test("INVALID_DATA: no LOSS, one leg's event result missing a score -> NO_ACTION", async () => {
  const fake = createFakeDb();
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
    { providerEventId: EVENT_B, eventResult: eventResult({ homeScore: null }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.aggregate.kind, "INVALID_DATA");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

/* -------------------------------------------------------------------------- */
/* Duplicate / missing provider ids                                          */
/* -------------------------------------------------------------------------- */

test("duplicate providerEventId in eventResults -> REJECTED, no DB write", async () => {
  const fake = createFakeDb();
  const results: EventResultEntryInput[] = [
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
    { providerEventId: EVENT_A, eventResult: eventResult({ homeScore: 5, awayScore: 0 }) }, // duplicate key
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "DUPLICATE_PROVIDER_EVENT_RESULT" });
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("extra unmatched providerEventId in eventResults is silently ignored, not rejected", async () => {
  const fake = createFakeDb();
  const results: EventResultEntryInput[] = [
    ...BOTH_WIN_RESULTS,
    { providerEventId: "evt-unrelated", eventResult: eventResult({ homeScore: 9, awayScore: 0 }) },
  ];

  const result = await autoSettleExpressBet(db(fake), input(results));

  assert.equal(result.kind, "SETTLED"); // proceeds normally, extra entry never looked up
});

test("missing provider result for one leg -> WAITING via NO_ACTION (covered above), no crash", async () => {
  const fake = createFakeDb();
  const result = await autoSettleExpressBet(db(fake), input([]));

  assert.equal(result.kind, "NO_ACTION");
  if (result.kind !== "NO_ACTION") return;
  assert.equal(result.aggregate.kind, "WAITING");
});

/* -------------------------------------------------------------------------- */
/* Old EXPRESS without metadata                                              */
/* -------------------------------------------------------------------------- */

test("old EXPRESS without provider metadata on any leg -> REJECTED/MISSING_PROVIDER_REFERENCE", async () => {
  const selections = [
    fakeSelection({ id: "sel-1", providerName: null, providerEventId: null }),
    fakeSelection({ id: "sel-2", providerName: null, providerEventId: null, canonicalMarketType: null, canonicalSelectionType: null, canonicalPeriod: null }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({}, selections) });

  const result = await autoSettleExpressBet(db(fake), input([]));

  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_PROVIDER_REFERENCE" });
});

test("EXPRESS with valid provider metadata but missing canonical fields -> REJECTED/MISSING_CANONICAL_METADATA", async () => {
  const selections = [
    fakeSelection({ id: "sel-1", providerEventId: EVENT_A }),
    fakeSelection({ id: "sel-2", providerEventId: EVENT_B, canonicalMarketType: null }),
  ];
  const fake = createFakeDb({ bet: fakeExpressBet({}, selections) });

  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));

  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "MISSING_CANONICAL_METADATA" });
});

test("EXPRESS bet with zero selections -> REJECTED/EMPTY_SELECTIONS (defensive; Stage 12 guarantees this never happens in practice)", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({}, []) });

  const result = await autoSettleExpressBet(db(fake), input([]));

  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "EMPTY_SELECTIONS" });
});

/* -------------------------------------------------------------------------- */
/* Eligibility — bet-level                                                    */
/* -------------------------------------------------------------------------- */

test("Bet not found -> NOT_FOUND", async () => {
  const fake = createFakeDb({ bet: null });
  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));
  assert.deepEqual(result, { kind: "NOT_FOUND", betId: BET_ID });
});

test("SINGLE bet rejected -> NOT_EXPRESS", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({ type: "SINGLE" }) });
  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "NOT_EXPRESS" });
});

test("PENDING EXPRESS rejected -> UNSUPPORTED_BET_STATUS", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({ status: "PENDING" }) });
  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));
  assert.deepEqual(result, { kind: "REJECTED", betId: BET_ID, reasonCode: "UNSUPPORTED_BET_STATUS" });
});

/* -------------------------------------------------------------------------- */
/* Duplicate settlement / idempotency                                        */
/* -------------------------------------------------------------------------- */

test("duplicate settlement: second identical call is idempotent, no second Transaction, no double balance change", async () => {
  const fake = createFakeDb();

  const first = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));
  assert.equal(first.kind, "SETTLED");
  if (first.kind !== "SETTLED") return;
  assert.equal(first.idempotent, false);

  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();

  const second = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS));
  assert.equal(second.kind, "SETTLED");
  if (second.kind !== "SETTLED") return;
  assert.equal(second.idempotent, true);

  assert.equal(fake._debug.transactions().length, 1);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

test("duplicate settlement: already settled to a DIFFERENT outcome -> CONFLICT, not a silent overwrite", async () => {
  const fake = createFakeDb({ bet: fakeExpressBet({ status: "SETTLED_LOSS" }) });

  const result = await autoSettleExpressBet(db(fake), input(BOTH_WIN_RESULTS)); // would compute WIN

  assert.deepEqual(result, { kind: "CONFLICT", betId: BET_ID, reasonCode: "ALREADY_SETTLED" });
  assert.equal(fake._debug.getBet(BET_ID)?.status, "SETTLED_LOSS");
  assert.equal(fake._debug.transactionCreateCallCount(), 0);
});

test("purity: eventResults input is not mutated", async () => {
  const fake = createFakeDb();
  const results = [...BOTH_WIN_RESULTS];
  const resultsCopy = JSON.parse(JSON.stringify(results.map((r) => ({ providerEventId: r.providerEventId, eventResult: r.eventResult }))));

  await autoSettleExpressBet(db(fake), input(results));

  const resultsAfter = JSON.parse(JSON.stringify(results.map((r) => ({ providerEventId: r.providerEventId, eventResult: r.eventResult }))));
  assert.deepEqual(resultsAfter, resultsCopy);
});
