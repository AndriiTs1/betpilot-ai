// Stage 4.3.2 — Retry & Manual Review: pure classification only. No DB, no
// HTTP, no Date.now(), no side effects — every function here is a
// deterministic mapping from an already-computed settlement/provider
// signal to one of six categories (see BetClassification below). Nothing
// in this file calls settleBet()/settlementRules.ts, evaluates a
// selection, fetches a provider, or decides WIN/LOSS/VOID itself — it only
// classifies outcomes those existing, unmodified modules already produced.
//
// The one rule this entire file exists to enforce (Stage 4.3 v3's explicit
// correction): a provider batch/request failure is ALWAYS
// CYCLE_PROVIDER_FAILURE, regardless of call site (cron batch polling,
// manual retry, CLI trigger, internal service call) — it is never folded
// into a bet-level retry/review decision. classifyProviderFetchFailure()
// below is the only function that produces CYCLE_PROVIDER_FAILURE, and it
// is unconditional: every ScoresFetchFailureReason maps to it, with no
// exceptions.

import type { SettlementReviewReason } from "@/lib/generated/prisma/client";
import { SettlementReviewReason as ReviewReason } from "@/lib/generated/prisma/client";
import type {
  InvalidDataReasonCode,
  SelectionOutcomeEvaluation,
  UnsupportedReasonCode,
} from "./evaluateSelectionOutcome";
import type { AutoSettlementRejectionReasonCode } from "./autoSettleSingleBet";
import type { AutoSettlementExpressRejectionReasonCode } from "./autoSettleExpressBet";
import type { AggregateExpressOutcome } from "./aggregateExpressOutcome";
import type { ScoresFetchFailureReason } from "@/lib/odds/providers/theOddsApi/scoresAdapter";

/* -------------------------------------------------------------------------- */
/* Result contract                                                            */
/* -------------------------------------------------------------------------- */

export type BetClassification =
  // Whole provider batch/request failed — no bet-level consequence at all.
  // Caller must not write to any of Bet's settlementRetry*/lastSettlement*/
  // settlementReview* fields for a bet affected by this.
  | { readonly category: "CYCLE_PROVIDER_FAILURE" }
  // Legitimately not-yet-resolved (event not completed/postponed/abandoned,
  // or an EXPRESS leg with no result yet and no terminal/permanent leg
  // elsewhere in the same bet). Not an error — never counts toward the
  // retry threshold.
  | { readonly category: "WAITING" }
  // WIN/LOSS/VOID — hand off to settleBet() through the existing,
  // unmodified autoSettleSingleBet()/autoSettleExpressBet() path. This
  // classifier never computes a payout and is not itself in that path.
  | { readonly category: "TERMINAL_OUTCOME" }
  // A resolved race (settleBet()'s own CONFLICT paths) or a structurally
  // impossible-except-via-race rejection (UNSUPPORTED_BET_STATUS — see
  // classifyRejectionReasonCode below). No write, no retry, no review.
  | { readonly category: "CONFLICT_NO_ACTION" }
  // Bet-level, plausibly self-resolving on a later attempt. retryCode is
  // the technical value to persist in Bet.lastSettlementErrorCode;
  // maxRetriesReason is the SettlementReviewReason to persist in
  // Bet.settlementReviewReason ONLY once the caller's own attempt-count
  // threshold is reached (this classifier does not know or track the
  // threshold itself — that is orchestration, Stage 4.3.3's job).
  | { readonly category: "BET_TRANSIENT"; readonly retryCode: string; readonly maxRetriesReason: SettlementReviewReason }
  // Bet-level, will not self-resolve by retrying. Escalate immediately —
  // zero automatic retries spent on it.
  | { readonly category: "BET_PERMANENT_REVIEW"; readonly reason: SettlementReviewReason };

/* -------------------------------------------------------------------------- */
/* Cycle-level: provider batch/request failure                                */
/* -------------------------------------------------------------------------- */

// Unconditional — every ScoresFetchFailureReason (MISSING_API_KEY, TIMEOUT,
// HTTP_401, HTTP_429, HTTP_5XX, HTTP_ERROR, INVALID_JSON, INVALID_RESPONSE)
// maps to the same CYCLE_PROVIDER_FAILURE result, whether this failure was
// observed during cron batch polling, a manual single-bet retry, a
// `vercel crons run` CLI trigger, or any other internal caller — the
// failure's nature (provider-side, not bet-specific) is what determines
// its classification, never the call site. The parameter exists (rather
// than this being a bare constant) purely so every call site is forced to
// have a real ScoresFetchFailureReason in hand — and so a unit test can
// exhaustively enumerate all 8 reasons and assert none of them ever
// produces anything other than CYCLE_PROVIDER_FAILURE.
export function classifyProviderFetchFailure(
  _reason: ScoresFetchFailureReason,
): Extract<BetClassification, { category: "CYCLE_PROVIDER_FAILURE" }> {
  return { category: "CYCLE_PROVIDER_FAILURE" };
}

/* -------------------------------------------------------------------------- */
/* Bet-level: evaluator/aggregator reasonCode -> classification               */
/* -------------------------------------------------------------------------- */

// Every UnsupportedReasonCode evaluateSelectionOutcome() can produce.
// Exhaustive via Record<UnsupportedReasonCode, ...> — a missing key is a
// compile error, not a runtime guess.
const UNSUPPORTED_REASON_MAP: Record<UnsupportedReasonCode, SettlementReviewReason> = {
  UNSUPPORTED_MARKET: ReviewReason.UNSUPPORTED_MARKET,
  UNSUPPORTED_SELECTION: ReviewReason.UNSUPPORTED_SELECTION,
  UNSUPPORTED_PERIOD: ReviewReason.UNSUPPORTED_PERIOD,
};

// Every InvalidDataReasonCode EXCEPT MISSING_SCORE — MISSING_SCORE is
// handled separately in classifyInvalidDataReasonCode() below (bet-level
// transient, not permanent). Exhaustive via
// Record<Exclude<InvalidDataReasonCode, "MISSING_SCORE">, ...>.
const PERMANENT_INVALID_DATA_REASON_MAP: Record<Exclude<InvalidDataReasonCode, "MISSING_SCORE">, SettlementReviewReason> = {
  INVALID_SCORE: ReviewReason.INVALID_SCORE,
  PARTICIPANT_MISMATCH: ReviewReason.PARTICIPANT_MISMATCH,
  INVALID_EVENT_RESULT: ReviewReason.INVALID_EVENT_RESULT,
  MISSING_PARTICIPANT_NAME: ReviewReason.MISSING_PARTICIPANT_NAME,
  AMBIGUOUS_PARTICIPANT_MATCH: ReviewReason.AMBIGUOUS_PARTICIPANT_MATCH,
};

// Shared by classifyEvaluatorOutcome() (SINGLE, and — in Stage 4.3.3's
// future EXPRESS per-leg wiring, not built yet — reusable there too) for
// any UNSUPPORTED reasonCode. Takes a plain string (not the narrower
// UnsupportedReasonCode type) because a future EXPRESS caller reads this
// value out of AggregateExpressOutcome's own Record<string, string>
// reasonCodes map, which is not typed as narrowly as
// SelectionOutcomeEvaluation.reasonCode is.
export function classifyUnsupportedReasonCode(reasonCode: string): BetClassification {
  const mapped = (UNSUPPORTED_REASON_MAP as Record<string, SettlementReviewReason | undefined>)[reasonCode];
  if (mapped) return { category: "BET_PERMANENT_REVIEW", reason: mapped };
  // Defensive fallback only — every UnsupportedReasonCode
  // evaluateSelectionOutcome() can produce is enumerated above (confirmed
  // by reading that file in full). An unrecognized value degrades to the
  // narrowest honest permanent reason rather than being silently dropped
  // or guessed into a more specific (and possibly wrong) one.
  return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.UNSUPPORTED_MARKET };
}

// Shared by classifyEvaluatorOutcome() (SINGLE) and, in the future,
// EXPRESS per-leg wiring — the latter's reasonCodes map can also contain
// aggregateExpressOutcome.ts's own synthetic "INVALID_SELECTION_ODDS"
// (produced when computeTotalOdds() throws for a WIN leg with missing/
// non-positive stored odds — a genuine stored-data problem, not one of
// evaluateSelectionOutcome()'s own InvalidDataReasonCode values). That
// value — and any other unrecognized invalid-data reasonCode — falls
// through to the INVALID_EXPRESS_DATA default below: "invalid data" is
// definitionally not something a retry fixes, MISSING_SCORE being the one
// proven, explicit exception handled first.
export function classifyInvalidDataReasonCode(reasonCode: string): BetClassification {
  if (reasonCode === "MISSING_SCORE") {
    return { category: "BET_TRANSIENT", retryCode: "MISSING_SCORE", maxRetriesReason: ReviewReason.MISSING_SCORE_MAX_RETRIES };
  }
  const mapped = (PERMANENT_INVALID_DATA_REASON_MAP as Record<string, SettlementReviewReason | undefined>)[reasonCode];
  if (mapped) return { category: "BET_PERMANENT_REVIEW", reason: mapped };
  return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.INVALID_EXPRESS_DATA };
}

// SINGLE's own full evaluation -> classification. WIN/LOSS/VOID hand off
// to settleBet() via the existing autoSettleSingleBet() path (this
// classifier does not call it); WAITING never counts toward the retry
// threshold; UNSUPPORTED/INVALID_DATA delegate to the shared helpers
// above.
export function classifyEvaluatorOutcome(evaluation: SelectionOutcomeEvaluation): BetClassification {
  switch (evaluation.kind) {
    case "WIN":
    case "LOSS":
    case "VOID":
      return { category: "TERMINAL_OUTCOME" };
    case "WAITING":
      return { category: "WAITING" };
    case "UNSUPPORTED":
      return classifyUnsupportedReasonCode(evaluation.reasonCode);
    case "INVALID_DATA":
      return classifyInvalidDataReasonCode(evaluation.reasonCode);
  }
}

const WAITING_REASON_CODES: ReadonlySet<string> = new Set(["EVENT_NOT_COMPLETED", "EVENT_POSTPONED", "EVENT_ABANDONED"]);
const UNSUPPORTED_REASON_CODES: ReadonlySet<string> = new Set(["UNSUPPORTED_MARKET", "UNSUPPORTED_SELECTION", "UNSUPPORTED_PERIOD"]);

// SINGLE-only. autoSettleSingleBet()'s own NO_ACTION.reasonCode is a
// flattened plain string — "always exactly evaluation.reasonCode, passed
// through verbatim, never re-derived" per that file's own
// AutoSettlementNoActionReasonCode comment — not the original typed
// {kind, reasonCode} pair classifyEvaluatorOutcome() expects. This
// re-derives which of WAITING/UNSUPPORTED/INVALID_DATA the flattened
// string belongs to from the three known, disjoint, exhaustively-closed
// reasonCode sets evaluateSelectionOutcome() can produce (confirmed by
// reading that file in full) — a value outside all three is only
// reachable via a genuine drift between the two files, and falls through
// to classifyInvalidDataReasonCode()'s own defensive BET_PERMANENT_REVIEW
// fallback rather than being guessed or silently dropped.
export function classifyNoActionReasonCode(reasonCode: string): BetClassification {
  if (WAITING_REASON_CODES.has(reasonCode)) return { category: "WAITING" };
  if (UNSUPPORTED_REASON_CODES.has(reasonCode)) return classifyUnsupportedReasonCode(reasonCode);
  return classifyInvalidDataReasonCode(reasonCode);
}

// EXPRESS-only. Folds autoSettleExpressBet()'s NO_ACTION.aggregate (which
// carries one reasonCode PER AFFECTED LEG, not a single bet-level one —
// aggregateExpressOutcome.ts's own Record<string, string> reasonCodes map)
// into the single bet-level classification decision Stage 4.3's tracking
// model needs.
//
// WAITING is always treated as WAITING, regardless of *why* each
// individual leg is still missing a result — a leg's own missing-result
// cause (cycle-level provider failure vs a genuinely not-yet-resolved
// event) is deliberately NOT distinguished per leg in Stage 4.3.3 (see
// that stage's own report for this documented scope boundary: SINGLE gets
// the CYCLE_FAILURE/NOT_IN_RESPONSE distinction via
// pollConfirmedBetResults.ts's per-id resolution tracking; EXPRESS legs do
// not, yet — nothing mis-settles either way, the only cost is slower
// escalation for one specific EXPRESS edge case, backstopped by the future
// window-expiry sweep).
//
// For UNSUPPORTED/INVALID_DATA: any single leg resolving to
// BET_PERMANENT_REVIEW makes the whole bet BET_PERMANENT_REVIEW
// immediately (an express/parlay is only as good as its worst leg) — only
// when EVERY affected leg's reasonCode is the one proven bet-level-
// transient case (MISSING_SCORE) does the whole bet stay BET_TRANSIENT.
export function classifyExpressNoActionAggregate(
  aggregate: Extract<AggregateExpressOutcome, { kind: "WAITING" | "UNSUPPORTED" | "INVALID_DATA" }>,
): BetClassification {
  if (aggregate.kind === "WAITING") return { category: "WAITING" };

  const perLeg =
    aggregate.kind === "UNSUPPORTED"
      ? Object.values(aggregate.reasonCodes).map(classifyUnsupportedReasonCode)
      : Object.values(aggregate.reasonCodes).map(classifyInvalidDataReasonCode);

  const firstPermanent = perLeg.find((c) => c.category === "BET_PERMANENT_REVIEW");
  if (firstPermanent) return firstPermanent;

  // Every leg's classification is BET_TRANSIENT here — for INVALID_DATA
  // that is only reachable when every affected leg's reasonCode was
  // MISSING_SCORE (classifyInvalidDataReasonCode()'s one transient case);
  // UNSUPPORTED never produces BET_TRANSIENT at all, so perLeg is
  // guaranteed non-empty whenever this line is reached.
  return perLeg[0];
}

/* -------------------------------------------------------------------------- */
/* Bet-level: structural REJECTED reasonCode (autoSettleSingle/ExpressBet)    */
/* -------------------------------------------------------------------------- */

// Exhaustive switch over both SINGLE's and EXPRESS's REJECTED reasonCode
// unions (autoSettleSingleBet.ts / autoSettleExpressBet.ts) — every one is
// a structural/data problem that will never self-resolve by retrying,
// EXCEPT UNSUPPORTED_BET_STATUS: see its own case comment. NOT_SINGLE and
// NOT_EXPRESS both map to the single INVALID_BET_TYPE reason (Stage 4.3
// v3's explicit "don't invent duplicate enum values for one operator
// reason" instruction) rather than getting one reason each.
export function classifyRejectionReasonCode(
  reasonCode: AutoSettlementRejectionReasonCode | AutoSettlementExpressRejectionReasonCode,
): BetClassification {
  switch (reasonCode) {
    case "UNSUPPORTED_BET_STATUS":
      // The eligibility query that fed this bet into the pipeline at all
      // already required status === CONFIRMED (loadEligibleSingleBets/
      // loadEligibleExpressBets in pollConfirmedBetResults.ts) — so this
      // branch is only reachable via a genuine race between that read and
      // this call (the bet moved to PENDING/REJECTED in between, which
      // nothing in the existing lifecycle does going forward from
      // CONFIRMED — see settlementRules.ts's own "unreachable in practice"
      // reasoning for the analogous case). Not a data problem with THIS
      // bet — same class as settleBet()'s own CONFLICT paths, not a
      // NEEDS_REVIEW-worthy finding. Flagged explicitly in the Stage 4.3
      // v3 implementation report as the one reconciliation gap against the
      // v3 enum list (no dedicated SettlementReviewReason value exists for
      // it, deliberately not added without confirmation).
      return { category: "CONFLICT_NO_ACTION" };
    case "NOT_SINGLE":
    case "NOT_EXPRESS":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.INVALID_BET_TYPE };
    case "MISSING_PROVIDER_REFERENCE":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.MISSING_PROVIDER_REFERENCE };
    case "PROVIDER_EVENT_MISMATCH":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.PROVIDER_EVENT_MISMATCH };
    case "MISSING_CANONICAL_METADATA":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.MISSING_CANONICAL_METADATA };
    case "EMPTY_SELECTIONS":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.EMPTY_SELECTIONS };
    case "DUPLICATE_PROVIDER_EVENT_RESULT":
      return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.DUPLICATE_PROVIDER_EVENT_RESULT };
  }
}

/* -------------------------------------------------------------------------- */
/* Bet-level: settleBet() FAILED reasonCode                                   */
/* -------------------------------------------------------------------------- */

// errorCode is settleBet()'s own thrown-error .code (MissingSettlementOddsError
// / InvalidEffectiveSettlementOddsError) as surfaced through
// AutoSettleSingleBetResult/AutoSettleExpressBetResult's FAILED.reasonCode,
// or the literal "UNEXPECTED_ERROR" both autoSettle* catch-alls use for any
// other thrown value. Takes a plain string (not a narrower literal union)
// because both result contracts type FAILED.reasonCode as `string`, not a
// closed union — this function's own runtime checks are what actually
// narrow it.
export function classifySettleFailureCode(errorCode: string): BetClassification {
  if (errorCode === "MISSING_SETTLEMENT_ODDS") {
    return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.MISSING_SETTLEMENT_ODDS };
  }
  if (errorCode === "INVALID_EFFECTIVE_SETTLEMENT_ODDS") {
    return { category: "BET_PERMANENT_REVIEW", reason: ReviewReason.INVALID_SETTLEMENT_ODDS };
  }
  // "UNEXPECTED_ERROR" (a non-P2025 error settleBet()'s own $transaction
  // propagated — e.g. a transient DB connectivity failure) and any other
  // unrecognized code both degrade to the same bounded-retry-then-review
  // treatment: plausibly transient, never silently ignored, never guessed
  // into a more specific (and possibly wrong) permanent reason.
  return { category: "BET_TRANSIENT", retryCode: "DB_ERROR", maxRetriesReason: ReviewReason.DB_ERROR_MAX_RETRIES };
}

/* -------------------------------------------------------------------------- */
/* Bet-level: CONFLICT (settleBet()'s own resolved-race outcomes)             */
/* -------------------------------------------------------------------------- */

// autoSettleSingleBet()/autoSettleExpressBet()'s CONFLICT results
// (ALREADY_SETTLED / STATUS_CHANGED_DURING_TRANSACTION) — both are
// settleBet()'s own race-recovery mechanism already resolving itself
// correctly (see settleBet.ts's RaceResolvedIdempotently / P2025 handling,
// unmodified by Stage 4.3). Never a retry, never a review — the outer
// eligibility query naturally never sees this bet again once its status
// has actually left CONFIRMED.
export function classifyConflict(): Extract<BetClassification, { category: "CONFLICT_NO_ACTION" }> {
  return { category: "CONFLICT_NO_ACTION" };
}

/* -------------------------------------------------------------------------- */
/* Bet-level: EVENT_NOT_FOUND (synthetic — computed by the orchestrator)      */
/* -------------------------------------------------------------------------- */

// Not produced by evaluateSelectionOutcome(), scoresAdapter.ts, or any
// existing settlement module today — this is Stage 4.3's own derived
// signal for "the provider's batch/chunk fetch itself SUCCEEDED, but this
// specific requested providerEventId was absent from the response,"
// computed by the future Stage 4.3.3 orchestration layer by cross-
// referencing the set of requested ids against a successful fetch's
// returned ids (never inferred from a FAILED fetch — that is always
// classifyProviderFetchFailure()'s CYCLE_PROVIDER_FAILURE instead, with no
// exceptions). Exists as its own named function (rather than the caller
// hand-rolling the same literal object) so every call site produces byte-
// identical BET_TRANSIENT output and so this one, deliberately narrow
// definition of EVENT_NOT_FOUND is exercised directly by a unit test.
export function classifyEventNotFound(): Extract<BetClassification, { category: "BET_TRANSIENT" }> {
  return { category: "BET_TRANSIENT", retryCode: "EVENT_NOT_FOUND", maxRetriesReason: ReviewReason.EVENT_NOT_FOUND_MAX_RETRIES };
}
