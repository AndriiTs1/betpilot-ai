// MASTER STAGE M4.0 — types and pure comparison logic only. No live model
// call lives in this file, and nothing here is invoked by the production
// screenshot pipeline (app/api/miniapp/bets/screenshot/preview/route.ts,
// lib/ocr/recognizeBetSlipScreenshot.ts) yet. This is the shape M4.1 would
// eventually populate from a real vision call (see this stage's own report,
// Phase 5, for the one-call-vs-two-call recommendation) — defined now so
// dark-launch diagnostics (lib/logging/screenshotDarkLaunchDiagnostic.ts)
// and fixture expectations (lib/testing/screenshotFixtures.ts) have a real,
// reusable type to target instead of each inventing their own ad hoc shape.
//
// Deliberately extends lib/ocr/regionDetection.ts's existing NormalizedRegion
// (screenshotPreprocessing.ts) rather than redeclaring x/y/width/height —
// this file's own contribution is the SECOND region (the selected control)
// and the bookmaker-agnostic `kind` vocabulary for it, not a new geometry
// type.

import type { NormalizedRegion } from "./screenshotPreprocessing";

// Bookmaker-agnostic visual cues only — never a bookmaker name, never a
// fixed pixel/device coordinate. Mirrors the audit's own "Allowed visual
// cues" list: a highlighted/active control, a filled state, a check mark, a
// visually active row, or the bet-slip card containing the active
// selection. UNKNOWN covers "a selected region was found, but its own
// visual signal didn't cleanly map to one of the named cues" — still a real
// region, just an honestly-uncertain reason, never guessed at.
export type SelectedRegionKind = "HIGHLIGHTED_CONTROL" | "FILLED_STATE" | "CHECK_MARK" | "ACTIVE_ROW" | "BET_SLIP_CARD" | "UNKNOWN";

// Mirrors lib/ocr/regionDetection.ts's own RegionDetectionOutcome discriminated-
// kind convention. NOT_ATTEMPTED is new here: this stage's own dark-launch
// posture means a caller may deliberately choose not to invoke localization
// at all for a given request (cost/rollout control), which is a genuinely
// different state from every existing outcome (all of which imply a call was
// made). FOUND_SLIP_ONLY covers the common, honest case where the bet-slip
// region itself is confidently found but no single control could be
// determined to be "the selected one" — still useful (see
// wouldLocalizedPathDiffer below), never conflated with NOT_FOUND.
export type LocalizationStatus =
  | "NOT_ATTEMPTED"
  | "FOUND_BOTH"
  | "FOUND_SLIP_ONLY"
  | "NOT_FOUND"
  | "INVALID"
  | "TIMEOUT"
  | "ERROR";

export interface LocalizedRegion extends NormalizedRegion {
  readonly confidence: number;
}

export interface SelectedRegion extends NormalizedRegion {
  readonly confidence: number;
  readonly kind: SelectedRegionKind;
}

// The full shadow-localization result for one screenshot. Both regions are
// independently nullable (see LocalizationStatus above) — a caller must
// never assume betSlipRegion present implies selectedRegion present, or vice
// versa.
export interface SelectedRegionLocalization {
  readonly betSlipRegion: LocalizedRegion | null;
  readonly selectedRegion: SelectedRegion | null;
  readonly localizationStatus: LocalizationStatus;
}

/* -------------------------------------------------------------------------- */
/* Shadow decision comparison — pure, no I/O, never called by any production */
/* route. Exists so a dark-launch diagnostic (or a fixture-driven test) can  */
/* answer "would the localized-evidence path have decided differently from  */
/* the current whole-screen path" from already-computed verdicts, without   */
/* re-implementing lib/ai/betParser.ts's own isUnreliableNumericClaim/       */
/* isUnreliableMarketClaim policy a second time — those two functions stay  */
/* the only real policy; this is a read-only comparison of their outcome.   */
/* -------------------------------------------------------------------------- */

// Mirrors lib/ai/numericRoleVerifier.ts's NumericRoleVerdict /
// lib/ai/marketIntentVerifier.ts's MarketIntentVerdict, plus one addition:
// NOT_AVAILABLE, for whenever a localized verdict genuinely could not be
// computed (localization/OCR failed or was never attempted) — distinct from
// UNVERIFIED (which means "evidence was extracted and considered, and
// found no strong signal either way"), so a caller/diagnostic can always
// tell "we don't know yet" apart from "we checked, and found nothing".
export type ShadowVerdict = "CORROBORATED" | "CONTRADICTED" | "UNVERIFIED" | "AMBIGUOUS" | "NOT_AVAILABLE";

// The production, already-decided outcome for one screenshot request —
// deliberately a closed three-way enum (never a raw ParseBetSlipResult),
// since this comparator only ever needs to know WHICH gate (if either)
// actually rejected, not the full parse result.
export type CurrentFinalDecision = "ACCEPTED" | "REJECTED_NUMERIC" | "REJECTED_MARKET";

export interface DecisionComparisonInput {
  readonly currentNumericVerdict: ShadowVerdict;
  readonly localizedNumericVerdict: ShadowVerdict;
  readonly currentMarketVerdict: ShadowVerdict;
  readonly localizedMarketVerdict: ShadowVerdict;
  readonly currentFinalDecision: CurrentFinalDecision;
}

// Same CONTRADICTED/AMBIGUOUS-reject, everything-else-continue policy as
// lib/ai/betParser.ts's isUnreliableNumericClaim/isUnreliableMarketClaim —
// intentionally re-expressed here (not imported) since those two functions
// operate on NumericRoleObservation/MarketIntentObservation, a materially
// different, heavier shape this comparator has no need for; duplicating the
// two-line boolean rule is safer than manufacturing fake observation objects
// just to reuse it. If that policy ever changes, this must be updated to
// match — there is no structural link enforcing that today, which is exactly
// why this function is documented as comparison-only, never itself a
// decision path.
function rejectsUnderPolicy(verdict: ShadowVerdict): boolean {
  return verdict === "CONTRADICTED" || verdict === "AMBIGUOUS";
}

// NOT_AVAILABLE never rejects on its own (same "absence of evidence is not
// evidence of a problem" principle UNVERIFIED already carries) — a localized
// verdict that could not be computed must never be treated as if it had
// found a conflict; it simply cannot corroborate or refute anything yet.
export function wouldLocalizedPathDiffer(input: DecisionComparisonInput): boolean {
  const currentRejected = input.currentFinalDecision !== "ACCEPTED";
  const localizedWouldReject = rejectsUnderPolicy(input.localizedNumericVerdict) || rejectsUnderPolicy(input.localizedMarketVerdict);
  return currentRejected !== localizedWouldReject;
}
