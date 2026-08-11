// Stage 3.3 — AUTOMATIC SINGLE SETTLEMENT
//
// Application-layer orchestration: given a SINGLE bet id and an
// already-fetched, already-matched CanonicalEventResult, decides whether
// this bet can be automatically settled and, if so, applies that
// settlement through the existing, unmodified settleBet() (Stage 13.3).
//
// This module does NOT: call a provider/HTTP endpoint, run polling/cron/
// worker/queue logic, compute payouts, write a Transaction directly, touch
// Player.currentCredit directly, or duplicate settleBet()'s own
// idempotency/concurrency guarantees. It does exactly one non-transactional
// read (to decide eligibility and the intended outcome), then delegates the
// actual state transition entirely to settleBet(), which independently
// re-validates and atomically applies it.

import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  settleBet,
  BetNotFoundForSettlementError,
  MissingSettlementOddsError,
  type SettlementDatabase,
  type SettleBetResult,
} from "@/lib/bets/settleBet";
import {
  BetNotConfirmedForSettlementError,
  BetAlreadyRejectedError,
  SettlementConflictError,
  type SettlementTarget,
} from "@/lib/bets/settlementRules";
import { evaluateSelectionOutcome } from "./evaluateSelectionOutcome";
import type { CanonicalEventResult } from "./eventResultDomain";
import { mapSingleBetToCanonicalSelection, type SingleBetCanonicalFields } from "./mapSingleBetToCanonicalSelection";

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type AutoSettlementRejectionReasonCode =
  | "NOT_SINGLE"
  | "UNSUPPORTED_BET_STATUS"
  | "MISSING_PROVIDER_REFERENCE"
  | "PROVIDER_EVENT_MISMATCH"
  | "MISSING_CANONICAL_METADATA";

// Mirrors the evaluator's own WaitingReasonCode | UnsupportedReasonCode |
// InvalidDataReasonCode as a plain string here rather than re-importing all
// three unions — this field is always exactly evaluation.reasonCode,
// passed through verbatim, never re-derived.
export type AutoSettlementNoActionReasonCode = string;

export type AutoSettleSingleBetResult =
  | {
      readonly kind: "SETTLED";
      readonly betId: string;
      // H4-B6 — HALF_WIN/HALF_LOSS joined WIN/LOSS/VOID: SINGLE SPREAD can
      // now reach real financial settlement (see settlementTargetFor below).
      readonly outcome: "WIN" | "LOSS" | "VOID" | "HALF_WIN" | "HALF_LOSS";
      readonly previousStatus: string;
      readonly finalStatus: SettlementTarget;
      readonly idempotent: boolean;
    }
  | { readonly kind: "NO_ACTION"; readonly betId: string; readonly reasonCode: AutoSettlementNoActionReasonCode }
  | { readonly kind: "REJECTED"; readonly betId: string; readonly reasonCode: AutoSettlementRejectionReasonCode }
  | { readonly kind: "NOT_FOUND"; readonly betId: string }
  | { readonly kind: "CONFLICT"; readonly betId: string; readonly reasonCode: "ALREADY_SETTLED" | "STATUS_CHANGED_DURING_TRANSACTION" }
  | { readonly kind: "FAILED"; readonly betId: string; readonly reasonCode: string; readonly message: string };

export interface AutoSettleSingleBetInput {
  readonly betId: string;
  readonly eventResult: CanonicalEventResult;
  readonly expectedProviderEventId: string;
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

// Bet.status values that settleBet() will accept an APPLY-or-idempotent
// attempt from. PENDING/REJECTED are excluded on purpose: settleBet() /
// decideSettlementTransition() always throws for both (a bet must pass
// through the existing, unrelated confirm route first; REJECTED is
// terminal) — this is a cheap short-circuit that mirrors settlementRules.ts
// exactly, not new business logic layered on top of it.
//
// H4-B6 — SETTLED_HALF_WIN/SETTLED_HALF_LOSS added alongside SETTLED_WIN/
// SETTLED_LOSS/VOID: now that SINGLE SPREAD can reach real settlement, a
// bet already half-settled must remain eligible for a REPEATED settlement
// attempt (e.g. a re-run poll cycle) so settleBet()'s own idempotency check
// can run and correctly return IDEMPOTENT — mirroring decideSettlementTransition's
// (settlementRules.ts) already-widened terminal-status recognition exactly.
// Without this, a second call after a HALF_WIN/HALF_LOSS would be rejected
// here as UNSUPPORTED_BET_STATUS before ever reaching that idempotency path.
const ELIGIBLE_BET_STATUSES: ReadonlySet<string> = new Set([
  "CONFIRMED",
  "SETTLED_WIN",
  "SETTLED_LOSS",
  "VOID",
  "SETTLED_HALF_WIN",
  "SETTLED_HALF_LOSS",
]);

export interface AutoSettlementEligibilityInput {
  readonly type: string;
  readonly status: string;
  readonly providerName: string | null;
  readonly providerEventId: string | null;
}

export type AutoSettlementEligibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: AutoSettlementRejectionReasonCode };

// Pure. Deliberately does NOT validate canonical market/selection/period
// fields — mapSingleBetToCanonicalSelection() already validates those as
// part of building the CanonicalSelection, and re-checking them here would
// duplicate that logic. A null mapper result is what actually produces
// MISSING_CANONICAL_METADATA, in the orchestrator below.
export function validateAutoSettlementEligibility(
  bet: AutoSettlementEligibilityInput,
  expectedProviderEventId: string,
): AutoSettlementEligibilityResult {
  if (bet.type !== "SINGLE") {
    return { ok: false, reasonCode: "NOT_SINGLE" };
  }
  if (!ELIGIBLE_BET_STATUSES.has(bet.status)) {
    return { ok: false, reasonCode: "UNSUPPORTED_BET_STATUS" };
  }
  if (bet.providerName === null || bet.providerEventId === null) {
    return { ok: false, reasonCode: "MISSING_PROVIDER_REFERENCE" };
  }
  if (bet.providerEventId !== expectedProviderEventId) {
    return { ok: false, reasonCode: "PROVIDER_EVENT_MISMATCH" };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Evaluator outcome -> settlement target                                     */
/* -------------------------------------------------------------------------- */

// H4-B6 — widened from WIN/LOSS/VOID to also map HALF_WIN/HALF_LOSS, now
// that settleBet()'s computeSettlementFinancials (H4-B3) has real,
// exhaustively-tested Decimal math for SETTLED_HALF_WIN/SETTLED_HALF_LOSS
// and decideSettlementTransition (settlementRules.ts, H4-B3) already
// structurally accepts them as an internal requestedStatus via
// isInternalSettlementTarget. This function performs NO financial
// computation itself — it only names which existing settleBet() target
// corresponds to which evaluator outcome; the money is settleBet()'s alone.
function settlementTargetFor(outcome: "WIN" | "LOSS" | "VOID" | "HALF_WIN" | "HALF_LOSS"): SettlementTarget {
  if (outcome === "WIN") return "SETTLED_WIN";
  if (outcome === "LOSS") return "SETTLED_LOSS";
  if (outcome === "HALF_WIN") return "SETTLED_HALF_WIN";
  if (outcome === "HALF_LOSS") return "SETTLED_HALF_LOSS";
  return "VOID";
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

interface LoadedBet extends AutoSettlementEligibilityInput, SingleBetCanonicalFields {
  readonly id: string;
}

export async function autoSettleSingleBet(
  db: PrismaClient,
  input: AutoSettleSingleBetInput,
): Promise<AutoSettleSingleBetResult> {
  const { betId, eventResult, expectedProviderEventId } = input;

  const bet: LoadedBet | null = await db.bet.findUnique({
    where: { id: betId },
    select: {
      id: true,
      type: true,
      status: true,
      providerName: true,
      providerEventId: true,
      canonicalMarketType: true,
      canonicalSelectionType: true,
      canonicalParticipant: true,
      canonicalPeriod: true,
      // H4-B2 — threaded through to mapSingleBetToCanonicalSelection() so
      // SPREAD selections carry their line into evaluateSelectionOutcome().
      line: true,
    },
  });

  if (!bet) {
    return { kind: "NOT_FOUND", betId };
  }

  const eligibility = validateAutoSettlementEligibility(bet, expectedProviderEventId);
  if (!eligibility.ok) {
    return { kind: "REJECTED", betId, reasonCode: eligibility.reasonCode };
  }

  const selection = mapSingleBetToCanonicalSelection(bet);
  if (!selection) {
    return { kind: "REJECTED", betId, reasonCode: "MISSING_CANONICAL_METADATA" };
  }

  // H4-B6 — the H4-B2/H4-B5 SPREAD deferral (`selection.marketType ===
  // "SPREAD" -> NO_ACTION SPREAD_AUTO_SETTLEMENT_DEFERRED`) is removed here:
  // it existed only because settleBet()/settlementRules.ts had no financial
  // execution support for SETTLED_HALF_WIN/SETTLED_HALF_LOSS yet. H4-B3 gave
  // both real, exhaustively-tested Decimal math (settleBet.test.ts), and
  // H4-B5/H4-B5.x production-verified SPREAD provider matching end-to-end
  // (standard and quarter lines, exact-line safety, no rounding/nearest-line
  // guessing). Every WIN/LOSS/VOID/HALF_WIN/HALF_LOSS outcome the evaluator
  // can now produce for SPREAD — for standard AND quarter lines alike — is
  // handled uniformly below, exactly like every other market this function
  // already settles. EXPRESS SPREAD is a separate, independent guard in
  // lib/bets/settlement/aggregateExpressOutcome.ts, untouched by this
  // change. Any evaluation kind still outside the five settleable outcomes
  // (WAITING/UNSUPPORTED/INVALID_DATA) remains NO_ACTION, unchanged.
  const evaluation = evaluateSelectionOutcome(eventResult, selection);

  if (
    evaluation.kind !== "WIN" &&
    evaluation.kind !== "LOSS" &&
    evaluation.kind !== "VOID" &&
    evaluation.kind !== "HALF_WIN" &&
    evaluation.kind !== "HALF_LOSS"
  ) {
    return { kind: "NO_ACTION", betId, reasonCode: evaluation.reasonCode };
  }

  const requestedStatus = settlementTargetFor(evaluation.kind);

  let settleResult: SettleBetResult;
  try {
    settleResult = await settleBet(db as unknown as SettlementDatabase, { betId, requestedStatus });
  } catch (err) {
    if (err instanceof SettlementConflictError) {
      return { kind: "CONFLICT", betId, reasonCode: "ALREADY_SETTLED" };
    }
    if (err instanceof BetNotConfirmedForSettlementError || err instanceof BetAlreadyRejectedError) {
      return { kind: "CONFLICT", betId, reasonCode: "STATUS_CHANGED_DURING_TRANSACTION" };
    }
    if (err instanceof BetNotFoundForSettlementError) {
      return { kind: "NOT_FOUND", betId };
    }
    if (err instanceof MissingSettlementOddsError) {
      return { kind: "FAILED", betId, reasonCode: err.code, message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "FAILED", betId, reasonCode: "UNEXPECTED_ERROR", message };
  }

  if (settleResult.kind === "IDEMPOTENT") {
    return {
      kind: "SETTLED",
      betId,
      outcome: evaluation.kind,
      previousStatus: settleResult.status,
      finalStatus: settleResult.status,
      idempotent: true,
    };
  }

  return {
    kind: "SETTLED",
    betId,
    outcome: evaluation.kind,
    previousStatus: bet.status,
    finalStatus: settleResult.status,
    idempotent: false,
  };
}
