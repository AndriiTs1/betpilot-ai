import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { handleBetConfirm, type HandleBetConfirmOptions } from "./route";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { signPreviewToken, signExpressPreviewToken, type PreviewTokenInput, type ExpressPreviewTokenInput } from "@/lib/betPreview/previewToken";

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

  const tx = {
    bet: {
      findUnique: async ({ where }: { where: { previewId: string } }) => readBet(where.previewId),
      create: async ({ data }: { data: Parameters<typeof insertBet>[0] }) => insertBet(data),
    },
    oddsSnapshot: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: `snap-${Date.now()}`, checkedAt: new Date(), ...data }),
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
    },
  };
}

function fakeOptions(db: ReturnType<typeof createFakeDb>, overrides: Partial<HandleBetConfirmOptions> = {}): HandleBetConfirmOptions {
  return { db: db as unknown as PrismaClient, botToken: BOT_TOKEN, previewTokenSecret: PREVIEW_SECRET, ...overrides };
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
