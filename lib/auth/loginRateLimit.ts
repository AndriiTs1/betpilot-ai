// In-memory login rate limiter — a deliberate, documented minimal defense,
// not a production-grade solution. Two real limitations, spelled out here
// rather than left implicit:
//
// 1. Per-instance only: Vercel serverless functions don't share memory
//    across concurrent invocations or regions, so the Map backing a given
//    limiter is not a global counter across a real multi-instance
//    deployment — an attacker whose requests land on enough different warm
//    instances could exceed the intended limit. Acceptable for this stage
//    (a small, low-traffic internal operator login), not acceptable to
//    silently assume works like a "real" distributed rate limiter.
// 2. Resets on cold start / redeploy: a fresh function instance starts with
//    an empty Map, so any accumulated failure count is lost.
//
// A durable store (Vercel KV/Upstash, or a database table) would remove
// both limitations. Deliberately not introduced in this stage — see
// docs/OPERATOR_AUTH_IMPLEMENTATION.md.

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

interface RateLimitBucket {
  failures: number;
  windowStart: number;
}

export interface LoginRateLimiter {
  isRateLimited(key: string): boolean;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
}

interface LoginRateLimiterOptions {
  windowMs?: number;
  maxFailures?: number;
}

// Factory, not a bare module-level Map — so tests get their own isolated
// limiter instance (no shared state to leak between test cases) while the
// real route uses the one shared instance exported below, whose state
// needs to persist across requests within the same warm serverless
// instance.
export function createLoginRateLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
}: LoginRateLimiterOptions = {}): LoginRateLimiter {
  const buckets = new Map<string, RateLimitBucket>();

  function getActiveBucket(key: string): RateLimitBucket | null {
    const bucket = buckets.get(key);
    if (!bucket) return null;

    if (Date.now() - bucket.windowStart > windowMs) {
      buckets.delete(key);
      return null;
    }

    return bucket;
  }

  return {
    isRateLimited(key) {
      const bucket = getActiveBucket(key);
      return bucket !== null && bucket.failures >= maxFailures;
    },
    recordFailure(key) {
      const bucket = getActiveBucket(key);
      if (!bucket) {
        buckets.set(key, { failures: 1, windowStart: Date.now() });
        return;
      }
      bucket.failures += 1;
    },
    recordSuccess(key) {
      // A successful login clears the bucket outright (not just decrements
      // it) — the failed-attempt count that mattered belonged to whoever
      // was locked out of *this* key; a real successful login means
      // whatever attempts preceded it are no longer relevant.
      buckets.delete(key);
    },
  };
}

export const operatorLoginRateLimiter = createLoginRateLimiter();
