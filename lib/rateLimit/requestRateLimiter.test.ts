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

/* E. Bounded memory / stale-entry cleanup (Step 13B baseline coverage —    */
/* still valid, and still passing, under Step 13D's hard-capacity policy)  */

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

/* E2. Step 13D — hard capacity boundary                                   */

test("requestRateLimiter (capacity): a third distinct key at capacity is allowed but not tracked — active buckets keep their state, not evicted", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => clock, maxTrackedKeys: 2 });

  // Fill both tracked slots.
  assert.equal(limiter.checkAndRecord("A").allowed, true);
  assert.equal(limiter.checkAndRecord("B").allowed, true);

  // A third, never-before-seen key arrives while capacity is full and
  // nothing has expired (frozen clock) — admitted (fail-open) but never
  // inserted into the tracked set.
  assert.equal(limiter.checkAndRecord("C").allowed, true, "an untracked key at capacity is admitted (best-effort fail-open)");
  // Proven, without any debug/size API: C succeeds again immediately —
  // if it had been tracked (maxRequests: 1), this second call would be
  // rejected. It isn't, because it was never stored.
  assert.equal(limiter.checkAndRecord("C").allowed, true, "C was never tracked, so it is never subject to its own quota");

  // A and B's own active buckets must be untouched by C's admission — both
  // still rejected, proving neither was evicted to make room for C.
  assert.equal(limiter.checkAndRecord("A").allowed, false, "A's tracked bucket must not have been evicted to admit C");
  assert.equal(limiter.checkAndRecord("B").allowed, false, "B's tracked bucket must not have been evicted to admit C");
});

test("requestRateLimiter (capacity): capacity becomes available once tracked entries genuinely expire", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 2, windowMs: 100, now: () => clock, maxTrackedKeys: 2 });

  assert.equal(limiter.checkAndRecord("A").allowed, true);
  assert.equal(limiter.checkAndRecord("B").allowed, true);

  // Still within the window — capacity remains full, C is admitted but
  // untracked.
  assert.equal(limiter.checkAndRecord("C").allowed, true);

  // Advance the injected clock past A/B's window (resetAt = 100).
  clock = 150;

  // C arrives again — this time the sweep (triggered by the capacity check)
  // finds A and B genuinely expired, frees both slots, and C becomes
  // tracked for real.
  assert.equal(limiter.checkAndRecord("C").allowed, true, "C's first call after expiry frees capacity and becomes tracked");
  assert.equal(limiter.checkAndRecord("C").allowed, true, "C's second call is still within its own maxRequests: 2");
  assert.equal(limiter.checkAndRecord("C").allowed, false, "C's third call exceeds its own configured limit now that it is tracked");
});

test("requestRateLimiter (capacity): buckets.size never exceeds maxTrackedKeys, proven behaviorally across many distinct overflow keys", () => {
  let clock = 0;
  const limiter = createRequestRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => clock, maxTrackedKeys: 3 });

  assert.equal(limiter.checkAndRecord("keep1").allowed, true);
  assert.equal(limiter.checkAndRecord("keep2").allowed, true);
  assert.equal(limiter.checkAndRecord("keep3").allowed, true);

  // A large burst of distinct, never-repeated keys, all while the clock is
  // frozen (nothing ever expires) — none of these can ever be tracked
  // (capacity stays full, sweep always finds nothing expired), so every one
  // of them must be allowed every time (fail-open, never subject to its own
  // quota since it's never stored).
  for (let i = 0; i < 5_000; i += 1) {
    const decision = limiter.checkAndRecord(`overflow-${i}`);
    assert.equal(decision.allowed, true, `overflow key ${i} must always be admitted while capacity is full and nothing has expired`);
  }

  // The three original tracked keys must retain exactly the quota state
  // they had before the overflow burst — still rejected (maxRequests: 1,
  // already consumed), proving none of the 5,000 overflow keys ever
  // evicted or reset them.
  assert.equal(limiter.checkAndRecord("keep1").allowed, false, "keep1's original bucket must have survived the overflow burst untouched");
  assert.equal(limiter.checkAndRecord("keep2").allowed, false, "keep2's original bucket must have survived the overflow burst untouched");
  assert.equal(limiter.checkAndRecord("keep3").allowed, false, "keep3's original bucket must have survived the overflow burst untouched");
});

/* E3. Step 13D — option validation                                        */

test("requestRateLimiter (validation): maxRequests: 0 throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 0, windowMs: 60_000 }), /maxRequests must be a positive integer/);
});

test("requestRateLimiter (validation): maxRequests < 0 throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: -5, windowMs: 60_000 }), /maxRequests must be a positive integer/);
});

test("requestRateLimiter (validation): non-integer maxRequests throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 1.5, windowMs: 60_000 }), /maxRequests must be a positive integer/);
});

test("requestRateLimiter (validation): windowMs: 0 throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 5, windowMs: 0 }), /windowMs must be a positive finite number/);
});

test("requestRateLimiter (validation): windowMs < 0 throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 5, windowMs: -100 }), /windowMs must be a positive finite number/);
});

test("requestRateLimiter (validation): windowMs: Infinity throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 5, windowMs: Infinity }), /windowMs must be a positive finite number/);
});

test("requestRateLimiter (validation): windowMs: NaN throws at construction", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: 5, windowMs: NaN }), /windowMs must be a positive finite number/);
});

test("requestRateLimiter (validation): maxTrackedKeys: 0 throws at construction", () => {
  assert.throws(
    () => createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000, maxTrackedKeys: 0 }),
    /maxTrackedKeys must be a positive integer/,
  );
});

test("requestRateLimiter (validation): maxTrackedKeys < 0 throws at construction", () => {
  assert.throws(
    () => createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000, maxTrackedKeys: -1 }),
    /maxTrackedKeys must be a positive integer/,
  );
});

test("requestRateLimiter (validation): non-integer maxTrackedKeys throws at construction", () => {
  assert.throws(
    () => createRequestRateLimiter({ maxRequests: 5, windowMs: 60_000, maxTrackedKeys: 2.5 }),
    /maxTrackedKeys must be a positive integer/,
  );
});

test("requestRateLimiter (validation): invalid options are not silently normalized — no limiter is returned", () => {
  assert.throws(() => createRequestRateLimiter({ maxRequests: -1, windowMs: -1, maxTrackedKeys: -1 }));
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
