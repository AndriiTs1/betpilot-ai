import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { VerificationReasonCode } from "@/lib/odds/verification";

// Stage 12, Phase 2 — maps a single selection's odds-verification outcome
// to its BetSelectionOddsStatus. Pure, not wired into any route yet.
//
// Input is `OddsCheckResult | null`, not `OddsCheckResult` alone: `null`
// means the check never ran at all (mirrors how the preview routes already
// skip verifyOdds() entirely when a selection has no odds to check —
// see app/api/miniapp/bets/text/preview/route.ts's `parsed.odds !== null
// ? await verifyOdds(...) : null`). A caller integrating
// Promise.allSettled (Stage 12's planned parallel per-selection check —
// see the audit's point 6) should convert a `rejected` outcome to `null`
// before calling this function, for the same reason: from this function's
// point of view, "the check threw" and "the check was never attempted" are
// both simply "no result to evaluate", i.e. UNAVAILABLE.
//
// Stage 4.2B1 — root cause fix (Stage 4.2A audit): every failure path
// inside verifyOdds() used to collapse to the same `matched: false` with
// only a free-text `note`, and lib/odds/legacyOddsBridge.ts discarded even
// that — so this mapper could not distinguish "event/selection genuinely
// not found" from "a technical provider failure occurred while checking"
// (rate limit, timeout, malformed response, provider outage). Both showed
// as NOT_FOUND, which is misleading: a transient provider failure is
// retryable and not the same claim as "this event does not exist."
// legacyOddsBridge.ts now threads result.reasonCode through unconditionally
// (see its own comment) — this function reads it to split the two cases,
// but ONLY for the narrow, explicitly-technical set below. Every other
// reason (EVENT_NOT_FOUND, SELECTION_NOT_FOUND, SPORT_NOT_SUPPORTED,
// LEAGUE_NOT_SUPPORTED, MARKET_NOT_SUPPORTED, AMBIGUOUS_EVENT, INVALID_INPUT,
// NOT_CHECKED, or reasonCode simply absent — an older/hand-built
// OddsCheckResult) keeps EXACTLY the prior behavior: NOT_FOUND. This is a
// deliberate, minimal whitelist, not a general "anything unusual is
// UNAVAILABLE" rule — widening it further is a separate decision, not made
// here.
const PROVIDER_TECHNICAL_FAILURE_REASONS: ReadonlySet<VerificationReasonCode> = new Set([
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_INVALID_RESPONSE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_AUTH_FAILED",
]);

export function mapOddsCheckToSelectionStatus(result: OddsCheckResult | null): BetSelectionOddsStatus {
  if (result === null) {
    return "UNAVAILABLE";
  }

  if (!result.matched) {
    if (result.reasonCode && PROVIDER_TECHNICAL_FAILURE_REASONS.has(result.reasonCode)) {
      return "UNAVAILABLE";
    }
    return "NOT_FOUND";
  }

  return result.withinTolerance === true ? "VERIFIED" : "ODDS_CHANGED";
}
