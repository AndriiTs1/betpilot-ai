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
import type { CandidateResolver, ResolvedEventCandidate } from "@/lib/odds/discovery/candidateResolver";
import type { SportmonksFixtureByIdResult } from "@/lib/odds/providers/sportmonks/sportmonksFixturesAdapter";
import type { SportmonksOddsFetchResult } from "@/lib/odds/providers/sportmonks/sportmonksOddsAdapter";
import { verifyPreviewToken } from "@/lib/betPreview/previewToken";

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

test("BA-2B Step 4: a numeric_mismatch parser rejection (lib/ai/betParser.ts's new CONTRADICTED/AMBIGUOUS safety check) returns the exact same generic 422 PARSE_FAILED body as any other parse failure — no new error shape, no client-visible change — and NEVER reaches odds verification", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  let providerCalls = 0;
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Арсенал ТБ 2.5, ставка 10" }),
    baseOptions({
      // Exactly the shape buildParsedBetSlipResult (lib/ai/betParser.ts)
      // now produces when a numeric claim is CONTRADICTED/AMBIGUOUS — this
      // route requires zero changes to handle it correctly, since "code"
      // other than "timeout" already falls through to the same generic path.
      parseBetSlip: fakeParseBetSlip({
        valid: false,
        error: "Numeric claim not corroborated by message text (role=STAKE, verdict=CONTRADICTED)",
        code: "numeric_mismatch",
      }),
      verifyOddsFn: fakeVerifyOddsFn(() => (providerCalls += 1)),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.deepEqual(body, { error: "PARSE_FAILED", detail: "Unable to understand the bet message" });
  const bodyText = JSON.stringify(body);
  assert.equal(bodyText.includes("STAKE"), false, "internal verdict detail must never reach the client");
  assert.equal(bodyText.includes("CONTRADICTED"), false, "internal verdict detail must never reach the client");
  assert.equal(providerCalls, 0, "a rejected numeric claim must never reach odds verification — no provider call, and therefore no previewToken, no Bet, no DB write is possible downstream");
});

test("Step 15J.3 (F): a successful preview is completely unaffected by the new timeout branch", async () => {
  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(buildRequest(initData, { message: "Real Madrid win, stake 100, odds 1.90" }), baseOptions());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(typeof body.previewToken, "string");
});

/* -------------------------------------------------------------------------- */
/* Stage 10 — Sportmonks football vertical slice, feature-flag gated         */
/* -------------------------------------------------------------------------- */
// buildSportmonksFootballPreview's own resolution/side-mapping/odds logic is
// fully covered by lib/bets/buildSportmonksFootballPreview.test.ts against
// fakes. These tests only prove the ROUTE respects the flag and wires the
// new path in correctly, without disturbing the existing pipeline.

function juventusCandidate(overrides: Partial<ResolvedEventCandidate> = {}): ResolvedEventCandidate {
  return {
    provider: "SPORTMONKS",
    providerEventId: "19743018",
    sportKey: "sportmonks:1101",
    league: "Club Friendlies 1",
    commenceTime: null,
    homeTeam: "Juventus",
    awayTeam: "Nice",
    matchedTeamNames: ["Juventus"],
    matchMethod: "EXACT",
    score: 1,
    diagnostics: [],
    ...overrides,
  };
}

function fakeSportmonksResolver(overrides: Partial<Pick<CandidateResolver, "buildDependencies" | "resolve">> = {}): Pick<CandidateResolver, "buildDependencies" | "resolve"> {
  return {
    buildDependencies: async () => ({ status: "SUCCESS" }),
    resolve: () => ({ kind: "TEAM_RESOLVED", candidate: juventusCandidate() }),
    ...overrides,
  };
}

function fakeSportmonksFixtureById(): (id: string) => Promise<SportmonksFixtureByIdResult> {
  return async () => ({
    status: "SUCCESS",
    fixture: {
      provider: "SPORTMONKS",
      providerEventId: "19743018",
      sport: "FOOTBALL",
      leagueId: 1101,
      leagueName: "Club Friendlies 1",
      stageName: "Regular Season",
      homeTeamId: "625",
      homeTeamName: "Juventus",
      awayTeamId: "450",
      awayTeamName: "Nice",
      commenceTime: "2026-07-31T16:00:00.000Z",
      stateId: 1,
    },
  });
}

function fakeSportmonksOdds(): (id: string) => Promise<SportmonksOddsFetchResult> {
  return async () => ({
    status: "SUCCESS",
    snapshot: {
      provider: "SPORTMONKS",
      providerEventId: "19743018",
      bookmakerId: "13",
      bookmakerName: "Coral",
      marketId: 1,
      marketName: "Fulltime Result",
      homeOdds: "1.55",
      drawOdds: "3.75",
      awayOdds: "5.00",
      updatedAt: "2026-07-30 16:47:15",
    },
  });
}

function sportmonksOptions(overrides: Record<string, unknown> = {}) {
  return {
    resolver: fakeSportmonksResolver(),
    fetchFixtureById: fakeSportmonksFixtureById(),
    fetchOdds: fakeSportmonksOdds(),
    now: () => Date.parse("2026-07-30T18:00:00Z"),
    ...overrides,
  };
}

test("Stage 10: flag OFF (unset) — a football message uses the existing The Odds API pipeline unchanged", async () => {
  delete process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED;
  let sportmonksResolverCalled = false;

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid to win vs Barcelona, 1.9, 50" }),
    baseOptions({
      sportmonksPreviewOptions: sportmonksOptions({
        resolver: fakeSportmonksResolver({
          buildDependencies: async () => {
            sportmonksResolverCalled = true;
            return { status: "SUCCESS" };
          },
        }),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.previewToken, "string", "old pipeline still signs a real previewToken");
  assert.equal(sportmonksResolverCalled, false, "Sportmonks path must never be touched when the flag is off");
});

test("Stage 10.2: flag ON — a football SINGLE bet resolves through Sportmonks and returns a real, signed, provider-tagged previewToken", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";
  let oddsApiVerifyCalled = false;

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Juventus победа 100" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 100,
        selections: [{ sport: "Football", event: "Juventus", market: null, selection: "Juventus победа", submittedOdds: null }],
      }),
      verifyOddsFn: fakeVerifyOddsFn(() => {
        oddsApiVerifyCalled = true;
      }),
      sportmonksPreviewOptions: sportmonksOptions(),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
  assert.equal(body.preview.selections[0].event, "Juventus vs Nice");
  assert.equal(body.preview.selections[0].currentOdds, 1.55);
  assert.equal(typeof body.previewToken, "string", "Stage 10.2: Sportmonks preview now signs a real token");
  assert.ok(body.previewToken.length > 0);

  const verified = verifyPreviewToken(body.previewToken, PREVIEW_TOKEN_SECRET);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.providerName, "SPORTMONKS");
    assert.equal(verified.payload.providerEventId, "19743018");
    assert.equal(verified.payload.playerId, PLAYER_ID);
  }

  assert.equal(oddsApiVerifyCalled, false, "The Odds API must never be called for a flag-on football SINGLE");
});

test("Stage 10: flag ON — a non-football bet is completely unaffected and still uses the old pipeline", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";
  let sportmonksResolverCalled = false;

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Lakers to win vs Celtics, 1.9, 50" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 50,
        selections: [{ sport: "Basketball", event: "Lakers vs Celtics", market: null, selection: "Lakers Win", submittedOdds: 1.9 }],
      }),
      sportmonksPreviewOptions: sportmonksOptions({
        resolver: fakeSportmonksResolver({
          buildDependencies: async () => {
            sportmonksResolverCalled = true;
            return { status: "SUCCESS" };
          },
        }),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.previewToken, "string", "non-football still goes through the old, token-signing pipeline");
  assert.equal(sportmonksResolverCalled, false, "Sportmonks path must never be touched for a non-football sport");
});

test("Stage 10: flag ON — an EXPRESS bet is completely unaffected (NOT_APPLICABLE falls through)", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real Madrid win 1.9 and Barcelona win 2.1, express 50" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "EXPRESS",
        stake: 50,
        selections: [
          { sport: "Football", event: "Real Madrid vs X", market: null, selection: "Real Madrid Win", submittedOdds: 1.9 },
          { sport: "Football", event: "Barcelona vs Y", market: null, selection: "Barcelona Win", submittedOdds: 2.1 },
        ],
      }),
      sportmonksPreviewOptions: sportmonksOptions(),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "EXPRESS");
});

test("Stage 10: flag ON — team not found via Sportmonks returns a safe 422, never falls back to The Odds API", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";
  let oddsApiVerifyCalled = false;

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Nonexistent FC to win, 50" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 50,
        selections: [{ sport: "Football", event: "Nonexistent FC", market: null, selection: "Nonexistent FC Win", submittedOdds: null }],
      }),
      verifyOddsFn: fakeVerifyOddsFn(() => {
        oddsApiVerifyCalled = true;
      }),
      sportmonksPreviewOptions: sportmonksOptions({
        resolver: fakeSportmonksResolver({ resolve: () => ({ kind: "NOT_FOUND", reason: "x" }) }),
      }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "EVENT_NOT_FOUND");
  assert.equal(oddsApiVerifyCalled, false);
});

test("Stage 10: flag ON — an already-started fixture returns the exact required Russian message", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Juventus победа 100" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 100,
        selections: [{ sport: "Football", event: "Juventus", market: null, selection: "Juventus победа", submittedOdds: null }],
      }),
      sportmonksPreviewOptions: sportmonksOptions({
        fetchFixtureById: async () => ({
          status: "SUCCESS",
          fixture: {
            provider: "SPORTMONKS",
            providerEventId: "19743018",
            sport: "FOOTBALL",
            leagueId: 1101,
            leagueName: "Club Friendlies 1",
            stageName: "Regular Season",
            homeTeamId: "625",
            homeTeamName: "Juventus",
            awayTeamId: "450",
            awayTeamName: "Nice",
            commenceTime: "2026-07-31T16:00:00.000Z",
            stateId: 2,
          },
        }),
      }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "EVENT_ALREADY_STARTED");
  assert.equal(body.detail, "Матч уже начался. Выберите другое событие.");
});

test("Stage 10: flag ON — empty odds returns the exact required Russian message", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Juventus победа 100" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 100,
        selections: [{ sport: "Football", event: "Juventus", market: null, selection: "Juventus победа", submittedOdds: null }],
      }),
      sportmonksPreviewOptions: sportmonksOptions({ fetchOdds: async () => ({ status: "EMPTY" }) }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "ODDS_UNAVAILABLE");
  assert.equal(body.detail, "Коэффициент на выбранный исход сейчас недоступен.");
});

test("Stage 10: flag ON — an ambiguous team returns a safe 422, no candidate is guessed", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Real to win, 50" }),
    baseOptions({
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 50,
        selections: [{ sport: "Football", event: "Real", market: null, selection: "Real Win", submittedOdds: null }],
      }),
      sportmonksPreviewOptions: sportmonksOptions({
        resolver: fakeSportmonksResolver({
          resolve: () => ({
            kind: "AMBIGUOUS",
            candidates: [juventusCandidate(), juventusCandidate({ providerEventId: "2" })],
            reason: "x",
          }),
        }),
      }),
    }),
  );

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "AMBIGUOUS_EVENT");
});

test("Stage 10: no Bet is ever created and no balance field is ever touched by this route (db has no bet/player-write methods)", async () => {
  process.env.SPORTMONKS_FOOTBALL_PREVIEW_ENABLED = "true";
  const readOnlyDb = {
    player: {
      findUnique: async () => ({ id: PLAYER_ID }),
      // Deliberately no update/create — a call to either throws.
    },
  } as unknown as PrismaClient;

  const initData = buildInitData(BOT_TOKEN, PLAYER_TELEGRAM_ID);
  const response = await handleTextPreview(
    buildRequest(initData, { message: "Juventus победа 100" }),
    baseOptions({
      db: readOnlyDb,
      parseBetSlip: fakeParseBetSlip({
        valid: true,
        type: "SINGLE",
        stake: 100,
        selections: [{ sport: "Football", event: "Juventus", market: null, selection: "Juventus победа", submittedOdds: null }],
      }),
      sportmonksPreviewOptions: sportmonksOptions(),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.preview.type, "SINGLE");
});
