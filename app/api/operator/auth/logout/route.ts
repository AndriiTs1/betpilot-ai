import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE_NAME, revokeOperatorSession } from "@/lib/auth/operatorSession";
import { buildOperatorSessionClearCookie } from "@/lib/auth/operatorSessionCookie";

// Idempotent by design: revokeOperatorSession() already no-ops safely for a
// missing/expired/revoked/malformed token (see operatorSession.ts), so this
// route never needs to branch on "was there actually a session" — it always
// does the same two things (best-effort revoke, then clear the cookie) and
// always returns { ok: true }.
export async function POST(request: NextRequest) {
  const token = request.cookies.get(OPERATOR_SESSION_COOKIE_NAME)?.value;

  if (token) {
    await revokeOperatorSession(token);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(buildOperatorSessionClearCookie());
  return response;
}
