import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { isCronAuthorized } from "./cronAuth";

const SECRET = "test-cron-secret-value";
const originalSecret = process.env.CRON_SECRET;

test.beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
});

test.after(() => {
  if (originalSecret !== undefined) {
    process.env.CRON_SECRET = originalSecret;
  } else {
    delete process.env.CRON_SECRET;
  }
});

function requestWithAuth(authHeader: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;
  return new NextRequest("http://localhost/api/internal/poll-results", { headers });
}

/* -------------------------------------------------------------------------- */
/* 1-2. CRON_SECRET env state                                                 */
/* -------------------------------------------------------------------------- */

test("CRON_SECRET missing -> false, even with a correct-looking header", () => {
  delete process.env.CRON_SECRET;
  const request = requestWithAuth(`Bearer ${SECRET}`);
  assert.equal(isCronAuthorized(request), false);
});

test("CRON_SECRET empty string -> false, never treated as no-secret-required", () => {
  process.env.CRON_SECRET = "";
  const request = requestWithAuth(`Bearer ${SECRET}`);
  assert.equal(isCronAuthorized(request), false);
});

/* -------------------------------------------------------------------------- */
/* 3-4. Authorization header state                                            */
/* -------------------------------------------------------------------------- */

test("Authorization header missing -> false", () => {
  assert.equal(isCronAuthorized(requestWithAuth(null)), false);
});

test("Authorization header empty -> false", () => {
  assert.equal(isCronAuthorized(requestWithAuth("")), false);
});

/* -------------------------------------------------------------------------- */
/* 5-6. Scheme                                                                */
/* -------------------------------------------------------------------------- */

test("only the word 'Bearer' with no token -> false", () => {
  assert.equal(isCronAuthorized(requestWithAuth("Bearer")), false);
});

test("Basic scheme instead of Bearer -> false", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`Basic ${SECRET}`)), false);
});

/* -------------------------------------------------------------------------- */
/* 7-9. Token correctness                                                     */
/* -------------------------------------------------------------------------- */

test("wrong token -> false", () => {
  assert.equal(isCronAuthorized(requestWithAuth("Bearer wrong-token-value")), false);
});

test("token of a different length than the real secret -> false (exercises the length-check-before-timingSafeEqual path)", () => {
  assert.equal(isCronAuthorized(requestWithAuth("Bearer short")), false);
});

test("correct token -> true", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`Bearer ${SECRET}`)), true);
});

/* -------------------------------------------------------------------------- */
/* 10. Case sensitivity of the scheme                                        */
/* -------------------------------------------------------------------------- */

test("Bearer scheme is accepted case-insensitively ('bearer', 'BEARER', 'BeArEr')", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`bearer ${SECRET}`)), true);
  assert.equal(isCronAuthorized(requestWithAuth(`BEARER ${SECRET}`)), true);
  assert.equal(isCronAuthorized(requestWithAuth(`BeArEr ${SECRET}`)), true);
});

/* -------------------------------------------------------------------------- */
/* 11-12. Malformed spacing                                                   */
/* -------------------------------------------------------------------------- */

test("extra parts after the token are rejected, not silently truncated to just the token", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`Bearer ${SECRET} extra`)), false);
});

test("ambiguous internal whitespace (double space between scheme and token) is rejected, not normalized", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`Bearer  ${SECRET}`)), false);
});

test("outer leading/trailing whitespace around the whole header is tolerated (trimmed)", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`  Bearer ${SECRET}  `)), true);
});

test("a tab instead of a space between scheme and token is rejected", () => {
  assert.equal(isCronAuthorized(requestWithAuth(`Bearer\t${SECRET}`)), false);
});

/* -------------------------------------------------------------------------- */
/* 13. Secret is never returned from the helper                              */
/* -------------------------------------------------------------------------- */

test("the helper's return value never contains or reveals the secret (it's a plain boolean)", () => {
  const result = isCronAuthorized(requestWithAuth(`Bearer ${SECRET}`));
  assert.equal(typeof result, "boolean");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

/* -------------------------------------------------------------------------- */
/* 14. Never throws on malformed input                                        */
/* -------------------------------------------------------------------------- */

test("helper never throws for any malformed Authorization value", () => {
  // Every value here is a real, constructible HTTP header value (header
  // values are restricted to ByteString/Latin-1 by the Fetch spec itself —
  // NextRequest's own Headers implementation rejects anything outside that
  // range before isCronAuthorized ever sees it, so a non-ASCII value isn't
  // a realistic malformed-input case to test here).
  const malformedHeaders = [null, "", "Bearer", "Bearer ", "Bearer  ", " ", "\t", "Bearer\t", `Bearer ${SECRET} extra parts here`];
  for (const header of malformedHeaders) {
    assert.doesNotThrow(() => isCronAuthorized(requestWithAuth(header)));
  }
});

test("helper does not throw when CRON_SECRET is missing entirely, regardless of header", () => {
  delete process.env.CRON_SECRET;
  assert.doesNotThrow(() => isCronAuthorized(requestWithAuth(`Bearer ${SECRET}`)));
  assert.doesNotThrow(() => isCronAuthorized(requestWithAuth(null)));
});
