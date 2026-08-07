import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyNumericRoleClaim, type NumericRoleClaim } from "./numericRoleVerifier";
import { extractNumericRoleEvidence, type NumericRoleEvidence } from "./numericRoleEvidence";

function claim(role: NumericRoleClaim["role"], value: string | number): NumericRoleClaim {
  return { role, value };
}

function evidenceEntry(overrides: Partial<NumericRoleEvidence> & Pick<NumericRoleEvidence, "role" | "value" | "confidence">): NumericRoleEvidence {
  return { marker: null, start: 0, end: overrides.value.length, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* 1-4. Core corroboration/contradiction, driven by real extracted evidence   */
/* -------------------------------------------------------------------------- */

test("1. exact stake corroborated: 'Арсенал ТБ 2.5, ставка 10', claim STAKE=10", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.supportingEvidence[0].role, "STAKE");
  assert.equal(result.conflictingEvidence.length, 0);
});

test("2. wrong stake contradicted by explicit marker: same input, claim STAKE=2.5", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const result = verifyNumericRoleClaim(claim("STAKE", 2.5), evidence);
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].role, "STAKE");
  assert.equal(result.conflictingEvidence[0].value, "10");
  // Not contradicted "because 2.5 exists as LINE" — the conflicting
  // evidence is explicitly STAKE-role, never LINE-role.
});

test("3. exact line corroborated: same input, claim LINE=2.5", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const result = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence[0].role, "LINE");
});

test("4. wrong line contradicted: same input, claim LINE=10", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const result = verifyNumericRoleClaim(claim("LINE", 10), evidence);
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.conflictingEvidence[0].role, "LINE");
  assert.equal(result.conflictingEvidence[0].value, "2.5");
});

/* -------------------------------------------------------------------------- */
/* 5-6. Equal values are always legal — no equality heuristics anywhere       */
/* -------------------------------------------------------------------------- */

test("5. equal stake/line legal: 'Арсенал ТБ 10, ставка 10' — both claims CORROBORATED independently", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 10, ставка 10");
  const lineResult = verifyNumericRoleClaim(claim("LINE", 10), evidence);
  const stakeResult = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(lineResult.verdict, "CORROBORATED");
  assert.equal(stakeResult.verdict, "CORROBORATED");
});

test("6. same decimal stake/line legal: 'Арсенал ТБ 2.5 ставка 2.5' — both claims CORROBORATED independently", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 ставка 2.5");
  const lineResult = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  const stakeResult = verifyNumericRoleClaim(claim("STAKE", 2.5), evidence);
  assert.equal(lineResult.verdict, "CORROBORATED");
  assert.equal(stakeResult.verdict, "CORROBORATED");
});

/* -------------------------------------------------------------------------- */
/* 7-8. Odds                                                                  */
/* -------------------------------------------------------------------------- */

test("7. explicit odds corroborated: 'Арсенал ТБ 2.5 коэффициент 1.90 ставка 10'", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 коэффициент 1.90 ставка 10");
  assert.equal(verifyNumericRoleClaim(claim("LINE", 2.5), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("ODDS", 1.9), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 10), evidence).verdict, "CORROBORATED");
});

test("8. wrong explicit odds contradicted: same input, claim ODDS=2.10", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 коэффициент 1.90 ставка 10");
  const result = verifyNumericRoleClaim(claim("ODDS", 2.1), evidence);
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.conflictingEvidence[0].role, "ODDS");
  assert.equal(result.conflictingEvidence[0].value, "1.90");
});

test("wrong odds is only UNVERIFIED (never CONTRADICTED) when no ODDS evidence exists at all", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const result = verifyNumericRoleClaim(claim("ODDS", 1.9), evidence);
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.conflictingEvidence.length, 0);
  // This is deliberately NOT comparing against a live provider price — a
  // completely different, out-of-scope concern (see this file's own header).
});

/* -------------------------------------------------------------------------- */
/* 9. No evidence at all                                                     */
/* -------------------------------------------------------------------------- */

test("9. no role evidence at all -> UNVERIFIED", () => {
  const result = verifyNumericRoleClaim(claim("STAKE", 10), []);
  assert.equal(result.verdict, "UNVERIFIED");
  assert.deepEqual(result.supportingEvidence, []);
  assert.deepEqual(result.conflictingEvidence, []);
});

/* -------------------------------------------------------------------------- */
/* 10-11. Confidence policy                                                   */
/* -------------------------------------------------------------------------- */

test("10. MARKER_LOW behavior: 'на' evidence CAN corroborate a matching claim...", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 на 10");
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence[0].confidence, "MARKER_LOW");
});

test("10b. ...but a MARKER_LOW mismatch is never strong enough to CONTRADICT on its own", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "STAKE", value: "10", confidence: "MARKER_LOW", marker: "на" })];
  const result = verifyNumericRoleClaim(claim("STAKE", 5), evidence);
  assert.equal(result.verdict, "UNVERIFIED");
  // The mismatch is still surfaced as context, just doesn't drive the verdict.
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].confidence, "MARKER_LOW");
});

test("11. SOLE_CANDIDATE behavior: 'Арсенал победа 10', claim STAKE=10 -> UNVERIFIED, not CORROBORATED", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа 10");
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "UNVERIFIED");
  // The matching SOLE_CANDIDATE entry is still surfaced for context...
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.supportingEvidence[0].confidence, "SOLE_CANDIDATE");
  // ...but never strong enough on its own to CORROBORATE.
});

test("11b. SOLE_CANDIDATE never CONTRADICTS a mismatched claim either", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "STAKE", value: "10", confidence: "SOLE_CANDIDATE" })];
  const result = verifyNumericRoleClaim(claim("STAKE", 20), evidence);
  assert.equal(result.verdict, "UNVERIFIED");
});

/* -------------------------------------------------------------------------- */
/* 12-14. Numeric comparison — format-insensitive, never raw string compare   */
/* -------------------------------------------------------------------------- */

test("12. '2.5' == '2.50'", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "2.50", confidence: "MARKER_HIGH", marker: "тб" })];
  const result = verifyNumericRoleClaim(claim("LINE", "2.5"), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("13. '10' == '10.00'", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "STAKE", value: "10.00", confidence: "MARKER_HIGH", marker: "ставка" })];
  const result = verifyNumericRoleClaim(claim("STAKE", "10"), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("14. signed spread values: '+1' == '1', and '-1.5' compares correctly", () => {
  const plusOne: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "1", confidence: "MARKER_HIGH", marker: "ф2" })];
  assert.equal(verifyNumericRoleClaim(claim("LINE", "+1"), plusOne).verdict, "CORROBORATED");

  const negative: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "-1.5", confidence: "MARKER_HIGH", marker: "ф1" })];
  assert.equal(verifyNumericRoleClaim(claim("LINE", "-1.5"), negative).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("LINE", "1.5"), negative).verdict, "CONTRADICTED");
  assert.equal(verifyNumericRoleClaim(claim("LINE", -1.5), negative).verdict, "CORROBORATED");
});

/* -------------------------------------------------------------------------- */
/* 15-17. EXPRESS — spans preserved, no leg attribution attempted             */
/* -------------------------------------------------------------------------- */

test("15. EXPRESS global stake: 'Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20' — slip-level STAKE=20 corroborated", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20");
  const result = verifyNumericRoleClaim(claim("STAKE", 20), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("16. EXPRESS multiple DIFFERENT lines: correctly AMBIGUOUS, not falsely CORROBORATED — the verifier has no leg-attribution capability, so it honestly cannot tell which leg a matching claim actually belongs to", () => {
  // Revised on review: this used to assert CORROBORATED for a claim
  // matching one of two distinct per-leg lines. That overclaimed
  // confidence the verifier doesn't actually have — from its flat,
  // leg-unaware view, two distinct MARKER_HIGH LINE values are
  // indistinguishable from the "ставка 10, ставка 20" self-contradiction
  // case (see the AMBIGUOUS tests above). AMBIGUOUS is the honest verdict
  // here; leg attribution remains a separate, future problem, exactly as
  // this stage's own brief said it must.
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20");
  const lines = evidence.filter((e) => e.role === "LINE");
  assert.equal(lines.length, 2);

  const matchFirst = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  assert.equal(matchFirst.verdict, "AMBIGUOUS");
  assert.equal(matchFirst.supportingEvidence[0].value, "2.5");
  assert.equal(matchFirst.conflictingEvidence[0].value, "3.5");

  const matchSecond = verifyNumericRoleClaim(claim("LINE", 3.5), evidence);
  assert.equal(matchSecond.verdict, "AMBIGUOUS");

  // A value matching NEITHER leg is also AMBIGUOUS, not CONTRADICTED — the
  // hard rule applies regardless of whether the claim happens to match one
  // of the conflicting values.
  const matchNeither = verifyNumericRoleClaim(claim("LINE", 4.5), evidence);
  assert.equal(matchNeither.verdict, "AMBIGUOUS");
  assert.equal(matchNeither.supportingEvidence.length, 0);
  assert.equal(matchNeither.conflictingEvidence.length, 2);

  // The slip-level STAKE claim is entirely unaffected — only one STAKE
  // value exists in the text, so no ambiguity applies to that role.
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 20), evidence).verdict, "CORROBORATED");
});

test("17. EXPRESS repeated same line: 'Арсенал ТБ 2.5 + Реал ТМ 2.5, экспресс 20' — two distinct LINE=2.5 occurrences both preserved and both corroborate the same claim", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 + Реал ТМ 2.5, экспресс 20");
  const lines = evidence.filter((e) => e.role === "LINE");
  assert.equal(lines.length, 2, "Step 1 must still report two distinct occurrences");
  assert.notEqual(lines[0].start, lines[1].start);

  const result = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  // Both occurrences legitimately support the claim — the verifier makes no
  // attempt to decide which one "belongs" to which leg (out of scope for
  // Step 2; leg-ownership is a separate future problem).
  assert.equal(result.supportingEvidence.length, 2);
});

/* -------------------------------------------------------------------------- */
/* 18. Malformed claimed value                                               */
/* -------------------------------------------------------------------------- */

test("18. malformed claimed numeric value never crashes and never fabricates a verdict", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  for (const malformed of ["", "abc", "NaN", "Infinity", "-", "2.5.5"]) {
    const result = verifyNumericRoleClaim(claim("STAKE", malformed), evidence);
    assert.equal(result.verdict, "UNVERIFIED", `"${malformed}" must never produce CORROBORATED or CONTRADICTED`);
    assert.deepEqual(result.supportingEvidence, []);
    assert.deepEqual(result.conflictingEvidence, []);
  }
});

/* -------------------------------------------------------------------------- */
/* 19. Cross-role isolation                                                   */
/* -------------------------------------------------------------------------- */

test("19. evidence for another role never creates a contradiction — LINE evidence cannot contradict a STAKE claim", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "2.5", confidence: "MARKER_HIGH", marker: "тб" })];
  // No STAKE evidence exists at all — only an unrelated LINE entry with a
  // totally different value from the claim.
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "UNVERIFIED");
  assert.equal(result.conflictingEvidence.length, 0);
});

/* -------------------------------------------------------------------------- */
/* 20. Immutability                                                           */
/* -------------------------------------------------------------------------- */

test("20. input claim and evidence array are never mutated", () => {
  const originalEvidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  const evidenceSnapshot = JSON.stringify(originalEvidence);
  const claimObject = claim("STAKE", 10);
  const claimSnapshot = JSON.stringify(claimObject);

  verifyNumericRoleClaim(claimObject, originalEvidence);

  assert.equal(JSON.stringify(originalEvidence), evidenceSnapshot);
  assert.equal(JSON.stringify(claimObject), claimSnapshot);
});

/* ============================================================================
 * Review round: conflicting same-role high-confidence evidence -> AMBIGUOUS
 * ============================================================================ */

test("21. conflicting STAKE: 'Арсенал победа, ставка 10, ставка 20' — claim STAKE=10 is AMBIGUOUS, never confidently CORROBORATED", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа, ставка 10, ставка 20");
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.supportingEvidence[0].value, "10");
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].value, "20");
});

test("21b. the SAME conflict makes a claim of the OTHER value AMBIGUOUS too, not CORROBORATED", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа, ставка 10, ставка 20");
  const result = verifyNumericRoleClaim(claim("STAKE", 20), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("21c. and a claim matching NEITHER conflicting value is AMBIGUOUS, not CONTRADICTED", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа, ставка 10, ставка 20");
  const result = verifyNumericRoleClaim(claim("STAKE", 15), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
  assert.equal(result.supportingEvidence.length, 0);
  assert.equal(result.conflictingEvidence.length, 2);
});

test("22. conflicting ODDS: 'коэффициент 1.80, коэффициент 1.90' — claim ODDS=1.80 is AMBIGUOUS", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа, коэффициент 1.80, коэффициент 1.90, ставка 10");
  const oddsResult = verifyNumericRoleClaim(claim("ODDS", 1.8), evidence);
  assert.equal(oddsResult.verdict, "AMBIGUOUS");
  // The unrelated, unambiguous STAKE role is completely unaffected.
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 10), evidence).verdict, "CORROBORATED");
});

test("23. duplicated SAME value is NOT conflicting: 'ставка 10, ставка 10' may still CORROBORATE", () => {
  const evidence = extractNumericRoleEvidence("Арсенал победа, ставка 10, ставка 10");
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence.length, 2);
});

test("24. one MARKER_HIGH + an unrelated MARKER_LOW of a different value must NOT create false ambiguity", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 ставка 10 на 15");
  const stakes = evidence.filter((e) => e.role === "STAKE");
  assert.equal(stakes.length, 2);
  assert.equal(stakes.find((e) => e.value === "10")?.confidence, "MARKER_HIGH");
  assert.equal(stakes.find((e) => e.value === "15")?.confidence, "MARKER_LOW");

  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "CORROBORATED", "a single MARKER_HIGH value plus an unrelated weak MARKER_LOW mention must not trigger AMBIGUOUS");
});

test("two DISTINCT MARKER_LOW values alone (no MARKER_HIGH at all) do not trigger AMBIGUOUS either — only MARKER_HIGH conflicts count", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "10", confidence: "MARKER_LOW", marker: "на" }),
    evidenceEntry({ role: "STAKE", value: "20", confidence: "MARKER_LOW", marker: "на" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.notEqual(result.verdict, "AMBIGUOUS");
});

/* ============================================================================
 * Review round: European/RU-UA decimal comma support (Step 1's fix)
 * ============================================================================ */

test("25. LINE with comma decimal: 'Арсенал ТБ 2,5 ставка 10' — raw evidence value stays '2,5', verified correctly against a dot-decimal claim", () => {
  const text = "Арсенал ТБ 2,5 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lineEntry = evidence.find((e) => e.role === "LINE");
  assert.ok(lineEntry);
  assert.equal(lineEntry.value, "2,5", "the raw comma-containing substring must be preserved exactly");
  assert.equal(text.slice(lineEntry.start, lineEntry.end), "2,5");

  assert.equal(verifyNumericRoleClaim(claim("LINE", "2.5"), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("LINE", 2.5), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 10), evidence).verdict, "CORROBORATED");
});

test("26. ODDS with comma decimal: 'коэффициент 1,90' — raw value '1,90', verified correctly", () => {
  const text = "Арсенал победа коэффициент 1,90 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const oddsEntry = evidence.find((e) => e.role === "ODDS");
  assert.ok(oddsEntry);
  assert.equal(oddsEntry.value, "1,90");

  assert.equal(verifyNumericRoleClaim(claim("ODDS", "1.90"), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("ODDS", 1.9), evidence).verdict, "CORROBORATED");
});

test("27. signed SPREAD with comma decimal: 'Арсенал Ф1(-1,5) ставка 20' — raw value '-1,5', verified correctly", () => {
  const text = "Арсенал Ф1(-1,5) ставка 20";
  const evidence = extractNumericRoleEvidence(text);
  const lineEntry = evidence.find((e) => e.role === "LINE");
  assert.ok(lineEntry);
  assert.equal(lineEntry.value, "-1,5");
  assert.equal(text.slice(lineEntry.start, lineEntry.end), "-1,5");

  assert.equal(verifyNumericRoleClaim(claim("LINE", "-1.5"), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("LINE", -1.5), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 20), evidence).verdict, "CORROBORATED");
});

test("28. originalText is never rewritten by comma normalization", () => {
  const text = "Арсенал ТБ 2,5 ставка 10";
  const before = text.slice();
  extractNumericRoleEvidence(text);
  assert.equal(text, before);
});
