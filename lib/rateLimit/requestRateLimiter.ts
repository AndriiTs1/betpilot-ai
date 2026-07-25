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

const DEFAULT_MAX_TRACKED_KEYS = 1000;

export interface RequestRateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  // Injected so tests can control time deterministically — never a real
  // wait, matching lib/telegram/oddsCommand.ts's options.now convention.
  // Defaults to the real wall clock in production.
  now?: () => number;
  // Bounds the Map's size so an unbounded stream of distinct keys (e.g. one
  // per attacker-controlled identity) can't grow memory forever. Mirrors
  // oddsCommand.ts's MAX_TRACKED_COOLDOWN_USERS sweep-on-overflow pattern.
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
  const buckets = new Map<string, Bucket>();

  // Sweeps only already-expired buckets — never touches a live window.
  // Runs only when the map has grown past maxTrackedKeys, exactly like
  // oddsCommand.ts's isOnCooldown sweep, so the common case (a small,
  // steady set of active keys) never pays this cost.
  function sweepExpired(currentTime: number): void {
    if (buckets.size <= maxTrackedKeys) return;
    for (const [key, bucket] of buckets) {
      if (currentTime >= bucket.resetAt) {
        buckets.delete(key);
      }
    }
  }

  return {
    checkAndRecord(key: string): RateLimitDecision {
      const currentTime = now();
      sweepExpired(currentTime);

      const existing = buckets.get(key);

      if (!existing || currentTime >= existing.resetAt) {
        buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
        return { allowed: true };
      }

      if (existing.count < maxRequests) {
        existing.count += 1;
        return { allowed: true };
      }

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000));
      return { allowed: false, retryAfterSeconds };
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
