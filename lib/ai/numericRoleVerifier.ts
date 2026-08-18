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

// LABEL_STRONG/LABEL_WEAK and MARKER_LOW can all actively CONFIRM a claim —
// even a weak/ambiguous marker like "на" is still real textual evidence the
// player wrote, and requiring it to also carry the higher CONTRADICTED bar
// (below) before it can even support a match would make Step 1's MARKER_LOW
// tier pointless. SOLE_CANDIDATE deliberately never corroborates on its own:
// it is "the one number nothing else explains," not evidence that a
// specific ROLE was intended — a claim that happens to equal it is
// unverified, not confirmed, matching this stage's own worked example
// (`Арсенал победа 10`, claim STAKE=10 against only a SOLE_CANDIDATE=10
// entry -> UNVERIFIED).
const CORROBORATING_CONFIDENCES: ReadonlySet<NumericRoleEvidenceConfidence> = new Set(["LABEL_STRONG", "LABEL_WEAK", "MARKER_LOW"]);

// LABEL_STRONG/LABEL_WEAK can both CONTRADICT (the primaryTierEvidence()
// filter below, applied before this set is ever consulted, already ensures
// LABEL_WEAK entries are only reached here when NO LABEL_STRONG evidence for
// the same role exists at all — see this file's own header). MARKER_LOW
// ("на") is too common a preposition to justify a hard negative signal on
// its own — a mismatch against it is real context (surfaced in
// conflictingEvidence either way) but must never alone flip the verdict to
// CONTRADICTED. SOLE_CANDIDATE never contradicts either, by the same
// reasoning as above: it was never strong evidence FOR a role in the first
// place, so a mismatch against it cannot be strong evidence AGAINST a claim
// either.
const CONTRADICTING_CONFIDENCES: ReadonlySet<NumericRoleEvidenceConfidence> = new Set(["LABEL_STRONG", "LABEL_WEAK"]);

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S2 — tiering: an explicit field-name label always wins  */
/* -------------------------------------------------------------------------- */

// A sportsbook screenshot commonly carries an explicit, unambiguous field
// label ("Ставка: 100") ALONGSIDE unrelated currency-suffixed noise with no
// label of its own (a quick-stake preset button, a repeated CTA amount) —
// before this stage, both were the same MARKER_HIGH tier, so two DIFFERENT
// values at that tier always triggered AMBIGUOUS even when one was a clearly
// labeled real field and the other was unlabeled UI chrome. This function is
// the ONE place that decision is made: whenever ANY LABEL_STRONG evidence
// exists for a role, every LABEL_WEAK entry for that SAME role is filtered
// out before ambiguity/matching/contradiction is ever evaluated — it cannot
// compete with, dilute, or out-rank an explicit label, regardless of its own
// value. MARKER_LOW and SOLE_CANDIDATE are never filtered here; they were
// never part of the high-confidence tier to begin with (see
// CORROBORATING_CONFIDENCES/CONTRADICTING_CONFIDENCES above) and this
// function changes nothing about how they're treated. When no LABEL_STRONG
// evidence exists for the role at all, LABEL_WEAK entries pass through
// unfiltered and behave exactly as MARKER_HIGH used to (including: two
// DISTINCT LABEL_WEAK values with no label anywhere still fail closed as
// AMBIGUOUS — this stage narrows false positives, it does not weaken the
// fail-closed guarantee for genuinely unresolvable input).
function primaryTierEvidence(sameRole: readonly NumericRoleEvidence[]): readonly NumericRoleEvidence[] {
  const hasLabelStrong = sameRole.some((entry) => entry.confidence === "LABEL_STRONG");
  if (!hasLabelStrong) return sameRole;
  return sameRole.filter((entry) => entry.confidence !== "LABEL_WEAK");
}

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

// CORE BETTING PIPELINE STABILIZATION (Stage S2) — two high-tier entries
// are a genuine ambiguous pair unless they (a) already agree on the value,
// or (b) both carry a KNOWN (non-null) `attribution` (see
// NumericRoleEvidence's own field comment) that DIFFERS — in which case
// they describe two different, legitimate sides/directions of the same
// two-sided market (e.g. Ф1's line vs Ф2's line, or a TOTALS OVER line vs
// its own UNDER line), not a self-contradiction. Whenever either entry's
// attribution is unknown (null — including every entry from before this
// stage, which never set the field), this degrades to exactly today's
// fully attribution-blind rule: any two different values are a conflict,
// full fail-closed safety preserved. This only ever compares evidence
// entries against EACH OTHER, both drawn from the same extractNumericRoleEvidence
// call over the same source text — never against the claim's own
// (possibly differently-spelled/transliterated) text, which is what keeps
// this safe (see deriveLineAttribution's own header for the proven reason
// a claim-vs-evidence comparison would NOT be safe here).
function isGenuineConflictPair(a: NumericRoleEvidence, b: NumericRoleEvidence): boolean {
  if (sameNumericValue(a.value, b.value)) return false;
  if (a.attribution != null && b.attribution != null && a.attribution !== b.attribution) return false;
  return true;
}

// LABEL_STRONG/LABEL_WEAK entries always count. A plain MARKER_LOW entry
// (e.g. STAKE's "на" preposition) never does — it was never strong enough
// to assert anything on its own, so it cannot make the source "ambiguous"
// either, and this must stay true regardless of what else changes here.
//
// CORE BETTING PIPELINE STABILIZATION (Stage S2), Phase 2 fix — a MARKER_LOW
// LINE entry produced by isBareTotalsWordMarker (numericRoleEvidence.ts) is
// a DIFFERENT kind of weak: its confidence was downgraded purely to stop it
// out-ranking/competing with an unrelated ODDS-shaped number (the odds-vs-
// line discrimination problem), never because the direction word itself is
// vague the way "на" is. Such an entry always carries a non-null
// `attribution` ("OVER"/"UNDER" — deriveLineAttribution's TOTALS branch runs
// unconditionally before the confidence downgrade). Two of these for the
// same role are therefore still eligible to conflict with each other
// exactly like two LABEL_STRONG entries would (e.g. "Over 2.5" + "Over
// 3.5"): same reasoning as isGenuineConflictPair itself — a shared
// attribution with a different value is a genuine same-direction
// disagreement, not two sides of one market. A bare STAKE/ODDS MARKER_LOW
// entry never has an attribution (that field only exists for LINE), so this
// is a no-op for "на" and every other non-LINE weak marker — the exclusion
// above is preserved for exactly the cases it was meant for.
function isAmbiguityEligible(entry: NumericRoleEvidence): boolean {
  return entry.confidence === "LABEL_STRONG" || entry.confidence === "LABEL_WEAK" || (entry.confidence === "MARKER_LOW" && entry.attribution != null);
}

// Callers already pass this function evidence that primaryTierEvidence() has
// filtered, so in practice at most ONE of LABEL_STRONG/LABEL_WEAK is ever
// actually present here for a given role — isAmbiguityEligible simply covers
// both tier names (plus the attributed-MARKER_LOW case above) rather than
// assuming which one survived filtering.
function hasGenuineHighConfidenceConflict(sameRole: readonly NumericRoleEvidence[]): boolean {
  const highConfidence = sameRole.filter(isAmbiguityEligible);
  for (let i = 0; i < highConfidence.length; i += 1) {
    for (let j = i + 1; j < highConfidence.length; j += 1) {
      if (isGenuineConflictPair(highConfidence[i], highConfidence[j])) return true;
    }
  }
  return false;
}

// Detects when the source text itself carries two or more DISTINCT,
// explicit high-tier values for the same role (e.g. "ставка 10, ставка
// 20", or two different "коэффициент" mentions) — a property of the
// SOURCE, independent of what the claim says. Checked before any matching
// logic runs: even a claim that happens to equal ONE of the conflicting
// values must not be reported as confidently CORROBORATED while another
// explicit high-confidence mention disagrees — the hard rule this stage
// exists to enforce. A repeated mention of the exact SAME value
// ("ставка 10 ... ставка 10") is NOT ambiguous. This never attempts to
// decide which value the player "really meant" — both are simply reported.
function detectSameRoleAmbiguity(claim: NumericRoleClaim, sameRole: readonly NumericRoleEvidence[]): NumericRoleVerification | null {
  if (!hasGenuineHighConfidenceConflict(sameRole)) return null;

  const highConfidenceEntries = sameRole.filter(isAmbiguityEligible);
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
  // SCREENSHOT QA-CORE S2 — see primaryTierEvidence()'s own header: whenever
  // this role has any LABEL_STRONG evidence, every LABEL_WEAK entry is
  // excluded from everything below (ambiguity detection AND matching/
  // contradiction) — it never gets a vote once an explicit field label
  // exists. MARKER_LOW/SOLE_CANDIDATE are untouched by this filter either
  // way.
  const primaryEvidence = primaryTierEvidence(sameRole);

  const ambiguity = detectSameRoleAmbiguity(claim, primaryEvidence);
  if (ambiguity !== null) return ambiguity;

  const matching = primaryEvidence.filter((entry) => claimMatchesEvidence(claim, entry));
  const conflicting = primaryEvidence.filter((entry) => !claimMatchesEvidence(claim, entry));

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
