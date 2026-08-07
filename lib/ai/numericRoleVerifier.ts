// Stage BA-2B, Step 2 — a pure, deterministic verifier that compares a
// numeric value ALREADY CLAIMED by the AI/parser output (stake / line /
// odds) against the raw-text evidence Step 1
// (lib/ai/numericRoleEvidence.ts) extracted. It only returns a verdict —
// it never corrects, swaps, infers, mutates, throws, or rejects anything.
// No production caller exists yet; nothing wires this in.
//
// Deliberately built against the numeric TYPES that already exist:
// ParsedBetSlip.stake is a `number`, BetSlipSelectionInput.submittedOdds is
// `number | null`, BetSlipSelectionInput.line is `string | null`
// (lib/bets/betSlip.ts); UniversalBetDraft.stake is a decimal `string`,
// UniversalBetDraftSelection.submittedOdds is `string | null`
// (lib/bets/draft/domain.ts). No new parallel bet model is introduced here
// — NumericRoleClaim.value accepts `string | number` specifically so a
// caller can hand either shape's own value straight through, unconverted.

import { sameNumericValue, type NumericRole, type NumericRoleEvidence, type NumericRoleEvidenceConfidence } from "./numericRoleEvidence";

// AMBIGUOUS added on review (not part of the original three-verdict design):
// the source text itself can contain two DISTINCT, explicit MARKER_HIGH
// values for the same role (e.g. "ставка 10, ставка 20") — a genuinely
// different epistemic state from UNVERIFIED ("no evidence") or CONTRADICTED
// ("evidence disagrees with THIS specific claim"). Collapsing "the text
// contradicts itself" into UNVERIFIED would force any future consumer to
// re-derive that distinction by inspecting array contents instead of
// reading the verdict — a fourth explicit state is the more honest,
// self-describing design, and costs nothing today since nothing downstream
// exists yet to migrate.
export type NumericRoleVerdict = "CORROBORATED" | "CONTRADICTED" | "UNVERIFIED" | "AMBIGUOUS";

export interface NumericRoleClaim {
  readonly role: NumericRole;
  readonly value: string | number;
}

export interface NumericRoleVerification {
  readonly verdict: NumericRoleVerdict;
  // Same-role evidence that numerically matches the claim. Populated even
  // when the verdict is UNVERIFIED (e.g. a matching SOLE_CANDIDATE entry,
  // present but not strong enough on its own to CORROBORATE) — its
  // presence is diagnostic context, never itself proof of the verdict.
  readonly supportingEvidence: readonly NumericRoleEvidence[];
  // Same-role evidence with a DIFFERENT numeric value than the claim.
  // Populated even when the verdict is UNVERIFIED (e.g. a non-matching
  // MARKER_LOW entry, too weak to hard-CONTRADICT on its own).
  readonly conflictingEvidence: readonly NumericRoleEvidence[];
}

/* -------------------------------------------------------------------------- */
/* Confidence policy                                                          */
/* -------------------------------------------------------------------------- */

// MARKER_HIGH and MARKER_LOW can both actively CONFIRM a claim — even a
// weak/ambiguous marker like "на" is still real textual evidence the player
// wrote, and requiring it to also carry the higher CONTRADICTED bar (below)
// before it can even support a match would make Step 1's MARKER_LOW tier
// pointless. SOLE_CANDIDATE deliberately never corroborates on its own: it
// is "the one number nothing else explains," not evidence that a specific
// ROLE was intended — a claim that happens to equal it is unverified, not
// confirmed, matching this stage's own worked example (`Арсенал победа 10`,
// claim STAKE=10 against only a SOLE_CANDIDATE=10 entry -> UNVERIFIED).
const CORROBORATING_CONFIDENCES: ReadonlySet<NumericRoleEvidenceConfidence> = new Set(["MARKER_HIGH", "MARKER_LOW"]);

// Only MARKER_HIGH can CONTRADICT. MARKER_LOW ("на") is too common a
// preposition to justify a hard negative signal on its own — a mismatch
// against it is real context (surfaced in conflictingEvidence either way)
// but must never alone flip the verdict to CONTRADICTED. SOLE_CANDIDATE
// never contradicts either, by the same reasoning as above: it was never
// strong evidence FOR a role in the first place, so a mismatch against it
// cannot be strong evidence AGAINST a claim either. This asymmetric bar
// (corroborate: HIGH+LOW; contradict: HIGH only) is the deliberate design
// choice that keeps false-positive CONTRADICTED verdicts rare, per this
// stage's explicit goal.
const CONTRADICTING_CONFIDENCES: ReadonlySet<NumericRoleEvidenceConfidence> = new Set(["MARKER_HIGH"]);

/* -------------------------------------------------------------------------- */
/* Numeric comparison                                                         */
/* -------------------------------------------------------------------------- */

// A malformed claimed value (NaN, Infinity, empty string, garbage) can
// never be meaningfully verified against anything — this is not this
// verifier's validation to perform (a different layer's job), so it
// degrades to UNVERIFIED rather than crashing or fabricating a verdict.
//
// JS's own `Number("")` coerces to 0 (a well-known gotcha) — an empty or
// whitespace-only string is explicitly rejected BEFORE that coercion so it
// is never silently treated as a real, comparable "0" claim.
function isComparableNumber(value: string | number): boolean {
  if (typeof value === "string" && value.trim().length === 0) return false;
  const numeric = typeof value === "number" ? value : Number(value.replace(",", "."));
  return Number.isFinite(numeric);
}

function claimMatchesEvidence(claim: NumericRoleClaim, evidence: NumericRoleEvidence): boolean {
  return sameNumericValue(String(claim.value), evidence.value);
}

/* -------------------------------------------------------------------------- */
/* Same-role ambiguity — a property of the SOURCE, checked before any        */
/* matching logic                                                             */
/* -------------------------------------------------------------------------- */

// Only MARKER_HIGH entries are considered — a single MARKER_HIGH value plus
// an unrelated MARKER_LOW mention of a different number must never trigger
// this (MARKER_LOW was never strong enough to assert anything on its own,
// so it cannot make the source "ambiguous" either).
function distinctHighConfidenceValues(sameRole: readonly NumericRoleEvidence[]): NumericRoleEvidence[] {
  const highConfidence = sameRole.filter((entry) => entry.confidence === "MARKER_HIGH");
  const distinct: NumericRoleEvidence[] = [];
  for (const entry of highConfidence) {
    if (!distinct.some((existing) => sameNumericValue(existing.value, entry.value))) distinct.push(entry);
  }
  return distinct;
}

// Detects when the source text itself carries two or more DISTINCT,
// explicit MARKER_HIGH values for the same role (e.g. "ставка 10, ставка
// 20", or two different "коэффициент" mentions) — a property of the
// SOURCE, independent of what the claim says. Checked before any matching
// logic runs: even a claim that happens to equal ONE of the conflicting
// values must not be reported as confidently CORROBORATED while another
// explicit high-confidence mention disagrees — the hard rule this stage
// exists to enforce. A repeated mention of the exact SAME value
// ("ставка 10 ... ставка 10") is NOT ambiguous — sameNumericValue-based
// deduplication in distinctHighConfidenceValues means only genuinely
// different values ever reach this branch. This never attempts to decide
// which value the player "really meant" — both are simply reported.
function detectSameRoleAmbiguity(claim: NumericRoleClaim, sameRole: readonly NumericRoleEvidence[]): NumericRoleVerification | null {
  if (distinctHighConfidenceValues(sameRole).length < 2) return null;

  const highConfidenceEntries = sameRole.filter((entry) => entry.confidence === "MARKER_HIGH");
  return {
    verdict: "AMBIGUOUS",
    supportingEvidence: highConfidenceEntries.filter((entry) => claimMatchesEvidence(claim, entry)),
    conflictingEvidence: highConfidenceEntries.filter((entry) => !claimMatchesEvidence(claim, entry)),
  };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

// Never mutates `evidence`. Never throws. Never selects a market or event,
// never infers a missing value, never swaps stake/line/odds — the caller's
// claim is never altered, only judged against what the raw text actually
// says about its OWN role. Evidence of a DIFFERENT role is never consulted
// at all (a LINE=2.5 entry can never contradict a STAKE=2.5 claim) — this
// is what makes "equal stake and line values" always legal (see this
// file's own tests): the two roles are verified completely independently.
export function verifyNumericRoleClaim(claim: NumericRoleClaim, evidence: readonly NumericRoleEvidence[]): NumericRoleVerification {
  if (!isComparableNumber(claim.value)) {
    return { verdict: "UNVERIFIED", supportingEvidence: [], conflictingEvidence: [] };
  }

  const sameRole = evidence.filter((entry) => entry.role === claim.role);

  const ambiguity = detectSameRoleAmbiguity(claim, sameRole);
  if (ambiguity !== null) return ambiguity;

  const matching = sameRole.filter((entry) => claimMatchesEvidence(claim, entry));
  const conflicting = sameRole.filter((entry) => !claimMatchesEvidence(claim, entry));

  const strongMatching = matching.filter((entry) => CORROBORATING_CONFIDENCES.has(entry.confidence));
  if (strongMatching.length > 0) {
    return { verdict: "CORROBORATED", supportingEvidence: strongMatching, conflictingEvidence: [] };
  }

  const strongConflicting = conflicting.filter((entry) => CONTRADICTING_CONFIDENCES.has(entry.confidence));
  if (strongConflicting.length > 0) {
    return { verdict: "CONTRADICTED", supportingEvidence: [], conflictingEvidence: strongConflicting };
  }

  // Neither threshold cleared — genuinely unverified. Whatever weak
  // matching/conflicting evidence exists (SOLE_CANDIDATE, or MARKER_LOW on
  // the conflicting side) is still returned as context, never silently
  // dropped, but it never drives the verdict itself.
  return { verdict: "UNVERIFIED", supportingEvidence: matching, conflictingEvidence: conflicting };
}
