import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter } from "./loginRateLimit";

test("rate limit: allows attempts under the failure threshold", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000 });
  const key = "ip1|+41000000000";

  for (let i = 0; i < 4; i += 1) {
    assert.equal(limiter.isRateLimited(key), false);
    limiter.recordFailure(key);
  }

  assert.equal(limiter.isRateLimited(key), false);
});

test("rate limit: blocks once the failure threshold is reached", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000 });
  const key = "ip1|+41000000000";

  for (let i = 0; i < 5; i += 1) {
    limiter.recordFailure(key);
  }

  assert.equal(limiter.isRateLimited(key), true);
});

test("rate limit: a successful login clears the failure count for that key", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000 });
  const key = "ip1|+41000000000";

  for (let i = 0; i < 5; i += 1) {
    limiter.recordFailure(key);
  }
  assert.equal(limiter.isRateLimited(key), true);

  limiter.recordSuccess(key);
  assert.equal(limiter.isRateLimited(key), false);
});

test("rate limit: different keys are tracked independently", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5, windowMs: 60_000 });
  const keyA = "ip1|+41000000000";
  const keyB = "ip2|+41000000001";

  for (let i = 0; i < 5; i += 1) {
    limiter.recordFailure(keyA);
  }

  assert.equal(limiter.isRateLimited(keyA), true);
  assert.equal(limiter.isRateLimited(keyB), false);
});

test("rate limit: an expired window resets the failure count", () => {
  const limiter = createLoginRateLimiter({ maxFailures: 2, windowMs: 10 });
  const key = "ip1|+41000000000";

  limiter.recordFailure(key);
  limiter.recordFailure(key);
  assert.equal(limiter.isRateLimited(key), true);

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.isRateLimited(key), false);
      resolve();
    }, 20);
  });
});
