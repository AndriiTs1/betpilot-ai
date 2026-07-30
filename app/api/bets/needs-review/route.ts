import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { isOperatorAuthorized } from "@/lib/auth/operatorAuth";

// Stage 4.3.5 — Manual Review Dashboard Read View. Same three-layer shape
// as every other operator GET-list route in this codebase (GET
// /api/bets/pending, GET /api/bets/history): isOperatorAuthorized() ->
// exactly-one bounded Prisma query -> a plain `{ bets, pagination }` body
// (no `{ success, data }` envelope — this repo's real, already-standardized
// GET-list convention, confirmed by reading both of those routes; the
// `{success, error}` envelope belongs to the separate family of *mutating*
// action routes — settle/confirm/reject/poll-results — never GET-list
// ones). Read-only: this file never writes to Bet, never calls
// settleBet()/autoSettle*Bet(), never calls a provider.
//
// Exported as a DI-testable handleNeedsReview() + a thin GET wrapper —
// unlike pending/history (untested, no DI seam), this route's query has
// real, non-trivial behavior (pagination validation, sorting, WHERE shape,
// serialization) that genuinely warrants the same
// db-injection-for-testing convention app/api/internal/poll-results/route.ts
// and app/api/bets/[id]/settle/route.ts already establish in this exact
// codebase — not a new pattern, the existing one for "a GET/POST route
// worth unit-testing."

export interface HandleNeedsReviewOptions {
  db?: PrismaClient;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// Same formula mapBetForDisplay.ts's own potentialPayout already uses
// (stake x (totalOdds ?? odds)) — computed here at the Prisma.Decimal layer
// directly (this route has the raw Decimal, not the already-serialized
// string mapBetForDisplay operates on), never a second, independently
// invented calculation.
function computePotentialPayout(
  stake: Prisma.Decimal,
  odds: Prisma.Decimal | null,
  totalOdds: Prisma.Decimal | null,
): string | null {
  const effectiveOdds = totalOdds ?? odds;
  if (effectiveOdds === null) return null;
  return stake.times(effectiveOdds).toFixed(2);
}

export async function handleNeedsReview(
  request: NextRequest,
  options: HandleNeedsReviewOptions = {},
): Promise<NextResponse> {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const limit = parsePositiveInt(searchParams.get("limit"), DEFAULT_LIMIT);
  const offset = parsePositiveInt(searchParams.get("offset"), 0);

  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` }, { status: 400 });
  }
  if (offset === null || offset < 0) {
    return NextResponse.json({ error: "offset must be a non-negative integer" }, { status: 400 });
  }

  const db = options.db ?? prisma;

  try {
    // Exact eligibility filter (Stage 4.3.5's own explicit contract): a bet
    // that is NEEDS_REVIEW but whose status is no longer CONFIRMED (a rare
    // resolved-race case — see settleBet.ts's own CONFLICT handling, never
    // modified by this stage) is correctly excluded by the `status:
    // "CONFIRMED"` half of this AND alone, with no separate check needed —
    // Prisma's WHERE is already exactly this: both conditions on the same
    // row.
    const where = { status: "CONFIRMED", settlementReviewStatus: "NEEDS_REVIEW" } as const;

    const [bets, total] = await Promise.all([
      db.bet.findMany({
        where,
        select: {
          id: true,
          type: true,
          status: true,
          stake: true,
          odds: true,
          totalOdds: true,
          player: { select: { id: true, name: true } },
          providerName: true,
          providerEventId: true,
          providerSportKey: true,
          eventStartTime: true,
          settlementRetryCount: true,
          lastSettlementAttemptAt: true,
          lastSettlementErrorCode: true,
          lastSettlementErrorMessage: true,
          settlementReviewReason: true,
          createdAt: true,
          updatedAt: true,
          // Stage 4.3.5's own explicit EXPRESS field list, mapped onto the
          // real BetSelection columns (see this route's own report for the
          // exact field-name reconciliation): market ("market"), selection
          // ("outcome" — the player's actual pick text), participant/team
          // name ("event" — the fixture name, this app's established
          // "team/matchup" display field everywhere else, e.g.
          // SelectionRow.tsx; canonicalParticipant included too when
          // present, since it's the more structurally precise name when
          // set), outcome/status ("oddsStatus" — the only status-shaped
          // column BetSelection actually has; there is no per-leg
          // settlement-outcome column, never invented here). `sport`/`odds`
          // included beyond the literal requested list because they're
          // real, existing columns needed to render a leg consistently with
          // every other selection display in this app (SelectionRow.tsx).
          selections: {
            select: {
              id: true,
              sport: true,
              market: true,
              event: true,
              outcome: true,
              odds: true,
              canonicalParticipant: true,
              providerName: true,
              providerEventId: true,
              eventStartTime: true,
              oddsStatus: true,
            },
            orderBy: { createdAt: "asc" },
          },
        },
        // Oldest unresolved review first, id as a stable tie-breaker.
        // updatedAt (not a new column) is the reliable "when was this
        // flagged" signal: every escalation path in Stage 4.3.3/4.3.4
        // writes to this bet via db.bet.update()/updateMany(), and
        // Bet.updatedAt is @updatedAt (Prisma auto-sets it on every write)
        // — always populated, unlike lastSettlementAttemptAt, which the
        // expiry/structural sweep deliberately leaves untouched (see
        // escalateExpiredPolling.ts) and so can be null even for an
        // escalated bet.
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit,
      }),
      db.bet.count({ where }),
    ]);

    const serialized = bets.map((bet) => ({
      id: bet.id,
      type: bet.type,
      status: bet.status,
      player: bet.player,
      stake: bet.stake.toString(),
      odds: bet.odds ? bet.odds.toString() : null,
      totalOdds: bet.totalOdds ? bet.totalOdds.toString() : null,
      potentialPayout: computePotentialPayout(bet.stake, bet.odds, bet.totalOdds),
      providerName: bet.providerName,
      providerEventId: bet.providerEventId,
      providerSportKey: bet.providerSportKey,
      eventStartTime: bet.eventStartTime ? bet.eventStartTime.toISOString() : null,
      settlementRetryCount: bet.settlementRetryCount,
      lastSettlementAttemptAt: bet.lastSettlementAttemptAt ? bet.lastSettlementAttemptAt.toISOString() : null,
      lastSettlementErrorCode: bet.lastSettlementErrorCode,
      lastSettlementErrorMessage: bet.lastSettlementErrorMessage,
      settlementReviewReason: bet.settlementReviewReason,
      createdAt: bet.createdAt.toISOString(),
      updatedAt: bet.updatedAt.toISOString(),
      selections: bet.selections.map((selection) => ({
        id: selection.id,
        sport: selection.sport,
        market: selection.market,
        selection: selection.outcome,
        participant: selection.canonicalParticipant ?? selection.event,
        odds: selection.odds ? selection.odds.toString() : null,
        providerName: selection.providerName,
        providerEventId: selection.providerEventId,
        eventStartTime: selection.eventStartTime ? selection.eventStartTime.toISOString() : null,
        oddsStatus: selection.oddsStatus,
      })),
    }));

    return NextResponse.json({
      bets: serialized,
      pagination: { limit, offset, total, hasMore: offset + serialized.length < total },
    });
  } catch (err) {
    console.error("GET /api/bets/needs-review failed:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleNeedsReview(request);
}
