import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBetPreview,
  fetchExpressLegExclusionPreview,
  getBetPreviewErrorMessage,
  isAiTimeoutFailure,
} from "./betPreviewApi";

// Focused coverage for the client-side error-message mapping — the actual
// fetchBetPreview() network/parsing logic is exercised indirectly by the
// server-side route tests; this file is specifically about the Telegram
// auth-error unification (previously malformed/invalid_signature and
// expired had two different messages here; now both routes go through the
// shared components/miniapp/telegramAuthError.ts).

test("getBetPreviewErrorMessage: expired gets the shared, distinct expired message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "expired" });
  assert.equal(message, "Your Telegram session has expired. Close and reopen the Mini App through the bot.");
});

test("getBetPreviewErrorMessage: malformed and invalid_signature share the same message as each other", () => {
  const malformed = getBetPreviewErrorMessage({ kind: "http", code: "malformed" });
  const invalidSignature = getBetPreviewErrorMessage({ kind: "http", code: "invalid_signature" });

  assert.equal(malformed, "Unable to verify your Telegram session. Close and reopen the Mini App through the bot.");
  assert.equal(malformed, invalidSignature);
  assert.notEqual(malformed, getBetPreviewErrorMessage({ kind: "http", code: "expired" }));
});

test("getBetPreviewErrorMessage: unrelated error codes keep their own unchanged messages", () => {
  assert.equal(getBetPreviewErrorMessage({ kind: "http", code: "PLAYER_NOT_FOUND" }), "Your player account was not found.");
});

// Odds are never required from the player — the PARSE_FAILED recovery hint
// must reflect that (event/selection/stake only), never nudge the player
// toward typing odds. See lib/ai/betParserPrompt.ts's matching policy.
test("getBetPreviewErrorMessage: PARSE_FAILED never suggests adding odds", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "PARSE_FAILED" });
  assert.equal(message, "We could not understand this bet. Try including the event, selection, and stake.");
  assert.equal(message.toLowerCase().includes("odds"), false);
});

test("getBetPreviewErrorMessage: network/timeout/invalid_response keep their existing, unrelated messages", () => {
  assert.equal(getBetPreviewErrorMessage({ kind: "network" }), "Unable to connect. Check your internet connection.");
  assert.equal(getBetPreviewErrorMessage({ kind: "timeout" }), "The request took too long. Please try again.");
  assert.equal(getBetPreviewErrorMessage({ kind: "invalid_response" }), "Something went wrong. Please try again.");
});

// ---------------------------------------------------------------------
// Step 15J.3 — AI_TIMEOUT is a parser-layer timeout, distinguished from
// PARSE_FAILED so BetTextForm can show its own dedicated "AI service timed
// out / Try again" UI instead of the misleading "we couldn't understand
// this bet" message.
// ---------------------------------------------------------------------

test("getBetPreviewErrorMessage: AI_TIMEOUT has its own honest message, distinct from PARSE_FAILED, and never claims the bet was rejected", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "AI_TIMEOUT" });
  assert.equal(message, "Your bet was not rejected. The analysis took too long. Please try again.");
  assert.notEqual(message, getBetPreviewErrorMessage({ kind: "http", code: "PARSE_FAILED" }));
});

test("isAiTimeoutFailure: true only for kind:http code:AI_TIMEOUT", () => {
  assert.equal(isAiTimeoutFailure({ kind: "http", code: "AI_TIMEOUT" }), true);
});

/* -------------------------------------------------------------------------- */
/* Production bug regression — "Benfica vs St. Gallen победа Benfica 10"     */
/* -------------------------------------------------------------------------- */
// Root cause: this was never a server-side exception. The server (Stage 10)
// already returned a correctly typed, graceful 422 with a specific reason
// (in this reported case: ODDS_UNAVAILABLE — confirmed by reproducing the
// exact resolution live, which succeeds and reaches a clean odds-unavailable
// result, never a throw). The bug was entirely client-side: none of the 5
// Stage 10 preview error codes were ever added to BetPreviewErrorCode or to
// getBetPreviewErrorMessage's switch, so every one of them silently fell
// through to the generic "Something went wrong" default — masking the
// server's own, already-correct, specific message. These tests prove each
// of the 5 codes now has its own distinct, non-generic message.

const GENERIC_FALLBACK = "Something went wrong. Please try again.";

test("Regression (Benfica vs St. Gallen bug): ODDS_UNAVAILABLE no longer falls through to the generic fallback", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "ODDS_UNAVAILABLE" });
  assert.notEqual(message, GENERIC_FALLBACK);
  assert.equal(message, "Odds for this selection aren't available right now. Please try again shortly.");
});

test("getBetPreviewErrorMessage: EVENT_NOT_FOUND has its own distinct message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "EVENT_NOT_FOUND" });
  assert.notEqual(message, GENERIC_FALLBACK);
  assert.equal(message, "We couldn't find that team or match. Please check the spelling and try again.");
});

test("getBetPreviewErrorMessage: AMBIGUOUS_EVENT has its own distinct message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "AMBIGUOUS_EVENT" });
  assert.notEqual(message, GENERIC_FALLBACK);
  assert.equal(message, "We found more than one matching event. Please be more specific, e.g. include both team names.");
});

test("getBetPreviewErrorMessage: UNSUPPORTED_SELECTION has its own distinct message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "UNSUPPORTED_SELECTION" });
  assert.notEqual(message, GENERIC_FALLBACK);
  assert.equal(message, "Only Home win, Draw, or Away win are supported for this event right now.");
});

test("getBetPreviewErrorMessage: EVENT_ALREADY_STARTED has its own distinct message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "EVENT_ALREADY_STARTED" });
  assert.notEqual(message, GENERIC_FALLBACK);
  assert.equal(message, "This match has already started. Please choose a different event.");
});

test("Regression: all 5 Stage 10 preview error codes produce mutually distinct, non-generic messages", () => {
  const codes = ["EVENT_NOT_FOUND", "AMBIGUOUS_EVENT", "UNSUPPORTED_SELECTION", "EVENT_ALREADY_STARTED", "ODDS_UNAVAILABLE"] as const;
  const messages = codes.map((code) => getBetPreviewErrorMessage({ kind: "http", code }));

  for (const message of messages) {
    assert.notEqual(message, GENERIC_FALLBACK, `code produced the generic fallback instead of a specific message`);
  }
  assert.equal(new Set(messages).size, messages.length, "every code must have its own distinct message");
});

test("isAiTimeoutFailure: false for PARSE_FAILED and every other http code", () => {
  assert.equal(isAiTimeoutFailure({ kind: "http", code: "PARSE_FAILED" }), false);
  assert.equal(isAiTimeoutFailure({ kind: "http", code: "PLAYER_NOT_FOUND" }), false);
  assert.equal(isAiTimeoutFailure({ kind: "http", code: "UNKNOWN" }), false);
});

test("isAiTimeoutFailure: false for non-http failure kinds (network/timeout/invalid_response)", () => {
  assert.equal(isAiTimeoutFailure({ kind: "network" }), false);
  assert.equal(isAiTimeoutFailure({ kind: "timeout" }), false);
  assert.equal(isAiTimeoutFailure({ kind: "invalid_response" }), false);
});

/* -------------------------------------------------------------------------- */
/* UI-E1 — RATE_LIMITED (429) was previously unhandled, silently falling     */
/* through to the generic "Something went wrong" default and discarding the */
/* server's already-computed retryAfterSeconds (lib/rateLimit/               */
/* rateLimitResponse.ts). Same "was there a specific server reason that got  */
/* masked" shape as the Benfica/St. Gallen regression above, so it's tested  */
/* the same two ways: the message-mapping layer (getBetPreviewErrorMessage)  */
/* and the HTTP-body-extraction layer (fetchBetPreview) that feeds it.       */
/* -------------------------------------------------------------------------- */

function stubFetch(responseInit: { status: number; body: unknown }) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responseInit.body), {
      status: responseInit.status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("getBetPreviewErrorMessage: RATE_LIMITED with retryAfterSeconds includes the exact wait time, never the generic fallback", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "RATE_LIMITED", retryAfterSeconds: 12 });
  assert.equal(message, "Too many attempts. Please try again in 12 seconds.");
  assert.notEqual(message, GENERIC_FALLBACK);
});

test("getBetPreviewErrorMessage: RATE_LIMITED without retryAfterSeconds falls back to a generic-wait message, still never the unrelated generic fallback", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "RATE_LIMITED" });
  assert.equal(message, "Too many attempts. Please try again shortly.");
  assert.notEqual(message, GENERIC_FALLBACK);
});

test("fetchBetPreview: 429 RATE_LIMITED with retryAfterSeconds propagates it onto the failure object", async () => {
  const restore = stubFetch({ status: 429, body: { error: "RATE_LIMITED", retryAfterSeconds: 12 } });
  try {
    const result = await fetchBetPreview("fake-init-data", "Arsenal win stake 10");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.failure, { kind: "http", code: "RATE_LIMITED", retryAfterSeconds: 12 });
    assert.equal(getBetPreviewErrorMessage(result.failure), "Too many attempts. Please try again in 12 seconds.");
  } finally {
    restore();
  }
});

test("fetchBetPreview: 429 RATE_LIMITED without retryAfterSeconds in the body leaves it undefined on the failure object", async () => {
  const restore = stubFetch({ status: 429, body: { error: "RATE_LIMITED" } });
  try {
    const result = await fetchBetPreview("fake-init-data", "Arsenal win stake 10");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.failure, { kind: "http", code: "RATE_LIMITED" });
    assert.equal((result.failure as { retryAfterSeconds?: number }).retryAfterSeconds, undefined);
    assert.equal(getBetPreviewErrorMessage(result.failure), "Too many attempts. Please try again shortly.");
  } finally {
    restore();
  }
});

test("fetchBetPreview: retryAfterSeconds is never attached to a non-RATE_LIMITED http failure", async () => {
  const restore = stubFetch({ status: 422, body: { error: "PARSE_FAILED", detail: "unrelated" } });
  try {
    const result = await fetchBetPreview("fake-init-data", "gibberish");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.failure, { kind: "http", code: "PARSE_FAILED" });
  } finally {
    restore();
  }
});

test("UI-E1 regression: existing AI_TIMEOUT message is unchanged by this stage", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "AI_TIMEOUT" });
  assert.equal(message, "Your bet was not rejected. The analysis took too long. Please try again.");
});

test("UI-E1 regression: existing network failure message is unchanged by this stage", () => {
  assert.equal(getBetPreviewErrorMessage({ kind: "network" }), "Unable to connect. Check your internet connection.");
});

test("getBetPreviewErrorMessage: an unknown HTTP error code still uses the generic fallback, unchanged", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "UNKNOWN" });
  assert.equal(message, GENERIC_FALLBACK);
});

// ---------------------------------------------------------------------
// Sector 1 (ADR-0002) — POST /api/miniapp/bets/express/exclude-legs's own
// error codes.
// ---------------------------------------------------------------------

test("getBetPreviewErrorMessage: ALL_LEGS_EXCLUDED has its own actionable message", () => {
  const message = getBetPreviewErrorMessage({ kind: "http", code: "ALL_LEGS_EXCLUDED" });
  assert.equal(message, "Removing this leg would leave nothing to bet on. Please cancel and start over.");
});

test("getBetPreviewErrorMessage: PREVIEW_EXPIRED/PREVIEW_INVALID share the same message as each other, distinct from the generic fallback", () => {
  const expired = getBetPreviewErrorMessage({ kind: "http", code: "PREVIEW_EXPIRED" });
  const invalid = getBetPreviewErrorMessage({ kind: "http", code: "PREVIEW_INVALID" });
  assert.equal(expired, invalid);
  assert.notEqual(expired, GENERIC_FALLBACK);
});

test("getBetPreviewErrorMessage: the remaining exclusion defense-in-depth codes fall back to the generic message", () => {
  for (const code of ["NOT_EXPRESS_TOKEN", "NO_LEGS_EXCLUDED", "DUPLICATE_LEG_INDEX", "INVALID_LEG_INDEX", "LEG_NOT_RECOVERABLE"] as const) {
    assert.equal(getBetPreviewErrorMessage({ kind: "http", code }), GENERIC_FALLBACK);
  }
});

// ---------------------------------------------------------------------
// fetchExpressLegExclusionPreview — network/parsing behavior, mirroring
// fetchBetPreview's own untested-here convention (server-side route tests
// exercise the real endpoint; this covers the client-side fetch wrapper).
// ---------------------------------------------------------------------

test("fetchExpressLegExclusionPreview: a network failure is reported as kind:network", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  try {
    const result = await fetchExpressLegExclusionPreview("initdata", "token", [0]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, "network");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchExpressLegExclusionPreview: a non-2xx response is mapped to kind:http with the server's error code", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify({ error: "LEG_NOT_RECOVERABLE" }), { status: 422 })) as typeof fetch;

  try {
    const result = await fetchExpressLegExclusionPreview("initdata", "token", [0]);
    assert.equal(result.ok, false);
    if (!result.ok && result.failure.kind === "http") {
      assert.equal(result.failure.code, "LEG_NOT_RECOVERABLE");
    } else {
      assert.fail("expected kind:http failure");
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchExpressLegExclusionPreview: a valid success body round-trips through isBetPreviewSuccess and is returned as-is", async () => {
  const successBody = {
    preview: { type: "SINGLE", stake: 50, totalOdds: 2.1, potentialWin: 105, selections: [
      {
        sport: "Football", event: "Real Madrid vs Barcelona", market: null, selection: "Real Madrid Win",
        marketType: null, participant: null, line: null, submittedOdds: 2.1, currentOdds: 2.1,
        oddsStatus: "VERIFIED", bookmaker: "Pinnacle", discrepancyPercent: 0,
        homeTeamName: null, awayTeamName: null, competitionName: null, eventStartTime: null,
      },
    ] },
    previewToken: "new-token-value",
  };

  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify(successBody), { status: 200 })) as typeof fetch;

  try {
    const result = await fetchExpressLegExclusionPreview("initdata", "old-token-value", [1]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.previewToken, "new-token-value");
      assert.notEqual(result.data.previewToken, "old-token-value");
    }
  } finally {
    global.fetch = originalFetch;
  }
});
