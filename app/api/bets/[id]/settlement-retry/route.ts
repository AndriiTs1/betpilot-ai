import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";
import { retryBetSettlement, type ManualRetryBetSnapshot, type ManualRetryOutcome } from "@/lib/bets/settlement/manualRetrySettlement";

// Stage 4.3.6 — the operator-only HTTP layer over retryBetSettlement().
// Same "authorize -> validate -> call exactly one existing service -> map
// its result/errors to an HTTP response" shape as
// app/api/bets/[id]/settle/route.ts (the closest precedent) — this file
// contains no settlement logic of its own, no financial operation, no
// provider call. `{success, error}` envelope matches that same file's own
// convention (the mutating-action family — settle/confirm/reject/
// poll-results — not GET-list routes like needs-review's `{bets, ...}`).

export interface HandleSettlementRetryOptions {
  db?: PrismaClient;
  retry?: typeof retryBetSettlement;
}

interface ErrorBody {
  readonly success: false;
  readonly error: { readonly code: string; readonly message: string; readonly betId?: string };
}

interface SuccessBody {
  readonly success: true;
  readonly result: {
    readonly status: string;
    readonly bet: Record<string, unknown>;
    readonly settlement?: { readonly outcome: string; readonly idempotent: boolean };
  };
}

function errorResponse(status: number, body: ErrorBody["error"]): NextResponse<ErrorBody> {
  return NextResponse.json({ success: false, error: body }, { status });
}

// Rejection reason -> HTTP status, per Stage 4.3.6's own explicit
// contract: 404 for a bet that doesn't exist, 409 for a state that has
// already moved on (nothing about a retry can fix "the bet isn't CONFIRMED
// any more" or "isn't NEEDS_REVIEW"), 400 for a request that could never
// succeed regardless of timing (structural/type problems).
function rejectionStatus(reason: string): number {
  if (reason === "NOT_FOUND") return 404;
  if (reason === "NOT_CONFIRMED" || reason === "NOT_NEEDS_REVIEW") return 409;
  return 400; // UNSUPPORTED_BET_TYPE | STRUCTURALLY_INVALID
}

function serializeBetSnapshot(bet: ManualRetryBetSnapshot) {
  return {
    id: bet.id,
    status: bet.status,
    settlementReviewStatus: bet.settlementReviewStatus,
    settlementReviewReason: bet.settlementReviewReason,
    settlementRetryCount: bet.settlementRetryCount,
    lastSettlementAttemptAt: bet.lastSettlementAttemptAt ? bet.lastSettlementAttemptAt.toISOString() : null,
    lastSettlementErrorCode: bet.lastSettlementErrorCode,
    lastSettlementErrorMessage: bet.lastSettlementErrorMessage,
  };
}

export async function handleSettlementRetry(
  request: NextRequest,
  betId: string,
  options: HandleSettlementRetryOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return errorResponse(401, { code: "UNAUTHORIZED", message: "Unauthorized" });
  }

  if (!betId) {
    return errorResponse(400, { code: "INVALID_REQUEST", message: "Missing bet id" });
  }

  const db = options.db ?? prisma;
  const retry = options.retry ?? retryBetSettlement;

  try {
    const outcome: ManualRetryOutcome = await retry(db, { betId, now: new Date() });

    if (outcome.kind === "REJECTED") {
      return errorResponse(rejectionStatus(outcome.reason), { code: outcome.reason, message: outcome.message, betId });
    }

    // outcome.kind === "OK" — every non-rejected outcome is reported as a
    // 200 success, status field carries which of SETTLED/WAITING/
    // TRANSIENT_FAILURE/PERMANENT_REVIEW/CONFLICT/PROVIDER_UNAVAILABLE
    // actually happened. PROVIDER_UNAVAILABLE is intentionally still 200
    // here (not 503) — from the caller's perspective the retry request
    // itself was handled correctly; the *outcome* just wasn't a settlement.
    // Never a raw provider payload, stack trace, or internal DB detail —
    // outcome.bet is already the curated, safe snapshot
    // retryBetSettlement() itself constructs.
    const body: SuccessBody = {
      success: true,
      result: {
        status: outcome.status,
        bet: serializeBetSnapshot(outcome.bet),
        ...(outcome.settlement ? { settlement: outcome.settlement } : {}),
      },
    };
    return NextResponse.json(body, { status: 200 });
  } catch {
    // Same discipline as poll-results/route.ts's own catch: never the
    // caught error itself, not even err.message — an unexpected failure
    // this deep (provider adapter, Prisma, or anything else
    // retryBetSettlement() calls) could carry a raw request URL, provider
    // response fragment, database detail, or a secret embedded by a
    // downstream library's own error message.
    console.error(`POST /api/bets/${betId}/settlement-retry failed`);
    return errorResponse(500, { code: "INTERNAL_ERROR", message: "Internal server error", betId });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  return handleSettlementRetry(request, id);
}
