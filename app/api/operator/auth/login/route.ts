import { NextRequest, NextResponse } from "next/server";
import { attemptOperatorLogin, parseOperatorLoginRequestBody } from "@/lib/auth/operatorLogin";
import { buildOperatorSessionCookie } from "@/lib/auth/operatorSessionCookie";
import { operatorLoginRateLimiter } from "@/lib/auth/loginRateLimit";

// Deliberately separate from the Telegram player-auth surface
// (app/api/miniapp/*) — no shared code, no shared cookie, no shared secret.
// See lib/auth/operatorSession.ts's own file-level note.
//
// Body validation follows this project's existing convention (manual type
// guards on the parsed JSON — see app/api/miniapp/bets/text/preview/
// route.ts), not zod: zod is used elsewhere for AI-output/token payload
// schemas, never for raw HTTP request bodies in this codebase.

const GENERIC_FAILURE = { ok: false as const, error: "INVALID_CREDENTIALS" as const };

// Same generic response and status for a rate-limited request as for a
// wrong password — the caller gets no signal distinguishing "you're
// throttled" from "wrong credentials." See
// docs/OPERATOR_AUTH_IMPLEMENTATION.md for the reasoning.
function genericFailureResponse() {
  return NextResponse.json(GENERIC_FAILURE, { status: 401 });
}

function getClientIp(request: NextRequest): string {
  // Vercel sets x-forwarded-for; local dev has no proxy in front, so this
  // falls back to a fixed placeholder rather than throwing or leaving the
  // rate-limit key undefined.
  const forwardedFor = request.headers.get("x-forwarded-for");
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function POST(request: NextRequest) {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
  }

  const parsed = parseOperatorLoginRequestBody(rawBody);
  if (!parsed) {
    return NextResponse.json({ ok: false, error: "INVALID_REQUEST" }, { status: 400 });
  }

  const { phone, password } = parsed;
  const rateLimitKey = `${getClientIp(request)}|${phone}`;

  if (operatorLoginRateLimiter.isRateLimited(rateLimitKey)) {
    return genericFailureResponse();
  }

  try {
    const result = await attemptOperatorLogin(phone, password);

    if (!result.ok) {
      operatorLoginRateLimiter.recordFailure(rateLimitKey);
      return genericFailureResponse();
    }

    operatorLoginRateLimiter.recordSuccess(rateLimitKey);

    const response = NextResponse.json({ ok: true });
    response.cookies.set(buildOperatorSessionCookie(result.token, result.expiresAt));
    return response;
  } catch (err) {
    // Never log phone/password here — only the fact that the attempt threw.
    console.error("POST /api/operator/auth/login failed:", err);
    return NextResponse.json({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
