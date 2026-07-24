// Step 11B — confirmation-time odds freshness verification. A pure domain
// service: no HTTP, no Next.js, no Response objects, no JSON, no status
// codes, no database, no wallet mutation, no bet creation. It reconstructs
// a ParsedBetSlip from an already-verified preview token payload and calls
// the existing, unmodified buildBetSlipPreview() exactly once — the same
// production odds-verification pipeline every preview (text, screenshot,
// Telegram /odds, Telegram natural-language) already goes through. This
// file owns nothing about signature/expiry/player-match verification
// (already done by the caller before this is ever reached) and nothing
// about persistence (also the caller's job, after inspecting the decision
// this returns).
//
// No canonical mapping, legacy-bridge translation, or provider call is
// duplicated here: buildBetSlipPreview() already owns all of that, via the
// exact same legacyOddsBridge.ts/OddsVerificationService/TheOddsApiProvider
// path used at preview time. This file's only original logic is deciding
// what a fresh BetSlipPreview's per-selection oddsStatus means for a
// confirmation that already happened once before.

import type { ParsedBetSlip } from "@/lib/bets/betSlip";
import {
  buildBetSlipPreview,
  type BetSlipPreview,
  type BetSlipPreviewSelection,
  type BuildBetSlipPreviewOptions,
} from "@/lib/bets/buildBetSlipPreview";
import type { AnyPreviewTokenPayload } from "@/lib/betPreview/previewToken";

// Pre-commit review correction — NOT_FOUND (the selection/event/market is
// genuinely gone) and UNAVAILABLE (the provider itself could not verify
// anything right now, a transient condition) are deliberately kept as two
// separate outcomes, never collapsed: NOT_FOUND is a durable "this exact
// bet can't be reconfirmed" signal, UNAVAILABLE is a "try again shortly"
// signal — conflating them would misrepresent one as the other to the
// caller, exactly what this correction fixes.
export type VerifyPreviewFreshnessDecision =
  | { kind: "ACCEPT" }
  // Refreshed preview/token reuse buildBetSlipPreview's own BetSlipPreview
  // shape and signPreviewToken/signExpressPreviewToken (called internally
  // by buildBetSlipPreview, unmodified) — no second preview representation
  // exists. refreshedPreviewToken is guaranteed non-null/non-empty by
  // construction: ODDS_CHANGED is only ever returned after runtime-checking
  // that buildBetSlipPreview actually produced a real token (see
  // decisionForWorstRank below) — a reconfirmation-required response is
  // meaningless without something the client can actually resubmit.
  | { kind: "ODDS_CHANGED"; refreshedPreview: BetSlipPreview; refreshedPreviewToken: string }
  // Also returned (instead of ODDS_CHANGED) when odds genuinely changed but
  // buildBetSlipPreview could not produce a signed refreshed token to
  // reconfirm against (see decisionForWorstRank) — never alongside an
  // unresolved or missing leg either: a reconfirmable refreshed preview
  // must never contain an unverified or missing leg.
  | { kind: "SELECTION_UNAVAILABLE" }
  | { kind: "VERIFICATION_UNAVAILABLE" };

// Same DI seams buildBetSlipPreview.ts itself already exposes — passed
// straight through, never wrapped or reinterpreted. Production passes
// neither, so buildBetSlipPreview falls through to its own default
// (real) provider/service, exactly as it does at preview time.
export interface VerifyPreviewFreshnessOptions {
  verifyOddsFn?: BuildBetSlipPreviewOptions["verifyOddsFn"];
  oddsVerificationService?: BuildBetSlipPreviewOptions["oddsVerificationService"];
}

// Every field needed already exists on the token — market is display-only
// and never consulted by buildBetSlipPreview's own odds-verification
// routing (legacySelectionToCanonicalRequest never reads it), so a SINGLE
// payload's absent market field is not a gap: null here means exactly what
// it always has meant for a SINGLE bet elsewhere in this codebase
// (lib/bets/betSlip.ts's normalizeParsedBet does the same).
function reconstructParsedBetSlip(payload: AnyPreviewTokenPayload): ParsedBetSlip {
  if (payload.type === "SINGLE") {
    return {
      type: "SINGLE",
      stake: payload.stake,
      selections: [
        {
          sport: payload.sport,
          event: payload.event,
          market: null,
          selection: payload.outcome,
          submittedOdds: payload.odds,
        },
      ],
    };
  }

  // EXPRESS token fields are decimal strings (mirrors Prisma.Decimal's own
  // toString() convention, per previewToken.ts's own comment) — converted
  // to numbers here only because ParsedBetSlip.stake/submittedOdds are
  // numbers, the same conversion createBetFromPreview.ts already performs
  // in the opposite direction via `new Prisma.Decimal(payload.stake)`.
  return {
    type: "EXPRESS",
    stake: Number(payload.stake),
    selections: payload.selections.map((selection) => ({
      sport: selection.sport,
      event: selection.event,
      market: selection.market,
      selection: selection.outcome,
      submittedOdds: selection.submittedOdds !== null ? Number(selection.submittedOdds) : null,
    })),
  };
}

// Section 3/4 of the pre-commit review — the exact required precedence,
// implemented as a "take the single worst status across every
// freshness-relevant selection" ranking rather than a chain of independent
// booleans (which is what previously, incorrectly, let ODDS_CHANGED
// outrank UNAVAILABLE/NOT_FOUND). Higher rank always wins:
//   0 VERIFIED           -> contributes nothing
//   1 ODDS_CHANGED        -> odds moved, but the selection IS still real
//   2 NOT_FOUND            -> the selection/event/market is gone
//   3 UNAVAILABLE/PENDING  -> could not verify anything right now (transient)
// This directly encodes every required combination: ODDS_CHANGED+UNAVAILABLE
// -> rank 3 -> VERIFICATION_UNAVAILABLE; ODDS_CHANGED+NOT_FOUND -> rank 2 ->
// SELECTION_UNAVAILABLE; NOT_FOUND+UNAVAILABLE -> rank 3 ->
// VERIFICATION_UNAVAILABLE. PENDING is ranked identically to UNAVAILABLE,
// defensively — mapOddsCheckToSelectionStatus (lib/odds/mapOddsStatus.ts)
// never actually produces it, but nothing here assumes that will always
// remain true.
const STATUS_RANK: Record<BetSlipPreviewSelection["oddsStatus"], number> = {
  VERIFIED: 0,
  ODDS_CHANGED: 1,
  NOT_FOUND: 2,
  UNAVAILABLE: 3,
  PENDING: 3,
};

// Final pre-commit correction — a reconfirmation-required response is only
// valid when the server can actually hand back something the client can
// resubmit. buildBetSlipPreview's own previewToken is genuinely nullable
// for EXPRESS (it stays null whenever totalOdds/potentialWin couldn't be
// computed — e.g. some OTHER, exempt null-submittedOdds leg is present), so
// ODDS_CHANGED must never be returned with a null/empty token: that would
// be a domain contract lying about what the caller can do with the result.
// This function proves the token exists at runtime (typeof + non-empty
// check) before ever constructing the ODDS_CHANGED variant — no `!`
// non-null assertion and no `as string` cast anywhere. When odds genuinely
// changed but no valid reconfirmable token could be produced, the caller
// gets SELECTION_UNAVAILABLE instead: the response cannot be safely
// reconfirmed, there is no valid signed replacement, and the player must
// generate a brand new preview from the beginning — never a stale/old
// token, never a fabricated one, and never the misleading transient
// VERIFICATION_UNAVAILABLE code (verification itself DID complete; only
// token generation did not).
function decisionForWorstRank(
  worstRank: number,
  refreshedPreview: BetSlipPreview,
  refreshedPreviewToken: string | null,
): VerifyPreviewFreshnessDecision {
  if (worstRank >= 3) return { kind: "VERIFICATION_UNAVAILABLE" };
  if (worstRank === 2) return { kind: "SELECTION_UNAVAILABLE" };

  if (worstRank === 1) {
    // Explicit runtime narrowing (typeof + length check), not a `!`
    // non-null assertion and not an `as string` cast — TypeScript's own
    // control-flow analysis narrows refreshedPreviewToken to `string` for
    // every line after this guard, satisfying the ODDS_CHANGED variant's
    // required (non-optional, non-null) field type genuinely, not just
    // superficially.
    if (typeof refreshedPreviewToken !== "string" || refreshedPreviewToken.length === 0) {
      return { kind: "SELECTION_UNAVAILABLE" };
    }
    return { kind: "ODDS_CHANGED", refreshedPreview, refreshedPreviewToken };
  }

  return { kind: "ACCEPT" };
}

export async function verifyPreviewFreshness(
  payload: AnyPreviewTokenPayload,
  previewTokenSecret: string,
  options: VerifyPreviewFreshnessOptions = {},
): Promise<VerifyPreviewFreshnessDecision> {
  const slip = reconstructParsedBetSlip(payload);

  const buildOptions: BuildBetSlipPreviewOptions = {};
  if (options.oddsVerificationService) {
    buildOptions.oddsVerificationService = options.oddsVerificationService;
  } else if (options.verifyOddsFn) {
    buildOptions.verifyOddsFn = options.verifyOddsFn;
  }

  // The one and only reuse of buildBetSlipPreview() — this IS the fresh
  // odds verification (real provider call, real OddsVerificationService,
  // real legacy-bridge translation), never re-implemented here.
  const result = await buildBetSlipPreview(slip, payload.playerId, previewTokenSecret, buildOptions);

  let worstRank = 0;

  result.preview.selections.forEach((selection, index) => {
    const originalSubmittedOdds = slip.selections[index].submittedOdds;

    // A selection with no originally-submitted odds was never sent to the
    // provider at preview time either — buildBetSlipPreview.ts
    // unconditionally skips verification for a null submittedOdds
    // (confirmed by direct inspection: such a selection's index is never
    // added to verifiableIndices, so its oddsCheck stays exactly null, and
    // mapOddsCheckToSelectionStatus(null) always returns exactly
    // "UNAVAILABLE" — never VERIFIED, never ODDS_CHANGED, and never
    // NOT_FOUND, since that branch requires a real, attempted oddsCheck).
    // This means a null-submittedOdds selection's fresh status is
    // deterministically, structurally always "UNAVAILABLE" — not a
    // newly-discovered problem, but the exact same non-signal preview time
    // already produced for it (lib/bets/betSlipRules.ts's
    // canSubmitBetSlip already permits submitting such a selection for
    // operator review). Treating this as a genuine "could not verify"
    // signal here would make every bet that ever had an unclaimed-odds leg
    // permanently unconfirmable, since this selection could structurally
    // never produce any other status — a correctness bug, not a stricter
    // safety improvement. Excluding it from gating is therefore the
    // correct realization of "freshness could not be confirmed" for THIS
    // selection specifically: there was never a claimed value to go stale.
    // It does not affect any OTHER selection's own status in the same
    // slip, which is still gated normally (see the dedicated
    // "does not hide UNAVAILABLE" test).
    if (originalSubmittedOdds === null) return;

    const rank = STATUS_RANK[selection.oddsStatus];
    if (rank > worstRank) worstRank = rank;
  });

  return decisionForWorstRank(worstRank, result.preview, result.previewToken);
}
