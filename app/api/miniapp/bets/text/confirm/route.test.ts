import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { handleBetConfirm, type HandleBetConfirmOptions } from "./route";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { signPreviewToken, signExpressPreviewToken, type PreviewTokenInput, type ExpressPreviewTokenInput } from "@/lib/betPreview/previewToken";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { createRequestRateLimiter, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";
import { buildBetSlipPreview } from "@/lib/bets/buildBetSlipPreview";
import type { ParsedBetSlip } from "@/lib/bets/betSlip";

// ---------------------------------------------------------------------
// Test-only crypto material — self-consistent, never the real production
// bot token or preview-token secret. Every helper below signs and verifies
// against these same constants.
// ---------------------------------------------------------------------
const BOT_TOKEN = "test-bot-token";
const PREVIEW_SECRET = "test-preview-token-secret";
const TELEGRAM_ID = 555000111;
const PLAYER_ID = "player-1";

function signInitData(telegramId: number): string {
  const authDate = Math.floor(Date.now() / 1000).toString();
  const params = new URLSearchParams();
  params.set("query_id", "AAHtest");
  params.set("user", JSON.stringify({ id: telegramId, first_name: "Test" }));
  params.set("auth_date", authDate);

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);

  return params.toString();
}

function confirmRequest(previewToken: unknown, initData: string | null = signInitData(TELEGRAM_ID)): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (initData !== null) headers.Authorization = `tma ${initData}`;

  return new NextRequest("http://localhost/api/miniapp/bets/text/confirm", {
    method: "POST",
    headers,
    body: previewToken === undefined ? "{}" : JSON.stringify({ previewToken }),
  });
}

// ---------------------------------------------------------------------
// In-memory fake Prisma client covering everything handleBetConfirm and
// createBetFromPreview together touch: player.findUnique, bet.findUnique/
// create (with nested selections), oddsSnapshot.create, $transaction. Same
// no-mocking-library, hand-written-fake convention as
// lib/bets/createBetFromPreview.test.ts one layer down — this file's fake
// additionally has a `player` collection, which that one didn't need.
// ---------------------------------------------------------------------

interface FakeBetRow {
  id: string;
  playerId: string;
  previewId: string | null;
  type: "SINGLE" | "EXPRESS";
  sport: string;
  event: string | null;
  outcome: string | null;
  odds: Prisma.Decimal | null;
  totalOdds: Prisma.Decimal | null;
  stake: Prisma.Decimal;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSelectionRow {
  id: string;
  betId: string;
  sport: string;
  event: string;
  outcome: string;
  market: string | null;
  odds: Prisma.Decimal | null;
  currentOdds: Prisma.Decimal | null;
  oddsStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`previewId`)", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName: "Bet" },
  });
}

function createFakeDb(options: { players?: Record<string, string> } = {}) {
  let nextBetId = 1;
  let nextSelectionId = 1;
  const bets = new Map<string, FakeBetRow>();
  const selectionsByBetId = new Map<string, FakeSelectionRow[]>();
  const betIdByPreviewId = new Map<string, string>();
  const players = options.players ?? { [TELEGRAM_ID.toString()]: PLAYER_ID };
  let createCallCount = 0;

  function readBet(previewId: string): (FakeBetRow & { selections: FakeSelectionRow[] }) | null {
    const id = betIdByPreviewId.get(previewId);
    if (!id) return null;
    return { ...bets.get(id)!, selections: selectionsByBetId.get(id) ?? [] };
  }

  function insertBet(data: {
    playerId: string;
    previewId: string;
    type: "SINGLE" | "EXPRESS";
    sport: string;
    event: string | null;
    outcome: string | null;
    odds: Prisma.Decimal | null;
    stake: Prisma.Decimal;
    totalOdds: Prisma.Decimal | null;
    status: string;
    selections?: { create: Array<Omit<FakeSelectionRow, "id" | "betId" | "createdAt" | "updatedAt">> };
  }) {
    createCallCount += 1;
    if (betIdByPreviewId.has(data.previewId)) throw p2002();

    const now = new Date();
    const id = `bet-${nextBetId++}`;
    const bet: FakeBetRow = {
      id,
      playerId: data.playerId,
      previewId: data.previewId,
      type: data.type,
      sport: data.sport,
      event: data.event,
      outcome: data.outcome,
      odds: data.odds,
      totalOdds: data.totalOdds,
      stake: data.stake,
      status: data.status,
      createdAt: now,
      updatedAt: now,
    };

    const newSelections = (data.selections?.create ?? []).map((s) => ({
      id: `sel-${nextSelectionId++}`,
      betId: id,
      createdAt: now,
      updatedAt: now,
      ...s,
    }));

    bets.set(id, bet);
    betIdByPreviewId.set(data.previewId, id);
    selectionsByBetId.set(id, newSelections);

    return { ...bet, selections: newSelections };
  }

  let oddsSnapshotCreateCount = 0;

  const tx = {
    bet: {
      findUnique: async ({ where }: { where: { previewId: string } }) => readBet(where.previewId),
      create: async ({ data }: { data: Parameters<typeof insertBet>[0] }) => insertBet(data),
    },
    oddsSnapshot: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        oddsSnapshotCreateCount += 1;
        return { id: `snap-${Date.now()}`, checkedAt: new Date(), ...data };
      },
    },
  };

  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const id = players[where.telegramId];
        return id ? { id } : null;
      },
    },
    bet: tx.bet,
    oddsSnapshot: tx.oddsSnapshot,
    $transaction: async <T>(fn: (tx: typeof tx) => Promise<T>) => fn(tx),
    _debug: {
      betCount: () => bets.size,
      createCallCount: () => createCallCount,
      oddsSnapshotCreateCount: () => oddsSnapshotCreateCount,
    },
  };
}

// Step 11B — every test in this file that exercises the success path now
// implicitly goes through verifyPreviewFreshness's own real
// buildBetSlipPreview() call, which needs SOME odds-provider fake to avoid
// a real network call. This permissive default ("whatever odds you send,
// I'll confirm they match exactly") preserves every pre-existing test's
// SUCCESS-path assertions unchanged — those tests are about token
// signature/expiry/player-match/idempotency, not freshness itself.
// Freshness-specific tests below override this explicitly.
function alwaysVerifiedOddsFn() {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => ({
    matched: true,
    withinTolerance: true,
    sourceOdds: input.odds,
    submittedOdds: input.odds,
    discrepancyPercent: 0,
    bookmaker: "Pinnacle",
    note: null,
  });
}

// Step 13B — a generous-ceiling limiter by default so none of the existing
// (pre-Step-13B) tests below are affected by rate limiting; individual
// rate-limit-specific tests override this explicitly with a tight limiter.
function freshLimiter(): RequestRateLimiter {
  return createRequestRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
}

function fakeOptions(db: ReturnType<typeof createFakeDb>, overrides: Partial<HandleBetConfirmOptions> = {}): HandleBetConfirmOptions {
  return {
    db: db as unknown as PrismaClient,
    botToken: BOT_TOKEN,
    previewTokenSecret: PREVIEW_SECRET,
    verifyOddsFn: alwaysVerifiedOddsFn(),
    rateLimiter: freshLimiter(),
    ...overrides,
  };
}

// Keyed by event name — same convention as
// lib/bets/buildBetSlipPreview.test.ts's fakeVerifyOddsFn, for tests that
// need a specific per-event fresh-odds outcome instead of the permissive
// always-matches default above.
function fakeVerifyOddsFnByEvent(byEvent: Record<string, OddsCheckResult | "reject">) {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (outcome === undefined) throw new Error(`No fake outcome configured for event "${input.event}"`);
    if (outcome === "reject") throw new Error(`Simulated odds-check failure for "${input.event}"`);
    return outcome;
  };
}

function oddsChangedResult(sourceOdds: number, submittedOdds: number): OddsCheckResult {
  return {
    matched: true,
    withinTolerance: false,
    sourceOdds,
    submittedOdds,
    discrepancyPercent: 0,
    bookmaker: "Pinnacle",
    note: null,
  };
}

function notFoundResult(submittedOdds: number): OddsCheckResult {
  return {
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds,
    discrepancyPercent: null,
    bookmaker: null,
    note: "No matching event found",
  };
}

function singleTokenInput(overrides: Partial<PreviewTokenInput> = {}): PreviewTokenInput {
  return {
    playerId: PLAYER_ID,
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 100,
    odds: 2.1,
    totalOdds: 2.1,
    oddsCheck: { matched: true, withinTolerance: true, sourceOdds: 2.1, bookmaker: "Bet365" },
    ...overrides,
  };
}

function expressTokenInput(overrides: Partial<ExpressPreviewTokenInput> = {}): ExpressPreviewTokenInput {
  return {
    playerId: PLAYER_ID,
    stake: "40.00",
    totalOdds: "3.06",
    potentialWin: "122.40",
    selections: [
      {
        sport: "Football",
        event: "Real Madrid vs Barcelona",
        outcome: "Real Madrid Win",
        market: "Match Winner",
        submittedOdds: "1.80",
        currentOdds: "1.80",
        oddsStatus: "VERIFIED",
      },
      {
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        market: null,
        submittedOdds: "1.70",
        currentOdds: null,
        oddsStatus: "UNAVAILABLE",
      },
    ],
    ...overrides,
  };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

// ---------------------------------------------------------------------
// SINGLE regression
// ---------------------------------------------------------------------

test("confirm route: valid SINGLE token is confirmed, response shape unchanged", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 200);

  const body = (await json(res)) as { bet: Record<string, unknown>; idempotent: boolean };
  assert.equal(body.idempotent, false);
  assert.equal(body.bet.type, "SINGLE");
  assert.equal(body.bet.event, "Real Madrid vs Barcelona");
  assert.equal(body.bet.outcome, "Real Madrid Win");
  assert.equal(typeof body.bet.stake, "number"); // unchanged: .toNumber(), not a string
  assert.equal(body.bet.stake, 100);
  assert.equal(body.bet.odds, 2.1);
  assert.equal(body.bet.totalOdds, 2.1);
  assert.ok("selections" in body.bet === false); // SINGLE response never gained a selections field
});

test("confirm route: repeated SINGLE confirm is idempotent, no duplicate", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput(), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  const second = await handleBetConfirm(confirmRequest(token), fakeOptions(db));

  const firstBody = (await json(first)) as { idempotent: boolean };
  const secondBody = (await json(second)) as { idempotent: boolean };
  assert.equal(firstBody.idempotent, false);
  assert.equal(secondBody.idempotent, true);
  assert.equal(db._debug.betCount(), 1);
});

test("confirm route: an invalid SINGLE token is rejected with 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb();
  const res = await handleBetConfirm(confirmRequest("garbage.token"), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
});

test("confirm route: SINGLE player mismatch is rejected with 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb({ players: { [TELEGRAM_ID.toString()]: "a-different-player" } });
  const token = signPreviewToken(singleTokenInput({ playerId: PLAYER_ID }), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
  assert.equal(db._debug.betCount(), 0);
});

// ---------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------

test("confirm route: valid EXPRESS token is confirmed, type=EXPRESS, selections included in order", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 200);

  const body = (await json(res)) as {
    bet: {
      type: string;
      event: null;
      outcome: null;
      odds: null;
      stake: string;
      totalOdds: string;
      sport: string;
      selections: Array<Record<string, unknown>>;
    };
    idempotent: boolean;
  };

  assert.equal(body.idempotent, false);
  assert.equal(body.bet.type, "EXPRESS");
  assert.equal(body.bet.event, null);
  assert.equal(body.bet.outcome, null);
  assert.equal(body.bet.odds, null);
  assert.equal(body.bet.sport, "Football"); // first selection's sport, per createBetFromPreview
  assert.equal(typeof body.bet.stake, "string");
  assert.equal(body.bet.stake, "40");
  assert.equal(typeof body.bet.totalOdds, "string");
  assert.equal(body.bet.totalOdds, "3.06");
  assert.equal(body.bet.selections.length, 2);

  // order preserved
  assert.equal(body.bet.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(body.bet.selections[1].event, "Inter Milan vs Juventus");
});

test("confirm route: EXPRESS selection Decimal fields are strings, and null currentOdds stays null", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  const body = (await json(res)) as { bet: { selections: Array<Record<string, unknown>> } };

  const [a, b] = body.bet.selections;
  assert.equal(typeof a.odds, "string");
  assert.equal(a.odds, "1.8");
  assert.equal(typeof a.currentOdds, "string");
  assert.equal(a.currentOdds, "1.8");
  assert.equal(a.oddsStatus, "VERIFIED");

  assert.equal(typeof b.odds, "string");
  assert.equal(b.odds, "1.7");
  assert.equal(b.currentOdds, null); // stayed null, not "0" or missing
  assert.equal(b.oddsStatus, "UNAVAILABLE");
});

test("confirm route: mixed-sport EXPRESS selections each return their own sport", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  const body = (await json(res)) as { bet: { selections: Array<Record<string, unknown>> } };

  assert.equal(body.bet.selections[0].sport, "Football");
  assert.equal(body.bet.selections[1].sport, "Tennis");
});

test("confirm route: repeated EXPRESS confirm returns the existing Bet, no duplicate", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  const second = await handleBetConfirm(confirmRequest(token), fakeOptions(db));

  const firstBody = (await json(first)) as { idempotent: boolean; bet: { id: string } };
  const secondBody = (await json(second)) as { idempotent: boolean; bet: { id: string; selections: unknown[] } };

  assert.equal(firstBody.idempotent, false);
  assert.equal(secondBody.idempotent, true);
  assert.equal(firstBody.bet.id, secondBody.bet.id);
  assert.equal(secondBody.bet.selections.length, 2);
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.createCallCount(), 1);
});

test("confirm route: missing previewToken -> 400 INVALID_REQUEST", async () => {
  const db = createFakeDb();
  const res = await handleBetConfirm(confirmRequest(undefined), fakeOptions(db));
  assert.equal(res.status, 400);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "INVALID_REQUEST");
});

test("confirm route: previewToken: null -> 400 INVALID_REQUEST", async () => {
  const db = createFakeDb();
  const res = await handleBetConfirm(confirmRequest(null), fakeOptions(db));
  assert.equal(res.status, 400);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "INVALID_REQUEST");
});

test("confirm route: malformed EXPRESS-shaped token -> 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb();
  const res = await handleBetConfirm(confirmRequest("not-a-real-token"), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
});

test("confirm route: garbage token -> 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb();
  const res = await handleBetConfirm(confirmRequest("Zm9v.YmFy"), fakeOptions(db)); // valid base64url, not a real payload/signature
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
});

test("confirm route: EXPRESS token with a corrupted signature -> 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const [encodedPayload] = token.split(".");
  const tampered = `${encodedPayload}.not-the-real-signature`;

  const res = await handleBetConfirm(confirmRequest(tampered), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
  assert.equal(db._debug.betCount(), 0);
});

test("confirm route: an expired EXPRESS token is rejected", async () => {
  const db = createFakeDb();
  const originalNow = Date.now;
  let token: string;
  try {
    Date.now = () => new Date("2020-01-01T00:00:00Z").getTime();
    token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  } finally {
    Date.now = originalNow;
  }

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 410);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_EXPIRED");
});

test("confirm route: an unknown token type is rejected", async () => {
  const db = createFakeDb();
  // Same forging technique as previewToken.test.ts: hand-build and sign a
  // payload with a type verifyExpressPreviewToken/verifyPreviewToken would
  // never themselves produce.
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = { v: 1, previewId: "p1", playerId: PLAYER_ID, type: "PARLAY", issuedAt, expiresAt: issuedAt + 180 };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", PREVIEW_SECRET).update(encodedPayload).digest("base64url");
  const token = `${encodedPayload}.${signature}`;

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
});

test("confirm route: EXPRESS player mismatch is rejected with 422 PREVIEW_INVALID", async () => {
  const db = createFakeDb({ players: { [TELEGRAM_ID.toString()]: "a-different-player" } });
  const token = signExpressPreviewToken(expressTokenInput({ playerId: PLAYER_ID }), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
  assert.equal(db._debug.betCount(), 0);
});

test("confirm route: arbitrary body fields (type/selections/stake/odds) are ignored — only the signed token counts", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ stake: 100, event: "Real Madrid vs Barcelona" }), PREVIEW_SECRET);

  const req = new NextRequest("http://localhost/api/miniapp/bets/text/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${signInitData(TELEGRAM_ID)}` },
    body: JSON.stringify({
      previewToken: token,
      type: "EXPRESS",
      stake: 999999,
      odds: 50,
      selections: [{ event: "Fake Event", outcome: "Fake Win", submittedOdds: "9.99" }],
    }),
  });

  const res = await handleBetConfirm(req, fakeOptions(db));
  const body = (await json(res)) as { bet: { type: string; event: string | null; stake: number } };

  // The forged body fields had zero effect — the actual signed SINGLE token
  // content won.
  assert.equal(body.bet.type, "SINGLE");
  assert.equal(body.bet.event, "Real Madrid vs Barcelona");
  assert.equal(body.bet.stake, 100);
});

// ---------------------------------------------------------------------
// Direct API bypass: each verifier only accepts its own token type
// ---------------------------------------------------------------------

test("confirm route bypass: an EXPRESS token cannot be confirmed as SINGLE and vice versa is structurally impossible to request", async () => {
  // The route always dispatches by the token's own embedded type (peeked,
  // unsigned, dispatch-only) — there is no request field a client can set
  // to force "verify this EXPRESS token as SINGLE" or vice versa. This
  // test proves the practical consequence: a genuinely EXPRESS-signed
  // token always produces an EXPRESS bet, never a SINGLE one, regardless
  // of anything else in the request.
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  const body = (await json(res)) as { bet: { type: string } };
  assert.equal(body.bet.type, "EXPRESS");
});

test("confirm route bypass: EXPRESS confirms only with a validly signed EXPRESS previewToken, not a same-shape-but-wrong-secret token", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), "a-different-secret-entirely");

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(res.status, 422);
  assert.equal(db._debug.betCount(), 0);
});

// ---------------------------------------------------------------------
// Step 11B — confirmation-time odds freshness verification
// ---------------------------------------------------------------------

test("confirm route: SINGLE with unchanged odds still confirms (freshness ACCEPT)", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": { matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null } }) }),
  );

  assert.equal(res.status, 200);
  const body = (await json(res)) as { idempotent: boolean };
  assert.equal(body.idempotent, false);
});

test("confirm route: SINGLE with worse odds returns 409 ODDS_CHANGED_RECONFIRM_REQUIRED with a refreshed preview and token, no DB write", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(1.9, 2.1) }) }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string; refreshedPreview: unknown; refreshedPreviewToken: string | null };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.ok(body.refreshedPreview);
  assert.equal(typeof body.refreshedPreviewToken, "string");
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
});

test("confirm route: SINGLE with better odds is still rejected as ODDS_CHANGED — never silently accepted", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(2.5, 2.1) }) }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.equal(db._debug.betCount(), 0);
});

test("confirm route: SINGLE with the event no longer found (NOT_FOUND) confirms as PENDING for operator review, with the submitted odds, never the transient VERIFICATION_UNAVAILABLE code", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": notFoundResult(2.1) }) }),
  );

  assert.equal(res.status, 200);
  const body = (await json(res)) as { idempotent: boolean; bet: Record<string, unknown> };
  assert.equal(body.idempotent, false);
  assert.equal(body.bet.status, "PENDING");
  assert.equal(body.bet.type, "SINGLE");
  assert.equal(body.bet.odds, 2.1, "Bet.odds is the player's submitted odds from the signed token, not a provider price");
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.createCallCount(), 1);
});

test("confirm route: repeated confirm of the same NOT_FOUND-turned-ACCEPT previewId is idempotent, no duplicate Bet", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const notFoundOptions = fakeOptions(db, {
    verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": notFoundResult(2.1) }),
  });

  const first = await handleBetConfirm(confirmRequest(token), notFoundOptions);
  assert.equal(first.status, 200);
  const firstBody = (await json(first)) as { idempotent: boolean; bet: Record<string, unknown> };
  assert.equal(firstBody.idempotent, false);
  assert.equal(firstBody.bet.status, "PENDING");

  const second = await handleBetConfirm(confirmRequest(token), notFoundOptions);
  assert.equal(second.status, 200);
  const secondBody = (await json(second)) as { idempotent: boolean; bet: Record<string, unknown> };
  assert.equal(secondBody.idempotent, true);
  assert.deepEqual(secondBody.bet, firstBody.bet);
  assert.equal(db._debug.betCount(), 1, "only one Bet row may ever exist for this previewId");
  assert.equal(db._debug.createCallCount(), 1, "only the first confirm may have ever called bet.create");
});

test("confirm route: SINGLE with a provider failure (thrown error) returns 503 VERIFICATION_UNAVAILABLE, no DB write", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": "reject" }) }),
  );

  assert.equal(res.status, 503);
  const body = (await json(res)) as { error: string; refreshedPreview?: unknown; refreshedPreviewToken?: unknown };
  assert.equal(body.error, "VERIFICATION_UNAVAILABLE");
  assert.equal(body.refreshedPreview, undefined);
  assert.equal(body.refreshedPreviewToken, undefined);
  assert.equal(db._debug.betCount(), 0);
});

test("confirm route: SINGLE with a provider timeout (thrown timeout error) returns 503 VERIFICATION_UNAVAILABLE, no DB write", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const timeoutVerifyOddsFn = async (): Promise<OddsCheckResult> => {
    throw new Error("The Odds API request timed out after 8000ms");
  };

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { verifyOddsFn: timeoutVerifyOddsFn }));

  assert.equal(res.status, 503);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "VERIFICATION_UNAVAILABLE");
  assert.equal(db._debug.betCount(), 0);
});

test("confirm route: EXPRESS with exactly one leg's odds changed rejects the entire slip, no DB write", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({
        "Real Madrid vs Barcelona": oddsChangedResult(1.6, 1.8),
        "Inter Milan vs Juventus": { matched: true, withinTolerance: true, sourceOdds: 1.7, submittedOdds: 1.7, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null },
      }),
    }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
});

test("confirm route: EXPRESS with one leg changed and one leg UNAVAILABLE returns 503 VERIFICATION_UNAVAILABLE, no refreshed preview/token, no DB write", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({
        "Real Madrid vs Barcelona": oddsChangedResult(1.6, 1.8),
        "Inter Milan vs Juventus": "reject",
      }),
    }),
  );

  assert.equal(res.status, 503);
  const body = (await json(res)) as { error: string; refreshedPreview?: unknown; refreshedPreviewToken?: unknown };
  assert.equal(body.error, "VERIFICATION_UNAVAILABLE");
  assert.equal(body.refreshedPreview, undefined);
  assert.equal(body.refreshedPreviewToken, undefined);
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
});

test("confirm route: EXPRESS with one leg changed and one leg NOT_FOUND returns 409 ODDS_CHANGED_RECONFIRM_REQUIRED — a real price move is never waved through by a merely-not-found sibling leg, no DB write", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({
        "Real Madrid vs Barcelona": oddsChangedResult(1.6, 1.8),
        "Inter Milan vs Juventus": notFoundResult(1.7),
      }),
    }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string; refreshedPreview: unknown; refreshedPreviewToken: string | null };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.ok(body.refreshedPreview);
  assert.equal(typeof body.refreshedPreviewToken, "string");
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
});

test("confirm route: EXPRESS with one leg NOT_FOUND and the other VERIFIED confirms as PENDING for operator review, selections carry the submitted odds", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({
        "Real Madrid vs Barcelona": { matched: true, withinTolerance: true, sourceOdds: 1.8, submittedOdds: 1.8, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null },
        "Inter Milan vs Juventus": notFoundResult(1.7),
      }),
    }),
  );

  assert.equal(res.status, 200);
  const body = (await json(res)) as { idempotent: boolean; bet: Record<string, unknown> & { selections: Array<Record<string, unknown>> } };
  assert.equal(body.idempotent, false);
  assert.equal(body.bet.status, "PENDING");
  assert.equal(body.bet.type, "EXPRESS");
  assert.equal(body.bet.selections.length, 2);
  assert.equal(body.bet.selections[0].odds, "1.8", "the submitted odds from the token, not a provider price");
  assert.equal(body.bet.selections[1].odds, "1.7", "the NOT_FOUND leg still carries the player's submitted odds");
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.createCallCount(), 1);
});

test("confirm route: EXPRESS with changed odds but no reconfirmable token (another exempt null-odds leg) returns 422 SELECTION_UNAVAILABLE, never 409 with a null token, no DB write, no persistence transaction", async () => {
  const db = createFakeDb();
  // One leg genuinely ODDS_CHANGED, the other has no submitted odds at all
  // — buildBetSlipPreview only signs an EXPRESS refreshedPreviewToken when
  // EVERY selection's submittedOdds is known, so this is the real,
  // repository-supported case where odds changed is detected but no valid
  // signed replacement preview can exist.
  const token = signExpressPreviewToken(
    expressTokenInput({
      selections: [
        expressTokenInput().selections[0],
        { ...expressTokenInput().selections[1], submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
      ],
    }),
    PREVIEW_SECRET,
  );

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(1.6, 1.8) }),
    }),
  );

  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string; refreshedPreview?: unknown; refreshedPreviewToken?: unknown };
  assert.equal(body.error, "SELECTION_UNAVAILABLE");
  assert.equal("refreshedPreview" in body, false);
  assert.equal("refreshedPreviewToken" in body, false);
  assert.equal(db._debug.betCount(), 0, "no Bet may be created");
  assert.equal(db._debug.createCallCount(), 0, "no persistence transaction (bet.create) may run");
});

test("confirm route: an already-confirmed SINGLE preview is returned idempotently, fully serialized identically to the first confirm, without ever calling the odds provider again", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(first.status, 200);
  const firstBody = (await json(first)) as { idempotent: boolean; bet: Record<string, unknown> };

  let providerCallCount = 0;
  const second = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
        providerCallCount += 1;
        return { matched: true, withinTolerance: true, sourceOdds: input.odds, submittedOdds: input.odds, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null };
      },
    }),
  );

  assert.equal(second.status, 200);
  const secondBody = (await json(second)) as { idempotent: boolean; bet: Record<string, unknown> };
  assert.equal(secondBody.idempotent, true);
  // Full structural equivalence — every field the SINGLE serializer
  // produces (id, status, type, sport, event, outcome, stake, odds,
  // totalOdds, createdAt), not merely id/idempotent — proving the plain
  // findUnique fast-path needs no extra include/select beyond what it
  // already has for this serializer's scalar-only needs.
  assert.deepEqual(secondBody.bet, firstBody.bet);
  assert.equal(providerCallCount, 0, "the odds provider must never be called for an already-confirmed preview");
  assert.equal(db._debug.createCallCount(), 1, "only the first confirm may have ever called bet.create");
});

test("confirm route: an already-confirmed EXPRESS preview is returned idempotently, fully serialized identically to the first confirm (including ordered selections), without ever calling the odds provider again", async () => {
  const db = createFakeDb();
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db));
  assert.equal(first.status, 200);
  const firstBody = (await json(first)) as { idempotent: boolean; bet: Record<string, unknown> & { selections: unknown[] } };

  let providerCallCount = 0;
  const second = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
        providerCallCount += 1;
        return { matched: true, withinTolerance: true, sourceOdds: input.odds, submittedOdds: input.odds, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null };
      },
    }),
  );

  assert.equal(second.status, 200);
  const secondBody = (await json(second)) as { idempotent: boolean; bet: Record<string, unknown> & { selections: unknown[] } };
  assert.equal(secondBody.idempotent, true);
  // Full structural equivalence, including the nested, ordered selections
  // array — proving the fast-path's include:{selections:true} produces
  // exactly what serializeExpressBet needs, matching the first
  // (createBetFromPreview-driven) response byte-for-byte.
  assert.deepEqual(secondBody.bet, firstBody.bet);
  assert.equal(secondBody.bet.selections.length, 2);
  assert.equal(providerCallCount, 0, "the odds provider must never be called for an already-confirmed preview");
  assert.equal(db._debug.createCallCount(), 1);
});

// ---------------------------------------------------------------------
// Step 13B / Step 13A-R — rate limiting
// ---------------------------------------------------------------------

const OTHER_TELEGRAM_ID = 555000222;
const OTHER_PLAYER_ID = "player-2";

function twoPlayerDb() {
  return createFakeDb({ players: { [TELEGRAM_ID.toString()]: PLAYER_ID, [OTHER_TELEGRAM_ID.toString()]: OTHER_PLAYER_ID } });
}

test("confirm route (rate limit): a normal fresh confirmation below the limit preserves the Step 11 flow", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const limiter = createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000 });

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(res.status, 200);
  const body = (await json(res)) as { idempotent: boolean };
  assert.equal(body.idempotent, false);
});

test("confirm route (rate limit): an over-limit user with a new valid preview receives 429 RATE_LIMITED with matching Retry-After", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const tokenA = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const first = await handleBetConfirm(confirmRequest(tokenA), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(first.status, 200);

  const tokenB = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET); // distinct previewId — a new, not-yet-confirmed preview
  const second = await handleBetConfirm(confirmRequest(tokenB), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(second.status, 429);
  const body = (await json(second)) as { error: string; retryAfterSeconds: number };
  assert.equal(body.error, "RATE_LIMITED");
  assert.equal(typeof body.retryAfterSeconds, "number");
  assert.equal(second.headers.get("Retry-After"), String(body.retryAfterSeconds));
});

test("confirm route (rate limit): a rate-limited fresh confirmation never calls verifyPreviewFreshness or createBetFromPreview, and creates no Bet", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  let providerCallCount = 0;
  const countingOddsFn = async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    providerCallCount += 1;
    return { matched: true, withinTolerance: true, sourceOdds: input.odds, submittedOdds: input.odds, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null };
  };

  const tokenA = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  await handleBetConfirm(confirmRequest(tokenA), fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: countingOddsFn }));
  assert.equal(providerCallCount, 1);
  assert.equal(db._debug.createCallCount(), 1);

  const tokenB = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const limited = await handleBetConfirm(confirmRequest(tokenB), fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: countingOddsFn }));
  assert.equal(limited.status, 429);
  assert.equal(providerCallCount, 1, "verifyPreviewFreshness must never have run for the rate-limited request");
  assert.equal(db._debug.createCallCount(), 1, "createBetFromPreview must never have run for the rate-limited request, no new Bet created");
});

test("confirm route (rate limit): an over-limit user with an already-existing SINGLE Bet still receives it (200, idempotent: true)", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(first.status, 200); // this fresh confirm consumed the only quota unit

  // Retrying the exact same (now-confirmed) token must still succeed even
  // though the limiter is fully exhausted — the idempotency lookup returns
  // before the limiter is ever consulted (Step 13A-R Section 8/10).
  const retry = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(retry.status, 200);
  const retryBody = (await json(retry)) as { idempotent: boolean };
  assert.equal(retryBody.idempotent, true);
});

test("confirm route (rate limit): an over-limit user with an already-existing EXPRESS Bet still receives it (200, idempotent: true)", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(first.status, 200);

  const retry = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(retry.status, 200);
  const retryBody = (await json(retry)) as { idempotent: boolean };
  assert.equal(retryBody.idempotent, true);
});

test("confirm route (rate limit): more than the configured quota's worth of idempotent retries never returns 429, never consumes quota, never calls freshness or createBetFromPreview again", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  let providerCallCount = 0;
  const countingOddsFn = async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    providerCallCount += 1;
    return { matched: true, withinTolerance: true, sourceOdds: input.odds, submittedOdds: input.odds, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null };
  };
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: countingOddsFn }));
  assert.equal(providerCallCount, 1);

  for (let i = 0; i < 5; i += 1) {
    const retry = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: countingOddsFn }));
    assert.equal(retry.status, 200, `idempotent retry ${i + 1} must never be 429`);
    const retryBody = (await json(retry)) as { idempotent: boolean };
    assert.equal(retryBody.idempotent, true);
  }

  assert.equal(providerCallCount, 1, "verifyPreviewFreshness must never run again for any idempotent retry");
  assert.equal(db._debug.createCallCount(), 1, "createBetFromPreview must never run again for any idempotent retry");
});

test("confirm route (rate limit): an invalid previewToken preserves its existing response and does not consume quota", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const invalid = await handleBetConfirm(confirmRequest("not-a-real-token"), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(invalid.status, 422);
  const invalidBody = (await json(invalid)) as { error: string };
  assert.equal(invalidBody.error, "PREVIEW_INVALID");

  // Quota untouched — a genuinely fresh, valid confirm afterward must still
  // succeed against the same (still-full) limiter.
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const valid = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(valid.status, 200);
});

test("confirm route (rate limit): an expired previewToken preserves its existing response and does not consume quota", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const originalNow = Date.now;
  let expiredToken: string;
  try {
    Date.now = () => new Date("2020-01-01T00:00:00Z").getTime();
    expiredToken = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  } finally {
    Date.now = originalNow;
  }

  const expiredRes = await handleBetConfirm(confirmRequest(expiredToken), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(expiredRes.status, 410);
  const expiredBody = (await json(expiredRes)) as { error: string };
  assert.equal(expiredBody.error, "PREVIEW_EXPIRED");

  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const valid = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(valid.status, 200, "quota must not have been consumed by the expired-token rejection");
});

test("confirm route (rate limit): a wrong-owner token preserves PREVIEW_INVALID, does not consume quota, and never even looks up previewId existence", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  let findUniqueCalls = 0;
  const probingDb = {
    ...db,
    bet: {
      ...db.bet,
      findUnique: async (...args: Parameters<typeof db.bet.findUnique>) => {
        findUniqueCalls += 1;
        return db.bet.findUnique(...args);
      },
    },
  };

  // Token signed for a player that is NOT the authenticated (TELEGRAM_ID ->
  // PLAYER_ID) player.
  const wrongOwnerToken = signPreviewToken(singleTokenInput({ playerId: "someone-elses-player-id", odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(wrongOwnerToken),
    fakeOptions(probingDb as unknown as ReturnType<typeof createFakeDb>, { rateLimiter: limiter }),
  );
  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "PREVIEW_INVALID");
  assert.equal(findUniqueCalls, 0, "a wrong-owner token must be rejected before any previewId lookup — it can never reveal whether that previewId exists");

  // Quota untouched.
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const valid = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(valid.status, 200);
});

test("confirm route (rate limit): an ODDS_CHANGED outcome consumes quota and preserves its existing 409 response, no Bet created", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const first = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      rateLimiter: limiter,
      verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(1.8, 2.1) }),
    }),
  );
  assert.equal(first.status, 409);
  const firstBody = (await json(first)) as { error: string };
  assert.equal(firstBody.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.equal(db._debug.betCount(), 0, "no Bet may be created for an ODDS_CHANGED outcome");

  // Quota was consumed by the ODDS_CHANGED attempt itself — a second,
  // otherwise-valid fresh confirm must now be 429.
  const tokenB = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const second = await handleBetConfirm(confirmRequest(tokenB), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(second.status, 429);
});

test("confirm route (rate limit): repeated refreshed-token submissions each consume confirm quota", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 2, windowMs: 60_000 });
  // Always reports ODDS_CHANGED for this event, on every call — deterministic,
  // not one-shot, so the refreshed token also triggers ODDS_CHANGED again.
  // This test's token always sets odds: 2.1 — real narrowing (not an
  // assertion) since OddsVerificationInput.odds widened to
  // `number | null` in Step 15G for an unrelated, not-yet-wired-in
  // capability that doesn't affect this test's own fixture.
  const alwaysOddsChanged = async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    if (input.odds === null) throw new Error("test token always sets odds");
    return oddsChangedResult(1.8, input.odds);
  };

  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: alwaysOddsChanged }));
  assert.equal(first.status, 409); // consumes quota unit 1 of 2
  const firstBody = (await json(first)) as { refreshedPreviewToken: string };

  const second = await handleBetConfirm(
    confirmRequest(firstBody.refreshedPreviewToken),
    fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: alwaysOddsChanged }),
  );
  assert.equal(second.status, 409); // consumes quota unit 2 of 2

  const secondBody = (await json(second)) as { refreshedPreviewToken: string };
  const third = await handleBetConfirm(
    confirmRequest(secondBody.refreshedPreviewToken),
    fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: alwaysOddsChanged }),
  );
  assert.equal(third.status, 429, "the third resubmission (of a refreshed token) must be rate-limited — each resubmission is its own confirm attempt");
});

test("confirm route (rate limit): a NOT_FOUND-turned-ACCEPT confirmation also consumes quota (any request reaching verifyPreviewFreshness does, regardless of outcome)", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const first = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { rateLimiter: limiter, verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": notFoundResult(2.1) }) }),
  );
  assert.equal(first.status, 200);
  const firstBody = (await json(first)) as { bet: Record<string, unknown> };
  assert.equal(firstBody.bet.status, "PENDING");

  const tokenB = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const second = await handleBetConfirm(confirmRequest(tokenB), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(second.status, 429);
});

test("confirm route (rate limit): a throwing rate limiter fails open — a fresh confirm still succeeds instead of 500", async () => {
  const db = createFakeDb();
  const throwingLimiter: RequestRateLimiter = {
    checkAndRecord() {
      throw new Error("simulated limiter backend failure");
    },
  };
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: throwingLimiter }));
  assert.equal(res.status, 200, "an optional protection failing must never turn into a 500 for the underlying confirm flow");
});

test("confirm route (rate limit): a throwing rate limiter never affects the already-confirmed idempotent fast-path (the limiter is never even called on that path)", async () => {
  const db = createFakeDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const first = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(first.status, 200);

  const throwingLimiter: RequestRateLimiter = {
    checkAndRecord() {
      throw new Error("simulated limiter backend failure — must never be reached for an idempotent retry");
    },
  };
  const retry = await handleBetConfirm(confirmRequest(token), fakeOptions(db, { rateLimiter: throwingLimiter }));
  assert.equal(retry.status, 200);
  const retryBody = (await json(retry)) as { idempotent: boolean };
  assert.equal(retryBody.idempotent, true);
});

test("confirm route (rate limit): SINGLE and EXPRESS confirmations share one per-user confirm bucket", async () => {
  const db = twoPlayerDb();
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const singleToken = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);
  const singleRes = await handleBetConfirm(confirmRequest(singleToken), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(singleRes.status, 200); // consumes the user's only quota unit via SINGLE

  const expressToken = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const expressRes = await handleBetConfirm(confirmRequest(expressToken), fakeOptions(db, { rateLimiter: limiter }));
  assert.equal(expressRes.status, 429, "EXPRESS must draw from the same bucket a prior SINGLE confirm already consumed for this user");

  // A different Telegram user's EXPRESS confirm must be unaffected.
  const otherExpressToken = signExpressPreviewToken(expressTokenInput({ playerId: OTHER_PLAYER_ID }), PREVIEW_SECRET);
  const otherRes = await handleBetConfirm(
    confirmRequest(otherExpressToken, signInitData(OTHER_TELEGRAM_ID)),
    fakeOptions(db, { rateLimiter: limiter }),
  );
  assert.equal(otherRes.status, 200, "a different Telegram user must not share the exhausted user's quota");
});

// ---------------------------------------------------------------------
// Step 15I — end-to-end: a SINGLE preview built from a null-odds selection
// (auto-looked-up provider price) flows unmodified through the existing,
// untouched verifyPreviewFreshness/createBetFromPreview confirmation
// pipeline. These tests build the previewToken via the real
// buildBetSlipPreview() (the auto-lookup pipeline itself), not a
// hand-built singleTokenInput(), specifically to prove the token that
// pipeline now produces for a null-odds SINGLE is a normal, fully
// confirmable token — nothing about confirm.ts needed to change.
// ---------------------------------------------------------------------

function autoLookupSlip(): ParsedBetSlip {
  return {
    type: "SINGLE",
    stake: 100,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: null },
    ],
  };
}

test("Step 15I (F): a preview built from auto-looked-up odds confirms normally — freshness runs, Bet.odds equals the provider odds, an OddsSnapshot is created", async () => {
  const preview = await buildBetSlipPreview(autoLookupSlip(), PLAYER_ID, PREVIEW_SECRET, {
    verifyOddsFn: async () => ({
      matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null,
    }),
  });
  assert.equal(preview.preview.selections[0].submittedOdds, 2.1, "sanity: the preview itself must already carry the promoted provider odds");
  assert.ok(preview.previewToken);

  const db = createFakeDb();

  let freshnessCallCount = 0;
  const res = await handleBetConfirm(
    confirmRequest(preview.previewToken),
    fakeOptions(db, {
      verifyOddsFn: async (input) => {
        freshnessCallCount += 1;
        assert.equal(input.odds, 2.1, "reconfirmation must check freshness against the promoted odds now baked into the token, not null");
        return { matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null };
      },
    }),
  );

  assert.equal(freshnessCallCount, 1, "confirmation must run freshness verification, unmodified");
  assert.equal(res.status, 200);
  const body = (await json(res)) as { bet: Record<string, unknown>; idempotent: boolean };
  assert.equal(body.idempotent, false);
  assert.equal(body.bet.odds, 2.1, "Bet.odds must equal the provider odds promoted at preview time");
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.oddsSnapshotCreateCount(), 1, "an OddsSnapshot must be created for the confirmed bet");
});

test("Step 15I (G): the provider price moves between preview and confirm — 409 ODDS_CHANGED_RECONFIRM_REQUIRED, the refreshed preview carries the updated provider odds, and no Bet is created until a second confirmation", async () => {
  const preview = await buildBetSlipPreview(autoLookupSlip(), PLAYER_ID, PREVIEW_SECRET, {
    verifyOddsFn: async () => ({
      matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null,
    }),
  });
  assert.ok(preview.previewToken);

  const db = createFakeDb();
  const res = await handleBetConfirm(
    confirmRequest(preview.previewToken),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(1.85, 2.1) }),
    }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string; refreshedPreview: { selections: Array<{ currentOdds: number | null }> }; refreshedPreviewToken: string | null };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.equal(body.refreshedPreview.selections[0].currentOdds, 1.85, "the refreshed preview must carry the provider's new, moved price");
  assert.equal(typeof body.refreshedPreviewToken, "string");
  assert.equal(db._debug.betCount(), 0, "no Bet may be created before the player reconfirms against the refreshed price");

  // The refreshedPreviewToken still quotes the player's ORIGINAL 2.1 (a
  // reconfirm, not a silent acceptance of the moved price — see
  // buildBetSlipPreview's signPreviewToken call: `odds: single.submittedOdds`
  // is the selection's own already-known price, never the just-observed
  // currentOdds). A second confirmation only succeeds once the market is
  // back within tolerance of that same 2.1.
  const secondRes = await handleBetConfirm(
    confirmRequest(body.refreshedPreviewToken),
    fakeOptions(db, {
      verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": { matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null } }),
    }),
  );
  assert.equal(secondRes.status, 200);
  const secondBody = (await json(secondRes)) as { bet: Record<string, unknown> };
  assert.equal(secondBody.bet.odds, 2.1);
  assert.equal(db._debug.betCount(), 1);
});

// ---------------------------------------------------------------------
// Step 15J — a SINGLE token whose odds never resolved (submittedOdds was
// null and the Step 15I auto-lookup either failed or never ran) must never
// be confirmable: no Bet, no OddsSnapshot, no wallet mutation. Blocked
// before verifyPreviewFreshness/createBetFromPreview are ever reached —
// those two files are untouched by this step, exactly as required.
// ---------------------------------------------------------------------

function unresolvedOddsSingleToken(): string {
  // The exact shape buildBetSlipPreview.ts's SINGLE branch produces for a
  // null-submittedOdds selection whose provider lookup never resolved to a
  // price: odds/totalOdds both null, oddsCheck reflects the failed check
  // (matched:false) — never signPreviewToken called with a fabricated
  // number. Built directly with signPreviewToken (rather than via
  // buildBetSlipPreview) only because this test targets the confirm route's
  // own gate in isolation; Step 15I (A)/(B) in buildBetSlipPreview.test.ts
  // already prove buildBetSlipPreview itself never fabricates this token's
  // odds field.
  return signPreviewToken(
    singleTokenInput({
      odds: null,
      totalOdds: null,
      oddsCheck: { matched: false, withinTolerance: null, sourceOdds: null, bookmaker: null },
    }),
    PREVIEW_SECRET,
  );
}

test("Step 15J (A): text SINGLE + null odds + provider failure (event/selection not found) — confirm is blocked with 422 ODDS_REQUIRED_BEFORE_CONFIRMATION, no Bet, no OddsSnapshot", async () => {
  const db = createFakeDb();
  const token = unresolvedOddsSingleToken();

  let verifyOddsFnCallCount = 0;
  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, {
      verifyOddsFn: async () => {
        verifyOddsFnCallCount += 1;
        throw new Error("must never be called — a null-odds SINGLE must be rejected before any freshness/provider call");
      },
    }),
  );

  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string; message?: string };
  assert.equal(body.error, "ODDS_REQUIRED_BEFORE_CONFIRMATION");
  assert.equal(typeof body.message, "string");
  assert.ok(body.message && body.message.length > 0, "response must clearly state odds could not be verified and a new preview or manual odds are required");
  assert.equal(verifyOddsFnCallCount, 0, "verifyPreviewFreshness/the odds provider must never be reached for an unresolved-odds SINGLE");
  assert.equal(db._debug.betCount(), 0, "no Bet may be created");
  assert.equal(db._debug.createCallCount(), 0, "no persistence transaction may run");
  assert.equal(db._debug.oddsSnapshotCreateCount(), 0, "no OddsSnapshot may be created");
});

test("Step 15J (B): text SINGLE + null odds + provider unavailable — same blocking behavior, no side effects", async () => {
  // Provider-unavailable at PREVIEW time (not confirm time) also always
  // leaves odds:null on the token — there is no separate token shape for
  // "not found" vs "unavailable"; both collapse to the same
  // odds:null/oddsCheck.matched:false shape (see mapOddsCheckToSelectionStatus
  // and legacyOddsBridge.ts's own NOT_FOUND/UNAVAILABLE handling), so the
  // confirm-route gate (payload.odds === null) is identical for both.
  const db = createFakeDb();
  const token = unresolvedOddsSingleToken();

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));

  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "ODDS_REQUIRED_BEFORE_CONFIRMATION");
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
  assert.equal(db._debug.oddsSnapshotCreateCount(), 0);
});

test("Step 15J (C): text SINGLE + provider success — Step 15I's auto-lookup confirm success remains green (unblocked)", async () => {
  const preview = await buildBetSlipPreview(autoLookupSlip(), PLAYER_ID, PREVIEW_SECRET, {
    verifyOddsFn: async () => ({
      matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null,
    }),
  });
  assert.ok(preview.previewToken);

  const db = createFakeDb();
  const res = await handleBetConfirm(
    confirmRequest(preview.previewToken),
    fakeOptions(db, {
      verifyOddsFn: async () => ({ matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0, bookmaker: "Pinnacle", note: null }),
    }),
  );

  assert.equal(res.status, 200);
  const body = (await json(res)) as { bet: Record<string, unknown> };
  assert.equal(body.bet.odds, 2.1);
  assert.equal(db._debug.betCount(), 1);
  assert.equal(db._debug.oddsSnapshotCreateCount(), 1);
});

test("Step 15J (D): numeric SINGLE — unchanged, never touches the new odds:null gate", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));

  assert.equal(res.status, 200);
  const body = (await json(res)) as { bet: Record<string, unknown>; idempotent: boolean };
  assert.equal(body.idempotent, false);
  assert.equal(body.bet.odds, 2.1);
  assert.equal(db._debug.betCount(), 1);
});

test("Step 15J (E): a screenshot/OCR-originated SINGLE token is structurally identical to a text one — there is no route-origin field to preserve, so the same unresolved-odds block necessarily (and correctly) applies to both", async () => {
  // Proves the scope-audit finding directly: buildBetSlipPreview.ts (used
  // verbatim by both app/api/miniapp/bets/text/preview/route.ts and
  // app/api/miniapp/bets/screenshot/preview/route.ts) produces the exact
  // same PreviewTokenPayload shape via the exact same signPreviewToken,
  // confirmed by the exact same handleBetConfirm — there is no separate
  // screenshot confirm route and no origin field anywhere in the token.
  // A screenshot/OCR preview that failed to read odds therefore produces a
  // token indistinguishable from this test's own unresolvedOddsSingleToken()
  // fixture (used verbatim, not a special-cased "screenshot" builder,
  // because none could be built any differently). No existing test in this
  // codebase (confirm route or screenshot preview route) ever asserted that
  // such a token must remain confirmable, so this is not a regression
  // against any previously-guaranteed behavior — it closes an unintentional
  // gap uniformly for both origins, exactly as the Step 15I audit flagged.
  const db = createFakeDb();
  const token = unresolvedOddsSingleToken();

  const res = await handleBetConfirm(confirmRequest(token), fakeOptions(db));

  assert.equal(res.status, 422);
  const body = (await json(res)) as { error: string };
  assert.equal(body.error, "ODDS_REQUIRED_BEFORE_CONFIRMATION");
  assert.equal(db._debug.betCount(), 0);
});

test("Step 15J (F): odds-changed 409 reconfirmation flow is unaffected by the new odds:null gate (payload.odds is a real number throughout)", async () => {
  const db = createFakeDb();
  const token = signPreviewToken(singleTokenInput({ odds: 2.1 }), PREVIEW_SECRET);

  const res = await handleBetConfirm(
    confirmRequest(token),
    fakeOptions(db, { verifyOddsFn: fakeVerifyOddsFnByEvent({ "Real Madrid vs Barcelona": oddsChangedResult(1.9, 2.1) }) }),
  );

  assert.equal(res.status, 409);
  const body = (await json(res)) as { error: string; refreshedPreview: unknown; refreshedPreviewToken: string | null };
  assert.equal(body.error, "ODDS_CHANGED_RECONFIRM_REQUIRED");
  assert.ok(body.refreshedPreview);
  assert.equal(typeof body.refreshedPreviewToken, "string");
  assert.equal(db._debug.betCount(), 0);
  assert.equal(db._debug.createCallCount(), 0);
});
