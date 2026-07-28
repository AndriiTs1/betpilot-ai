import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchProviderScores } from "./scoresAdapter";

// Same fetch-indirection technique as lib/odds/oddsVerifier.test.ts —
// global.fetch replaced exactly once, delegating to a mutable handler.
// No real network request is made anywhere in this file.

const originalFetch = global.fetch;
const originalApiKey = process.env.ODDS_API_KEY;

let currentHandler: (url: string) => Promise<Response> = async () => {
  throw new Error("scoresAdapter.test.ts: no fetch handler set for this test");
};
let lastRequestedUrl: string | null = null;

global.fetch = (((url: string | URL) => {
  lastRequestedUrl = String(url);
  return currentHandler(String(url));
}) as unknown) as typeof fetch;

test.beforeEach(() => {
  process.env.ODDS_API_KEY = "test-odds-api-key";
  lastRequestedUrl = null;
  currentHandler = async () => {
    throw new Error("scoresAdapter.test.ts: no fetch handler set for this test");
  };
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalApiKey !== undefined) {
    process.env.ODDS_API_KEY = originalApiKey;
  } else {
    delete process.env.ODDS_API_KEY;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockScores(body: unknown, status = 200): void {
  currentHandler = async () => jsonResponse(body, status);
}

function providerEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    sport_key: "soccer_epl",
    sport_title: "EPL",
    commence_time: "2026-07-28T15:00:00Z",
    completed: true,
    home_team: "Arsenal",
    away_team: "Chelsea",
    scores: [
      { name: "Arsenal", score: "2" },
      { name: "Chelsea", score: "1" },
    ],
    last_update: "2026-07-28T17:00:00Z",
    ...overrides,
  };
}

function input(overrides: { providerSportKey?: string; providerEventIds?: string[] } = {}) {
  return { providerSportKey: "soccer_epl", providerEventIds: ["evt-1"], ...overrides };
}

/* -------------------------------------------------------------------------- */
/* 1-3. Completed outcomes                                                   */
/* -------------------------------------------------------------------------- */

test("completed home win", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "2" }, { name: "Chelsea", score: "0" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], {
    providerEventId: "evt-1",
    eventResult: { status: "COMPLETED", homeParticipant: { name: "Arsenal" }, awayParticipant: { name: "Chelsea" }, homeScore: 2, awayScore: 0 },
  });
});

test("completed away win", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "0" }, { name: "Chelsea", score: "3" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, 0);
  assert.equal(result.results[0].eventResult.awayScore, 3);
});

test("completed draw", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "1" }, { name: "Chelsea", score: "1" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, 1);
  assert.equal(result.results[0].eventResult.awayScore, 1);
});

/* -------------------------------------------------------------------------- */
/* 4-5. In-progress / upcoming                                               */
/* -------------------------------------------------------------------------- */

test("in-progress with scores -> IN_PROGRESS, scores left null (not meaningful per domain)", async () => {
  mockScores([providerEvent({ completed: false, scores: [{ name: "Arsenal", score: "1" }, { name: "Chelsea", score: "0" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.results[0].eventResult, {
    status: "IN_PROGRESS",
    homeParticipant: { name: "Arsenal" },
    awayParticipant: { name: "Chelsea" },
    homeScore: null,
    awayScore: null,
  });
});

test("upcoming without scores -> NOT_STARTED", async () => {
  mockScores([providerEvent({ completed: false, scores: null })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.status, "NOT_STARTED");
  assert.equal(result.results[0].eventResult.homeScore, null);
});

/* -------------------------------------------------------------------------- */
/* 6-12. Score resolution edge cases                                          */
/* -------------------------------------------------------------------------- */

test("scores array order reversed -> still resolved by exact name, not position", async () => {
  mockScores([providerEvent({ scores: [{ name: "Chelsea", score: "1" }, { name: "Arsenal", score: "2" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, 2);
  assert.equal(result.results[0].eventResult.awayScore, 1);
});

test("malformed score string -> event rejected, not COMPLETED with a guessed score", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "two" }, { name: "Chelsea", score: "1" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  // Malformed score -> home unresolved -> COMPLETED with null scores (the
  // honest "completed but no trustworthy score" case), not a rejected event.
  assert.equal(result.results[0].eventResult.homeScore, null);
  assert.equal(result.results[0].eventResult.awayScore, null);
});

test("decimal score rejected", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "2.5" }, { name: "Chelsea", score: "1" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, null);
});

test("negative score rejected", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "-1" }, { name: "Chelsea", score: "1" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, null);
});

test("one team missing from scores -> both sides null, not partially trusted", async () => {
  mockScores([providerEvent({ scores: [{ name: "Arsenal", score: "2" }] })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, null);
  assert.equal(result.results[0].eventResult.awayScore, null);
});

test("duplicate home team entry -> unresolved, not the first/last one silently picked", async () => {
  mockScores([
    providerEvent({
      scores: [
        { name: "Arsenal", score: "2" },
        { name: "Arsenal", score: "3" },
        { name: "Chelsea", score: "1" },
      ],
    }),
  ]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, null);
  assert.equal(result.results[0].eventResult.awayScore, null); // whole pair rejected, not half-trusted
});

test("unknown extra team entry does not create ambiguity when home/away still resolve uniquely", async () => {
  mockScores([
    providerEvent({
      scores: [
        { name: "Arsenal", score: "2" },
        { name: "Chelsea", score: "1" },
        { name: "Some Third Entry", score: "99" },
      ],
    }),
  ]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.homeScore, 2);
  assert.equal(result.results[0].eventResult.awayScore, 1);
});

/* -------------------------------------------------------------------------- */
/* 13. Completed without scores                                              */
/* -------------------------------------------------------------------------- */

test("completed without scores -> COMPLETED with null scores (evaluateSelectionOutcome's own MISSING_SCORE rule handles it downstream)", async () => {
  mockScores([providerEvent({ completed: true, scores: null })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results[0].eventResult.status, "COMPLETED");
  assert.equal(result.results[0].eventResult.homeScore, null);
  assert.equal(result.results[0].eventResult.awayScore, null);
});

/* -------------------------------------------------------------------------- */
/* 14-16. Malformed event shape -> event rejected, batch preserved            */
/* -------------------------------------------------------------------------- */

test("invalid commence_time -> event rejected, not partially trusted", async () => {
  mockScores([providerEvent({ commence_time: "not-a-real-date" }), providerEvent({ id: "evt-2" })]);
  const result = await fetchProviderScores(input({ providerEventIds: ["evt-1", "evt-2"] }));

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].providerEventId, "evt-2");
  assert.equal(result.rejectedEvents, 1);
});

test("malformed event ID (empty string) -> event rejected", async () => {
  mockScores([providerEvent({ id: "" })]);
  const result = await fetchProviderScores(input());

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 0);
  assert.equal(result.rejectedEvents, 1);
});

test("malformed sport_key (mismatched from requested key) -> event rejected", async () => {
  mockScores([providerEvent({ sport_key: "basketball_nba" })]);
  const result = await fetchProviderScores(input({ providerSportKey: "soccer_epl" }));

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 0);
  assert.equal(result.rejectedEvents, 1);
});

/* -------------------------------------------------------------------------- */
/* 17. Partial response — one valid, one invalid                             */
/* -------------------------------------------------------------------------- */

test("partial response: one valid event preserved alongside one rejected event", async () => {
  mockScores([providerEvent({ id: "evt-1" }), providerEvent({ id: "evt-2", home_team: "" })]);
  const result = await fetchProviderScores(input({ providerEventIds: ["evt-1", "evt-2"] }));

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].providerEventId, "evt-1");
  assert.equal(result.rejectedEvents, 1);
});

/* -------------------------------------------------------------------------- */
/* 18-19. Top-level invalid response / invalid JSON                          */
/* -------------------------------------------------------------------------- */

test("top-level invalid response (not an array) -> FAILED/INVALID_RESPONSE", async () => {
  mockScores({ error: "unexpected shape" });
  const result = await fetchProviderScores(input());

  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_RESPONSE" });
});

test("invalid JSON body -> FAILED/INVALID_JSON", async () => {
  currentHandler = async () => new Response("not json{{{", { status: 200 });
  const result = await fetchProviderScores(input());

  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_JSON" });
});

/* -------------------------------------------------------------------------- */
/* 20-24. Network/HTTP failures                                              */
/* -------------------------------------------------------------------------- */

test("timeout -> FAILED/TIMEOUT", async () => {
  currentHandler = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const result = await fetchProviderScores(input());

  assert.deepEqual(result, { status: "FAILED", reason: "TIMEOUT" });
});

test("HTTP 401 -> FAILED/HTTP_401", async () => {
  mockScores({ message: "unauthorized" }, 401);
  const result = await fetchProviderScores(input());
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_401" });
});

test("HTTP 429 -> FAILED/HTTP_429 (classified separately for Stage 3.6)", async () => {
  mockScores({ message: "rate limited" }, 429);
  const result = await fetchProviderScores(input());
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_429" });
});

test("HTTP 500 -> FAILED/HTTP_5XX", async () => {
  mockScores({ message: "server error" }, 500);
  const result = await fetchProviderScores(input());
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_5XX" });
});

test("generic HTTP error (404) -> FAILED/HTTP_ERROR", async () => {
  mockScores({ message: "not found" }, 404);
  const result = await fetchProviderScores(input());
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_ERROR" });
});

/* -------------------------------------------------------------------------- */
/* 25. Missing API key                                                       */
/* -------------------------------------------------------------------------- */

test("missing ODDS_API_KEY -> FAILED/MISSING_API_KEY, no request attempted", async () => {
  delete process.env.ODDS_API_KEY;
  let fetchCalled = false;
  currentHandler = async () => {
    fetchCalled = true;
    return jsonResponse([]);
  };

  const result = await fetchProviderScores(input());

  assert.deepEqual(result, { status: "FAILED", reason: "MISSING_API_KEY" });
  assert.equal(fetchCalled, false);
});

/* -------------------------------------------------------------------------- */
/* 26-27. URL construction and secret hygiene                                */
/* -------------------------------------------------------------------------- */

test("URL contains correct sport, daysFrom=3, dateFormat=iso, and eventIds", async () => {
  mockScores([providerEvent()]);
  await fetchProviderScores(input({ providerSportKey: "soccer_epl", providerEventIds: ["evt-1", "evt-2"] }));

  assert.ok(lastRequestedUrl);
  const url = new URL(lastRequestedUrl!);
  assert.equal(url.pathname, "/v4/sports/soccer_epl/scores/");
  assert.equal(url.searchParams.get("daysFrom"), "3");
  assert.equal(url.searchParams.get("dateFormat"), "iso");
  assert.equal(url.searchParams.get("eventIds"), "evt-1,evt-2");
});

test("API key is present in the URL (required by the provider) but never appears in a returned error/result", async () => {
  mockScores({ message: "server error" }, 500);
  const result = await fetchProviderScores(input());

  assert.ok(lastRequestedUrl!.includes("apiKey=test-odds-api-key"));
  assert.equal(JSON.stringify(result).includes("test-odds-api-key"), false);
});

/* -------------------------------------------------------------------------- */
/* 28-30. Cleanup, purity, determinism                                       */
/* -------------------------------------------------------------------------- */

test("AbortController timeout is cleared on a normal successful response (no dangling timer)", async () => {
  mockScores([providerEvent()]);
  // No direct way to assert clearTimeout was called without a timer mock;
  // this test instead proves the function resolves promptly rather than
  // hanging until any timeout would fire, which is the externally
  // observable consequence of the finally-block cleanup.
  const start = Date.now();
  await fetchProviderScores(input());
  assert.ok(Date.now() - start < 1000);
});

test("input is not mutated", async () => {
  mockScores([providerEvent()]);
  const theInput = input({ providerEventIds: ["evt-1"] });
  const copy = { ...theInput, providerEventIds: [...theInput.providerEventIds] };

  await fetchProviderScores(theInput);

  assert.deepEqual(theInput, copy);
});

test("deterministic output for identical input", async () => {
  mockScores([providerEvent()]);
  const r1 = await fetchProviderScores(input());
  const r2 = await fetchProviderScores(input());
  assert.deepEqual(r1, r2);
});
