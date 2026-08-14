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

// Business priority (fixed, in this exact order — see decideFreshnessOutcome
// below). Final product decision: the odds provider must positively confirm
// an event/market before a Bet is ever created — the operator queue must
// never receive a bet the provider couldn't verify at all.
//   1. Any selection UNAVAILABLE/PENDING (provider couldn't verify anything
//      right now, a transient condition)      -> VERIFICATION_UNAVAILABLE
//   2. Else, any selection ODDS_CHANGED (the selection IS real and
//      provider-confirmed, only the price moved) -> ODDS_CHANGED (reconfirm)
//   3. Else, any selection NOT_FOUND (the provider could not match this
//      exact event/market at all)             -> SELECTION_UNAVAILABLE
//   4. Else — every selection is VERIFIED      -> ACCEPT
// NOT_FOUND is a blocking status: unlike ODDS_CHANGED (a real, confirmed
// selection whose price merely moved), NOT_FOUND means the provider never
// confirmed this selection exists at all, so confirm must refuse to create
// a Bet for it — never silently downgrade it to "let the operator sort it
// out". Implemented as explicit "does any selection have this status"
// checks, evaluated in priority order — not a numeric rank/Math.max — so
// the precedence is readable straight off decideFreshnessOutcome instead of
// being implied by which status was assigned the highest number.
export type VerifyPreviewFreshnessDecision =
  | { kind: "ACCEPT" }
  // Refreshed preview/token reuse buildBetSlipPreview's own BetSlipPreview
  // shape and signPreviewToken/signExpressPreviewToken (called internally
  // by buildBetSlipPreview, unmodified) — no second preview representation
  // exists. refreshedPreviewToken is guaranteed non-null/non-empty by
  // construction: ODDS_CHANGED is only ever returned after runtime-checking
  // that buildBetSlipPreview actually produced a real token (see
  // decideFreshnessOutcome below) — a reconfirmation-required response is
  // meaningless without something the client can actually resubmit.
  | { kind: "ODDS_CHANGED"; refreshedPreview: BetSlipPreview; refreshedPreviewToken: string }
  // Returned whenever the provider could not match a selection's exact
  // event/market at all (NOT_FOUND), and also when odds genuinely changed
  // but buildBetSlipPreview could not produce a signed refreshed EXPRESS
  // token to reconfirm against (an exempt null-odds leg elsewhere prevents
  // allOddsKnown) — see decideFreshnessOutcome. Either way: no Bet may be
  // created, the player must fix/retry, never the operator's problem to sort
  // out.
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
//
// Betting Markets V1, Phase 2 — line is reconstructed from the token's own
// canonicalLine, unlike market/event/selection above: there is no raw
// "line text" stored anywhere on the token to re-derive it from (line was
// extracted once, at parse time, before a token ever existed), so
// canonicalLine — the exact value originally signed — is the only honest
// source for a fresh re-verification pass to use.
// Stage M4.8 — this reconstruction feeds ParsedBetSlip.submittedOdds, which
// buildBetSlipPreview() treats as "the price to compare the fresh live fetch
// against" (the confirmation acceptance baseline) — NOT as "whatever the
// player originally submitted". Before this stage, this used payload.odds /
// selection.submittedOdds (the original screenshot/typed reference price),
// which never updates across reconfirm cycles: every subsequent freshness
// check kept comparing a fresh live price against that same first-ever
// number, forever, which could make a bet structurally unconfirmable if the
// live price had permanently moved away from it (see this stage's own
// root-cause trace, and PreviewTokenPayload.acceptedOdds's own comment).
// Now uses acceptedOdds / currentOdds — the CURRENT BetPilot price the
// player was actually just shown in the preview being confirmed — so each
// reconfirm cycle compares against what the player most recently saw, not
// against history.
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
          submittedOdds: payload.acceptedOdds,
          line: payload.canonicalLine ?? null,
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
      submittedOdds: selection.currentOdds !== null ? Number(selection.currentOdds) : null,
      line: selection.canonicalLine ?? null,
    })),
  };
}

// Stage M4.8 — "did this selection ever have ANY known price at preview
// time" (either the player's own reference OR a resolved current price) —
// the signal that decides whether a selection is exempt from gating (see
// verifyPreviewFreshness's own loop below). Deliberately reads the ORIGINAL
// token fields directly, never the reconstructed slip's submittedOdds
// (which, per reconstructParsedBetSlip above, is now acceptedOdds/
// currentOdds only) — a selection that had a real reference price but
// genuinely couldn't be matched (NOT_FOUND) must still be gated, never
// silently exempted just because its CURRENT price happens to be null.
function hadAnyKnownPriceAtPreviewTime(payload: AnyPreviewTokenPayload, index: number): boolean {
  if (payload.type === "SINGLE") {
    return payload.odds !== null || payload.acceptedOdds !== null;
  }

  const selection = payload.selections[index];
  return selection.submittedOdds !== null || selection.currentOdds !== null;
}

// The exact required precedence, expressed directly as "does any selection
// have this status" checks, evaluated in priority order — not a numeric
// rank/Math.max: each business rule is its own explicit branch, so the
// precedence is readable straight off this function instead of being
// implied by which status was assigned the highest number. Exported so
// lib/bets/verifyPreviewFreshness.test.ts can unit-test the PENDING case
// directly — mapOddsCheckToSelectionStatus (lib/odds/mapOddsStatus.ts)
// never actually produces PENDING through the real provider pipeline
// (confirmed by direct inspection: it's exhaustive over exactly
// null/matched:false/withinTolerance/else), so there is no way to reach it
// through an integration-style test that goes via buildBetSlipPreview().
export function decideFreshnessOutcome(
  statuses: readonly BetSlipPreviewSelection["oddsStatus"][],
  refreshedPreview: BetSlipPreview,
  refreshedPreviewToken: string | null,
): VerifyPreviewFreshnessDecision {
  // Priority 1 — a real provider outage (or the reserved-but-unreachable
  // PENDING, ranked identically as defense-in-depth) always wins,
  // regardless of what any other selection's status is: "try again
  // shortly" can never be downgraded to something more permissive just
  // because another leg happened to be fine or merely not-found.
  const hasVerificationUnavailable = statuses.some(
    (status) => status === "UNAVAILABLE" || status === "PENDING",
  );
  if (hasVerificationUnavailable) return { kind: "VERIFICATION_UNAVAILABLE" };

  // Priority 2 — the selection is real and a price genuinely moved; the
  // player must see and accept the new price before this bet can be
  // created. This still applies even when another selection in the same
  // EXPRESS slip is merely NOT_FOUND (priority 3) — NOT_FOUND being
  // acceptable does not mean a real, worse-than-preview price change on a
  // DIFFERENT leg gets silently waved through.
  const hasOddsChanged = statuses.some((status) => status === "ODDS_CHANGED");
  if (hasOddsChanged) {
    // A reconfirmation-required response is only valid when the server can
    // actually hand back something the client can resubmit.
    // buildBetSlipPreview's own previewToken is genuinely nullable for
    // EXPRESS (stays null whenever totalOdds/potentialWin couldn't be
    // computed — e.g. some OTHER, exempt null-submittedOdds leg is
    // present), so ODDS_CHANGED must never be returned with a null/empty
    // token. Explicit runtime narrowing (typeof + non-empty check), not a
    // `!` non-null assertion and not an `as string` cast — TypeScript's own
    // control-flow analysis narrows refreshedPreviewToken to `string` for
    // every line after this guard. When odds genuinely changed but no
    // valid reconfirmable token could be produced, the caller gets
    // SELECTION_UNAVAILABLE instead: the response cannot be safely
    // reconfirmed, there is no valid signed replacement, and the player
    // must generate a brand new preview from the beginning.
    if (typeof refreshedPreviewToken !== "string" || refreshedPreviewToken.length === 0) {
      return { kind: "SELECTION_UNAVAILABLE" };
    }
    return { kind: "ODDS_CHANGED", refreshedPreview, refreshedPreviewToken };
  }

  // Priority 3 — the provider could not match this exact event/market at
  // all. Unlike ODDS_CHANGED, there is no confirmed selection whose price
  // merely moved — nothing here is safely reconfirmable, and this must
  // never become a Bet the operator queue has to sort out. Reuses the
  // existing SELECTION_UNAVAILABLE kind (same contract the null-token
  // ODDS_CHANGED fallback above already uses) rather than introducing a new
  // decision kind.
  const hasNotFound = statuses.some((status) => status === "NOT_FOUND");
  if (hasNotFound) return { kind: "SELECTION_UNAVAILABLE" };

  // Priority 4 — every relevant selection is VERIFIED (or there were no
  // relevant selections at all, e.g. every leg had no originally-submitted
  // odds). The resulting Bet is created PENDING with the player's submitted
  // odds (createBetFromPreview.ts, unchanged), for the operator's final
  // confirm/reject.
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

  const relevantStatuses: BetSlipPreviewSelection["oddsStatus"][] = [];

  result.preview.selections.forEach((selection, index) => {
    // A selection with no known price at all (never a player reference NOR
    // a resolved current price) was never really priced to begin with —
    // buildBetSlipPreview.ts unconditionally skips verification for a null
    // submittedOdds (confirmed by direct inspection: such a selection's
    // index is never added to verifiableIndices, so its oddsCheck stays
    // exactly null, and mapOddsCheckToSelectionStatus(null) always returns
    // exactly "UNAVAILABLE" — never VERIFIED, never ODDS_CHANGED, and never
    // NOT_FOUND, since that branch requires a real, attempted oddsCheck).
    // This means such a selection's fresh status is deterministically,
    // structurally always "UNAVAILABLE" — not a newly-discovered problem,
    // but the exact same non-signal preview time already produced for it.
    // Treating this as a genuine "could not verify" signal here would make
    // every bet that ever had an unclaimed-odds leg permanently
    // unconfirmable, since this selection could structurally never produce
    // any other status — a correctness bug, not a stricter safety
    // improvement. Excluding it from gating is therefore the correct
    // realization of "freshness could not be confirmed" for THIS selection
    // specifically: there was never a claimed value to go stale.
    // Stage M4.8 — deliberately checked against hadAnyKnownPriceAtPreviewTime
    // (the ORIGINAL token fields), never against the reconstructed slip's
    // own submittedOdds (which is now acceptedOdds/currentOdds only, per
    // reconstructParsedBetSlip above): a selection that HAD a real
    // reference price but genuinely couldn't be matched (NOT_FOUND, so its
    // currentOdds is null) must still be gated, never silently exempted.
    // It does not affect any OTHER selection's own status in the same
    // slip, which is still gated normally (see the dedicated
    // "does not hide UNAVAILABLE" test).
    if (!hadAnyKnownPriceAtPreviewTime(payload, index)) return;

    relevantStatuses.push(selection.oddsStatus);
  });

  return decideFreshnessOutcome(relevantStatuses, result.preview, result.previewToken);
}
