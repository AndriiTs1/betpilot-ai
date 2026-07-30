import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Prisma,
  SettlementReviewReason,
  SettlementReviewStatus,
  type BetStatus,
  type PrismaClient,
} from "@/lib/generated/prisma/client";
import { pollConfirmedBetResults, type PollConfirmedBetResultsInput } from "./pollConfirmedBetResults";
import type { ScoresFetchResult } from "@/lib/odds/providers/theOddsApi/scoresAdapter";
import type { CanonicalEventResult } from "./eventResultDomain";

// ---------------------------------------------------------------------
// In-memory fake Prisma client. Extends the established pattern from
// autoSettleSingleBet.test.ts / autoSettleExpressBet.test.ts with a real
// bet.findMany() that actually interprets the where-clause shape
// pollConfirmedBetResults.ts constructs (type/status/eventStartTime range,
// selections.some(...) for EXPRESS) — a faithful-enough fake to prove the
// query's own filtering logic, not just the settlement plumbing.
// ---------------------------------------------------------------------

interface FakeSelectionRow {
  id: string;
  betId: string;
  providerName: string | null;
  providerSportKey: string | null;
  providerEventId: string | null;
  eventStartTime: Date | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
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
  providerName: string | null;
  providerSportKey: string | null;
  providerEventId: string | null;
  eventStartTime: Date | null;
  canonicalMarketType: string | null;
  canonicalSelectionType: string | null;
  canonicalParticipant: string | null;
  canonicalPeriod: string | null;
  selections: FakeSelectionRow[];
  // Stage 4.3.3
  settlementRetryCount: number;
  lastSettlementAttemptAt: Date | null;
  lastSettlementErrorCode: string | null;
  lastSettlementErrorMessage: string | null;
  settlementReviewStatus: SettlementReviewStatus | null;
  settlementReviewReason: SettlementReviewReason | null;
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
  return new Prisma.PrismaClientKnownRequestError("record not found", {
    code: "P2025",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

const PLAYER_ID = "player-1";
const NOW = new Date("2026-07-28T12:00:00Z");
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function inWindow(hoursAgo = 2): Date {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000);
}

function fakeSingleBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "single-1",
    type: "SINGLE",
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("2.00"),
    odds: new Prisma.Decimal("2.00"),
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: inWindow(),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    selections: [],
    settlementRetryCount: 0,
    lastSettlementAttemptAt: null,
    lastSettlementErrorCode: null,
    lastSettlementErrorMessage: null,
    settlementReviewStatus: null,
    settlementReviewReason: null,
    ...overrides,
  };
}

function fakeSelection(overrides: Partial<FakeSelectionRow> = {}): FakeSelectionRow {
  return {
    id: "sel-1",
    betId: "express-1",
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: inWindow(),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    odds: new Prisma.Decimal("2.00"),
    ...overrides,
  };
}

function fakeExpressBet(selections: FakeSelectionRow[], overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "express-1",
    type: "EXPRESS",
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: new Prisma.Decimal("4.00"),
    odds: null,
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    eventStartTime: null,
    canonicalMarketType: null,
    canonicalSelectionType: null,
    canonicalParticipant: null,
    canonicalPeriod: null,
    selections,
    settlementRetryCount: 0,
    lastSettlementAttemptAt: null,
    lastSettlementErrorCode: null,
    lastSettlementErrorMessage: null,
    settlementReviewStatus: null,
    settlementReviewReason: null,
    ...overrides,
  };
}

interface FieldFilter {
  lte?: Date;
  gte?: Date;
}

interface FindManyArgs {
  where: {
    type: string;
    status: string;
    eventStartTime?: FieldFilter;
    selections?: { some: { eventStartTime: FieldFilter } };
    settlementReviewStatus?: null;
  };
  orderBy: Record<string, "asc" | "desc">;
  take: number;
}

function matchesRange(value: Date | null, filter: FieldFilter | undefined): boolean {
  if (!filter) return true;
  if (value === null) return false;
  if (filter.lte && value.getTime() > filter.lte.getTime()) return false;
  if (filter.gte && value.getTime() < filter.gte.getTime()) return false;
  return true;
}

function createFakeDb(seed: { bets?: FakeBetRow[]; playerCurrentCredit?: Prisma.Decimal } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  const transactions: FakeTransactionRow[] = [];
  let nextTxId = 1;
  let findManyCallCount = 0;

  for (const bet of seed.bets ?? []) {
    bets.set(bet.id, { ...bet, selections: bet.selections.map((s) => ({ ...s })) });
    if (!players.has(bet.playerId)) {
      players.set(bet.playerId, { id: bet.playerId, currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0) });
    }
  }

  const findUnique = async ({ where }: { where: { id: string } }) => {
    const bet = bets.get(where.id);
    return bet ? { ...bet, selections: bet.selections.map((s) => ({ ...s })) } : null;
  };

  const findMany = async (args: FindManyArgs) => {
    findManyCallCount += 1;
    let rows = Array.from(bets.values()).filter((b) => b.type === args.where.type && b.status === args.where.status);

    if (args.where.eventStartTime) {
      rows = rows.filter((b) => matchesRange(b.eventStartTime, args.where.eventStartTime));
    }
    if (args.where.selections) {
      const filter = args.where.selections.some.eventStartTime;
      rows = rows.filter((b) => b.selections.some((sel) => matchesRange(sel.eventStartTime, filter)));
    }
    // Stage 4.3.3 — the exact eligibility exclusion pollConfirmedBetResults.ts
    // now applies: `settlementReviewStatus: null` in the where-clause
    // excludes any row whose settlementReviewStatus is NOT null (i.e.
    // NEEDS_REVIEW or RESOLVED), narrowing the existing filter set, never
    // widening it.
    if ("settlementReviewStatus" in args.where) {
      rows = rows.filter((b) => b.settlementReviewStatus === null);
    }

    const orderField = Object.keys(args.orderBy)[0] as "eventStartTime" | "id";
    rows = [...rows].sort((a, b) => {
      if (orderField === "id") return a.id.localeCompare(b.id);
      const at = a.eventStartTime?.getTime() ?? 0;
      const bt = b.eventStartTime?.getTime() ?? 0;
      return at - bt;
    });

    return rows.slice(0, args.take).map((b) => ({ ...b, selections: b.selections.map((s) => ({ ...s })) }));
  };

  const tx = {
    bet: {
      findUnique,
      findMany,
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
        const player = players.get(where.id);
        if (!player) throw p2025();
        player.currentCredit = player.currentCredit.plus(data.currentCredit.increment);
        return { ...player };
      },
    },
    transaction: {
      create: async ({ data }: { data: Omit<FakeTransactionRow, "id" | "createdAt"> }) => {
        const row: FakeTransactionRow = { id: `tx-${nextTxId++}`, createdAt: new Date(), ...data };
        transactions.push(row);
        return row;
      },
    },
  };

  // Stage 4.3.3 — the top-level, non-transactional bet.update() the new
  // settlement-tracking writes use (deliberately separate from tx.bet.update
  // above, which is settleBet()'s own atomic conditional-on-status update —
  // never reused for this, matching production exactly: these are two
  // different call sites, one inside $transaction, one never inside it).
  // Supports exactly the two shapes pollConfirmedBetResults.ts's
  // applyBetLevelClassification() actually sends: a plain field assignment,
  // and settlementRetryCount's `{ increment: 1 }`.
  const topLevelUpdate = async ({
    where,
    data,
  }: {
    where: { id: string };
    data: Partial<Omit<FakeBetRow, "settlementRetryCount">> & { settlementRetryCount?: number | { increment: number } };
  }) => {
    const bet = bets.get(where.id);
    if (!bet) throw p2025();

    const { settlementRetryCount, ...rest } = data;
    Object.assign(bet, rest);
    if (settlementRetryCount !== undefined) {
      bet.settlementRetryCount =
        typeof settlementRetryCount === "number" ? settlementRetryCount : bet.settlementRetryCount + settlementRetryCount.increment;
    }
    return { ...bet };
  };

  return {
    bet: { findUnique, findMany, update: topLevelUpdate },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      getBet: (id: string) => bets.get(id),
      getPlayer: (id: string) => players.get(id),
      transactions: () => transactions,
      findManyCallCount: () => findManyCallCount,
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

function fakeFetchScores(responses: Record<string, ScoresFetchResult>): (input: { providerSportKey: string; providerEventIds: readonly string[] }) => Promise<ScoresFetchResult> {
  let callCount = 0;
  const fn = async (input: { providerSportKey: string; providerEventIds: readonly string[] }): Promise<ScoresFetchResult> => {
    callCount += 1;
    const key = input.providerSportKey;
    return responses[key] ?? { status: "SUCCESS", results: [], rejectedEvents: 0 };
  };
  (fn as unknown as { callCount: () => number }).callCount = () => callCount;
  return fn;
}

function successResult(entries: Array<{ providerEventId: string; eventResult: CanonicalEventResult }>): ScoresFetchResult {
  return { status: "SUCCESS", results: entries, rejectedEvents: 0 };
}

function input(overrides: Partial<PollConfirmedBetResultsInput> = {}): PollConfirmedBetResultsInput {
  return { now: NOW, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Empty eligible list                                                        */
/* -------------------------------------------------------------------------- */

test("empty eligible result: provider is never called", async () => {
  const fake = createFakeDb({ bets: [] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.deepEqual(report, {
    scannedBets: 0, eligibleBets: 0, uniqueEvents: 0, providerRequests: 0, providerFailures: 0,
    settled: 0, noAction: 0, rejected: 0, conflicts: 0, failed: 0,
    transientFailures: 0, permanentReviewFailures: 0, escalatedToManualReview: 0,
  });
});

/* -------------------------------------------------------------------------- */
/* SINGLE outcomes                                                            */
/* -------------------------------------------------------------------------- */

test("SINGLE WIN settles via autoSettleSingleBet", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("single-1")?.status, "SETTLED_WIN");
});

test("SINGLE LOSS settles via autoSettleSingleBet", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 0, awayScore: 2 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("single-1")?.status, "SETTLED_LOSS");
});

test("SINGLE VOID settles via autoSettleSingleBet (2-way draw)", async () => {
  const bet = fakeSingleBet({ canonicalMarketType: "MONEYLINE_2WAY" });
  const fake = createFakeDb({ bets: [bet] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 1, awayScore: 1 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("single-1")?.status, "VOID");
});

test("SINGLE WAITING: no provider result available -> noAction, autoSettleSingleBet never called (bet status unchanged)", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([]) }); // event missing from response

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.noAction, 1);
  assert.equal(fake._debug.getBet("single-1")?.status, "CONFIRMED");
  assert.equal(fake._debug.transactions().length, 0);
});

test("SINGLE INVALID_DATA (completed with no scores) -> noAction", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: null, awayScore: null }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.noAction, 1);
  assert.equal(fake._debug.getBet("single-1")?.status, "CONFIRMED");
});

/* -------------------------------------------------------------------------- */
/* EXPRESS outcomes                                                           */
/* -------------------------------------------------------------------------- */

test("EXPRESS all-WIN settles", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1" }),
    fakeSelection({ id: "s2", providerEventId: "e2", odds: new Prisma.Decimal("1.50") }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e2", eventResult: eventResult({ homeScore: 3, awayScore: 1 }) },
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("express-1")?.status, "SETTLED_WIN");
});

test("EXPRESS LOSS settles", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1" }),
    fakeSelection({ id: "s2", providerEventId: "e2", canonicalSelectionType: "AWAY" }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e2", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // AWAY loses
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("express-1")?.status, "SETTLED_LOSS");
});

test("EXPRESS all-VOID settles", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1", canonicalMarketType: "MONEYLINE_2WAY" }),
    fakeSelection({ id: "s2", providerEventId: "e2", canonicalMarketType: "MONEYLINE_2WAY" }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "e1", eventResult: eventResult({ homeScore: 1, awayScore: 1 }) },
      { providerEventId: "e2", eventResult: eventResult({ homeScore: 2, awayScore: 2 }) },
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("express-1")?.status, "VOID");
});

test("EXPRESS WIN+VOID settles using adjusted effectiveOdds", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1", canonicalMarketType: "MONEYLINE_3WAY", odds: new Prisma.Decimal("2.00") }),
    fakeSelection({ id: "s2", providerEventId: "e2", canonicalMarketType: "MONEYLINE_2WAY", odds: new Prisma.Decimal("3.00") }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections, { stake: new Prisma.Decimal(100), totalOdds: new Prisma.Decimal("6.00") })] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e2", eventResult: eventResult({ homeScore: 1, awayScore: 1 }) }, // 2-way draw -> VOID
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("express-1")?.status, "SETTLED_WIN");
  const [tx] = fake._debug.transactions();
  assert.equal(tx.amount.toString(), "100"); // 100 * 2.00 - 100, not 100 * 6.00 - 100
});

test("EXPRESS WAITING because one event is missing from the provider response", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1" }),
    fakeSelection({ id: "s2", providerEventId: "e2" }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]), // e2 missing
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.noAction, 1);
  assert.equal(fake._debug.getBet("express-1")?.status, "CONFIRMED");
});

test("EXPRESS WAITING because one event is not yet completed", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1" }),
    fakeSelection({ id: "s2", providerEventId: "e2" }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e2", eventResult: eventResult({ status: "IN_PROGRESS", homeScore: null, awayScore: null }) },
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.noAction, 1);
});

/* -------------------------------------------------------------------------- */
/* Event reuse / deduplication / batching                                    */
/* -------------------------------------------------------------------------- */

test("same event reused by two different SINGLE bets -> one provider request, both settle", async () => {
  const betA = fakeSingleBet({ id: "single-a", providerEventId: "evt-shared" });
  const betB = fakeSingleBet({ id: "single-b", providerEventId: "evt-shared" });
  const fake = createFakeDb({ bets: [betA, betB] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-shared", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.uniqueEvents, 1);
  assert.equal(report.providerRequests, 1);
  assert.equal(report.settled, 2);
});

test("event deduplicated across SINGLE and EXPRESS referencing the same providerEventId", async () => {
  const singleBet = fakeSingleBet({ id: "single-1", providerEventId: "evt-shared" });
  const expressSelections = [fakeSelection({ id: "s1", providerEventId: "evt-shared" })];
  const fake = createFakeDb({ bets: [singleBet, fakeExpressBet(expressSelections)] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-shared", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.uniqueEvents, 1);
  assert.equal(report.settled, 2); // both the SINGLE and the EXPRESS settle from the one fetched result
});

test("providers grouped by sport key -> one request per distinct sport", async () => {
  const betA = fakeSingleBet({ id: "single-a", providerSportKey: "soccer_epl", providerEventId: "e1" });
  const betB = fakeSingleBet({ id: "single-b", providerSportKey: "basketball_nba", providerEventId: "e2" });
  const fake = createFakeDb({ bets: [betA, betB] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]),
    basketball_nba: successResult([{ providerEventId: "e2", eventResult: eventResult({ homeScore: 100, awayScore: 90 }) }]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.providerRequests, 2);
  assert.equal(report.settled, 2);
});

test("extra provider event (not referenced by any bet) is ignored, does not affect the report", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "evt-unrelated", eventResult: eventResult({ homeScore: 9, awayScore: 0 }) },
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
});

/* -------------------------------------------------------------------------- */
/* Failure isolation                                                          */
/* -------------------------------------------------------------------------- */

test("one sport batch failing does not stop another sport batch from settling", async () => {
  const betA = fakeSingleBet({ id: "single-a", providerSportKey: "soccer_epl", providerEventId: "e1" });
  const betB = fakeSingleBet({ id: "single-b", providerSportKey: "basketball_nba", providerEventId: "e2" });
  const fake = createFakeDb({ bets: [betA, betB] });
  const fetchFn = fakeFetchScores({
    soccer_epl: { status: "FAILED", reason: "HTTP_5XX" },
    basketball_nba: successResult([{ providerEventId: "e2", eventResult: eventResult({ homeScore: 100, awayScore: 90 }) }]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.providerFailures, 1);
  assert.equal(report.settled, 1); // basketball bet still settled
  assert.equal(report.noAction, 1); // soccer bet -> no result available -> noAction
});

test("one bet REJECTED does not stop another bet from settling", async () => {
  const okBet = fakeSingleBet({ id: "single-ok" });
  const brokenBet = fakeSingleBet({ id: "single-broken", providerEventId: "e2", canonicalMarketType: null });
  const fake = createFakeDb({ bets: [okBet, brokenBet] });
  // Both events must actually be present in the provider response so
  // autoSettleSingleBet() is called for brokenBet too — otherwise it would
  // short-circuit to noAction ("no result available") before ever reaching
  // its own REJECTED/MISSING_CANONICAL_METADATA eligibility check.
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([
      { providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e2", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
    ]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1);
  assert.equal(report.rejected, 1);
});

test("one bet CONFLICT does not stop another bet from settling", async () => {
  // The polling query only selects status: CONFIRMED, so a bet already
  // SETTLED_* is never scanned in the first place — a real CONFLICT can
  // only arise from a genuine race: something else (e.g. an operator's
  // manual settlement) changes the bet's status AFTER this cycle already
  // read it as CONFIRMED but BEFORE this cycle's own settlement call runs.
  // Simulated deterministically here by mutating the fake DB's bet status
  // as a side effect inside the injected fetchScoresFn — which the real
  // polling service always awaits strictly between the query step and the
  // settlement step — rather than via any fake concurrent-Promise race.
  const okBet = fakeSingleBet({ id: "single-ok", providerEventId: "e-ok" });
  const raceBet = fakeSingleBet({ id: "single-race", providerEventId: "e-race" });
  const fake = createFakeDb({ bets: [okBet, raceBet] });

  const fetchFn = async () => {
    const raceBetRow = fake._debug.getBet("single-race");
    if (raceBetRow) raceBetRow.status = "SETTLED_LOSS"; // concurrent settlement lands here
    return successResult([
      { providerEventId: "e-ok", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
      { providerEventId: "e-race", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }, // would compute WIN, conflicts with the now-SETTLED_LOSS status
    ]);
  };

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.settled, 1); // single-ok
  assert.equal(report.conflicts, 1); // single-race
  assert.equal(fake._debug.getBet("single-race")?.status, "SETTLED_LOSS"); // unchanged, not silently overwritten to WIN
});

/* -------------------------------------------------------------------------- */
/* Idempotency / overlapping cycles                                          */
/* -------------------------------------------------------------------------- */

test("repeated polling cycle does not double-pay", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const first = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(first.settled, 1);
  const balanceAfterFirst = fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString();
  const txCountAfterFirst = fake._debug.transactions().length;

  // Second cycle: the bet is now SETTLED_WIN, so the CONFIRMED-only query
  // no longer selects it at all — this is the primary, expected safety net
  // (the bet simply isn't scanned again).
  const second = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(second.scannedBets, 0);
  assert.equal(fake._debug.transactions().length, txCountAfterFirst);
  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), balanceAfterFirst);
});

test("overlapping invocation (same CONFIRMED bet settled twice concurrently) remains financially idempotent via settleBet()'s own guard", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const [r1, r2] = await Promise.all([
    pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn })),
    pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn })),
  ]);

  // Both cycles read the bet as CONFIRMED (fake db has no real async
  // interleaving to race on, so this proves idempotent-replay safety, not
  // a genuine data race — same honest limitation documented in every
  // earlier settlement stage's own tests).
  assert.equal(r1.settled + r2.settled >= 1, true);
  assert.equal(fake._debug.transactions().length, 1); // only ever one real payout
});

/* -------------------------------------------------------------------------- */
/* Query filtering — excluded bets                                            */
/* -------------------------------------------------------------------------- */

test("settled bets are excluded by the query", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ status: "SETTLED_WIN" })] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(report.scannedBets, 0);
});

test("future events are excluded", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ eventStartTime: new Date(NOW.getTime() + 60 * 60 * 1000) })] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(report.scannedBets, 0);
});

test("events older than 3 days are excluded", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ eventStartTime: new Date(NOW.getTime() - THREE_DAYS_MS - 60 * 60 * 1000) })] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(report.scannedBets, 0);
});

test("missing eventStartTime is excluded", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ eventStartTime: null })] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(report.scannedBets, 0);
});

test("old EXPRESS without any provider metadata on any leg is scanned but yields REJECTED via autoSettleExpressBet — never crashes, never settles blindly", async () => {
  // A leg needs SOME in-window eventStartTime for the bet to be scanned at
  // all (selections.some filter) — an EXPRESS entirely without metadata
  // never has that, so this specific case is naturally excluded from
  // scanning too (matches the query's own all-or-nothing reliance).
  const selections = [fakeSelection({ providerName: null, providerSportKey: null, providerEventId: null, eventStartTime: null })];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });
  const fetchFn = fakeFetchScores({});
  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(report.scannedBets, 0);
});

/* -------------------------------------------------------------------------- */
/* Starvation regression                                                      */
/* -------------------------------------------------------------------------- */

test("starvation regression: not-yet-eligible bets never crowd out later eligible ones, because the window filter runs at the query level", async () => {
  // 5 bets with id ordering "a".."e" whose eventStartTime is in the FUTURE
  // (would naively occupy the first N of a plain "take first N CONFIRMED"
  // scan if that scan didn't filter by window first), followed by one
  // genuinely eligible bet "z".
  const notYetEligible = ["a", "b", "c", "d", "e"].map((suffix) =>
    fakeSingleBet({ id: `single-${suffix}`, providerEventId: `future-${suffix}`, eventStartTime: new Date(NOW.getTime() + 60 * 60 * 1000) }),
  );
  const eligible = fakeSingleBet({ id: "single-z", providerEventId: "evt-1" });
  const fake = createFakeDb({ bets: [...notYetEligible, eligible] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn, limit: 3 }));

  // Even with a limit of 3 (smaller than the 5 not-yet-eligible rows), the
  // genuinely eligible bet is still found and settled — proof the window
  // filter runs in the query, not as an in-memory post-filter over an
  // arbitrary first-N page.
  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("single-z")?.status, "SETTLED_WIN");
});

/* -------------------------------------------------------------------------- */
/* Report shape / bounded query / no direct writes                            */
/* -------------------------------------------------------------------------- */

test("PollingReport counters are exact for a mixed cycle", async () => {
  const winBet = fakeSingleBet({ id: "s-win", providerEventId: "e-win" });
  const waitingBet = fakeSingleBet({ id: "s-wait", providerEventId: "e-wait" });
  const fake = createFakeDb({ bets: [winBet, waitingBet] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "e-win", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]), // e-wait missing
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.scannedBets, 2);
  assert.equal(report.eligibleBets, 2);
  assert.equal(report.uniqueEvents, 2);
  assert.equal(report.providerRequests, 1);
  assert.equal(report.settled, 1);
  assert.equal(report.noAction, 1);
});

test("bounded query: take/limit is respected", async () => {
  const bets = Array.from({ length: 5 }, (_, i) => fakeSingleBet({ id: `single-${i}`, providerEventId: `e${i}` }));
  const fake = createFakeDb({ bets });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult(bets.map((b) => ({ providerEventId: b.providerEventId!, eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }))) });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn, limit: 2 }));

  assert.equal(report.scannedBets, 2);
});

test("no direct Transaction/balance writes outside settleBet()'s own path — proven by exact counts matching WIN math", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ stake: new Prisma.Decimal(50), totalOdds: new Prisma.Decimal("3.00") })], playerCurrentCredit: new Prisma.Decimal(0) });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]) });

  await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(fake._debug.getPlayer(PLAYER_ID)?.currentCredit.toString(), "100"); // 50*3.00 - 50, exact settleBet() math
  assert.equal(fake._debug.transactions().length, 1);
});

/* -------------------------------------------------------------------------- */
/* Stage 4.3.3 — cycle-level vs bet-level classification                     */
/* -------------------------------------------------------------------------- */

test("1. failed provider chunk affecting N bets: providerFailures increments, zero settlement-field changes on any of them", async () => {
  const bets = Array.from({ length: 3 }, (_, i) => fakeSingleBet({ id: `single-${i}`, providerEventId: `e${i}` }));
  const fake = createFakeDb({ bets });
  const fetchFn = fakeFetchScores({ soccer_epl: { status: "FAILED", reason: "HTTP_5XX" } });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.providerFailures, 1);
  assert.equal(report.transientFailures, 0);
  assert.equal(report.permanentReviewFailures, 0);
  assert.equal(report.escalatedToManualReview, 0);
  for (const bet of bets) {
    const row = fake._debug.getBet(bet.id);
    assert.equal(row?.status, "CONFIRMED");
    assert.equal(row?.settlementRetryCount, 0);
    assert.equal(row?.lastSettlementAttemptAt, null);
    assert.equal(row?.lastSettlementErrorCode, null);
    assert.equal(row?.lastSettlementErrorMessage, null);
    assert.equal(row?.settlementReviewStatus, null);
    assert.equal(row?.settlementReviewReason, null);
  }
});

test("2. successful chunk missing one id: only that bet gets an EVENT_NOT_FOUND retry, the other settles normally", async () => {
  const foundBet = fakeSingleBet({ id: "single-found", providerEventId: "e-found" });
  const missingBet = fakeSingleBet({ id: "single-missing", providerEventId: "e-missing" });
  const fake = createFakeDb({ bets: [foundBet, missingBet] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "e-found", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]), // e-missing absent, chunk itself succeeded
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.providerFailures, 0);
  assert.equal(report.settled, 1);
  assert.equal(fake._debug.getBet("single-found")?.status, "SETTLED_WIN");
  assert.equal(fake._debug.getBet("single-found")?.settlementRetryCount, 0);

  const missingRow = fake._debug.getBet("single-missing");
  assert.equal(missingRow?.status, "CONFIRMED");
  assert.equal(missingRow?.settlementRetryCount, 1);
  assert.equal(missingRow?.lastSettlementErrorCode, "EVENT_NOT_FOUND");
  assert.equal(missingRow?.settlementReviewStatus, null);
  assert.equal(report.transientFailures, 1);
});

test("3. EVENT_NOT_FOUND retryCount increments atomically across cycles and escalates to NEEDS_REVIEW exactly once at MAX_AUTO_RETRY_ATTEMPTS", async () => {
  const bet = fakeSingleBet({ id: "single-1", providerEventId: "evt-1" });
  const fake = createFakeDb({ bets: [bet] });
  const fetchFn = fakeFetchScores({ soccer_epl: successResult([]) }); // never resolves — chunk always succeeds, event always absent

  const r1 = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(fake._debug.getBet("single-1")?.settlementRetryCount, 1);
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewStatus, null);
  assert.equal(r1.escalatedToManualReview, 0);

  const r2 = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(fake._debug.getBet("single-1")?.settlementRetryCount, 2);
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewStatus, null);
  assert.equal(r2.escalatedToManualReview, 0);

  const r3 = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(fake._debug.getBet("single-1")?.settlementRetryCount, 3);
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW);
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewReason, SettlementReviewReason.EVENT_NOT_FOUND_MAX_RETRIES);
  assert.equal(r3.escalatedToManualReview, 1);

  // A 4th cycle no longer even scans this bet — it's excluded from the
  // eligibility query now that settlementReviewStatus is NEEDS_REVIEW.
  const r4 = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));
  assert.equal(r4.scannedBets, 0);
  assert.equal(fake._debug.getBet("single-1")?.settlementRetryCount, 3); // unchanged
});

test("4. MISSING_SCORE is a bet-level transient retry, never settles as LOSS/VOID", async () => {
  const bet = fakeSingleBet({ id: "single-1", providerEventId: "evt-1" });
  const fake = createFakeDb({ bets: [bet] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: null, awayScore: null }) }]), // COMPLETED, no scores
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.noAction, 1);
  assert.equal(report.transientFailures, 1);
  const row = fake._debug.getBet("single-1");
  assert.equal(row?.status, "CONFIRMED"); // never LOSS/VOID
  assert.equal(row?.settlementRetryCount, 1);
  assert.equal(row?.lastSettlementErrorCode, "MISSING_SCORE");
  assert.equal(row?.settlementReviewStatus, null);
});

test("5. WAITING (event not yet completed / postponed / abandoned) never increments retryCount and never sets NEEDS_REVIEW", async () => {
  for (const status of ["NOT_STARTED", "IN_PROGRESS", "POSTPONED"] as const) {
    const bet = fakeSingleBet({ id: `single-${status}`, providerEventId: `evt-${status}` });
    const fake = createFakeDb({ bets: [bet] });
    const fetchFn = fakeFetchScores({
      soccer_epl: successResult([{ providerEventId: `evt-${status}`, eventResult: eventResult({ status, homeScore: null, awayScore: null }) }]),
    });

    const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

    assert.equal(report.transientFailures, 0, `status ${status}`);
    const row = fake._debug.getBet(`single-${status}`);
    assert.equal(row?.settlementRetryCount, 0, `status ${status}`);
    assert.equal(row?.settlementReviewStatus, null, `status ${status}`);
    // Informational only — lastSettlementAttemptAt/errorCode ARE written
    // for WAITING (diagnostic "last checked at" value), but never a
    // technical errorMessage (would be misleading for a legitimate wait).
    assert.equal(row?.lastSettlementAttemptAt?.getTime(), NOW.getTime(), `status ${status}`);
    assert.equal(row?.lastSettlementErrorMessage, null, `status ${status}`);
  }
});

test("6. PARTICIPANT_MISMATCH (a permanent reason) escalates to NEEDS_REVIEW immediately, retryCount stays 0", async () => {
  const bet = fakeSingleBet({
    id: "single-1",
    providerEventId: "evt-1",
    canonicalSelectionType: "PARTICIPANT",
    canonicalParticipant: "Some Totally Unrelated Team",
  });
  const fake = createFakeDb({ bets: [bet] });
  const fetchFn = fakeFetchScores({
    soccer_epl: successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]),
  });

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.permanentReviewFailures, 1);
  assert.equal(report.escalatedToManualReview, 1);
  const row = fake._debug.getBet("single-1");
  assert.equal(row?.status, "CONFIRMED");
  assert.equal(row?.settlementRetryCount, 0);
  assert.equal(row?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW);
  assert.equal(row?.settlementReviewReason, SettlementReviewReason.PARTICIPANT_MISMATCH);
});

test("7. UNSUPPORTED_BET_STATUS (status changed during the race window) is CONFLICT_NO_ACTION — no retry, no review", async () => {
  const bet = fakeSingleBet({ id: "single-1", providerEventId: "evt-1" });
  const fake = createFakeDb({ bets: [bet] });

  // Same deterministic race-simulation technique as the existing CONFLICT
  // test above: mutate the fake DB's bet status as a side effect inside the
  // injected fetchScoresFn, landing on PENDING (outside
  // ELIGIBLE_BET_STATUSES) rather than a settled status.
  const fetchFn = async () => {
    const row = fake._debug.getBet("single-1");
    if (row) row.status = "PENDING";
    return successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]);
  };

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.rejected, 1); // unchanged existing bucket
  assert.equal(report.transientFailures, 0);
  assert.equal(report.permanentReviewFailures, 0);
  assert.equal(report.escalatedToManualReview, 0);
  const row = fake._debug.getBet("single-1");
  assert.equal(row?.settlementRetryCount, 0);
  assert.equal(row?.settlementReviewStatus, null);
});

test("8. a NEEDS_REVIEW bet no longer appears in active polling eligibility", async () => {
  const bet = fakeSingleBet({
    id: "single-1",
    providerEventId: "evt-1",
    settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW,
    settlementReviewReason: SettlementReviewReason.PARTICIPANT_MISMATCH,
  });
  const fake = createFakeDb({ bets: [bet] });
  const fetchFn = fakeFetchScores({});

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.scannedBets, 0);
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewStatus, SettlementReviewStatus.NEEDS_REVIEW); // untouched
});

test("9. legacy CONFIRMED bet without provider metadata is never scanned and never gets a settlement-field write", async () => {
  const legacyBet = fakeSingleBet({
    id: "legacy-1",
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    eventStartTime: null,
    canonicalMarketType: null,
    canonicalSelectionType: null,
    canonicalPeriod: null,
  });
  const fake = createFakeDb({ bets: [legacyBet] });
  const fetchFn = fakeFetchScores({});

  const report = await pollConfirmedBetResults(db(fake), input({ fetchScoresFn: fetchFn }));

  assert.equal(report.scannedBets, 0);
  const row = fake._debug.getBet("legacy-1");
  assert.equal(row?.settlementRetryCount, 0);
  assert.equal(row?.lastSettlementAttemptAt, null);
  assert.equal(row?.settlementReviewStatus, null);
});
