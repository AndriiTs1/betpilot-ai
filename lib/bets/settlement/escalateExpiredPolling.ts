// Stage 4.3.4 — Expired Polling Sweep. A separate, standalone step from
// pollConfirmedBetResults.ts's own active-polling eligibility query (never
// embedded inside it) — its only job is to find CONFIRMED, provider-backed
// bets that have fallen OUT of the active polling window (or that were
// never structurally complete enough to be polled at all) and give them a
// one-time, terminal NEEDS_REVIEW classification, so they never silently
// vanish from view. This module never calls a provider, never calls
// autoSettleSingleBet()/autoSettleExpressBet()/settleBet(), never writes a
// Transaction, and never touches settlementRetryCount or
// lastSettlementAttemptAt (no settlement attempt happened here — see each
// function's own comment).
//
// windowStart is computed from pollConfirmedBetResults.ts's own exported
// POLLING_LOOKBACK_MS — the exact same constant the active-polling query
// uses — so this module's "expired" and that query's "in window" are
// always exact, non-overlapping complements of each other for a shared
// `now` (see this file's own escalateExpiredPolling() for how `now` is
// threaded through). The caller (the poll-results route, Stage 4.3.4)
// computes one `now` and passes it to both this module and
// pollConfirmedBetResults(), never letting either compute its own.

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { SettlementReviewReason, SettlementReviewStatus } from "@/lib/generated/prisma/client";
import { POLLING_LOOKBACK_MS } from "./pollConfirmedBetResults";
import { mapSingleBetToCanonicalSelection, type SingleBetCanonicalFields } from "./mapSingleBetToCanonicalSelection";
import {
  mapExpressSelectionToCanonicalSelection,
  type ExpressSelectionCanonicalFields,
} from "./mapExpressSelectionToCanonicalSelection";

// Same order-of-magnitude safety bound as pollConfirmedBetResults.ts's own
// DEFAULT_ELIGIBLE_BET_LIMIT — a demo-scale-MVP-appropriate ceiling on one
// sweep's scan, not a claim about real production scale.
const DEFAULT_SWEEP_BET_LIMIT = 200;

/* -------------------------------------------------------------------------- */
/* Report contract                                                            */
/* -------------------------------------------------------------------------- */

export interface EscalateExpiredPollingReport {
  readonly scanned: number;
  readonly escalatedSingles: number;
  readonly escalatedExpresses: number;
  readonly structurallyInvalid: number;
  readonly skippedLegacy: number;
}

export interface EscalateExpiredPollingInput {
  readonly now: Date;
  readonly limit?: number;
}

/* -------------------------------------------------------------------------- */
/* Loaded row shapes                                                          */
/* -------------------------------------------------------------------------- */

interface LoadedSingleBet extends SingleBetCanonicalFields {
  readonly id: string;
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}

interface LoadedExpressLeg extends ExpressSelectionCanonicalFields {
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}

interface LoadedExpressBet {
  readonly id: string;
  readonly selections: readonly LoadedExpressLeg[];
}

/* -------------------------------------------------------------------------- */
/* Legacy vs provider-backed vs structurally-invalid — the one recognizer    */
/* -------------------------------------------------------------------------- */
//
// The reliable signal, read directly from the real schema (prisma/schema.prisma):
// providerName / providerSportKey / providerEventId / eventStartTime are
// four independently-nullable columns with NO database-level CHECK
// constraint tying them together — Stage 3.1's "populated together or not
// at all" is an APPLICATION-level convention documented in code comments,
// never a guarantee this module may simply trust. So the recognizer below
// never treats "has an eventStartTime" or "has a providerEventId" alone as
// proof of anything — it inspects all four fields (plus canonical
// completeness, via the exact same mapSingleBetToCanonicalSelection() /
// mapExpressSelectionToCanonicalSelection() functions the real settlement
// path already uses — never re-implemented, never guessed) and classifies
// deterministically:
//
//   FULLY LEGACY        — all four provider-identity fields are NULL.
//                          Untouched by this module, exactly as it is
//                          already untouched by active polling.
//   STRUCTURALLY INVALID — at least one provider-identity field is set, but
//                          not all of them, OR all four are set but
//                          canonical mapping still fails. A real, permanent
//                          data problem — reused as the existing
//                          MISSING_PROVIDER_REFERENCE / MISSING_CANONICAL_
//                          METADATA reasons, never invented as a new one.
//   PROVIDER-BACKED, VALID — all four identity fields set AND canonical
//                          mapping succeeds. Only this shape is ever
//                          eligible for POLLING_WINDOW_EXPIRED, and only
//                          once its eventStartTime falls before windowStart.

function hasAnyProviderIdentityField(fields: {
  readonly providerName: string | null;
  readonly providerSportKey: string | null;
  readonly providerEventId: string | null;
  readonly eventStartTime: Date | null;
}): boolean {
  return fields.providerName !== null || fields.providerSportKey !== null || fields.providerEventId !== null || fields.eventStartTime !== null;
}

/* -------------------------------------------------------------------------- */
/* SINGLE classification                                                      */
/* -------------------------------------------------------------------------- */

export type SingleSweepDisposition =
  | { readonly kind: "SKIP_LEGACY" }
  | { readonly kind: "SKIP_ACTIVE" }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "STRUCTURAL_INVALID"; readonly reason: SettlementReviewReason; readonly technicalCode: string };

// Pure, no DB/side effects — directly unit-testable. windowStart is the
// caller's own POLLING_LOOKBACK_MS-derived cutoff (see this file's own
// header); a bet's eventStartTime strictly before it is "expired," an
// eventStartTime at or after it is still active polling's own concern
// (matches loadEligibleSingleBets()'s `gte: windowStart` inclusively —
// this function's own `<` is the exact, non-overlapping complement, never
// double-counting the boundary instant).
export function classifySingleBetForSweep(bet: LoadedSingleBet, windowStart: Date): SingleSweepDisposition {
  if (!hasAnyProviderIdentityField(bet)) {
    return { kind: "SKIP_LEGACY" };
  }

  if (bet.providerName === null || bet.providerEventId === null) {
    return { kind: "STRUCTURAL_INVALID", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE, technicalCode: "MISSING_PROVIDER_REFERENCE" };
  }
  // providerSportKey/eventStartTime aren't part of autoSettleSingleBet()'s
  // own narrower 2-field MISSING_PROVIDER_REFERENCE check (that function is
  // never even reached for this bet — extractProviderEventKey() would
  // already refuse to build a key without these) — but both are still,
  // fundamentally, an incomplete provider reference. Reused under the same
  // existing reason rather than inventing a new one (see this file's own
  // module header).
  if (bet.providerSportKey === null || bet.eventStartTime === null) {
    return { kind: "STRUCTURAL_INVALID", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE, technicalCode: "MISSING_PROVIDER_REFERENCE" };
  }
  const eventStartTime = bet.eventStartTime;

  if (!mapSingleBetToCanonicalSelection(bet)) {
    return { kind: "STRUCTURAL_INVALID", reason: SettlementReviewReason.MISSING_CANONICAL_METADATA, technicalCode: "MISSING_CANONICAL_METADATA" };
  }

  return eventStartTime.getTime() < windowStart.getTime() ? { kind: "EXPIRED" } : { kind: "SKIP_ACTIVE" };
}

/* -------------------------------------------------------------------------- */
/* EXPRESS classification — per-leg, then folded into one bet-level decision  */
/* -------------------------------------------------------------------------- */

type LegSweepDisposition =
  | { readonly kind: "LEGACY" }
  | { readonly kind: "ACTIVE" }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "INVALID"; readonly reason: SettlementReviewReason; readonly technicalCode: string };

function classifyExpressLegForSweep(leg: LoadedExpressLeg, windowStart: Date): LegSweepDisposition {
  if (!hasAnyProviderIdentityField(leg)) {
    return { kind: "LEGACY" };
  }
  if (leg.providerName === null || leg.providerEventId === null) {
    return { kind: "INVALID", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE, technicalCode: "MISSING_PROVIDER_REFERENCE" };
  }
  if (leg.providerSportKey === null || leg.eventStartTime === null) {
    return { kind: "INVALID", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE, technicalCode: "MISSING_PROVIDER_REFERENCE" };
  }
  const eventStartTime = leg.eventStartTime;

  if (!mapExpressSelectionToCanonicalSelection(leg)) {
    return { kind: "INVALID", reason: SettlementReviewReason.MISSING_CANONICAL_METADATA, technicalCode: "MISSING_CANONICAL_METADATA" };
  }

  return eventStartTime.getTime() < windowStart.getTime() ? { kind: "EXPIRED" } : { kind: "ACTIVE" };
}

export type ExpressSweepDisposition =
  | { readonly kind: "SKIP_LEGACY" }
  | { readonly kind: "SKIP_ACTIVE" }
  | { readonly kind: "EXPIRED" }
  | { readonly kind: "STRUCTURAL_INVALID"; readonly reason: SettlementReviewReason; readonly technicalCode: string };

// Pure, no DB/side effects — directly unit-testable. A real EXPRESS needs
// EVERY leg resolvable to ever settle automatically (autoSettleExpressBet()'s
// own buildLegsOrReject() already enforces this on the active-polling
// path) — this sweep applies the identical "every leg or nothing" standard:
// a single LEGACY leg mixed among otherwise-valid provider-backed legs is
// NOT a legacy bet (some legs clearly ARE provider-backed) and is NOT
// expired (it can never be resolved at all) — it is a structural problem,
// exactly like a single leg missing its providerEventId would be.
export function classifyExpressBetForSweep(bet: LoadedExpressBet, windowStart: Date): ExpressSweepDisposition {
  if (bet.selections.length === 0) {
    // Mirrors autoSettleExpressBet()'s own EMPTY_SELECTIONS rejection —
    // not reachable in practice (a Bet always has at least one
    // BetSelection by construction), kept only as an honest, typed
    // fallback rather than an unhandled case.
    return { kind: "STRUCTURAL_INVALID", reason: SettlementReviewReason.EMPTY_SELECTIONS, technicalCode: "EMPTY_SELECTIONS" };
  }

  const legDispositions = bet.selections.map((leg) => classifyExpressLegForSweep(leg, windowStart));

  if (legDispositions.every((d) => d.kind === "LEGACY")) {
    return { kind: "SKIP_LEGACY" };
  }

  const firstInvalid = legDispositions.find((d): d is Extract<LegSweepDisposition, { kind: "INVALID" }> => d.kind === "INVALID");
  if (firstInvalid) {
    return { kind: "STRUCTURAL_INVALID", reason: firstInvalid.reason, technicalCode: firstInvalid.technicalCode };
  }

  // No INVALID leg, not all-LEGACY — a leg still LEGACY here means a MIX of
  // legacy and valid legs, which is itself a structural problem (see this
  // function's own header): a legacy leg can never carry a real result, so
  // this express can never settle automatically no matter how long it
  // waits.
  if (legDispositions.some((d) => d.kind === "LEGACY")) {
    return { kind: "STRUCTURAL_INVALID", reason: SettlementReviewReason.MISSING_PROVIDER_REFERENCE, technicalCode: "MISSING_PROVIDER_REFERENCE" };
  }

  // Every leg is now ACTIVE or EXPIRED.
  if (legDispositions.some((d) => d.kind === "ACTIVE")) {
    return { kind: "SKIP_ACTIVE" };
  }
  return { kind: "EXPIRED" };
}

/* -------------------------------------------------------------------------- */
/* Atomic, guarded, one-time escalation write                                 */
/* -------------------------------------------------------------------------- */

// The one place this module writes anything. updateMany()'s WHERE clause
// (status + settlementReviewStatus, alongside id) is the actual one-time
// guard — matching zero rows (already escalated by another invocation of
// this same sweep, a concurrent one, or the bet somehow left CONFIRMED in
// between) makes a repeat/overlapping run a safe, silently-counted no-op,
// the same atomic-conditional-update idiom settleBet.ts's own financial
// guard already established (settleBet.ts itself is not modified by this
// stage). Deliberately omits settlementRetryCount and
// lastSettlementAttemptAt from `data` — this is a one-time
// reclassification of an already-stalled bet, never a settlement attempt
// (no provider call was made to produce this outcome).
async function escalateBet(
  db: PrismaClient,
  betId: string,
  reason: SettlementReviewReason,
  technicalCode: string,
  technicalMessage: string,
): Promise<boolean> {
  const result = await db.bet.updateMany({
    where: { id: betId, status: "CONFIRMED", settlementReviewStatus: null },
    data: {
      settlementReviewStatus: SettlementReviewStatus.NEEDS_REVIEW,
      settlementReviewReason: reason,
      lastSettlementErrorCode: technicalCode,
      lastSettlementErrorMessage: technicalMessage,
    },
  });
  return result.count === 1;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function escalateExpiredPolling(
  db: PrismaClient,
  input: EscalateExpiredPollingInput,
): Promise<EscalateExpiredPollingReport> {
  const { now } = input;
  const limit = input.limit ?? DEFAULT_SWEEP_BET_LIMIT;
  const windowStart = new Date(now.getTime() - POLLING_LOOKBACK_MS);

  // Deliberately NOT filtered by eventStartTime at the SQL level (unlike
  // pollConfirmedBetResults.ts's own eligibility queries) — this module's
  // classification depends on cross-field logic (all four provider-identity
  // fields together, plus canonical mapping) that isn't expressible as a
  // single WHERE condition, so every CONFIRMED/not-yet-reviewed row is
  // loaded once and classified precisely in application code, the same
  // "load broadly, decide precisely in code" pattern
  // loadEligibleExpressBets() already established for EXPRESS.
  const [singleBets, expressBets] = await Promise.all([
    db.bet.findMany({
      where: { type: "SINGLE", status: "CONFIRMED", settlementReviewStatus: null },
      select: {
        id: true,
        providerName: true,
        providerSportKey: true,
        providerEventId: true,
        eventStartTime: true,
        canonicalMarketType: true,
        canonicalSelectionType: true,
        canonicalParticipant: true,
        canonicalPeriod: true,
      },
      orderBy: { id: "asc" },
      take: limit,
    }),
    db.bet.findMany({
      where: { type: "EXPRESS", status: "CONFIRMED", settlementReviewStatus: null },
      select: {
        id: true,
        selections: {
          select: {
            providerName: true,
            providerSportKey: true,
            providerEventId: true,
            eventStartTime: true,
            canonicalMarketType: true,
            canonicalSelectionType: true,
            canonicalParticipant: true,
            canonicalPeriod: true,
          },
        },
      },
      orderBy: { id: "asc" },
      take: limit,
    }),
  ]);

  let escalatedSingles = 0;
  let escalatedExpresses = 0;
  let structurallyInvalid = 0;
  let skippedLegacy = 0;

  for (const bet of singleBets) {
    const disposition = classifySingleBetForSweep(bet, windowStart);
    if (disposition.kind === "SKIP_LEGACY") {
      skippedLegacy += 1;
      continue;
    }
    if (disposition.kind === "SKIP_ACTIVE") {
      continue;
    }
    if (disposition.kind === "EXPIRED") {
      const didEscalate = await escalateBet(
        db,
        bet.id,
        SettlementReviewReason.POLLING_WINDOW_EXPIRED,
        "POLLING_WINDOW_EXPIRED",
        "Event start time fell outside the automatic polling window before a result was ever obtained.",
      );
      if (didEscalate) escalatedSingles += 1;
      continue;
    }
    // STRUCTURAL_INVALID
    const didEscalate = await escalateBet(
      db,
      bet.id,
      disposition.reason,
      disposition.technicalCode,
      `Structural data problem detected during expiry sweep: ${disposition.technicalCode}.`,
    );
    if (didEscalate) structurallyInvalid += 1;
  }

  for (const bet of expressBets) {
    const disposition = classifyExpressBetForSweep(bet, windowStart);
    if (disposition.kind === "SKIP_LEGACY") {
      skippedLegacy += 1;
      continue;
    }
    if (disposition.kind === "SKIP_ACTIVE") {
      continue;
    }
    if (disposition.kind === "EXPIRED") {
      const didEscalate = await escalateBet(
        db,
        bet.id,
        SettlementReviewReason.POLLING_WINDOW_EXPIRED,
        "POLLING_WINDOW_EXPIRED",
        "Every leg's event start time fell outside the automatic polling window before a result was ever obtained.",
      );
      if (didEscalate) escalatedExpresses += 1;
      continue;
    }
    const didEscalate = await escalateBet(
      db,
      bet.id,
      disposition.reason,
      disposition.technicalCode,
      `Structural data problem detected during expiry sweep: ${disposition.technicalCode}.`,
    );
    if (didEscalate) structurallyInvalid += 1;
  }

  return {
    scanned: singleBets.length + expressBets.length,
    escalatedSingles,
    escalatedExpresses,
    structurallyInvalid,
    skippedLegacy,
  };
}
