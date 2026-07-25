import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimitedResponse } from "./rateLimitResponse";

test("rateLimitedResponse: returns HTTP 429", () => {
  const response = rateLimitedResponse(7);
  assert.equal(response.status, 429);
});

test("rateLimitedResponse: Retry-After header and JSON retryAfterSeconds match", async () => {
  const response = rateLimitedResponse(12);
  assert.equal(response.headers.get("Retry-After"), "12");

  const body = (await response.json()) as { error: string; retryAfterSeconds: number };
  assert.equal(body.retryAfterSeconds, 12);
  assert.equal(response.headers.get("Retry-After"), String(body.retryAfterSeconds));
});

test("rateLimitedResponse: JSON body carries the stable RATE_LIMITED error code", async () => {
  const response = rateLimitedResponse(1);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "RATE_LIMITED");
});

test("rateLimitedResponse: does not expose any field beyond error and retryAfterSeconds", async () => {
  const response = rateLimitedResponse(3);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["error", "retryAfterSeconds"]);
});
