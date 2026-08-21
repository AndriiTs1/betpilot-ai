import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { handleExpressLegExclusion, type HandleExpressLegExclusionOptions } from "./route";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  signExpressPreviewToken,
  PREVIEW_TOKEN_MAX_LENGTH,
  type ExpressPreviewTokenInput,
  type ExpressPreviewTokenSelection,
} from "@/lib/betPreview/previewToken";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import { createRequestRateLimiter, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";

// Sector 1 (ADR-0002) — HTTP-layer coverage for
// POST /api/miniapp/bets/express/exclude-legs. Same auth/token/fake-db
// conventions as app/api/miniapp/bets/text/confirm/route.test.ts (the
// closest sibling: it also verifies a signed EXPRESS previewToken and only
// needs a read-only Player lookup).

const BOT_TOKEN = "test-bot-token-exclude-legs";
const PREVIEW_SECRET = "test-preview-token-secret-exclude-legs";
const TELEGRAM_ID = 555000222;
const PLAYER_ID = "player-1";
const OTHER_PLAYER_ID = "player-2";

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

function excludeLegsRequest(
  body: unknown,
  initData: string | null = signInitData(TELEGRAM_ID),
): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (initData !== null) headers.Authorization = `tma ${initData}`;

  return new NextRequest("http://localhost/api/miniapp/bets/express/exclude-legs", {
    method: "POST",
    headers,
    body: body === undefined ? "not json{{{" : JSON.stringify(body),
  });
}

function fakeDb(players: Record<string, string> = { [TELEGRAM_ID.toString()]: PLAYER_ID }): PrismaClient {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const id = players[where.telegramId];
        return id ? { id } : null;
      },
    },
  } as unknown as PrismaClient;
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
        sport: "Football",
        event: "Inter vs Juventus",
        outcome: "Inter Win",
        market: null,
        submittedOdds: "1.70",
        currentOdds: null,
        oddsStatus: "NOT_FOUND",
      },
    ],
    ...overrides,
  };
}

function verified(sourceOdds: number, submittedOdds: number): OddsCheckResult {
  const discrepancyPercent = Number((((submittedOdds - sourceOdds) / sourceOdds) * 100).toFixed(2));
  return { matched: true, withinTolerance: true, sourceOdds, submittedOdds, discrepancyPercent, bookmaker: "Pinnacle", note: null };
}

function fakeVerifyOddsFn(byEvent: Record<string, OddsCheckResult>) {
  return async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    const outcome = byEvent[input.event];
    if (!outcome) throw new Error(`No fake outcome configured for event "${input.event}"`);
    return outcome;
  };
}

function baseOptions(overrides: Partial<HandleExpressLegExclusionOptions> = {}): HandleExpressLegExclusionOptions {
  return {
    db: fakeDb(),
    botToken: BOT_TOKEN,
    previewTokenSecret: PREVIEW_SECRET,
    verifyOddsFn: fakeVerifyOddsFn({ "Real Madrid vs Barcelona": verified(1.8, 1.8) }),
    rateLimiter: createRequestRateLimiter({ maxRequests: 1000, windowMs: 60_000 }) as RequestRateLimiter,
    ...overrides,
  };
}

async function json(res: Response): Promise<unknown> {
  return res.json();
}

/* -------------------------------------------------------------------------- */
/* Auth / validation                                                          */
/* -------------------------------------------------------------------------- */

test("exclude-legs route: no Authorization header is rejected with 401", async () => {
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: "x", excludeIndices: [0] }, null), baseOptions());
  assert.equal(res.status, 401);
});

test("exclude-legs route: unknown player is rejected with 404", async () => {
  const res = await handleExpressLegExclusion(
    excludeLegsRequest({ previewToken: "x", excludeIndices: [0] }),
    baseOptions({ db: fakeDb({}) }),
  );
  assert.equal(res.status, 404);
});

test("exclude-legs route: missing excludeIndices is rejected with 400 INVALID_REQUEST", async () => {
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: "x" }), baseOptions());
  assert.equal(res.status, 400);
  assert.equal((await json(res) as { error: string }).error, "INVALID_REQUEST");
});

test("exclude-legs route: non-array excludeIndices is rejected with 400", async () => {
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: "x", excludeIndices: "0" }), baseOptions());
  assert.equal(res.status, 400);
});

test("exclude-legs route: non-integer values inside excludeIndices are rejected with 400", async () => {
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: "x", excludeIndices: [0.5] }), baseOptions());
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Token verification                                                         */
/* -------------------------------------------------------------------------- */

test("exclude-legs route: expired token returns 410 PREVIEW_EXPIRED", async () => {
  // Same Date.now-mocking technique as
  // app/api/miniapp/bets/text/confirm/route.test.ts's identical expired-
  // EXPRESS-token test.
  const originalNow = Date.now;
  let token: string;
  try {
    Date.now = () => new Date("2020-01-01T00:00:00Z").getTime();
    token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  } finally {
    Date.now = originalNow;
  }

  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [1] }), baseOptions());
  assert.equal(res.status, 410);
  assert.equal((await json(res) as { error: string }).error, "PREVIEW_EXPIRED");
});

test("exclude-legs route: a signature-invalid token returns 422 PREVIEW_INVALID", async () => {
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const res = await handleExpressLegExclusion(
    excludeLegsRequest({ previewToken: token, excludeIndices: [1] }),
    baseOptions({ previewTokenSecret: "a-different-secret-entirely" }),
  );
  assert.equal(res.status, 422);
  assert.equal((await json(res) as { error: string }).error, "PREVIEW_INVALID");
});

test("exclude-legs route: a different player's token is reported identically to any other invalid token (PREVIEW_INVALID, no existence disclosure)", async () => {
  const token = signExpressPreviewToken(expressTokenInput({ playerId: OTHER_PLAYER_ID }), PREVIEW_SECRET);
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [1] }), baseOptions());
  assert.equal(res.status, 422);
  assert.equal((await json(res) as { error: string }).error, "PREVIEW_INVALID");
});

/* -------------------------------------------------------------------------- */
/* Success path                                                               */
/* -------------------------------------------------------------------------- */

test("exclude-legs route: excluding a NOT_FOUND leg returns 200 with a fresh SINGLE preview and a new previewToken", async () => {
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [1] }), baseOptions());

  assert.equal(res.status, 200);
  const body = (await json(res)) as { preview: { type: string; selections: unknown[] }; previewToken: string | null };
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(body.preview.selections.length, 1);
  assert.ok(typeof body.previewToken === "string" && body.previewToken.length > 0);
  assert.notEqual(body.previewToken, token);
});

/* -------------------------------------------------------------------------- */
/* Production incident — same PREVIEW_TOKEN_MAX_LENGTH bug as                 */
/* app/api/miniapp/bets/text/confirm/route.ts: this route reads the same     */
/* signed EXPRESS previewToken shape and used to duplicate the same          */
/* pre-Stage-3.1 2048-char limit, so a legitimate 3+ leg EXPRESS token could  */
/* also be rejected here as INVALID_REQUEST before ever reaching the real    */
/* leg-exclusion logic. See lib/betPreview/previewToken.test.ts's own        */
/* realistic-size tests for the unit-level side of this same regression.     */
/* -------------------------------------------------------------------------- */

// Same realistic-provider-metadata fixture shape as
// lib/betPreview/previewToken.test.ts's/text/confirm/route.test.ts's own
// realisticExpressLeg (duplicated per this codebase's existing per-file
// fixture convention). `n === recoverableIndex` (0-based) is the one leg
// this route can legitimately exclude (NOT_FOUND); every other leg is
// VERIFIED so the remaining-selections re-verification below succeeds.
function realisticExpressLeg(n: number, recoverableIndex: number | null): ExpressPreviewTokenSelection {
  const isRecoverable = recoverableIndex !== null && n - 1 === recoverableIndex;
  return {
    sport: "SOCCER",
    event: `Real Full Club Name United ${n} vs Another Real Full Club Name City ${n}`,
    outcome: `Team ${n} to win`,
    market: "MONEYLINE_3WAY",
    submittedOdds: "1.85",
    currentOdds: isRecoverable ? null : "1.85",
    oddsStatus: isRecoverable ? "NOT_FOUND" : "VERIFIED",
    providerEventId: isRecoverable ? null : `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b${n}`,
    providerSportKey: isRecoverable ? null : "soccer_spain_la_liga",
    eventStartTime: isRecoverable ? null : "2026-08-23T18:00:00.000Z",
    canonicalMarketType: isRecoverable ? null : "MONEYLINE_3WAY",
    canonicalSelectionType: isRecoverable ? null : "HOME",
    canonicalParticipant: null,
    canonicalPeriod: isRecoverable ? null : "FULL_TIME",
    canonicalLine: null,
    homeTeamName: isRecoverable ? null : `Real Full Club Name United ${n}`,
    awayTeamName: isRecoverable ? null : `Another Real Full Club Name City ${n}`,
    competitionName: isRecoverable ? null : "Some Realistic Competition Name - Spain",
  };
}

function realisticExpressTokenInput(legCount: number, recoverableIndex: number | null): ExpressPreviewTokenInput {
  return {
    playerId: PLAYER_ID,
    stake: "5",
    totalOdds: "123.45",
    potentialWin: "617.25",
    selections: Array.from({ length: legCount }, (_, i) => realisticExpressLeg(i + 1, recoverableIndex)),
  };
}

test("exclude-legs route: a realistic 3-leg EXPRESS token (full provider metadata, exceeds the old 2048-char limit) is accepted — the exact production incident, reproduced and fixed", async () => {
  const token = signExpressPreviewToken(realisticExpressTokenInput(3, 1), PREVIEW_SECRET);
  assert.ok(token.length > 2048, `expected the realistic 3-leg token to exceed the old 2048-char limit, got ${token.length}`);

  const res = await handleExpressLegExclusion(
    excludeLegsRequest({ previewToken: token, excludeIndices: [1] }),
    baseOptions({
      verifyOddsFn: fakeVerifyOddsFn({
        "Real Full Club Name United 1 vs Another Real Full Club Name City 1": verified(1.85, 1.85),
        "Real Full Club Name United 3 vs Another Real Full Club Name City 3": verified(1.85, 1.85),
      }),
    }),
  );

  assert.equal(res.status, 200);
  const body = (await json(res)) as { preview: { type: string; selections: unknown[] } };
  assert.equal(body.preview.type, "EXPRESS");
  assert.equal(body.preview.selections.length, 2);
});

// The length guard itself must still exist — this fix raises the ceiling to
// a domain-correct value, it does not remove the sanity check.
test("exclude-legs route: a previewToken longer than PREVIEW_TOKEN_MAX_LENGTH is still rejected with 400 INVALID_REQUEST", async () => {
  const oversized = "a".repeat(PREVIEW_TOKEN_MAX_LENGTH + 1);
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: oversized, excludeIndices: [1] }), baseOptions());
  assert.equal(res.status, 400);
  assert.equal((await json(res) as { error: string }).error, "INVALID_REQUEST");
});

/* -------------------------------------------------------------------------- */
/* Business-rule rejections mapped to HTTP                                    */
/* -------------------------------------------------------------------------- */

test("exclude-legs route: excluding a VERIFIED leg returns 422 LEG_NOT_RECOVERABLE", async () => {
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [0] }), baseOptions());
  assert.equal(res.status, 422);
  assert.equal((await json(res) as { error: string }).error, "LEG_NOT_RECOVERABLE");
});

test("exclude-legs route: excluding every leg returns 422 ALL_LEGS_EXCLUDED", async () => {
  const token = signExpressPreviewToken(
    expressTokenInput({
      selections: [
        { sport: "Football", event: "A", outcome: "A win", market: null, submittedOdds: null, currentOdds: null, oddsStatus: "NOT_FOUND" },
        { sport: "Football", event: "B", outcome: "B win", market: null, submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" },
      ],
    }),
    PREVIEW_SECRET,
  );
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [0, 1] }), baseOptions());
  assert.equal(res.status, 422);
  assert.equal((await json(res) as { error: string }).error, "ALL_LEGS_EXCLUDED");
});

test("exclude-legs route: an out-of-range index returns 422 INVALID_LEG_INDEX", async () => {
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const res = await handleExpressLegExclusion(excludeLegsRequest({ previewToken: token, excludeIndices: [7] }), baseOptions());
  assert.equal(res.status, 422);
  assert.equal((await json(res) as { error: string }).error, "INVALID_LEG_INDEX");
});

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                              */
/* -------------------------------------------------------------------------- */

test("exclude-legs route: rate limit is enforced per player", async () => {
  const token = signExpressPreviewToken(expressTokenInput(), PREVIEW_SECRET);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 }) as RequestRateLimiter;

  const first = await handleExpressLegExclusion(
    excludeLegsRequest({ previewToken: token, excludeIndices: [1] }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(first.status, 200);

  const second = await handleExpressLegExclusion(
    excludeLegsRequest({ previewToken: token, excludeIndices: [1] }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(second.status, 429);
});
