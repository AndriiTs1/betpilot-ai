import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOperatorSessionCookie, buildOperatorSessionClearCookie } from "./operatorSessionCookie";

// NODE_ENV is a plain mutable env var at runtime in this bare Node test
// process (not a bundler-inlined constant) — safe to flip around each
// assertion, restored immediately after. Next.js's bundled @types/node
// augmentation marks ProcessEnv.NODE_ENV readonly (correct for app code,
// where it really shouldn't be reassigned), so the mutation below goes
// through a locally-typed mutable view rather than widening that type
// project-wide.
type MutableEnv = { NODE_ENV: string | undefined };

function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const env = process.env as unknown as MutableEnv;
  const original = env.NODE_ENV;
  env.NODE_ENV = value;
  try {
    return fn();
  } finally {
    env.NODE_ENV = original;
  }
}

test("cookie: HttpOnly is always enabled", () => {
  const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + 1000));
  assert.equal(cookie.httpOnly, true);
});

test("cookie: SameSite is Lax", () => {
  const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + 1000));
  assert.equal(cookie.sameSite, "lax");
});

test("cookie: Secure is enabled in production", () => {
  withNodeEnv("production", () => {
    const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + 1000));
    assert.equal(cookie.secure, true);
  });
});

test("cookie: Secure is disabled in local development", () => {
  withNodeEnv("development", () => {
    const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + 1000));
    assert.equal(cookie.secure, false);
  });
});

test("cookie: Max-Age aligns with the given session expiry", () => {
  const ttlSeconds = 3600;
  const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + ttlSeconds * 1000));
  // Allow a small tolerance for the time elapsed between constructing
  // expiresAt above and buildOperatorSessionCookie's own Date.now() call.
  assert.ok(Math.abs(cookie.maxAge - ttlSeconds) <= 2, `maxAge ${cookie.maxAge} should be ~${ttlSeconds}`);
});

test("cookie: name and path match the documented policy", () => {
  const cookie = buildOperatorSessionCookie("token", new Date(Date.now() + 1000));
  assert.equal(cookie.name, "betpilot_operator_session");
  assert.equal(cookie.path, "/");
});

test("cookie: clear-cookie helper zeroes the value and Max-Age", () => {
  const cookie = buildOperatorSessionClearCookie();
  assert.equal(cookie.value, "");
  assert.equal(cookie.maxAge, 0);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
});
