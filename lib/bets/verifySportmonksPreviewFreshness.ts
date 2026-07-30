// Stage 10.2 — confirmation-time revalidation for a Sportmonks-sourced
// SINGLE preview token. Mirrors lib/bets/verifyPreviewFreshness.ts exactly
// in spirit: no HTTP, no database, no bet creation, no balance mutation —
// it re-runs the same live resolution/safety-check/odds-fetch preview
// build ran (buildSportmonksFootballPreview, unmodified) and reuses that
// file's own decideFreshnessOutcome for the actual odds-change decision
// (same 3% tolerance, same ACCEPT/ODDS_CHANGED/SELECTION_UNAVAILABLE/
// VERIFICATION_UNAVAILABLE priority order lib/odds/oddsVerifier.ts's
// ODDS_TOLERANCE_PERCENT and mapOddsCheckToSelectionStatus already use for
// The Odds API — no new financial policy is introduced here).

import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import type { BetSlipPreview } from "@/lib/bets/buildBetSlipPreview";
import { decideFreshnessOutcome, type VerifyPreviewFreshnessDecision } from "@/lib/bets/verifyPreviewFreshness";
import {
  buildSportmonksFootballPreview,
  signSportmonksFootballPreviewToken,
  type BuildSportmonksFootballPreviewOptions,
  type SportmonksFootballPreviewResult,
} from "@/lib/bets/buildSportmonksFootballPreview";
import type { PreviewTokenPayload } from "@/lib/betPreview/previewToken";
import type { BetSelectionOddsStatus } from "@/lib/generated/prisma/client";

// Same literal value as lib/odds/oddsVerifier.ts's own ODDS_TOLERANCE_PERCENT
// (not exported there) — duplicated by value, not reinvented: this is the
// one existing tolerance policy this codebase has, applied identically
// here so a Sportmonks bet is never held to a different standard than a
// The Odds API one.
const ODDS_TOLERANCE_PERCENT = 3;

function statusForResult(result: SportmonksFootballPreviewResult, originalOdds: number): BetSelectionOddsStatus {
  if (result.kind === "SUCCESS") {
    const current = result.preview.selections[0].currentOdds;
    if (current === null || current === 0) return "UNAVAILABLE";
    const discrepancyPercent = Number((((originalOdds - current) / current) * 100).toFixed(2));
    return Math.abs(discrepancyPercent) <= ODDS_TOLERANCE_PERCENT ? "VERIFIED" : "ODDS_CHANGED";
  }

  // The event/selection could not be re-confirmed exactly as originally
  // described (renamed, no longer resolvable, ambiguous now, the query
  // shape itself invalid, or the match has since kicked off) — matches
  // NOT_FOUND's existing meaning: nothing here is safely reconfirmable,
  // this must never become a Bet.
  if (
    result.kind === "TEAM_NOT_FOUND" ||
    result.kind === "AMBIGUOUS" ||
    result.kind === "INVALID_QUERY" ||
    result.kind === "UNSUPPORTED_SELECTION" ||
    result.kind === "ALREADY_STARTED"
  ) {
    return "NOT_FOUND";
  }

  // ODDS_UNAVAILABLE / FAILED / NOT_APPLICABLE — a transient or
  // provider-side condition, not a confirmed absence.
  return "UNAVAILABLE";
}

export interface VerifySportmonksPreviewFreshnessOptions {
  readonly buildOptions?: BuildSportmonksFootballPreviewOptions;
  readonly previewTokenSecret?: string;
}

export async function verifySportmonksPreviewFreshness(
  payload: PreviewTokenPayload,
  previewTokenSecret: string,
  options: VerifySportmonksPreviewFreshnessOptions = {},
): Promise<VerifyPreviewFreshnessDecision> {
  // payload.odds is guaranteed non-null by the confirm route's existing
  // ODDS_REQUIRED_BEFORE_CONFIRMATION guard, which runs before this is ever
  // reached — same precondition verifyPreviewFreshness's SINGLE caller
  // already relies on.
  const originalOdds = payload.odds as number;

  const slip: ParsedBetSlip = {
    type: "SINGLE",
    stake: payload.stake,
    selections: [{ sport: payload.sport, event: payload.event, market: null, selection: payload.outcome, submittedOdds: null }],
  };

  const result = await buildSportmonksFootballPreview(slip, options.buildOptions);
  const status = statusForResult(result, originalOdds);

  let refreshedPreview: BetSlipPreview;
  let refreshedPreviewToken: string | null = null;

  if (result.kind === "SUCCESS") {
    refreshedPreview = result.preview;
    if (status === "ODDS_CHANGED") {
      const secret = options.previewTokenSecret ?? previewTokenSecret;
      refreshedPreviewToken = signSportmonksFootballPreviewToken(payload.playerId, result, secret);
    }
  } else {
    // Never read by decideFreshnessOutcome for any status other than
    // ODDS_CHANGED (see that function's own body) — a minimal, honest
    // empty preview is enough; nothing here signs a token for a resolution
    // that just failed to re-confirm.
    refreshedPreview = { type: "SINGLE", stake: payload.stake, totalOdds: null, potentialWin: null, selections: [] };
  }

  return decideFreshnessOutcome([status], refreshedPreview, refreshedPreviewToken);
}
