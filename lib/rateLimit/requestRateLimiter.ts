// Step 13B — a neutral, domain-agnostic request-rate limiter. Deliberately
// not named or shaped after Telegram, the Mini App, or logins: it counts
// requests (not login failures — contrast lib/auth/loginRateLimit.ts, which
// is a fixed-window *failure* counter with a completely different public
// API and is neither reused nor modified here, per Step 13A Section 12's
// "new neutral limiter" decision) and exposes one atomic operation any
// caller can key however it likes.
//
// In-memory only. Process-local. Resets on cold start. Not shared across
// concurrent Vercel serverless instances or regions — this is a best-effort
// MVP protection against a single warm instance being hammered, never a
// globally enforced quota. See Step 13A Section 11 for the full analysis of
// why no distributed backend (Redis/Upstash/KV) is introduced in this step.
//
// Fixed-window algorithm: each key gets a window of `windowMs` starting at
// the first request seen for it; up to `maxRequests` requests inside that
// window are allowed, the next one is rejected until the window rolls over.
// A request at exactly the window boundary (now >= resetAt) starts a fresh
// window rather than being counted against the old one.
//
// Step 13D — maxTrackedKeys capacity policy (corrects a Step 13C MEDIUM
// finding: the original implementation swept expired entries only as a
// side effect of crossing the threshold, but always inserted the new key
// regardless of whether the sweep freed anything, so `buckets.size` could
// grow arbitrarily far past maxTrackedKeys under a sustained burst of
// distinct, still-live keys). The corrected policy, enforced only on the
// "unseen key" path (an already-tracked key's own check never triggers a
// sweep or a capacity check — its slot already exists):
//   1. buckets.size < maxTrackedKeys  -> track the new key normally.
//   2. buckets.size >= maxTrackedKeys -> sweep genuinely expired buckets
//      once; if that frees capacity, track the new key normally.
//   3. Still at capacity (every tracked bucket is still active) -> do NOT
//      evict any active bucket and do NOT track the new key. The current
//      request is allowed as a best-effort, intentionally fail-open
//      admission — an untracked key is simply not rate-limited until
//      capacity frees up, rather than either (a) silently discarding an
//      existing user's live quota state to make room, or (b) rejecting a
//      brand-new caller outright merely because unrelated users are
//      currently active. This is a deliberate MVP trade-off, consistent
//      with this limiter's overall best-effort, process-local, non-strict
//      nature (see the file header above) — buckets.size itself can never
//      exceed maxTrackedKeys under this policy.

const DEFAULT_MAX_TRACKED_KEYS = 1000;

export interface RequestRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  // Injected so tests can control time deterministically — never a real
  // wait, matching lib/telegram/oddsCommand.ts's options.now convention.
  // Defaults to the real wall clock in production.
  now?: () => number;
  // Hard cap on the number of simultaneously tracked buckets — see the
  // Step 13D capacity policy above. Mirrors oddsCommand.ts's
  // MAX_TRACKED_COOLDOWN_USERS sweep-on-overflow pattern in spirit, but
  // (unlike that simpler cooldown store) this limiter never lets
  // buckets.size exceed this value.
  maxTrackedKeys?: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RequestRateLimiter {
  checkAndRecord(key: string): RateLimitDecision;
}

interface Bucket {
  count: number;
  resetAt: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`createRequestRateLimiter: ${name} must be a positive integer, got ${value}`);
  }
}

// Factory, not a bare module-level Map — every call site (one per route
// category, per Step 13A Section 9's "do not share quota between route
// categories") gets its own fully independent instance and state, and tests
// get isolated instances with no risk of leaking state between cases.
export function createRequestRateLimiter({
  maxRequests,
  windowMs,
  now = () => Date.now(),
  maxTrackedKeys = DEFAULT_MAX_TRACKED_KEYS,
}: RequestRateLimiterOptions): RequestRateLimiter {
  // Step 13D — validated once, at construction time, not silently
  // normalized. A misconfigured caller (e.g. maxRequests: 0, intending "no
  // requests allowed") would otherwise get a confusing, unintended runtime
  // behavior instead of an immediate, actionable error.
  assertPositiveInteger(maxRequests, "maxRequests");
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error(`createRequestRateLimiter: windowMs must be a positive finite number, got ${windowMs}`);
  }
  assertPositiveInteger(maxTrackedKeys, "maxTrackedKeys");

  const buckets = new Map<string, Bucket>();

  // Sweeps only already-expired buckets — never touches a live window.
  // Invoked ONLY from the "unseen key at capacity" branch below, never on
  // every request and never for an already-tracked key's own check, so the
  // common case (a small, steady set of active keys, or any request from a
  // key already in `buckets`) never pays this cost.
  function sweepExpired(currentTime: number): void {
    for (const [key, bucket] of buckets) {
      if (currentTime >= bucket.resetAt) {
        buckets.delete(key);
      }
    }
  }

  function trackNewKey(key: string, currentTime: number): RateLimitDecision {
    buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
    return { allowed: true };
  }

  return {
    checkAndRecord(key: string): RateLimitDecision {
      const currentTime = now();
      const existing = buckets.get(key);

      if (existing) {
        if (currentTime >= existing.resetAt) {
          // Window rolled over for an already-tracked key — reuses its
          // existing Map slot, so buckets.size is unaffected; no capacity
          // check or sweep is ever needed on this path.
          return trackNewKey(key, currentTime);
        }

        if (existing.count < maxRequests) {
          existing.count += 1;
          return { allowed: true };
        }

        const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000));
        return { allowed: false, retryAfterSeconds };
      }

      // Unseen key, capacity available — track normally.
      if (buckets.size < maxTrackedKeys) {
        return trackNewKey(key, currentTime);
      }

      // Unseen key, at capacity — one deterministic sweep of genuinely
      // expired buckets, never an active one.
      sweepExpired(currentTime);

      if (buckets.size < maxTrackedKeys) {
        return trackNewKey(key, currentTime);
      }

      // Still at capacity with every tracked bucket active: do not evict,
      // do not track this key. Best-effort fail-open admission (Step 13D
      // approved capacity policy) — see the file-header note above.
      return { allowed: true };
    },
  };
}

// Shared fail-open wrapper — the limiter is optional protection layered on
// top of already-correct routes, never a source of truth those routes
// depend on for correctness (unlike, say, previewToken verification). If
// checkAndRecord ever throws (it isn't expected to; there's no I/O, no
// external backend in this in-memory implementation), the request proceeds
// as if it were allowed rather than turning an optional protection's bug
// into a full-route 500. One call site here instead of duplicating the same
// try/catch in all three route files.
export function safeCheckAndRecord(limiter: RequestRateLimiter, key: string, routeName: string): RateLimitDecision {
  try {
    return limiter.checkAndRecord(key);
  } catch (err) {
    console.error(`rate limiter threw for route "${routeName}" — failing open:`, err);
    return { allowed: true };
  }
}
