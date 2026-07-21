import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

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
// Important, checked against the *actual* current OddsCheckResult shape
// (types/oddsSnapshot.ts) before writing this, not assumed: every failure
// path inside verifyOdds() (unsupported sport, provider timeout/error, no
// matching event, no bookmaker odds, selection not found) returns the same
// `matched: false` with only a free-text `note` distinguishing *why* —
// there is no structured reason code on this type today. That means this
// mapper genuinely cannot distinguish "event/selection not found" from "a
// technical failure occurred while checking" when matched is false; both
// collapse to NOT_FOUND below. A future stage could split this further by
// adding a structured reason field to OddsCheckResult itself — out of
// scope for Phase 2, which only maps the type as it exists today.
export function mapOddsCheckToSelectionStatus(result: OddsCheckResult | null): BetSelectionOddsStatus {
  if (result === null) {
    return "UNAVAILABLE";
  }

  if (!result.matched) {
    return "NOT_FOUND";
  }

  return result.withinTolerance === true ? "VERIFIED" : "ODDS_CHANGED";
}
