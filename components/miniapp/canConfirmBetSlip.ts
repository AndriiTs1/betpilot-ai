import type { BetPreviewSelection, BetPreviewSuccess } from "./betPreviewApi";

// Stage 12, Phase 4, Step 5 — extracted out of BetTextForm.tsx and
// BetScreenshotForm.tsx, which had this exact condition duplicated
// byte-for-byte (both dropped the same `preview.preview.type === "SINGLE"`
// clause this step, since EXPRESS confirm is now implemented end-to-end).
// previewToken !== null is the one real technical guard: it's null exactly
// when there's nothing valid to submit yet (odds still unknown for some
// EXPRESS selection, or the preview hasn't resolved), regardless of
// SINGLE/EXPRESS. `isReady` is passed in rather than a raw phase string so
// this one function works for both forms' slightly different FormPhase
// unions without this file needing to know either of them.
//
// Step 15J.1 — mirrors the backend's exact confirmation invariant
// (app/api/miniapp/bets/text/confirm/route.ts: `if (payload.odds === null)`
// -> 422 ODDS_REQUIRED_BEFORE_CONFIRMATION) using the same structured field
// the backend itself signs into the SINGLE previewToken:
// preview.selections[0].submittedOdds. This is already the EFFECTIVE odds
// value — lib/bets/buildBetSlipPreview.ts's `effectiveSubmittedOdds` folds
// a provider-promoted price in here whenever the player submitted none — so
// a manually-typed number and a provider-promoted number are treated
// identically, exactly like the backend. Never derived from oddsStatus,
// error/status text, or which route produced the preview: those are
// explicitly out of scope for this invariant (see this file's own
// hasUnresolvedSingleOdds/getConfirmButtonLabel below, which read this
// exact same field and nothing else).
function isConfirmableSingleOdds(selection: BetPreviewSelection | undefined): boolean {
  if (!selection) return false;
  const { submittedOdds } = selection;
  // Number.isFinite rejects both NaN and +/-Infinity; the `> 0` guard
  // additionally rejects zero and negative values — none of these are ever
  // legitimate decimal odds, so none may be treated as confirmable.
  return submittedOdds !== null && Number.isFinite(submittedOdds) && submittedOdds > 0;
}

// Exported so BetTextForm/BetScreenshotForm can derive the "Odds
// unavailable" button label/messaging from the exact same structural
// condition canConfirmBetSlip's own SINGLE gate below uses — never a
// second, independently-maintained copy of the rule. Always false for
// EXPRESS/no preview: this predicate exists specifically to describe the
// one new SINGLE-only blocking reason this step adds, not a general
// "is anything wrong with this preview" check.
export function hasUnresolvedSingleOdds(preview: BetPreviewSuccess | null): boolean {
  if (preview === null || preview.preview.type !== "SINGLE") return false;
  return !isConfirmableSingleOdds(preview.preview.selections[0]);
}

export function canConfirmBetSlip(isReady: boolean, preview: BetPreviewSuccess | null): boolean {
  if (!isReady || preview === null || preview.previewToken === null) return false;

  // Step 15J.1 — SINGLE additionally requires finite, positive effective
  // odds (see isConfirmableSingleOdds above); every other slip type
  // (currently just EXPRESS) keeps its exact pre-existing behavior —
  // previewToken !== null alone, unchanged from before this step. Not
  // redesigning EXPRESS/operator-review gating here, per this step's scope.
  if (preview.preview.type === "SINGLE") {
    return isConfirmableSingleOdds(preview.preview.selections[0]);
  }

  return true;
}

// Step 15J.1 — the one place BetTextForm/BetScreenshotForm derive their
// Confirm button's label, so "Odds unavailable" is never duplicated inline
// in either form. `isConfirming` takes priority over the odds check so an
// in-flight confirm request (started before, e.g., a 409 reconfirm changed
// what's staged) never has its "Confirming..." label overwritten.
export function getConfirmButtonLabel(isConfirming: boolean, preview: BetPreviewSuccess | null): string {
  if (isConfirming) return "Confirming...";
  if (hasUnresolvedSingleOdds(preview)) return "Odds unavailable";
  return "Confirm bet";
}
