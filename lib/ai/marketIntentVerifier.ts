// Stage BA-2D, Step 3 — a pure, deterministic verifier that compares a
// market/selection value ALREADY CLAIMED by the AI/parser/canonical output
// against the raw-text evidence Step 2 (lib/ai/marketIntentEvidence.ts)
// extracted. It only returns a verdict — it never corrects, swaps, infers,
// mutates, throws, or rejects anything. No production caller exists yet;
// nothing wires this in (mirrors lib/ai/numericRoleVerifier.ts's own
// Step 2 header exactly).
//
// Deliberately built against the canonical betting domain that already
// exists: MarketType/SelectionType (lib/odds/domain.ts) and
// ShorthandClassification (lib/odds/shorthandClassifier.ts, reused
// unmodified inside MarketIntentEvidence). No parallel "market intent"
// domain model is introduced here.

import type { MarketType, SelectionType } from "@/lib/odds/domain";
import type { ShorthandClassification } from "@/lib/odds/shorthandClassifier";
import type { MarketIntentEvidence } from "./marketIntentEvidence";
import type { NumericRoleVerdict } from "./numericRoleVerifier";

// Reused, not re-declared: BA-2D Step 1's own architecture audit explicitly
// recommended importing NumericRoleVerdict's shape rather than a second,
// independently-maintained 4-value union. The verdicts mean the same thing
// epistemically here (evidence-vs-claim agreement/disagreement/absence/
// self-contradiction) even though the domain being judged — market/
// selection semantics, not a numeric value — is entirely different, which
// is why this file's own comparison logic (below) is still a fresh
// implementation, not a shared function with numericRoleVerifier.ts.
export type MarketIntentVerdict = NumericRoleVerdict;

// Minimal by design: marketType + selectionType only. participantName is
// deliberately NOT part of this claim shape (see the "same market,
// different participant text" requirement this step was built against) —
// this verifier judges market/selection SEMANTICS only. A claim that
// carried a participant string would invite comparing it, which is exactly
// the false-rejection risk ("Arsenal" vs "Арсенал" transliteration/
// normalization differences) this step must not introduce. If a future
// stage needs participant-alignment checking, that is a distinct,
// separately-designed concern — not folded into this contract.
export interface MarketIntentClaim {
  readonly marketType: MarketType;
  readonly selectionType: SelectionType;
}

export interface MarketIntentVerification {
  readonly verdict: MarketIntentVerdict;
  // Evidence whose (marketType, selectionType) matches the claim.
  // Populated even when the verdict is AMBIGUOUS (diagnostic context) —
  // its presence is never itself proof of the verdict.
  readonly supportingEvidence: readonly MarketIntentEvidence[];
  // Evidence whose (marketType, selectionType) differs from the claim.
  // Populated even when the verdict is AMBIGUOUS.
  readonly conflictingEvidence: readonly MarketIntentEvidence[];
}

/* -------------------------------------------------------------------------- */
/* Semantic signature — (marketType, selectionType) ONLY                     */
/* -------------------------------------------------------------------------- */

// The exact structural comparison this stage requires: participant text and
// embeddedLine are never part of the signature, which is what makes
// "Арсенал"/"Arsenal" transliteration differences (section 5) and SPREAD
// -1.5 vs -2.5 / TOTALS OVER 2.5 vs OVER 3.0 numeric differences (section 6
// — that disagreement belongs entirely to BA-2B's own numeric verifier, not
// this one) never affect the verdict here. marketType is always compared
// too, never assumed equal — TOTALS/OVER and TEAM_TOTAL/OVER are DIFFERENT
// signatures (section 7's explicit requirement), even though both carry
// selectionType "OVER".
function signatureKey(classification: Pick<ShorthandClassification, "marketType" | "selectionType">): string {
  return `${classification.marketType}:${classification.selectionType}`;
}

function sameSignature(classification: Pick<ShorthandClassification, "marketType" | "selectionType">, claim: MarketIntentClaim): boolean {
  return classification.marketType === claim.marketType && classification.selectionType === claim.selectionType;
}

/* -------------------------------------------------------------------------- */
/* Same-evidence ambiguity — a property of the SOURCE, independent of what   */
/* the claim says, checked before any matching logic (same discipline as    */
/* numericRoleVerifier.ts's own detectSameRoleAmbiguity)                    */
/* -------------------------------------------------------------------------- */

// Two (or more) evidence occurrences with the IDENTICAL (marketType,
// selectionType) signature are NOT ambiguous — "победа победа Арсенал
// ставка 10" producing two MONEYLINE_2WAY/PARTICIPANT entries still means
// exactly one thing. AMBIGUOUS requires genuinely DISTINCT semantic
// intents in the same message (section 9's explicit requirement) — e.g.
// "Арсенал ТБ 2.5 ТМ 3.5" (TOTALS/OVER vs TOTALS/UNDER) or "ничья Арсенал
// победа" (MONEYLINE_3WAY/DRAW vs MONEYLINE_2WAY/PARTICIPANT). Never
// attempts to decide which intent the player "really meant" — both are
// simply reported as conflicting.
function distinctSignatures(evidence: readonly MarketIntentEvidence[]): ReadonlySet<string> {
  const signatures = new Set<string>();
  for (const entry of evidence) signatures.add(signatureKey(entry.classification));
  return signatures;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

// Never mutates `claim` or `evidence`. Never throws. Never selects a market
// or infers a missing one — the caller's claim is never altered, only
// judged against what the raw text's strong, closed-vocabulary evidence
// actually says. LINE/numeric disagreement is never consulted or judged
// here at all (BA-2B's own concern, entirely) — a SPREAD claim with a
// different signed line than SPREAD evidence still CORROBORATES on market
// intent (section 6, section 8 item 19).
export function verifyMarketIntentClaim(claim: MarketIntentClaim, evidence: readonly MarketIntentEvidence[]): MarketIntentVerification {
  const signatures = distinctSignatures(evidence);

  if (signatures.size === 0) {
    // No strong market-shape token anywhere in the original text at all
    // ("Арсенал 10", "ставка 10 на Арсенал") — absence of evidence is never
    // treated as evidence of contradiction (section 4's explicit rule).
    return { verdict: "UNVERIFIED", supportingEvidence: [], conflictingEvidence: [] };
  }

  const matching = evidence.filter((entry) => sameSignature(entry.classification, claim));
  const conflicting = evidence.filter((entry) => !sameSignature(entry.classification, claim));

  if (signatures.size >= 2) {
    return { verdict: "AMBIGUOUS", supportingEvidence: matching, conflictingEvidence: conflicting };
  }

  // Exactly one distinct signature exists in the source — every entry in
  // `evidence` shares it, so `matching`/`conflicting` are simply "does that
  // one signature equal the claim" split across however many (semantically
  // identical) occurrences were found.
  if (matching.length > 0) {
    return { verdict: "CORROBORATED", supportingEvidence: matching, conflictingEvidence: [] };
  }

  return { verdict: "CONTRADICTED", supportingEvidence: [], conflictingEvidence: conflicting };
}
