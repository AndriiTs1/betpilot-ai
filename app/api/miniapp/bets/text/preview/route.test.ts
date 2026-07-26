import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { handleTextPreview } from "./route";
import type { ParseBetSlipResult } from "@/lib/ai/betParser";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { OddsVerificationInput } from "@/lib/odds/oddsVerifier";
import { createRequestRateLimiter, type RequestRateLimiter } from "@/lib/rateLimit/requestRateLimiter";

// Step 13B — this route previously had no test file and no DI seam at all
// (a bare `export async function POST`, unlike its screenshot/preview and
// text/confirm siblings). Bringing it up to the same injectable-options
// shape as those two is necessary to test the new rate limiter without a
// real database, a real Claude call, or a real Odds API call — not a
// broader refactor of anything this route already did.

const BOT_TOKEN = "test-bot-token-text-preview";
const PREVIEW_TOKEN_SECRET = "test-preview-token-secret";
const PLAYER_TELEGRAM_ID = 800000002; // synthetic — not Andrii or Denis
const PLAYER_ID = "player-synthetic-text-preview-1";

function buildInitData(botToken: string, userId: number, authDateOverride?: number): string {
  const authDate = authDateOverride ?? Math.floor(Date.now() / 1000);
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("user", JSON.stringify({ id: userId, first_name: "Test" }));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

interface FakePlayerRow {
  id: string;
  telegramId: string | null;
}

function fakeDb(players: FakePlayerRow[]): PrismaClient {
  return {
    player: {
      findUnique: async ({ where }: { where: { telegramId: string } }) => {
        const found = players.find((p) => p.telegramId === where.telegramId);
        return found ? { id: found.id } : null;
      },
    },
  } as unknown as PrismaClient;
}

function registeredDb(): PrismaClient {
  return fakeDb([{ id: PLAYER_ID, telegramId: String(PLAYER_TELEGRAM_ID) }]);
}

function singleSlip(overrides: Partial<Extract<ParseBetSlipResult, { valid: true }>> = {}): ParseBetSlipResult {
  return {
    valid: true,
    type: "SINGLE",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: 1.9 },
    ],
    ...overrides,
  };
}

// Deterministic fake parser — no real Claude call. Counts invocations so
// rate-limited-request tests can assert it was never reached.
function fakeParseBetSlip(
  result: ParseBetSlipResult,
  onCall?: () => void,
): typeof import("@/lib/ai/betParser").parseBetSlipMessage {
  return (async () => {
    onCall?.();
    return result;
  }) as typeof import("@/lib/ai/betParser").parseBetSlipMessage;
}

// Never hits the real Odds API — matches lib/bets/buildBetSlipPreview.test.ts's
// own fakeVerifyOddsFn convention.
function fakeVerifyOddsFn(onCall?: () => void): () => Promise<OddsCheckResult> {
  return async () => {
    onCall?.();
    return {
      matched: true,
      withinTolerance: true,
      sourceOdds: 1.9,
      submittedOdds: 1.9,
      discrepancyPercent: 0,
      bookmaker: "test-bookmaker",
      note: null,
    };
  };
}

function buildRequest(initData: string, body: unknown): NextRequest {
  return new NextRequest("https://example.com/api/miniapp/bets/text/preview", {
    method: "POST",
    headers: { authorization: `tma ${initData}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function freshLimiter(): RequestRateLimiter {
  // High ceiling by default — individual rate-limit tests override this
  // explicitly with a tight limiter; every other test just needs quota to
  // never be the reason a request fails.
  return createRequestRateLimiter({ maxRequests: 1000, windowMs: 60_000 });
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    db: registeredDb(),
    botToken: BOT_TOKEN,
    previewTokenSecret: PREVIEW_TOKEN_SECRET,
    parseBetSlip: fakeParseBetSlip(singleSlip()),
    verifyOddsFn: fakeVerifyOddsFn(),
    rateLimiter: freshLimiter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// Happy path / unchanged existing behavior
// ---------------------------------------------------------------------

test("text preview: a normal request below the limit succeeds unchanged", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, { message: "Real Madrid to win vs Barcelona, 1.9, 50" });

  const response = await handleTextPreview(request, baseOptions());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(typeof body.previewToken, "string");
});

test("text preview: missing Authorization header is unchanged (401 malformed)", async () => {
  const request = new NextRequest("https://example.com/api/miniapp/bets/text/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });

  const response = await handleTextPreview(request, baseOptions());
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "malformed");
});

test("text preview: invalid Telegram initData is unchanged", async () => {
  const request = buildRequest("garbage-init-data", { message: "Real Madrid to win, 1.9, 50" });
  const response = await handleTextPreview(request, baseOptions());
  assert.equal(response.status, 401);
});

test("text preview: invalid body (missing message) is unchanged and does not consume quota", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, { notMessage: "x" });
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const response = await handleTextPreview(request, baseOptions({ rateLimiter: limiter }));
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "INVALID_MESSAGE");

  // Quota untouched — a full-quota request afterward must still succeed.
  const followUp = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(followUp.status, 200);
});

test("text preview: too-short message is unchanged and does not consume quota", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const request = buildRequest(initData, { message: "ab" });
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const response = await handleTextPreview(request, baseOptions({ rateLimiter: limiter }));
  assert.equal(response.status, 422);

  const followUp = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(followUp.status, 200);
});

test("text preview: PLAYER_NOT_FOUND is unchanged and genuinely does not consume quota", async () => {
  // Step 13D correction — the previous version of this test only asserted
  // the 404 response and never proved the "does not consume quota" half of
  // its own name. Since PLAYER_NOT_FOUND is returned before the rate
  // limiter is ever reached, a request from the SAME (still-unregistered)
  // Telegram user always returns 404 regardless of quota state, so that
  // alone can't distinguish "quota consumed" from "quota untouched." This
  // version proves it properly: the same Telegram user, the same limiter
  // instance/key, but a different `db` between the two calls — first
  // unregistered (404), then registered (should succeed only if the first
  // call never consumed the only unit of quota).
  const telegramId = 999999999;
  const initData = buildInitData(BOT_TOKEN, telegramId);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const unregisteredDb = fakeDb([]);
  const notFound = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, db: unregisteredDb }),
  );
  assert.equal(notFound.status, 404);
  const notFoundBody = await notFound.json();
  assert.equal(notFoundBody.error, "PLAYER_NOT_FOUND");

  const nowRegisteredDb = fakeDb([{ id: "player-now-registered", telegramId: String(telegramId) }]);
  const followUp = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, db: nowRegisteredDb }),
  );
  assert.equal(followUp.status, 200, "quota must not have been consumed by the PLAYER_NOT_FOUND rejection");
});

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------

test("text preview: the configured boundary number of requests is allowed", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000 });

  for (let i = 0; i < 3; i += 1) {
    const response = await handleTextPreview(
      buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
      baseOptions({ rateLimiter: limiter }),
    );
    assert.equal(response.status, 200, `request ${i + 1} of 3 must succeed`);
  }
});

test("text preview: the request after the boundary returns 429 with matching Retry-After and body", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const first = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(first.status, 200);

  const second = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter }),
  );
  assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.error, "RATE_LIMITED");
  assert.equal(typeof body.retryAfterSeconds, "number");
  assert.equal(second.headers.get("Retry-After"), String(body.retryAfterSeconds));
});

test("text preview: a rate-limited request never calls parseBetSlipMessage", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  let parserCalls = 0;

  await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, parseBetSlip: fakeParseBetSlip(singleSlip(), () => (parserCalls += 1)) }),
  );

  const limited = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, parseBetSlip: fakeParseBetSlip(singleSlip(), () => (parserCalls += 1)) }),
  );

  assert.equal(limited.status, 429);
  assert.equal(parserCalls, 1, "the parser must only have been called by the first, non-limited request");
});

test("text preview: a rate-limited request never calls buildBetSlipPreview's odds verification", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  let providerCalls = 0;

  await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, verifyOddsFn: fakeVerifyOddsFn(() => (providerCalls += 1)) }),
  );

  const limited = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, verifyOddsFn: fakeVerifyOddsFn(() => (providerCalls += 1)) }),
  );

  assert.equal(limited.status, 429);
  assert.equal(providerCalls, 1, "the odds provider must only have been called by the first, non-limited request");
});

test("text preview: different Telegram users do not share quota", async () => {
  const otherDb = fakeDb([
    { id: PLAYER_ID, telegramId: String(PLAYER_TELEGRAM_ID) },
    { id: "player-synthetic-text-preview-2", telegramId: "800000003" },
  ]);
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  const initDataA = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const initDataB = buildInitData(BOT_TOKEN, 800000003);

  const first = await handleTextPreview(
    buildRequest(initDataA, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, db: otherDb }),
  );
  assert.equal(first.status, 200);

  // User A is now over quota; user B must be unaffected.
  const secondB = await handleTextPreview(
    buildRequest(initDataB, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: limiter, db: otherDb }),
  );
  assert.equal(secondB.status, 200, "a different Telegram user must not be affected by user A's quota");
});

test("text preview: a throwing rate limiter fails open — the route still succeeds instead of 500", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const throwingLimiter: RequestRateLimiter = {
    checkAndRecord() {
      throw new Error("simulated limiter backend failure");
    },
  };

  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: throwingLimiter }),
  );
  assert.equal(response.status, 200, "an optional protection failing must never turn into a 500 for the underlying route");
});

test("text preview: exhausting screenshot/preview's quota does not affect text/preview (separate limiter instances)", async () => {
  // This route only owns its own limiter instance — cross-route isolation
  // is structural (each route constructs an entirely separate
  // createRequestRateLimiter instance), proven here by never sharing a
  // limiter object between two independently-configured calls, mirroring
  // how the production module-level default limiters are never shared
  // across route files.
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const textPreviewLimiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });
  const unrelatedScreenshotLimiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000 });

  // Exhaust an entirely separate limiter instance (standing in for
  // screenshot/preview's own).
  unrelatedScreenshotLimiter.checkAndRecord(String(PLAYER_TELEGRAM_ID));
  unrelatedScreenshotLimiter.checkAndRecord(String(PLAYER_TELEGRAM_ID));

  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win, 1.9, 50" }),
    baseOptions({ rateLimiter: textPreviewLimiter }),
  );
  assert.equal(response.status, 200, "text/preview's own limiter is untouched by a different route's limiter instance");
});

// ---------------------------------------------------------------------
// Step 15I — SINGLE auto-lookup when the player supplied no odds
// ---------------------------------------------------------------------

test("text preview (Step 15I): a SINGLE message with no odds mentioned returns the provider price and a usable preview token", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const noOddsSlip = singleSlip({ selections: [
    { sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win", submittedOdds: null },
  ] });

  let providerCallCount = 0;
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win vs Barcelona, stake 50" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip(noOddsSlip),
      verifyOddsFn: async (input: OddsVerificationInput) => {
        providerCallCount += 1;
        assert.equal(input.odds, null, "the route's own pipeline must pass odds:null through to the provider, never inventing a value client-side");
        return { matched: true, withinTolerance: true, sourceOdds: 2.15, submittedOdds: 2.15, discrepancyPercent: 0, bookmaker: "test-bookmaker", note: null };
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(providerCallCount, 1, "provider lookup must be attempted exactly once for the no-odds SINGLE selection");

  const body = await response.json();
  assert.equal(body.preview.selections[0].submittedOdds, 2.15, "the response must show the real provider price, not null");
  assert.equal(body.preview.selections[0].currentOdds, 2.15);
  assert.equal(body.preview.selections[0].oddsStatus, "VERIFIED");
  assert.equal(typeof body.previewToken, "string");
  assert.ok(body.previewToken.length > 0, "a usable, non-empty preview token must be issued");
});

// ---------------------------------------------------------------------
// Step 15J.3 — a parser-layer timeout (parsed.code === "timeout") must be
// reported as its own AI_TIMEOUT/504, mirroring the screenshot preview
// route's identical distinction, never collapsed into the generic
// PARSE_FAILED/422 "we couldn't understand this bet" response.
// ---------------------------------------------------------------------

test("Step 15J.3 (A): a parser timeout returns 504 AI_TIMEOUT, with no raw SDK error text in the response", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid win, stake 100" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({ valid: false, error: "Request timed out.", code: "timeout" }),
    }),
  );

  assert.equal(response.status, 504);
  const body = await response.json();
  assert.deepEqual(body, { error: "AI_TIMEOUT" }, "the body must be exactly this safe, minimal shape — no detail field, no raw Anthropic error text");
  const bodyText = JSON.stringify(body);
  assert.equal(bodyText.includes("Request timed out"), false, "the raw SDK error message must never reach the client");
});

test("Step 15J.3 (B): a genuine parser rejection (reject_bet, no code) still returns 422 PARSE_FAILED, unchanged", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "hello there" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({ valid: false, error: "Message does not appear to be a bet request" }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.deepEqual(body, { error: "PARSE_FAILED", detail: "Unable to understand the bet message" });
});

test("Step 15J.3 (C): a Zod/schema validation failure (no code field) also returns 422 PARSE_FAILED, not AI_TIMEOUT", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid win, stake -5" }),
    baseOptions({
      // Shape a real betFieldsSchema.safeParse failure would produce:
      // valid:false, a Zod error message, and no `code` at all (only a
      // genuine Anthropic.APIConnectionTimeoutError sets code:"timeout" —
      // see lib/ai/betParser.ts's parseTextSlipWithClaude).
      parseBetSlip: fakeParseBetSlip({ valid: false, error: "stake: Number must be greater than 0" }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.deepEqual(body, { error: "PARSE_FAILED", detail: "Unable to understand the bet message" });
});

test("Step 15J.3 (F): a successful preview is completely unaffected by the new timeout branch", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(buildRequest(initData, { message: "Real Madrid win, stake 100, odds 1.90" }), baseOptions());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(typeof body.previewToken, "string");
});
