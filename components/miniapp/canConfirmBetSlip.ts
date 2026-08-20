import type { BetPreviewSelection, BetPreviewSuccess } from "./betPreviewApi";
import { translate } from "@/lib/i18n/translations";
import type { Locale } from "@/lib/i18n/locale";

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
// Stage M4.5 — exported (was module-private) so BetPreviewCard.tsx can
// drive its "Potential win" row and its single unavailable-odds notice off
// this exact same condition, instead of re-deriving an equivalent check
// from selection.submittedOdds independently.
export function isConfirmableSingleOdds(selection: BetPreviewSelection | undefined): boolean {
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

// Final product decision (see lib/bets/verifyPreviewFreshness.ts's
// decideFreshnessOutcome, the server-side enforcement point this mirrors):
// the odds provider must positively confirm a selection before the player
// may even attempt to confirm it. NOT_FOUND (the provider could not match
// this exact event/market), UNAVAILABLE (the provider couldn't verify
// anything right now), and the reserved-but-practically-unreachable PENDING
// default all block confirmation — a bet the provider never confirmed must
// never reach PENDING/the operator queue, so the button must never let the
// player attempt it in the first place, not merely fail server-side after
// the fact. ODDS_CHANGED is deliberately NOT included: that selection IS
// real and provider-confirmed, only the price moved — the player is still
// allowed to tap Confirm, which re-verifies and asks for a fresh
// confirmation (409 ODDS_CHANGED_RECONFIRM_REQUIRED) rather than being
// blocked client-side.
//
// Exported so BetPreviewCard.tsx can show the same "could not verify"
// messaging this exact same condition blocks Confirm for — one shared
// decision, never two independently-maintained copies.
const UNVERIFIED_ODDS_STATUSES: ReadonlySet<BetPreviewSelection["oddsStatus"]> = new Set([
  "NOT_FOUND",
  "UNAVAILABLE",
  "PENDING",
]);

export function hasUnverifiedOddsStatus(selections: readonly BetPreviewSelection[]): boolean {
  return selections.some((selection) => UNVERIFIED_ODDS_STATUSES.has(selection.oddsStatus));
}

// Stage M4.5 semantic review — the single correct "is this SINGLE
// selection's odds unavailable" signal, for presentation code (the
// "Potential win" row and the unavailable-odds notice). isConfirmableSingleOdds
// ALONE is not sufficient here: it only reads submittedOdds, which
// buildBetSlipPreview.ts's effectiveSubmittedOdds (see that file's own
// comment) can be non-null even when the provider lookup failed — a
// screenshot almost always carries a real OCR'd price regardless of
// whether the provider ever matched it. oddsStatus (server truth) must be
// checked first, exactly as canConfirmBetSlip's own gate and
// isOddsUnavailableForConfirm below already do; isConfirmableSingleOdds
// only adds the narrower, defensive "somehow still no submittedOdds
// despite a VERIFIED/ODDS_CHANGED status" case on top of that.
export function isSingleSelectionOddsUnavailable(selection: BetPreviewSelection): boolean {
  return hasUnverifiedOddsStatus([selection]) || !isConfirmableSingleOdds(selection);
}

// Sector 1 (ADR-0002) — a leg is offered for player-initiated exclusion
// only when the provider genuinely could not confirm it right now
// (NOT_FOUND/UNAVAILABLE) — never a VERIFIED/ODDS_CHANGED leg (out of
// Sector 1's approved scope: "VERIFIED legs в Sector 1 не делаем
// произвольно удаляемыми") and never the reserved-but-practically-
// unreachable PENDING. This is the client-side mirror of the identical
// rule enforced server-side in
// lib/bets/buildExpressLegExclusionPreview.ts's RECOVERABLE_ODDS_STATUSES —
// same "client mirrors server, server is the real gate" pattern as
// hasUnverifiedOddsStatus/canConfirmBetSlip above; this only decides
// whether BetPreviewCard.tsx shows the Remove affordance at all.
const RECOVERABLE_LEG_ODDS_STATUSES: ReadonlySet<BetPreviewSelection["oddsStatus"]> = new Set([
  "NOT_FOUND",
  "UNAVAILABLE",
]);

export function isRecoverableLeg(selection: BetPreviewSelection): boolean {
  return RECOVERABLE_LEG_ODDS_STATUSES.has(selection.oddsStatus);
}

export function canConfirmBetSlip(isReady: boolean, preview: BetPreviewSuccess | null): boolean {
  if (!isReady || preview === null || preview.previewToken === null) return false;

  if (hasUnverifiedOddsStatus(preview.preview.selections)) return false;

  // Step 15J.1 — SINGLE additionally requires finite, positive effective
  // odds (see isConfirmableSingleOdds above); every other slip type
  // (currently just EXPRESS) keeps its exact pre-existing behavior —
  // previewToken !== null (plus the odds-status gate above) alone.
  if (preview.preview.type === "SINGLE") {
    return isConfirmableSingleOdds(preview.preview.selections[0]);
  }

  return true;
}

// Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. True exactly when this preview
// cannot be confirmed because verified/current odds do not exist for at
// least one selection — the same structural signal canConfirmBetSlip
// already blocks Confirm for (hasUnverifiedOddsStatus, and for SINGLE also
// isConfirmableSingleOdds), factored out so BetTextForm/BetScreenshotForm
// can hide (not merely disable) the Confirm button. Deliberately does NOT
// read isReady/phase/previewToken the way canConfirmBetSlip does — those
// describe whether the app is ready to submit *right now* (e.g. mid
// "confirming" request), not whether the odds themselves are unavailable,
// so this must stay false once a confirm attempt is legitimately underway.
export function isOddsUnavailableForConfirm(preview: BetPreviewSuccess | null): boolean {
  if (preview === null) return false;
  if (hasUnverifiedOddsStatus(preview.preview.selections)) return true;
  if (preview.preview.type === "SINGLE") return !isConfirmableSingleOdds(preview.preview.selections[0]);
  return false;
}

// Step 15J.1 — the one place BetTextForm/BetScreenshotForm derive their
// Confirm button's label, so "Odds unavailable" is never duplicated inline
// in either form. `isConfirming` takes priority over the odds check so an
// in-flight confirm request (started before, e.g., a 409 reconfirm changed
// what's staged) never has its "Confirming..." label overwritten.
// Localization completion pass — `locale` defaults to "en" so every
// pre-existing call site/test that doesn't pass one keeps getting the exact
// same English label as before this pass; BetTextForm.tsx/
// BetScreenshotForm.tsx now explicitly pass the player's real current
// locale.
export function getConfirmButtonLabel(isConfirming: boolean, preview: BetPreviewSuccess | null, locale: Locale = "en"): string {
  if (isConfirming) return translate(locale, "confirm.confirming");
  if (hasUnresolvedSingleOdds(preview)) return translate(locale, "confirm.oddsUnavailable");
  return translate(locale, "confirm.confirmBet");
}
