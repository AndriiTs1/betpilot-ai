import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) return false;

  return timingSafeEqual(bufA, bufB);
}

export function isOperatorAuthorized(request: NextRequest): boolean {
  const expected = process.env.OPERATOR_SECRET;
  if (!expected) return false;

  const header = request.headers.get("authorization");
  if (!header) return false;

  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") return false;

  return safeCompare(token, expected);
}

// Sector 0 (ADR-0002) — cross-operator IDOR fix. Set exclusively by
// lib/dashboard/operatorApiProxy.ts's proxyToOperatorApi(), itself only
// reachable after requireOperatorApi() has already validated a real,
// session-authenticated operator (see lib/auth/requireOperator.ts). The
// proxy constructs its outgoing fetch() headers from scratch — it never
// copies headers from the original incoming client request — so a caller
// cannot forge this value by setting it on their own request to
// /api/dashboard/*. Absent when a route is reached any other way (e.g. a
// hypothetical direct OPERATOR_SECRET bearer call, the only other caller
// per OPERATOR_AUTH_AUDIT.md) — in that case scoping is skipped, preserving
// this route's prior unscoped behavior for that path unchanged.
export const INTERNAL_OPERATOR_SCOPE_HEADER = "x-internal-operator-id";

export function getScopedOperatorId(request: NextRequest): string | null {
  return request.headers.get(INTERNAL_OPERATOR_SCOPE_HEADER);
}
