import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchProviderSportsCatalog } from "./sportsCatalogAdapter";

// Same fetch-indirection technique as scoresAdapter.test.ts /
// oddsVerifier.test.ts — global.fetch replaced exactly once, delegating to
// a mutable handler. No real network request is made anywhere in this file.

const originalFetch = global.fetch;
const originalApiKey = process.env.ODDS_API_KEY;

let currentHandler: () => Promise<Response> = async () => {
  throw new Error("sportsCatalogAdapter.test.ts: no fetch handler set for this test");
};
let lastRequestedUrl: string | null = null;

global.fetch = (((url: string | URL) => {
  lastRequestedUrl = String(url);
  return currentHandler();
}) as unknown) as typeof fetch;

test.beforeEach(() => {
  process.env.ODDS_API_KEY = "test-odds-api-key";
  lastRequestedUrl = null;
  currentHandler = async () => {
    throw new Error("sportsCatalogAdapter.test.ts: no fetch handler set for this test");
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

function mockCatalog(body: unknown, status = 200): void {
  currentHandler = async () => jsonResponse(body, status);
}

function sportEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "soccer_epl",
    group: "Soccer",
    title: "EPL",
    description: "English Premier League",
    active: true,
    has_outrights: false,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Success                                                                    */
/* -------------------------------------------------------------------------- */

test("successful response maps provider fields to camelCase ProviderSportEntry", async () => {
  mockCatalog([sportEntry(), sportEntry({ key: "soccer_spain_la_liga", title: "La Liga - Spain" })]);
  const result = await fetchProviderSportsCatalog();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], {
    sportKey: "soccer_epl",
    group: "Soccer",
    title: "EPL",
    description: "English Premier League",
    active: true,
    hasOutrights: false,
  });
  assert.equal(result.rejectedEntries, 0);
});

test("empty catalog is a valid success with zero results", async () => {
  mockCatalog([]);
  const result = await fetchProviderSportsCatalog();
  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.deepEqual(result.results, []);
});

test("requests all=true so out-of-season competitions are included", async () => {
  mockCatalog([sportEntry()]);
  await fetchProviderSportsCatalog();
  assert.ok(lastRequestedUrl, "a request must have been made");
  const url = new URL(lastRequestedUrl!);
  assert.equal(url.searchParams.get("all"), "true");
});

test("one malformed entry is rejected and isolated, the rest of the batch still succeeds", async () => {
  mockCatalog([sportEntry(), { key: "soccer_broken" /* missing every other required field */ }]);
  const result = await fetchProviderSportsCatalog();

  assert.equal(result.status, "SUCCESS");
  if (result.status !== "SUCCESS") return;
  assert.equal(result.results.length, 1);
  assert.equal(result.rejectedEntries, 1);
});

/* -------------------------------------------------------------------------- */
/* Config / auth                                                             */
/* -------------------------------------------------------------------------- */

test("missing ODDS_API_KEY -> FAILED/MISSING_API_KEY, no request attempted", async () => {
  delete process.env.ODDS_API_KEY;
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "MISSING_API_KEY" });
  assert.equal(lastRequestedUrl, null);
});

/* -------------------------------------------------------------------------- */
/* HTTP failures                                                             */
/* -------------------------------------------------------------------------- */

test("HTTP 401 -> FAILED/HTTP_401", async () => {
  mockCatalog({ message: "Invalid API key" }, 401);
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_401" });
});

test("HTTP 429 -> FAILED/HTTP_429", async () => {
  mockCatalog({ message: "Rate limit exceeded" }, 429);
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_429" });
});

test("HTTP 500 -> FAILED/HTTP_5XX", async () => {
  mockCatalog({ message: "Internal error" }, 503);
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_5XX" });
});

test("other non-2xx status -> FAILED/HTTP_ERROR", async () => {
  mockCatalog({ message: "Not found" }, 404);
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_ERROR" });
});

/* -------------------------------------------------------------------------- */
/* Timeout                                                                    */
/* -------------------------------------------------------------------------- */

test("a request that never resolves before the abort signal fires -> FAILED/TIMEOUT", async () => {
  currentHandler = () =>
    new Promise<Response>((_resolve, reject) => {
      // Never resolves on its own; only the adapter's own AbortController
      // (fired via the real fetch's signal) would reject this in
      // production. Here we simulate exactly what the adapter's own catch
      // block sees for an aborted request.
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      // Reject immediately rather than actually waiting out 8s in this
      // test — same technique already used elsewhere in this codebase's
      // timeout tests (assert behavior given an AbortError, not real wall
      // time).
      reject(abortError);
    });
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "TIMEOUT" });
});

test("a generic network failure (not an AbortError) -> FAILED/HTTP_ERROR", async () => {
  currentHandler = async () => {
    throw new Error("network down");
  };
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "HTTP_ERROR" });
});

/* -------------------------------------------------------------------------- */
/* Malformed responses                                                       */
/* -------------------------------------------------------------------------- */

test("invalid JSON body -> FAILED/INVALID_JSON", async () => {
  currentHandler = async () => new Response("not json{{{", { status: 200 });
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_JSON" });
});

test("valid JSON but not an array (unexpected top-level shape) -> FAILED/INVALID_RESPONSE", async () => {
  mockCatalog({ unexpected: "object, not an array" });
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_RESPONSE" });
});

test("array of non-objects (e.g. strings) -> FAILED/INVALID_RESPONSE", async () => {
  mockCatalog(["not", "objects"]);
  const result = await fetchProviderSportsCatalog();
  assert.deepEqual(result, { status: "FAILED", reason: "INVALID_RESPONSE" });
});

/* -------------------------------------------------------------------------- */
/* Security — never leak the API key                                        */
/* -------------------------------------------------------------------------- */

test("does not throw or embed the API key in any returned failure value", async () => {
  process.env.ODDS_API_KEY = "super-secret-test-key";
  mockCatalog({ message: "Invalid API key" }, 401);
  const result = await fetchProviderSportsCatalog();
  assert.equal(JSON.stringify(result).includes("super-secret-test-key"), false);
});
