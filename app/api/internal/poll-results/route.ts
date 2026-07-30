import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { isCronAuthorized } from "@/lib/auth/cronAuth";
import { pollConfirmedBetResults, type PollingReport } from "@/lib/bets/settlement/pollConfirmedBetResults";
import { escalateExpiredPolling, type EscalateExpiredPollingReport } from "@/lib/bets/settlement/escalateExpiredPolling";

// Stage 3.5B1 — the thin, protected trigger for one polling cycle. Same
// "authorize -> validate -> call exactly one existing service -> map its
// result/errors to an HTTP response" shape every other route in this
// codebase already uses (app/api/bets/[id]/settle/route.ts is the closest
// precedent) — this file contains no business logic, no financial
// operation, and no provider/database access of its own. Not wired to any
// scheduler yet (Stage 3.5B2) — calling this route today requires manually
// supplying the CRON_SECRET Bearer token.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// maxDuration deliberately NOT set — the correct value depends on this
// project's actual Vercel plan/function-duration limits, which are not yet
// confirmed (see the Stage 3.5B audit). Picking an arbitrary number now
// would be a guess, not a decision.

// Fixed, production-safe values for this stage's first manual smoke test —
// deliberately far below pollConfirmedBetResults()'s own defaults
// (limit: 200, concurrency: 5). Not sourced from an env var or query
// param: nothing about this cycle's scope is caller-controlled.
const POLL_OPTIONS = { limit: 25, concurrency: 2 } as const;

// Stage 4.3.4 — the route's own merged response shape: active-polling's
// PollingReport plus the expiry sweep's three outcome counters, additive
// only. Deliberately NOT folded into PollingReport itself
// (pollConfirmedBetResults.ts's own return type) — that function never
// calls escalateExpiredPolling() and has no way to honestly produce these
// three counters on its own; merging happens here, at the one orchestration
// point that actually calls both.
interface CombinedPollingReport extends PollingReport {
  readonly expiredPollingEscalations: number;
  readonly structuralReviewEscalations: number;
  readonly legacySkipped: number;
}

interface SuccessBody {
  readonly success: true;
  readonly report: CombinedPollingReport;
}

interface ErrorBody {
  readonly success: false;
  readonly error: { readonly code: "UNAUTHORIZED" | "INTERNAL_ERROR"; readonly message: string };
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function jsonResponse<T>(body: T, status: number): NextResponse<T> {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function unauthorizedResponse(): NextResponse<ErrorBody> {
  return jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
}

function internalErrorResponse(): NextResponse<ErrorBody> {
  return jsonResponse({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
}

export interface HandlePollResultsOptions {
  poll?: typeof pollConfirmedBetResults;
  escalate?: typeof escalateExpiredPolling;
}

export async function handlePollResults(
  request: NextRequest,
  options: HandlePollResultsOptions = {},
): Promise<NextResponse<SuccessBody | ErrorBody>> {
  // Checked before the auth comparison itself: a misconfigured deployment
  // (secret never set) is not the caller's fault and must not be
  // distinguishable from "wrong secret" in the response — both surface as
  // the same generic response to an unauthenticated caller (never confirm
  // "the endpoint exists but is misconfigured"). Only the server-side log
  // line differs.
  if (!process.env.CRON_SECRET) {
    console.error("GET /api/internal/poll-results: CRON_SECRET is not configured");
    return internalErrorResponse();
  }

  if (!isCronAuthorized(request)) {
    return unauthorizedResponse();
  }

  const poll = options.poll ?? pollConfirmedBetResults;
  const escalate = options.escalate ?? escalateExpiredPolling;

  try {
    // Stage 4.3.4 — one shared `now` for this entire cycle, passed
    // explicitly to both steps (neither is left to compute its own) so
    // active polling's "in window" and the sweep's "expired" are always
    // exact, non-overlapping complements for the same instant — never a
    // bet momentarily eligible for (or missed by) both, or neither.
    // Sequential, not Promise.all: active polling runs to completion
    // first, the expiry/structural sweep second — the order this stage's
    // own design explicitly calls for.
    const now = new Date();
    const pollReport: PollingReport = await poll(prisma, { ...POLL_OPTIONS, now });
    const sweepReport: EscalateExpiredPollingReport = await escalate(prisma, { now });

    const report: CombinedPollingReport = {
      ...pollReport,
      expiredPollingEscalations: sweepReport.escalatedSingles + sweepReport.escalatedExpresses,
      structuralReviewEscalations: sweepReport.structurallyInvalid,
      legacySkipped: sweepReport.skippedLegacy,
    };
    return jsonResponse({ success: true, report }, 200);
  } catch {
    // Deliberately a single static string, never the caught error itself
    // (not even err.message) — an unexpected failure this deep in the
    // pipeline (provider adapter, Prisma, or anything else
    // pollConfirmedBetResults() calls) could carry a raw request URL,
    // provider response fragment, database detail, stack trace, or an API
    // key/secret embedded by a downstream library's own error message.
    // None of that is safe to assume absent just because this route
    // itself never constructs such a message — so the caught value is
    // discarded entirely rather than logged in any form.
    console.error("Internal polling route failed");
    return internalErrorResponse();
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handlePollResults(request);
}
