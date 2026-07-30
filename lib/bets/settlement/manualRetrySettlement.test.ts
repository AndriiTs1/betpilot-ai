import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Prisma,
  SettlementReviewReason,
  SettlementReviewStatus,
  type BetStatus,
  type PrismaClient,
} from "@/lib/generated/prisma/client";
import { checkManualRetryEligibility, retryBetSettlement, type ManualRetryBetSnapshot } from "./manualRetrySettlement";
import type { ScoresFetchResult } from "@/lib/odds/providers/theOddsApi/scoresAdapter";
import type { CanonicalEventResult } from "./eventResultDomain";

/* -------------------------------------------------------------------------- */
/* Fake DB — same conventions as pollConfirmedBetResults.test.ts's own fake,  */
/* extended with the top-level bet.updateMany() this service actually calls  */
/* -------------------------------------------------------------------------- */

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
const NOW = new Date("2026-07-30T12:00:00Z");

function fakeSingleBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "single-1",
    type: "SINGLE",
    status: "CONFIRMED",
    playerId: PLAYER_ID,
    stake: new Prisma.Decimal(100),
    totalOdds: null,
    odds: new Prisma.Decimal("2.00"),
    providerName: "THE_ODDS_API",
    providerSportKey: "soccer_epl",
    providerEventId: "evt-1",
    eventStartTime: new Date("2026-07-20T12:00:00Z"),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    selections: [],
    settlementRetryCount: 2,
    lastSettlementAttemptAt: new Date("2026-07-29T03:00:00Z"),
    lastSettlementErrorCode: "EVENT_NOT_FOUND",
    lastSettlementErrorMessage: "Provider response did not include this event this cycle.",
    settlementReviewStatus: "NEEDS_REVIEW",
    settlementReviewReason: "EVENT_NOT_FOUND_MAX_RETRIES",
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
    eventStartTime: new Date("2026-07-20T12:00:00Z"),
    canonicalMarketType: "MONEYLINE_3WAY",
    canonicalSelectionType: "HOME",
    canonicalParticipant: null,
    canonicalPeriod: "FULL_GAME",
    odds: new Prisma.Decimal("2.00"),
    ...overrides,
  };
}

function fakeExpressBet(selections: FakeSelectionRow[], overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return fakeSingleBet({
    id: "express-1",
    type: "EXPRESS",
    totalOdds: new Prisma.Decimal("4.00"),
    odds: null,
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    eventStartTime: null,
    canonicalMarketType: null,
    canonicalSelectionType: null,
    canonicalPeriod: null,
    selections,
    ...overrides,
  });
}

function createFakeDb(seed: { bets?: FakeBetRow[]; playerCurrentCredit?: Prisma.Decimal } = {}) {
  const bets = new Map<string, FakeBetRow>();
  const players = new Map<string, FakePlayerRow>();
  const transactions: FakeTransactionRow[] = [];
  let nextTxId = 1;

  for (const bet of seed.bets ?? []) {
    bets.set(bet.id, { ...bet, selections: bet.selections.map((s) => ({ ...s })) });
    if (!players.has(bet.playerId)) {
      players.set(bet.playerId, { id: bet.playerId, currentCredit: seed.playerCurrentCredit ?? new Prisma.Decimal(0) });
    }
  }

  // Honors an optional `select` the same way real Prisma does — narrows the
  // returned object to exactly the requested top-level keys. This matters
  // for loadSnapshot()'s own narrower select (manualRetrySettlement.ts):
  // without this, the fake would silently return every FakeBetRow field
  // regardless of what was asked for, masking a real over-fetching bug the
  // "safe, curated field set" test below is specifically there to catch.
  const findUnique = async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
    const bet = bets.get(where.id);
    if (!bet) return null;
    const full = { ...bet, selections: bet.selections.map((s) => ({ ...s })) };
    if (!select) return full;
    const projected: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      projected[key] = (full as Record<string, unknown>)[key];
    }
    return projected;
  };

  const updateMany = async ({
    where,
    data,
  }: {
    where: { id: string; status?: string; settlementReviewStatus?: SettlementReviewStatus | null };
    data: Partial<Omit<FakeBetRow, "settlementRetryCount">> & { settlementRetryCount?: number | { increment: number } };
  }) => {
    const bet = bets.get(where.id);
    if (!bet) return { count: 0 };
    if (where.status !== undefined && bet.status !== where.status) return { count: 0 };
    if ("settlementReviewStatus" in where && bet.settlementReviewStatus !== where.settlementReviewStatus) return { count: 0 };

    const { settlementRetryCount, ...rest } = data;
    Object.assign(bet, rest);
    if (settlementRetryCount !== undefined) {
      bet.settlementRetryCount =
        typeof settlementRetryCount === "number" ? settlementRetryCount : bet.settlementRetryCount + settlementRetryCount.increment;
    }
    return { count: 1 };
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

  return {
    bet: { findUnique, updateMany },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      getBet: (id: string) => bets.get(id),
      getPlayer: (id: string) => players.get(id),
      transactions: () => transactions,
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

function fakeFetchScores(
  handler: (input: { providerSportKey: string; providerEventIds: readonly string[] }) => ScoresFetchResult,
): typeof import("@/lib/odds/providers/theOddsApi/scoresAdapter").fetchProviderScores {
  return (async (input: { providerSportKey: string; providerEventIds: readonly string[] }) => handler(input)) as never;
}

function successResult(entries: Array<{ providerEventId: string; eventResult: CanonicalEventResult }>): ScoresFetchResult {
  return { status: "SUCCESS", results: entries, rejectedEvents: 0 };
}

/* -------------------------------------------------------------------------- */
/* 2-6. Eligibility rejections                                               */
/* -------------------------------------------------------------------------- */

test("2. bet not found is rejected", async () => {
  const fake = createFakeDb({ bets: [] });
  const result = await retryBetSettlement(db(fake), { betId: "missing", now: NOW, fetchScoresFn: fakeFetchScores(() => successResult([])) });

  assert.deepEqual(result, { kind: "REJECTED", reason: "NOT_FOUND", message: "No bet found with id missing" });
});

test("3. an ordinary CONFIRMED bet without NEEDS_REVIEW is rejected", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ settlementReviewStatus: null, settlementReviewReason: null })] });
  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW });

  assert.equal(result.kind, "REJECTED");
  assert.equal((result as { reason: string }).reason, "NOT_NEEDS_REVIEW");
});

test("4. a RESOLVED bet is rejected", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ status: "SETTLED_WIN", settlementReviewStatus: "RESOLVED" })] });
  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW });

  assert.equal(result.kind, "REJECTED");
  assert.equal((result as { reason: string }).reason, "NOT_CONFIRMED"); // status check runs first, also correctly not-eligible
});

test("5. a terminal bet is rejected", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ status: "SETTLED_LOSS" })] });
  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW });

  assert.equal(result.kind, "REJECTED");
  assert.equal((result as { reason: string }).reason, "NOT_CONFIRMED");
});

test("6. a legacy bet without provider metadata is rejected as structurally invalid", () => {
  const rejection = checkManualRetryEligibility({
    id: "legacy-1",
    type: "SINGLE",
    status: "CONFIRMED",
    settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW,
    providerName: null,
    providerSportKey: null,
    providerEventId: null,
    selections: [],
  });

  assert.deepEqual(rejection?.reason, "STRUCTURALLY_INVALID");
});

/* -------------------------------------------------------------------------- */
/* 7. Provider outage                                                        */
/* -------------------------------------------------------------------------- */

test("7. provider outage: PROVIDER_UNAVAILABLE, zero settlement-field changes, no Transaction", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const before = { ...fake._debug.getBet("single-1") };

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => ({ status: "FAILED", reason: "HTTP_5XX" })),
  });

  assert.equal(result.kind, "OK");
  assert.equal((result as { status: string }).status, "PROVIDER_UNAVAILABLE");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.settlementRetryCount, before.settlementRetryCount);
  assert.equal(after?.settlementReviewStatus, "NEEDS_REVIEW");
  assert.equal(after?.lastSettlementAttemptAt?.getTime(), before.lastSettlementAttemptAt?.getTime());
  assert.equal(after?.lastSettlementErrorCode, before.lastSettlementErrorCode);
  assert.equal(fake._debug.transactions().length, 0);
});

/* -------------------------------------------------------------------------- */
/* 8. WAITING                                                                */
/* -------------------------------------------------------------------------- */

test("8. WAITING: lastSettlementAttemptAt updates, retryCount unchanged, review stays NEEDS_REVIEW", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const before = { ...fake._debug.getBet("single-1") };

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ status: "IN_PROGRESS", homeScore: null, awayScore: null }) }])),
  });

  assert.equal((result as { status: string }).status, "WAITING");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.lastSettlementAttemptAt?.getTime(), NOW.getTime());
  assert.equal(after?.settlementRetryCount, before.settlementRetryCount);
  assert.equal(after?.settlementReviewStatus, "NEEDS_REVIEW");
});

/* -------------------------------------------------------------------------- */
/* 9. EVENT_NOT_FOUND                                                        */
/* -------------------------------------------------------------------------- */

test("9. EVENT_NOT_FOUND: atomic increment, review stays NEEDS_REVIEW", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ settlementRetryCount: 1 })] });

  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn: fakeFetchScores(() => successResult([])) });

  assert.equal((result as { status: string }).status, "TRANSIENT_FAILURE");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.settlementRetryCount, 2);
  assert.equal(after?.settlementReviewStatus, "NEEDS_REVIEW");
  assert.equal(after?.lastSettlementErrorCode, "EVENT_NOT_FOUND");
});

/* -------------------------------------------------------------------------- */
/* 10. MISSING_SCORE                                                         */
/* -------------------------------------------------------------------------- */

test("10. MISSING_SCORE is transient, never settles as LOSS/VOID", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: null, awayScore: null }) }])),
  });

  assert.equal((result as { status: string }).status, "TRANSIENT_FAILURE");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.status, "CONFIRMED"); // never LOSS/VOID
  assert.equal(after?.lastSettlementErrorCode, "MISSING_SCORE");
});

/* -------------------------------------------------------------------------- */
/* 11. Permanent mismatch                                                    */
/* -------------------------------------------------------------------------- */

test("11. a permanent reason (PARTICIPANT_MISMATCH) updates reviewReason, retryCount unchanged", async () => {
  const fake = createFakeDb({
    bets: [fakeSingleBet({ canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Some Totally Unrelated Team", settlementRetryCount: 3 })],
  });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }])),
  });

  assert.equal((result as { status: string }).status, "PERMANENT_REVIEW");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.settlementRetryCount, 3);
  assert.equal(after?.settlementReviewReason, SettlementReviewReason.PARTICIPANT_MISMATCH);
});

/* -------------------------------------------------------------------------- */
/* 12-13. Successful settlement                                              */
/* -------------------------------------------------------------------------- */

test("12. successful SINGLE settlement: terminal status, exactly one Transaction, reviewStatus RESOLVED", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }])),
  });

  assert.equal((result as { status: string }).status, "SETTLED");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.status, "SETTLED_WIN");
  assert.equal(after?.settlementReviewStatus, "RESOLVED");
  assert.equal(fake._debug.transactions().length, 1);
});

test("13. successful EXPRESS settlement: terminal status, exactly one Transaction, reviewStatus RESOLVED", async () => {
  const selections = [
    fakeSelection({ id: "s1", providerEventId: "e1" }),
    fakeSelection({ id: "s2", providerEventId: "e2" }),
  ];
  const fake = createFakeDb({ bets: [fakeExpressBet(selections)] });

  const result = await retryBetSettlement(db(fake), {
    betId: "express-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() =>
      successResult([
        { providerEventId: "e1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) },
        { providerEventId: "e2", eventResult: eventResult({ homeScore: 3, awayScore: 1 }) },
      ]),
    ),
  });

  assert.equal((result as { status: string }).status, "SETTLED");
  const after = fake._debug.getBet("express-1");
  assert.equal(after?.status, "SETTLED_WIN");
  assert.equal(after?.settlementReviewStatus, "RESOLVED");
  assert.equal(fake._debug.transactions().length, 1);
});

/* -------------------------------------------------------------------------- */
/* 14-15. Concurrency                                                        */
/* -------------------------------------------------------------------------- */

test("14. double retry (two concurrent calls) never produces two Transactions", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchScoresFn = fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]));

  const [r1, r2] = await Promise.all([
    retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn }),
    retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn }),
  ]);

  assert.equal(fake._debug.transactions().length, 1);
  const statuses = [r1, r2].map((r) => (r as { status: string }).status);
  assert.ok(statuses.includes("SETTLED"));
  assert.equal(fake._debug.getBet("single-1")?.settlementReviewStatus, "RESOLVED");
});

test("15. a settlement attempt racing against an already-applied one resolves idempotently, still one Transaction", async () => {
  // Simulates the "cron/manual race" shape structurally (even though a
  // NEEDS_REVIEW bet is, by construction, invisible to both
  // pollConfirmedBetResults.ts's active-polling query and
  // escalateExpiredPolling.ts's sweep query — see their own
  // settlementReviewStatus: null exclusions — so a literal cron collision
  // cannot reach this bet at all): a second manual-retry-shaped call
  // arriving after the bet is already terminal.
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const fetchScoresFn = fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }]));

  const first = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn });
  assert.equal((first as { status: string }).status, "SETTLED");

  // Second call now sees a terminal, RESOLVED bet — correctly rejected
  // before any provider call or settleBet() re-entry.
  const second = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn });
  assert.equal(second.kind, "REJECTED");
  assert.equal(fake._debug.transactions().length, 1);
});

/* -------------------------------------------------------------------------- */
/* 16. Repeat after terminal                                                 */
/* -------------------------------------------------------------------------- */

test("16. retrying an already-terminal bet is rejected, not a silent no-op with a 200", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ status: "SETTLED_WIN", settlementReviewStatus: "RESOLVED" })] });
  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW });

  assert.equal(result.kind, "REJECTED");
});

/* -------------------------------------------------------------------------- */
/* 17. No sensitive fields in the returned snapshot                          */
/* -------------------------------------------------------------------------- */

test("17. the returned bet snapshot contains only the safe, curated field set", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });
  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([])),
  });

  assert.equal(result.kind, "OK");
  const bet = (result as { bet: ManualRetryBetSnapshot }).bet;
  assert.deepEqual(
    Object.keys(bet).sort(),
    [
      "id",
      "lastSettlementAttemptAt",
      "lastSettlementErrorCode",
      "lastSettlementErrorMessage",
      "settlementReviewReason",
      "settlementReviewStatus",
      "settlementRetryCount",
      "status",
    ].sort(),
  );
});

/* -------------------------------------------------------------------------- */
/* 18. settleBet() failure never strips NEEDS_REVIEW / never sets RESOLVED   */
/* -------------------------------------------------------------------------- */

test("18. a settleBet() failure (MissingSettlementOddsError) leaves the bet in NEEDS_REVIEW, never prematurely RESOLVED", async () => {
  // totalOdds AND legacy odds both null -> settleBet() throws
  // MissingSettlementOddsError the moment a WIN is decided -> autoSettleSingleBet
  // returns FAILED -> classifySettleFailureCode -> BET_PERMANENT_REVIEW.
  const fake = createFakeDb({ bets: [fakeSingleBet({ odds: null, totalOdds: null })] });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }])),
  });

  assert.equal((result as { status: string }).status, "PERMANENT_REVIEW");
  const after = fake._debug.getBet("single-1");
  assert.equal(after?.status, "CONFIRMED"); // never moved
  assert.equal(after?.settlementReviewStatus, "NEEDS_REVIEW"); // never RESOLVED
  assert.equal(after?.settlementReviewReason, SettlementReviewReason.MISSING_SETTLEMENT_ODDS);
  assert.equal(fake._debug.transactions().length, 0);
});

/* -------------------------------------------------------------------------- */
/* Self-review regression — the returned `bet` snapshot must reflect the      */
/* state AFTER this call's own write, never the pre-write value captured     */
/* at the start of the request.                                              */
/* -------------------------------------------------------------------------- */

test("regression: the returned snapshot reflects RESOLVED after a successful settlement, not the stale pre-write NEEDS_REVIEW", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet()] });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }])),
  });

  assert.equal(result.kind, "OK");
  const returnedBet = (result as { bet: { status: string; settlementReviewStatus: string | null } }).bet;
  assert.equal(returnedBet.status, "SETTLED_WIN");
  assert.equal(returnedBet.settlementReviewStatus, "RESOLVED");
});

test("regression: the returned snapshot reflects the incremented settlementRetryCount after a transient outcome, not the stale pre-write count", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ settlementRetryCount: 1 })] });

  const result = await retryBetSettlement(db(fake), { betId: "single-1", now: NOW, fetchScoresFn: fakeFetchScores(() => successResult([])) });

  assert.equal(result.kind, "OK");
  const returnedBet = (result as { bet: { settlementRetryCount: number } }).bet;
  assert.equal(returnedBet.settlementRetryCount, 2); // not the stale pre-write value of 1
});

test("regression: the returned snapshot reflects the updated settlementReviewReason after a new permanent diagnosis", async () => {
  const fake = createFakeDb({
    bets: [fakeSingleBet({ canonicalSelectionType: "PARTICIPANT", canonicalParticipant: "Some Totally Unrelated Team", settlementReviewReason: "EVENT_NOT_FOUND_MAX_RETRIES" })],
  });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ homeScore: 2, awayScore: 0 }) }])),
  });

  assert.equal(result.kind, "OK");
  const returnedBet = (result as { bet: { settlementReviewReason: string | null } }).bet;
  assert.equal(returnedBet.settlementReviewReason, SettlementReviewReason.PARTICIPANT_MISMATCH); // not the stale EVENT_NOT_FOUND_MAX_RETRIES
});

test("regression: the returned snapshot reflects a fresh lastSettlementAttemptAt after WAITING, not the pre-write timestamp", async () => {
  const fake = createFakeDb({ bets: [fakeSingleBet({ lastSettlementAttemptAt: new Date("2020-01-01T00:00:00Z") })] });

  const result = await retryBetSettlement(db(fake), {
    betId: "single-1",
    now: NOW,
    fetchScoresFn: fakeFetchScores(() => successResult([{ providerEventId: "evt-1", eventResult: eventResult({ status: "IN_PROGRESS", homeScore: null, awayScore: null }) }])),
  });

  assert.equal(result.kind, "OK");
  const returnedBet = (result as { bet: { lastSettlementAttemptAt: Date | null } }).bet;
  assert.equal(returnedBet.lastSettlementAttemptAt?.getTime(), NOW.getTime());
});
