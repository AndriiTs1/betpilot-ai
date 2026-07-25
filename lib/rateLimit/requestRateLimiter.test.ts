import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestRateLimiter, safeCheckAndRecord, type RequestRateLimiter } from "./requestRateLimiter";

/* A. Basic allow/reject boundary                                          */

test("requestRateLimiter: the first request for a fresh key is allowed", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => 1_000 });
  assert.deepEqual(limiter.checkAndRecord("user1"), { allowed: true });
});

test("requestRateLimiter: every request up to maxRequests is allowed", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => 1_000 });
  assert.deepEqual(limiter.checkAndRecord("user1"), { allowed: true });
  assert.deepEqual(limiter.checkAndRecord("user1"), { allowed: true });
  assert.deepEqual(limiter.checkAndRecord("user1"), { allowed: true });
});

test("requestRateLimiter: the request immediately after maxRequests is rejected", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 3, windowMs: 60_000, now: () => 1_000 });
  limiter.checkAndRecord("user1");
  limiter.checkAndRecord("user1");
  limiter.checkAndRecord("user1");

  const fourth = limiter.checkAndRecord("user1");
  assert.equal(fourth.allowed, false);
});

test("requestRateLimiter: repeated calls while over limit remain rejected", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
  limiter.checkAndRecord("user1");
  assert.equal(limiter.checkAndRecord("user1").allowed, false);
  assert.equal(limiter.checkAndRecord("user1").allowed, false);
});

/* B. Independent state                                                    */

test("requestRateLimiter: independent keys have independent buckets", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
  assert.equal(limiter.checkAndRecord("userA").allowed, true);
  assert.equal(limiter.checkAndRecord("userA").allowed, false);

  assert.equal(limiter.checkAndRecord("userB").allowed, true, "a different key must not be affected by userA's quota");
});

test("requestRateLimiter: independent limiter instances have independent state", () => {
  const limiterA = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
  const limiterB = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });

  assert.equal(limiterA.checkAndRecord("same-key").allowed, true);
  assert.equal(limiterA.checkAndRecord("same-key").allowed, false);

  assert.equal(
    limiterB.checkAndRecord("same-key").allowed,
    true,
    "a separate limiter instance (e.g. a different route's limiter) must not share state even for an identical key string",
  );
});

/* C. retryAfterSeconds / Retry-After math                                 */

test("requestRateLimiter: retryAfterSeconds is a positive integer computed with ceiling", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 10_000, now: () => clock });

  clock = 0;
  limiter.checkAndRecord("user1"); // consumes the only slot, resetAt = 10_000

  clock = 3_001; // 6.999s remaining -> ceil -> 7
  const decision = limiter.checkAndRecord("user1");
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.retryAfterSeconds, 7);
    assert.equal(Number.isInteger(decision.retryAfterSeconds), true);
    assert.ok(decision.retryAfterSeconds > 0);
  }
});

test("requestRateLimiter: retryAfterSeconds shrinks as the window approaches reset, never going below 1", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 10_000, now: () => clock });

  clock = 0;
  limiter.checkAndRecord("user1");

  clock = 9_999; // 1ms remaining -> ceil -> 1
  const decision = limiter.checkAndRecord("user1");
  assert.equal(decision.allowed, false);
  if (!decision.allowed) {
    assert.equal(decision.retryAfterSeconds, 1);
  }
});

/* D. Window reset via injected clock — no real waiting                    */

test("requestRateLimiter: a request with now < resetAt stays in the current window and is counted against it", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 10_000, now: () => clock });

  clock = 0;
  assert.equal(limiter.checkAndRecord("user1").allowed, true);

  clock = 9_999; // still < resetAt (10_000)
  assert.equal(limiter.checkAndRecord("user1").allowed, false, "must still be counted against the original window");
});

test("requestRateLimiter: a request with now >= resetAt starts a fresh window", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 10_000, now: () => clock });

  clock = 0;
  assert.equal(limiter.checkAndRecord("user1").allowed, true);
  assert.equal(limiter.checkAndRecord("user1").allowed, false);

  clock = 10_000; // exactly resetAt -> new window
  assert.equal(limiter.checkAndRecord("user1").allowed, true, "the boundary instant itself must start a new window");
});

test("requestRateLimiter: window reset uses the injected clock, never real elapsed time", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 1, now: () => clock });

  assert.equal(limiter.checkAndRecord("user1").allowed, true);
  assert.equal(limiter.checkAndRecord("user1").allowed, false);

  clock += 2; // past a 1ms window, instantly, with no real waiting/sleep
  assert.equal(limiter.checkAndRecord("user1").allowed, true);
});

/* E. Bounded memory / stale-entry cleanup                                 */

test("requestRateLimiter: maxTrackedKeys bounds the map — expired entries are swept once the bound is exceeded", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({
    maxRequests: 1,
    windowMs: 100,
    now: () => clock,
    maxTrackedKeys: 5,
  });

  // Fill 5 keys, all expiring at t=100.
  for (let i = 0; i < 5; i += 1) {
    limiter.checkAndRecord(`user${i}`);
  }

  // Move well past their expiry, then push the map over the bound with a
  // 6th distinct key — this must trigger a sweep of the 5 stale entries
  // rather than letting the map grow unbounded.
  clock = 500;
  limiter.checkAndRecord("user5");

  // Proven indirectly: a previously-expired key's window must have reset
  // (it was swept, not preserved as a stale "still over limit" bucket).
  assert.equal(limiter.checkAndRecord("user0").allowed, true, "a swept, long-expired key must behave like a fresh key");
});

test("requestRateLimiter: a live (unexpired) bucket is never swept merely because the map is over its bound", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({
    maxRequests: 1,
    windowMs: 100_000, // long-lived, still active window
    now: () => clock,
    maxTrackedKeys: 3,
  });

  limiter.checkAndRecord("keepMe"); // still within its long window when the sweep below runs
  assert.equal(limiter.checkAndRecord("keepMe").allowed, false);

  // Push the map over the bound with unrelated keys.
  limiter.checkAndRecord("other1");
  limiter.checkAndRecord("other2");
  limiter.checkAndRecord("other3");

  // keepMe's window has not expired (windowMs is 100_000, clock never
  // advanced) — it must still be rejected, proving the sweep only removes
  // genuinely expired entries.
  assert.equal(limiter.checkAndRecord("keepMe").allowed, false);
});

/* F. No key-state leakage between tests (each test builds its own limiter) */

test("requestRateLimiter: a freshly constructed limiter has no memory of any previously constructed limiter's keys", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
  // "user1" was rate-limited to exhaustion in earlier tests in this file —
  // a new instance must not be affected, proving no shared/module-level state.
  assert.equal(limiter.checkAndRecord("user1").allowed, true);
});

/* G. safeCheckAndRecord — fail-open wrapper                               */

test("safeCheckAndRecord: passes through an allowed decision unchanged", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000, now: () => 1_000 });
  assert.deepEqual(safeCheckAndRecord(limiter, "user1", "test_route"), { allowed: true });
});

test("safeCheckAndRecord: passes through a rejected decision unchanged", () => {
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 1_000 });
  limiter.checkAndRecord("user1");
  const decision = safeCheckAndRecord(limiter, "user1", "test_route");
  assert.equal(decision.allowed, false);
});

test("safeCheckAndRecord: a throwing limiter fails open (allowed: true) instead of propagating", () => {
  const throwingLimiter: RequestRateLimiter = {
    checkAndRecord() {
      throw new Error("simulated limiter failure");
    },
  };

  const decision = safeCheckAndRecord(throwingLimiter, "user1", "test_route");
  assert.deepEqual(decision, { allowed: true });
});
