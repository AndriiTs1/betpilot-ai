import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { Prisma, type BetStatus, type PrismaClient, type SettlementReviewReason, type SettlementReviewStatus } from "@/lib/generated/prisma/client";
import { handleNeedsReview } from "./route";

const OPERATOR_SECRET = "test-operator-secret";
const originalSecret = process.env.OPERATOR_SECRET;

test.beforeEach(() => {
  process.env.OPERATOR_SECRET = OPERATOR_SECRET;
});

test.after(() => {
  process.env.OPERATOR_SECRET = originalSecret;
});

/* -------------------------------------------------------------------------- */
/* Fake DB — only what handleNeedsReview() actually calls                     */
/* -------------------------------------------------------------------------- */

interface FakeSelectionRow {
  id: string;
  sport: string;
  market: string | null;
  event: string;
  outcome: string;
  odds: Prisma.Decimal | null;
  canonicalParticipant: string | null;
  providerName: string | null;
  providerEventId: string | null;
  eventStartTime: Date | null;
  oddsStatus: string;
}

interface FakeBetRow {
  id: string;
  type: string;
  status: BetStatus;
  stake: Prisma.Decimal;
  odds: Prisma.Decimal | null;
  totalOdds: Prisma.Decimal | null;
  player: { id: string; name: string };
  providerName: string | null;
  providerEventId: string | null;
  providerSportKey: string | null;
  eventStartTime: Date | null;
  settlementRetryCount: number;
  lastSettlementAttemptAt: Date | null;
  lastSettlementErrorCode: string | null;
  lastSettlementErrorMessage: string | null;
  settlementReviewStatus: SettlementReviewStatus | null;
  settlementReviewReason: SettlementReviewReason | null;
  createdAt: Date;
  updatedAt: Date;
  selections: FakeSelectionRow[];
}

function fakeSingleBet(overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return {
    id: "single-1",
    type: "SINGLE",
    status: "CONFIRMED",
    stake: new Prisma.Decimal(100),
    odds: new Prisma.Decimal("2.00"),
    totalOdds: null,
    player: { id: "player-1", name: "Alice" },
    providerName: "THE_ODDS_API",
    providerEventId: "evt-1",
    providerSportKey: "soccer_epl",
    eventStartTime: new Date("2026-07-28T12:00:00Z"),
    settlementRetryCount: 3,
    lastSettlementAttemptAt: new Date("2026-07-29T03:00:00Z"),
    lastSettlementErrorCode: "EVENT_NOT_FOUND",
    lastSettlementErrorMessage: "Provider response did not include this event this cycle.",
    settlementReviewStatus: "NEEDS_REVIEW",
    settlementReviewReason: "EVENT_NOT_FOUND_MAX_RETRIES",
    createdAt: new Date("2026-07-25T10:00:00Z"),
    updatedAt: new Date("2026-07-29T03:00:00Z"),
    selections: [],
    ...overrides,
  };
}

function fakeSelection(overrides: Partial<FakeSelectionRow> = {}): FakeSelectionRow {
  return {
    id: "sel-1",
    sport: "FOOTBALL",
    market: "MONEYLINE_3WAY",
    event: "Fenerbahce vs Galatasaray",
    outcome: "Fenerbahce Win",
    odds: new Prisma.Decimal("1.85"),
    canonicalParticipant: "Fenerbahce",
    providerName: "THE_ODDS_API",
    providerEventId: "evt-leg-1",
    eventStartTime: new Date("2026-07-28T12:00:00Z"),
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function fakeExpressBet(selections: FakeSelectionRow[], overrides: Partial<FakeBetRow> = {}): FakeBetRow {
  return fakeSingleBet({
    id: "express-1",
    type: "EXPRESS",
    providerName: null,
    providerEventId: null,
    providerSportKey: null,
    eventStartTime: null,
    selections,
    ...overrides,
  });
}

interface FindManyArgs {
  where: { status: string; settlementReviewStatus: string };
  orderBy: Array<Record<string, "asc" | "desc">>;
  skip: number;
  take: number;
}

function createFakeDb(bets: FakeBetRow[]) {
  let lastFindManyArgs: FindManyArgs | null = null;

  const matchesWhere = (bet: FakeBetRow, where: FindManyArgs["where"]) =>
    bet.status === where.status && bet.settlementReviewStatus === where.settlementReviewStatus;

  const findMany = async (args: FindManyArgs) => {
    lastFindManyArgs = args;
    const filtered = bets.filter((b) => matchesWhere(b, args.where));

    const sorted = [...filtered].sort((a, b) => {
      const byUpdatedAt = a.updatedAt.getTime() - b.updatedAt.getTime();
      if (byUpdatedAt !== 0) return byUpdatedAt;
      return a.id.localeCompare(b.id);
    });

    return sorted.slice(args.skip, args.skip + args.take).map((b) => ({ ...b, selections: b.selections.map((s) => ({ ...s })) }));
  };

  const count = async ({ where }: { where: FindManyArgs["where"] }) => bets.filter((b) => matchesWhere(b, where)).length;

  return {
    bet: { findMany, count },
    _debug: { lastFindManyArgs: () => lastFindManyArgs },
  };
}

function db(fake: ReturnType<typeof createFakeDb>): PrismaClient {
  return fake as unknown as PrismaClient;
}

function needsReviewRequest(authHeader: string | null = `Bearer ${OPERATOR_SECRET}`, query = ""): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  return new NextRequest(`http://localhost/api/bets/needs-review${query}`, { method: "GET", headers });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

/* -------------------------------------------------------------------------- */
/* 1. Unauthorized                                                            */
/* -------------------------------------------------------------------------- */

test("1. unauthorized request is rejected with 401, no query attempted", async () => {
  const fake = createFakeDb([fakeSingleBet()]);
  const res = await handleNeedsReview(needsReviewRequest(null), { db: db(fake) });

  assert.equal(res.status, 401);
  assert.equal(fake._debug.lastFindManyArgs(), null);
});

/* -------------------------------------------------------------------------- */
/* 2-5. Eligibility filter                                                    */
/* -------------------------------------------------------------------------- */

test("2. only CONFIRMED + NEEDS_REVIEW bets are returned", async () => {
  const target = fakeSingleBet({ id: "target" });
  const fake = createFakeDb([
    target,
    fakeSingleBet({ id: "resolved", settlementReviewStatus: "RESOLVED", status: "SETTLED_LOSS" }),
    fakeSingleBet({ id: "terminal-needs-review", status: "SETTLED_WIN" }),
    fakeSingleBet({ id: "plain-confirmed", settlementReviewStatus: null, settlementReviewReason: null }),
  ]);

  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.equal(res.status, 200);
  const bets = body.bets as Array<{ id: string }>;
  assert.deepEqual(bets.map((b) => b.id), ["target"]);
});

test("3. a RESOLVED bet is never returned, even if status happens to be CONFIRMED", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "resolved-but-confirmed", settlementReviewStatus: "RESOLVED" })]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual((body.bets as unknown[]).length, 0);
});

test("4. a terminal bet (SETTLED_WIN) that still carries NEEDS_REVIEW is never returned", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "terminal", status: "SETTLED_WIN" })]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual((body.bets as unknown[]).length, 0);
});

test("5. an ordinary CONFIRMED bet without any review flag is never returned", async () => {
  const fake = createFakeDb([fakeSingleBet({ id: "ordinary", settlementReviewStatus: null, settlementReviewReason: null })]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual((body.bets as unknown[]).length, 0);
});

/* -------------------------------------------------------------------------- */
/* 6-7. Serialization                                                         */
/* -------------------------------------------------------------------------- */

test("6. SINGLE bet serializes correctly", async () => {
  const fake = createFakeDb([fakeSingleBet()]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);
  const bet = (body.bets as Array<Record<string, unknown>>)[0];

  assert.equal(bet.id, "single-1");
  assert.equal(bet.type, "SINGLE");
  assert.equal(bet.status, "CONFIRMED");
  assert.deepEqual(bet.player, { id: "player-1", name: "Alice" });
  assert.equal(bet.stake, "100");
  assert.equal(bet.odds, "2");
  assert.equal(bet.potentialPayout, "200.00"); // 100 * 2.00
  assert.equal(bet.settlementRetryCount, 3);
  assert.equal(bet.settlementReviewReason, "EVENT_NOT_FOUND_MAX_RETRIES");
  assert.equal(bet.lastSettlementErrorCode, "EVENT_NOT_FOUND");
  assert.equal(typeof bet.eventStartTime, "string");
  assert.equal(typeof bet.createdAt, "string");
  assert.equal(typeof bet.updatedAt, "string");
  assert.deepEqual(bet.selections, []);
});

test("7. EXPRESS bet serializes together with its selections", async () => {
  const selections = [
    fakeSelection({ id: "s1" }),
    fakeSelection({ id: "s2", providerEventId: "evt-leg-2", event: "Barcelona vs Real Madrid", outcome: "Barcelona Win" }),
  ];
  const fake = createFakeDb([fakeExpressBet(selections)]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);
  const bet = (body.bets as Array<Record<string, unknown>>)[0];

  assert.equal(bet.type, "EXPRESS");
  const legs = bet.selections as Array<Record<string, unknown>>;
  assert.equal(legs.length, 2);
  assert.equal(legs[0].id, "s1");
  assert.equal(legs[0].market, "MONEYLINE_3WAY");
  assert.equal(legs[0].selection, "Fenerbahce Win");
  assert.equal(legs[0].participant, "Fenerbahce"); // canonicalParticipant preferred over event
  assert.equal(legs[0].providerEventId, "evt-leg-1");
  assert.equal(legs[1].providerEventId, "evt-leg-2");
});

/* -------------------------------------------------------------------------- */
/* 8-9. Pagination                                                            */
/* -------------------------------------------------------------------------- */

test("8. default pagination applies limit=20, offset=0", async () => {
  const bets = Array.from({ length: 5 }, (_, i) => fakeSingleBet({ id: `s${i}`, updatedAt: new Date(2026, 6, 25 + i) }));
  const fake = createFakeDb(bets);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual(body.pagination, { limit: 20, offset: 0, total: 5, hasMore: false });
  assert.equal((body.bets as unknown[]).length, 5);
});

test("9. a limit above the max is rejected with 400, not silently clamped past it", async () => {
  const fake = createFakeDb([fakeSingleBet()]);
  const res = await handleNeedsReview(needsReviewRequest(`Bearer ${OPERATOR_SECRET}`, "?limit=1000"), { db: db(fake) });

  assert.equal(res.status, 400);
  assert.equal(fake._debug.lastFindManyArgs(), null);
});

test("9b. a negative offset is rejected with 400", async () => {
  const fake = createFakeDb([fakeSingleBet()]);
  const res = await handleNeedsReview(needsReviewRequest(`Bearer ${OPERATOR_SECRET}`, "?offset=-1"), { db: db(fake) });

  assert.equal(res.status, 400);
});

test("9c. limit/offset are respected and reflected in the pagination block", async () => {
  const bets = Array.from({ length: 5 }, (_, i) => fakeSingleBet({ id: `s${i}`, updatedAt: new Date(2026, 6, 25 + i) }));
  const fake = createFakeDb(bets);
  const res = await handleNeedsReview(needsReviewRequest(`Bearer ${OPERATOR_SECRET}`, "?limit=2&offset=1"), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual(body.pagination, { limit: 2, offset: 1, total: 5, hasMore: true });
  assert.equal((body.bets as Array<{ id: string }>).length, 2);
});

/* -------------------------------------------------------------------------- */
/* 10. Sorting stability                                                      */
/* -------------------------------------------------------------------------- */

test("10. sorting is oldest-updatedAt-first, with id as a stable tie-breaker", async () => {
  const bets = [
    fakeSingleBet({ id: "b", updatedAt: new Date("2026-07-29T00:00:00Z") }),
    fakeSingleBet({ id: "a", updatedAt: new Date("2026-07-29T00:00:00Z") }), // same updatedAt as "b" -> id tie-break
    fakeSingleBet({ id: "c", updatedAt: new Date("2026-07-28T00:00:00Z") }), // oldest -> first
  ];
  const fake = createFakeDb(bets);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.deepEqual((body.bets as Array<{ id: string }>).map((b) => b.id), ["c", "a", "b"]);
});

/* -------------------------------------------------------------------------- */
/* 11. No sensitive/internal fields                                           */
/* -------------------------------------------------------------------------- */

test("11. response contains no secrets, raw provider payload, rawMessage, or Transaction ledger", async () => {
  const fake = createFakeDb([fakeExpressBet([fakeSelection()])]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const bodyText = JSON.stringify(await json(res));

  for (const forbidden of ["rawMessage", "transactions", "apiKey", "OPERATOR_SECRET", "CRON_SECRET", "stack", "telegramId", "phoneNumber"]) {
    assert.equal(bodyText.includes(forbidden), false, `response must not contain "${forbidden}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* 12. Empty list                                                             */
/* -------------------------------------------------------------------------- */

test("12. an empty result set returns a correct, well-shaped success response", async () => {
  const fake = createFakeDb([]);
  const res = await handleNeedsReview(needsReviewRequest(), { db: db(fake) });
  const body = await json(res);

  assert.equal(res.status, 200);
  assert.deepEqual(body, { bets: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } });
});
