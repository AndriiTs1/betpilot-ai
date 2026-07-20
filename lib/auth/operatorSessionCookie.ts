// Single authoritative cookie configuration for the operator session.
// Every route that sets or clears this cookie (Stage 5.0C onward) must go
// through the two builders below — never construct cookie options inline,
// so the flags can never drift between routes.

import { OPERATOR_SESSION_COOKIE_NAME, getOperatorSessionTtlMs } from "./operatorSession";

export { OPERATOR_SESSION_COOKIE_NAME };

export interface OperatorSessionCookie {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number; // seconds
}

// Secure is unconditional outside local development: every deployed
// environment (Vercel preview and production alike) is served over HTTPS,
// and both `next build`/`next start` and Vercel's own build always set
// NODE_ENV=production — this matches the audit's stated policy exactly
// (OPERATOR_AUTH_AUDIT.md §6).
function isSecureCookieEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

export function buildOperatorSessionCookie(token: string, expiresAt: Date): OperatorSessionCookie {
  const maxAgeSeconds = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));

  return {
    name: OPERATOR_SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: isSecureCookieEnvironment(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// Deletion helper — same flags as the real cookie (a clear-cookie response
// with mismatched flags can fail to actually delete it in some browsers),
// empty value, immediate expiry.
export function buildOperatorSessionClearCookie(): OperatorSessionCookie {
  return {
    name: OPERATOR_SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: isSecureCookieEnvironment(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  };
}

// Exposed for tests/callers that want to display or validate the
// configured TTL without duplicating the env-parsing logic.
export { getOperatorSessionTtlMs };
