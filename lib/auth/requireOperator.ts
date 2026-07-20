// Server-only: composes Stage 5.0B's session validation for the two
// contexts Next.js App Router protection needs — Route Handlers (API) and
// Server Components (pages). Single source of truth so no route or page
// re-implements cookie reading or session validation itself. See
// lib/auth/password.ts's note on why the `server-only` package wasn't
// added as a new dependency.

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  OPERATOR_SESSION_COOKIE_NAME,
  getOperatorSessionFromRequest,
  validateOperatorSession,
  type OperatorSessionStore,
} from "./operatorSession";

export interface AuthenticatedOperator {
  operatorId: string;
}

function unauthorizedApiResponse(): NextResponse {
  // Never echoes *why* — matches operatorSession.ts's own discipline: a
  // missing, malformed, expired, or revoked session must all look
  // identical to the caller. See OperatorSessionValidation's `reason`
  // field, which exists for internal use only and is never read here.
  return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
}

export type RequireOperatorApiResult =
  | { ok: true; operator: AuthenticatedOperator }
  | { ok: false; response: NextResponse };

// For Route Handlers under /api/dashboard/*. Callers do:
//   const auth = await requireOperatorApi(request);
//   if (!auth.ok) return auth.response;
export async function requireOperatorApi(
  request: NextRequest,
  store?: OperatorSessionStore,
): Promise<RequireOperatorApiResult> {
  const validation = await getOperatorSessionFromRequest(request, store);

  if (!validation.valid) {
    return { ok: false, response: unauthorizedApiResponse() };
  }

  return { ok: true, operator: { operatorId: validation.operatorId } };
}

// The redirect-vs-authenticated decision, split out from requireOperatorPage
// so it's unit-testable without next/headers' cookies(). next/navigation's
// redirect() throws a synchronous, digest-tagged Error regardless of
// whether it's called inside a real Next.js request — it doesn't depend on
// any request-scoped context to do that — so this function's behavior is
// safely testable in isolation; see lib/auth/requireOperator.test.ts.
export async function resolveOperatorPageAuth(
  token: string | null,
  store?: OperatorSessionStore,
): Promise<AuthenticatedOperator> {
  const validation = await validateOperatorSession(token, store);

  if (!validation.valid) {
    redirect("/operator/login");
  }

  return { operatorId: validation.operatorId };
}

// For Server Component pages (e.g. app/page.tsx). Redirects to
// /operator/login on an invalid session; returns the authenticated
// operator otherwise. Call this before rendering anything else.
export async function requireOperatorPage(): Promise<AuthenticatedOperator> {
  const cookieStore = await cookies();
  const token = cookieStore.get(OPERATOR_SESSION_COOKIE_NAME)?.value ?? null;
  return resolveOperatorPageAuth(token);
}
