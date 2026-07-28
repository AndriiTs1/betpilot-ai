import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Stage 3.5B1 — same timing-safe-comparison mechanism as
// lib/auth/operatorAuth.ts's isOperatorAuthorized() and
// lib/auth/telegramWebhookAuth.ts's isTelegramWebhookAuthorized(), against
// a NEW, separate CRON_SECRET — never OPERATOR_SECRET, never
// TELEGRAM_WEBHOOK_SECRET, never BET_PREVIEW_TOKEN_SECRET. Different
// caller, different trust boundary; reusing a secret across boundaries
// means a leak of one compromises the other.

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

// Deliberately stricter than isOperatorAuthorized()'s own
// `header.split(" ")` (which silently ignores anything past the second
// token via array destructuring — "Bearer abc extra" would extract "abc"
// and never notice "extra"). Only the single canonical form
// "Bearer <token>" is accepted here: exactly one space, non-empty token,
// nothing else. The header's own leading/trailing whitespace is trimmed
// first (not semantically meaningful on an HTTP header value); everything
// between scheme and token is exact — any other internal spacing (double
// space, tab, etc.) produces a part count other than 2 and is rejected,
// not normalized/guessed.
function parseBearerToken(header: string): string | null {
  const parts = header.trim().split(" ");
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== "bearer") return null;
  if (token.length === 0) return null;

  return token;
}

// Returns only a boolean — matches both existing auth helpers' contract
// exactly (no typed reason, no thrown error for any malformed input).
// Missing/empty CRON_SECRET is treated as "not authorized" (a
// configuration error, never as "no secret required").
export function isCronAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  const token = parseBearerToken(header);
  if (!token) return false;

  return safeCompare(token, expected);
}
