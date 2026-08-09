import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarketIntentEvidence } from "./marketIntentEvidence";
import { verifyMarketIntentClaim, type MarketIntentClaim } from "./marketIntentVerifier";
import type { MarketIntentEvidence } from "./marketIntentEvidence";

function verify(text: string, claim: MarketIntentClaim) {
  return verifyMarketIntentClaim(claim, extractMarketIntentEvidence(text));
}

/* ============================================================================
 * The 20 critical regression-matrix cases, in order (BA-2D Step 3 brief).
 * ============================================================================ */

test("1. 'Арсенал Ф1(-1.5) ставка 10' claimed as MONEYLINE_2WAY/PARTICIPANT -> CONTRADICTED (the production incident's exact failure mode)", () => {
  const result = verify("Арсенал Ф1(-1.5) ставка 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.supportingEvidence.length, 0);
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].classification.marketType, "SPREAD");
});

test("2. same original, claimed as SPREAD/PARTICIPANT -> CORROBORATED", () => {
  const result = verify("Арсенал Ф1(-1.5) ставка 10", { marketType: "SPREAD", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.conflictingEvidence.length, 0);
});

test("3. 'Arsenal F1(-1.5) stake 10' claimed as MONEYLINE -> CONTRADICTED (Latin form, same protection)", () => {
  const result = verify("Arsenal F1(-1.5) stake 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CONTRADICTED");
});

test("4. 'Арсенал ТБ 2.5 ставка 10' claimed as MONEYLINE -> CONTRADICTED", () => {
  const result = verify("Арсенал ТБ 2.5 ставка 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CONTRADICTED");
});

test("5. same original, claimed as TOTALS/OVER -> CORROBORATED", () => {
  const result = verify("Арсенал ТБ 2.5 ставка 10", { marketType: "TOTALS", selectionType: "OVER" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("6. 'Арсенал ТМ 3 ставка 10' claimed as TOTALS/UNDER -> CORROBORATED", () => {
  const result = verify("Арсенал ТМ 3 ставка 10", { marketType: "TOTALS", selectionType: "UNDER" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("7. ТМ (under) input claimed as TOTALS/OVER -> CONTRADICTED (OVER vs UNDER is a real semantic conflict)", () => {
  const result = verify("Арсенал ТМ 3 ставка 10", { marketType: "TOTALS", selectionType: "OVER" });
  assert.equal(result.verdict, "CONTRADICTED");
});

test("8. 'ничья ставка 10' claimed as DRAW -> CORROBORATED", () => {
  const result = verify("ничья ставка 10", { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("9. 'ничья ставка 10' claimed as HOME -> CONTRADICTED", () => {
  const result = verify("ничья ставка 10", { marketType: "MONEYLINE_3WAY", selectionType: "HOME" });
  assert.equal(result.verdict, "CONTRADICTED");
});

test("10. 'нічия ставка 10' (Ukrainian) claimed as DRAW -> CORROBORATED", () => {
  const result = verify("нічия ставка 10", { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("11. 'draw stake 10' (English) claimed as DRAW -> CORROBORATED", () => {
  const result = verify("draw stake 10", { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("12. 'Арсенал победа ставка 10' claimed as MONEYLINE_2WAY/PARTICIPANT -> CORROBORATED", () => {
  const result = verify("Арсенал победа ставка 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("13. 'Arsenal win stake 10' -> CORROBORATED", () => {
  const result = verify("Arsenal win stake 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("14. 'Арсенал 10' -> UNVERIFIED (no strong evidence, never treated as contradiction)", () => {
  const result = verify("Арсенал 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.supportingEvidence.length, 0);
  assert.equal(result.conflictingEvidence.length, 0);
});

test("15. 'ставка 10 на Арсенал' -> UNVERIFIED", () => {
  const result = verify("ставка 10 на Арсенал", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "UNVERIFIED");
});

test("16. 'Арсенал ТБ 2.5 ТМ 3.5 ставка 10' -> AMBIGUOUS (two distinct strong TOTALS signals, never pick one)", () => {
  const result = verify("Арсенал ТБ 2.5 ТМ 3.5 ставка 10", { marketType: "TOTALS", selectionType: "OVER" });
  assert.equal(result.verdict, "AMBIGUOUS");
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.supportingEvidence[0].classification.selectionType, "OVER");
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].classification.selectionType, "UNDER");
});

test("17. 'ничья Арсенал победа ставка 10' -> AMBIGUOUS (DRAW vs MONEYLINE, two distinct signals)", () => {
  const result = verify("ничья Арсенал победа ставка 10", { marketType: "MONEYLINE_3WAY", selectionType: "DRAW" });
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("18. TEAM_TOTAL evidence vs TOTALS claim -> CONTRADICTED (different marketType, never treated as equivalent to TOTALS OVER)", () => {
  const result = verify("Арсенал ИТБ 1.5 ставка 10", { marketType: "TOTALS", selectionType: "OVER" });
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.conflictingEvidence[0].classification.marketType, "TEAM_TOTAL");
});

test("19. SPREAD evidence with a different numeric line than the claim still market-CORROBORATES — numeric line disagreement is BA-2B's concern, not this verifier's", () => {
  // originalText carries line -2.5 (embedded), claim itself carries no line
  // at all (MarketIntentClaim has no line field by design) — this verifier
  // only ever compares marketType/selectionType, so any line value in the
  // evidence is irrelevant to its verdict.
  const evidence = extractMarketIntentEvidence("Арсенал Ф1(-2.5) ставка 10");
  assert.equal(evidence[0].classification.embeddedLine, "-2.5");
  const result = verifyMarketIntentClaim({ marketType: "SPREAD", selectionType: "PARTICIPANT" }, evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("19b. TOTALS OVER 2.5 evidence vs an OVER claim (implicitly a different line, e.g. 3.0) still market-CORROBORATES", () => {
  const evidence = extractMarketIntentEvidence("Арсенал ТБ 2.5 ставка 10");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
  const result = verifyMarketIntentClaim({ marketType: "TOTALS", selectionType: "OVER" }, evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("20. verifyMarketIntentClaim never mutates its claim or evidence arguments", () => {
  const text = "Арсенал победа ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  const evidenceSnapshot = JSON.parse(JSON.stringify(evidence));
  const claim: MarketIntentClaim = { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" };
  const claimSnapshot = JSON.parse(JSON.stringify(claim));

  verifyMarketIntentClaim(claim, evidence);

  assert.deepEqual(evidence, evidenceSnapshot);
  assert.deepEqual(claim, claimSnapshot);
});

/* ============================================================================
 * Section 5 — participant text differences must never affect the verdict.
 * ============================================================================ */

test("participant text (Арсенал vs Arsenal) is never compared — MarketIntentClaim carries no participant field at all, so transliteration can never cause a false CONTRADICTED", () => {
  // The claim shape itself has no participant slot (by design — see
  // marketIntentVerifier.ts's own header comment) so there is nothing here
  // to even attempt comparing.
  const result = verify("Арсенал победа ставка 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CORROBORATED");
});

/* ============================================================================
 * Section 9 — identical (not merely co-occurring) evidence is never AMBIGUOUS.
 * ============================================================================ */

test("duplicate but semantically identical evidence (two mentions of the same market/selection) still CORROBORATES, not AMBIGUOUS", () => {
  const result = verify("Арсенал победа Арсенал победа ставка 10", { marketType: "MONEYLINE_2WAY", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence.length, 2);
});

/* ============================================================================
 * Section 7 — market-specific structural matching, beyond the 20 required
 * cases: exact (marketType, selectionType) equality, never a looser rule.
 * ============================================================================ */

test("MONEYLINE_3WAY AWAY evidence vs AWAY claim -> CORROBORATED; vs HOME claim -> CONTRADICTED", () => {
  const awayEvidence: MarketIntentEvidence[] = [
    { classification: { marketType: "MONEYLINE_3WAY", selectionType: "AWAY", participantName: null, embeddedLine: null }, confidence: "TOKEN_MATCH", start: 0, end: 1 },
  ];
  assert.equal(verifyMarketIntentClaim({ marketType: "MONEYLINE_3WAY", selectionType: "AWAY" }, awayEvidence).verdict, "CORROBORATED");
  assert.equal(verifyMarketIntentClaim({ marketType: "MONEYLINE_3WAY", selectionType: "HOME" }, awayEvidence).verdict, "CONTRADICTED");
});

test("TEAM_TOTAL/UNDER evidence vs TEAM_TOTAL/UNDER claim -> CORROBORATED (same marketType family, exact selectionType match)", () => {
  const result = verify("Арсенал ИТМ 1.5 ставка 10", { marketType: "TEAM_TOTAL", selectionType: "UNDER" });
  assert.equal(result.verdict, "CORROBORATED");
});

test("TEAM_TOTAL/OVER evidence vs TEAM_TOTAL/UNDER claim -> CONTRADICTED (same marketType, different selectionType)", () => {
  const result = verify("Арсенал ИТБ 1.5 ставка 10", { marketType: "TEAM_TOTAL", selectionType: "UNDER" });
  assert.equal(result.verdict, "CONTRADICTED");
});

/* ============================================================================
 * EXPRESS scope note (documentation, not an implementation limitation of
 * the pure function itself — see BA-2D Step 1 audit's own EXPRESS section).
 * ============================================================================ */

test("EXPRESS limitation: this verifier has no leg-attribution concept — it can only ever judge ONE claim against ALL evidence in the whole originalText, which is unsafe to treat as a per-leg verdict for a multi-selection EXPRESS message", () => {
  // A two-leg EXPRESS message naturally contains two distinct strong
  // signals in one originalText — exactly the shape this verifier already
  // reports as AMBIGUOUS for a SINGLE-selection claim, which is the
  // technically correct (if leg-unaware) outcome: it is genuinely unsafe to
  // pick either leg's evidence as "the" answer without real leg
  // attribution. This is documented, not solved, here — no EXPRESS-specific
  // code exists in marketIntentVerifier.ts, and none should be added until
  // a real leg-attribution design exists (BA-2D Step 1 audit, section 9).
  const expressLikeText = "Арсенал Ф1(-1.5) ставка 10 Челси ТБ 2.5 ставка 10";
  const result = verify(expressLikeText, { marketType: "SPREAD", selectionType: "PARTICIPANT" });
  assert.equal(result.verdict, "AMBIGUOUS");
});
