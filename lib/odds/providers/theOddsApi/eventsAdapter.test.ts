import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchProviderEvents } from "./eventsAdapter";

// Same fetch-indirection technique as scoresAdapter.test.ts /
// sportsCatalogAdapter.test.ts — global.fetch replaced exactly once,
// delegating to a mutable handler. No real network request is made
// anywhere in this file.

const originalFetch = global.fetch;
const originalApiKey = process.env.ODDS_API_KEY;

let currentHandler: () => Promise<Response> = async () => {
  throw new Error("eventsAdapter.test.ts: no fetch handler set for this test");
};
let lastRequestedUrl: string | null = null;
let fetchCallCount = 0;

global.fetch = (((url: string | URL) => {
  fetchCallCount += 1;
  lastRequestedUrl = String(url);
  return currentHandler();
}) as unknown) as typeof fetch;

test.beforeEach(() => {
  process.env.ODDS_API_KEY = "test-odds-api-key";
  lastRequestedUrl = null;
  fetchCallCount = 0;
  currentHandler = async () => {
    throw new Error("eventsAdapter.test.ts: no fetch handler set for this test");
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

function mockEvents(body: unknown, status = 200): void {
  currentHandler = async () => jsonResponse(body, status);
}

const SUPPORTED_KEY = "soccer_epl";
const UNSUPPORTED_KEY = "soccer_netherlands_eredivisie";

function providerEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    sport_key: SUPPORTED_KEY,
    sport_title: "EPL",
    commence_time: "2026-08-14T15:00:00Z",
    home_team: "Arsenal",
    away_team: "Chelsea",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Successful response with several events                                */
/* -------------------------------------------------------------------------- */

test("1. successful response with several events maps every one", async () => {
  mockEvents([
    providerEvent(),
    providerEvent({ id: "evt-2", home_team: "Liverpool", away_team: "Man City" }),
  ]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 2);
  assert.equal(result.rejectedEntries, 0);
});

/* -------------------------------------------------------------------------- */
/* 2. Correct URL and sportKey                                               */
/* -------------------------------------------------------------------------- */

test("2. requests the correct /events URL with the given sportKey", async () => {
  mockEvents([providerEvent()]);
  await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.ok(lastRequestedUrl, "a request must have been made");
  const url = new URL(lastRequestedUrl!);
  assert.equal(url.pathname, `/v4/sports/${SUPPORTED_KEY}/events/`);
});

/* -------------------------------------------------------------------------- */
/* 3. Never the paid /odds endpoint                                          */
/* -------------------------------------------------------------------------- */

test("3. never requests the paid /odds endpoint", async () => {
  mockEvents([providerEvent()]);
  await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.ok(lastRequestedUrl);
  assert.equal(lastRequestedUrl!.includes("/odds"), false);
});

/* -------------------------------------------------------------------------- */
/* 4-5. API key never leaks                                                  */
/* -------------------------------------------------------------------------- */

test("4. API key never appears in a successful result", async () => {
  process.env.ODDS_API_KEY = "super-secret-events-key";
  mockEvents([providerEvent()]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.equal(JSON.stringify(result).includes("super-secret-events-key"), false);
});

test("5. API key never appears in a failure result", async () => {
  process.env.ODDS_API_KEY = "super-secret-events-key";
  mockEvents({ message: "Invalid API key" }, 401);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.equal(JSON.stringify(result).includes("super-secret-events-key"), false);
});

/* -------------------------------------------------------------------------- */
/* 6. Unsupported sportKey never calls fetch                                 */
/* -------------------------------------------------------------------------- */

test("6. an unsupported sportKey returns FAILED/UNSUPPORTED_SPORT_KEY without calling fetch", async () => {
  const result = await fetchProviderEvents({ sportKey: UNSUPPORTED_KEY });

  assert.deepEqual(result, { status: "FAILED", reason: "UNSUPPORTED_SPORT_KEY" });
  assert.equal(fetchCallCount, 0);
  assert.equal(lastRequestedUrl, null);
});

/* -------------------------------------------------------------------------- */
/* 7. Missing API key                                                        */
/* -------------------------------------------------------------------------- */

test("7. missing ODDS_API_KEY -> FAILED/MISSING_API_KEY, no request attempted", async () => {
  delete process.env.ODDS_API_KEY;
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.deepEqual(result, { status: "FAILED", reason: "MISSING_API_KEY" });
  assert.equal(fetchCallCount, 0);
});

/* -------------------------------------------------------------------------- */
/* 8-10. HTTP failures                                                       */
/* -------------------------------------------------------------------------- */

test("8. HTTP 401 -> FAILED/HTTP_UNAUTHORIZED", async () => {
  mockEvents({ message: "Invalid API key" }, 401);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_UNAUTHORIZED" });
});

test("9. HTTP 429 -> FAILED/HTTP_RATE_LIMITED", async () => {
  mockEvents({ message: "Rate limit exceeded" }, 429);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_RATE_LIMITED" });
});

test("10. HTTP 500 -> FAILED/HTTP_ERROR", async () => {
  mockEvents({ message: "Internal error" }, 500);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_ERROR" });
});

/* -------------------------------------------------------------------------- */
/* 11. Timeout                                                               */
/* -------------------------------------------------------------------------- */

test("11. an aborted request (timeout) -> FAILED/TIMEOUT", async () => {
  currentHandler = () =>
    new Promise<Response>((_resolve, reject) => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      reject(abortError);
    });
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY, timeoutMs: 50 });
  assert.deepEqual(result, { status: "FAILED", reason: "TIMEOUT" });
});

/* -------------------------------------------------------------------------- */
/* 12. Network error                                                         */
/* -------------------------------------------------------------------------- */

test("12. a generic network failure (not AbortError) -> FAILED/NETWORK_ERROR", async () => {
  currentHandler = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.the-odds-api.com");
  };
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NETWORK_ERROR" });
});

/* -------------------------------------------------------------------------- */
/* 13-14. Malformed responses                                                */
/* -------------------------------------------------------------------------- */

test("13. invalid JSON body -> FAILED/INVALID_JSON", async () => {
  currentHandler = async () => new Response("not json{{{", { status: 200 });
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_JSON" });
});

test("14. valid JSON but not an array -> FAILED/INVALID_RESPONSE", async () => {
  mockEvents({ unexpected: "object, not an array" });
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_RESPONSE" });
});

/* -------------------------------------------------------------------------- */
/* 15-16. Batch isolation                                                    */
/* -------------------------------------------------------------------------- */

test("15. one broken entry does not break the rest of a valid batch", async () => {
  mockEvents([providerEvent(), { id: "evt-broken" /* missing every other required field */ }]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.equal(result.rejectedEntries, 1);
});

test("16. every entry broken -> FAILED/NO_VALID_EVENTS (not a hollow success)", async () => {
  mockEvents([
    { id: "evt-broken-1" },
    { id: "evt-broken-2", sport_key: SUPPORTED_KEY },
  ]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NO_VALID_EVENTS" });
});

/* -------------------------------------------------------------------------- */
/* 17-21. Per-entry business-rule rejection                                  */
/* -------------------------------------------------------------------------- */

test("17. invalid commence_time rejects that entry", async () => {
  mockEvents([providerEvent({ commence_time: "not-a-real-date" })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.equal(result.status, "FAILED");
  if (result.status !== "FAILED") return;
  assert.equal(result.reason, "NO_VALID_EVENTS");
});

test("18. empty home_team rejects that entry", async () => {
  mockEvents([providerEvent({ home_team: "" })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NO_VALID_EVENTS" });
});

test("19. empty away_team rejects that entry", async () => {
  mockEvents([providerEvent({ away_team: "" })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NO_VALID_EVENTS" });
});

test("20. identical home_team and away_team (after basic normalization) rejects that entry", async () => {
  mockEvents([providerEvent({ home_team: "Arsenal", away_team: "  arsenal " })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NO_VALID_EVENTS" });
});

test("21. an entry whose own sport_key differs from the requested sportKey is rejected", async () => {
  mockEvents([providerEvent({ sport_key: "soccer_spain_la_liga" })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "FAILED", reason: "NO_VALID_EVENTS" });
});

test("21b. a sport_key mismatch isolates only that entry when mixed with valid ones", async () => {
  mockEvents([providerEvent(), providerEvent({ id: "evt-wrong-key", sport_key: "soccer_spain_la_liga" })]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.equal(result.rejectedEntries, 1);
});

/* -------------------------------------------------------------------------- */
/* 22. Correct provider-neutral mapping                                      */
/* -------------------------------------------------------------------------- */

test("22. maps a valid provider event into the exact existing ProviderEventCandidate shape", async () => {
  mockEvents([
    providerEvent({
      id: "evt-42",
      sport_key: SUPPORTED_KEY,
      commence_time: "2026-08-14T15:00:00Z",
      home_team: "Arsenal",
      away_team: "Chelsea",
    }),
  ]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.results[0], {
    event: {
      sport: "FOOTBALL",
      league: { name: "Premier League" },
      name: "Arsenal vs Chelsea",
      participants: [{ name: "Arsenal" }, { name: "Chelsea" }],
      startTime: "2026-08-14T15:00:00Z",
      period: "FULL_GAME",
      homeParticipantIndex: 0,
      awayParticipantIndex: 1,
    },
    reference: {
      provider: "THE_ODDS_API",
      eventId: "evt-42",
      sportKey: SUPPORTED_KEY,
    },
  });
});

/* -------------------------------------------------------------------------- */
/* 23. Empty valid array                                                     */
/* -------------------------------------------------------------------------- */

test("23. an empty provider response is a predictable SUCCESS with zero results (not NO_VALID_EVENTS)", async () => {
  mockEvents([]);
  const result = await fetchProviderEvents({ sportKey: SUPPORTED_KEY });
  assert.deepEqual(result, { status: "SUCCESS", results: [], rejectedEntries: 0 });
});
