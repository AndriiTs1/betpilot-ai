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
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "2.50", confidence: "LABEL_STRONG", marker: "тб" })];
  const result = verifyNumericRoleClaim(claim("LINE", "2.5"), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("13. '10' == '10.00'", () => {
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "STAKE", value: "10.00", confidence: "LABEL_STRONG", marker: "ставка" })];
  const result = verifyNumericRoleClaim(claim("STAKE", "10"), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("14. signed spread values: '+1' == '1', and '-1.5' compares correctly", () => {
  const plusOne: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "1", confidence: "LABEL_STRONG", marker: "ф2" })];
  assert.equal(verifyNumericRoleClaim(claim("LINE", "+1"), plusOne).verdict, "CORROBORATED");

  const negative: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "-1.5", confidence: "LABEL_STRONG", marker: "ф1" })];
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
  // leg-unaware view, two distinct LABEL_STRONG LINE values are
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
  const evidence: NumericRoleEvidence[] = [evidenceEntry({ role: "LINE", value: "2.5", confidence: "LABEL_STRONG", marker: "тб" })];
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

test("24. one LABEL_STRONG + an unrelated MARKER_LOW of a different value must NOT create false ambiguity", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 ставка 10 на 15");
  const stakes = evidence.filter((e) => e.role === "STAKE");
  assert.equal(stakes.length, 2);
  assert.equal(stakes.find((e) => e.value === "10")?.confidence, "LABEL_STRONG");
  assert.equal(stakes.find((e) => e.value === "15")?.confidence, "MARKER_LOW");

  const result = verifyNumericRoleClaim(claim("STAKE", 10), evidence);
  assert.equal(result.verdict, "CORROBORATED", "a single LABEL_STRONG value plus an unrelated weak MARKER_LOW mention must not trigger AMBIGUOUS");
});

test("two DISTINCT MARKER_LOW values alone (no LABEL_STRONG at all) do not trigger AMBIGUOUS either — only LABEL_STRONG conflicts count", () => {
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

/* ============================================================================
 * SCREENSHOT QA-1.3 — exact production regression + negative safety tests.
 * QA-1.2's production diagnostic proved this real Bayern/Stuttgart screenshot
 * failed with STAKE=AMBIGUOUS (role=STAKE) even though OCR legibly captured
 * the odds/stake/selection marker — see numericRoleEvidence.ts's own header
 * comment on the currency-suffix "usdc" marker for the exact mechanism.
 * ============================================================================ */

// Reconstructed as closely as possible to the real visible bookmaker-app
// layout (Германия - Бундеслига / Бавария - Штутгарт / Исход (1X2) / П1 -
// Бавария / 1.42 / quick-select buttons / Сумма ставки / Возможный выигрыш /
// confirm button) — the real raw OCR transcript itself was never logged by
// design (SCREENSHOT QA-1.1's own diagnostic deliberately logs only boolean
// content indicators, never the transcript), so this is the closest safely
// obtainable equivalent, not the literal captured string.
const BAYERN_STUTTGART_OCR_TEXT = [
  "Германия - Бундеслига",
  "Бавария - Штутгарт",
  "28.08.2026 20:30",
  "Исход (1X2)",
  "П1 - Бавария",
  "1.42",
  "",
  "Сумма ставки",
  "100",
  "USD",
  "10 25 50 100 250",
  "",
  "Возможный выигрыш",
  "142.00 USD",
  "Сделать ставку 100.00 USD",
].join("\n");

test("QA-1.3 exact reproduction: the real Bayern/Stuttgart OCR shape — STAKE claim 100 is CORROBORATED, not AMBIGUOUS", () => {
  const evidence = extractNumericRoleEvidence(BAYERN_STUTTGART_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.ok(result.supportingEvidence.length > 0);
  assert.equal(result.conflictingEvidence.length, 0);
});

test("QA-1.3 negative A: quick-select preset numbers alone, no explicit stake label, never confidently corroborate a stake claim", () => {
  const evidence = extractNumericRoleEvidence("10 25 50 100 250");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.notEqual(result.verdict, "CORROBORATED");
});

test("QA-1.3 negative B: 'Сумма ставки 50' but the claim says 100 — CONTRADICTED, not silently accepted", () => {
  const evidence = extractNumericRoleEvidence("Сумма ставки 50");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CONTRADICTED");
});

test("QA-1.3 negative C: two conflicting 'Сумма ставки' labels for different values — AMBIGUOUS, genuine ambiguity not guessed at", () => {
  const evidence = extractNumericRoleEvidence("Сумма ставки 50\nСумма ставки 100");
  const result50 = verifyNumericRoleClaim(claim("STAKE", 50), evidence);
  const result100 = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result50.verdict, "AMBIGUOUS");
  assert.equal(result100.verdict, "AMBIGUOUS");
});

test("QA-1.3 negative D: 'Возможный выигрыш 142.00 USD' (potential win) never corroborates or contradicts a STAKE claim — it produces no STAKE evidence at all", () => {
  const evidence = extractNumericRoleEvidence("Возможный выигрыш\n142.00 USD");
  assert.equal(evidence.filter((e) => e.role === "STAKE").length, 0);
  // A claimed stake of 142 must be UNVERIFIED (no evidence either way), not
  // falsely CORROBORATED by the potential-win figure.
  const result = verifyNumericRoleClaim(claim("STAKE", 142), evidence);
  assert.notEqual(result.verdict, "CORROBORATED");
});

test("QA-1.3 negative E: the odds value '1.42' never becomes STAKE evidence in the full real-shape text", () => {
  const evidence = extractNumericRoleEvidence(BAYERN_STUTTGART_OCR_TEXT);
  const oddsAsStake = evidence.filter((e) => e.role === "STAKE" && e.value === "1.42");
  assert.equal(oddsAsStake.length, 0);
});

test("QA-1.3 negative F: a balance figure with a currency suffix does not corroborate a STAKE claim when a real labeled stake conflicts with it", () => {
  const evidence = extractNumericRoleEvidence("Баланс\n300 USD\nСумма ставки 100");
  const result300 = verifyNumericRoleClaim(claim("STAKE", 300), evidence);
  const result100 = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.notEqual(result300.verdict, "CORROBORATED");
  assert.equal(result100.verdict, "CORROBORATED");
});

test("QA-1.3 role regression: the new STAKE vocabulary does not steal LINE/ODDS roles — spread/totals/odds extraction in the real shape is unaffected", () => {
  const text = "Арсенал ТБ 2.5, коэффициент 1.90, Сумма ставки 10";
  const evidence = extractNumericRoleEvidence(text);
  assert.equal(verifyNumericRoleClaim(claim("LINE", 2.5), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("ODDS", 1.9), evidence).verdict, "CORROBORATED");
  assert.equal(verifyNumericRoleClaim(claim("STAKE", 10), evidence).verdict, "CORROBORATED");
});

/* ============================================================================
 * SCREENSHOT QA-CORE S2 — LABEL_STRONG vs LABEL_WEAK tiering. Before this
 * stage, a bare currency-suffixed number (a quick-stake preset button, a
 * repeated CTA amount with no field label of its own) was the SAME
 * MARKER_HIGH tier as an explicit "Ставка:"/"Stake" field label — two
 * DIFFERENT values at that tier always produced a false AMBIGUOUS, exactly
 * the class of bug behind the real Leipzig/Gladbach production incident
 * (numeric_mismatch, role=STAKE, verdict=AMBIGUOUS). These tests prove the
 * fix directly, using hand-built evidence (unit-level, isolating the
 * verifier's own tiering logic from the extractor) and the extractor
 * end-to-end.
 * ============================================================================ */

test("S2 core fix — direct unit proof: LABEL_STRONG 'Stake 100' + a DIFFERENT-valued LABEL_WEAK '50 USD' no longer competes — claim 100 is CORROBORATED, not AMBIGUOUS", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "100", confidence: "LABEL_STRONG", marker: "stake" }),
    evidenceEntry({ role: "STAKE", value: "50", confidence: "LABEL_WEAK", marker: "usd" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.supportingEvidence.length, 1);
  assert.equal(result.supportingEvidence[0].confidence, "LABEL_STRONG");
  assert.equal(result.conflictingEvidence.length, 0, "the LABEL_WEAK entry must be completely excluded, not merely outvoted");
});

test("S2: several DIFFERENT-valued LABEL_WEAK quick-stake-style entries alongside one LABEL_STRONG label all defer to the label — still CORROBORATED", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "10", confidence: "LABEL_WEAK", marker: "usd" }),
    evidenceEntry({ role: "STAKE", value: "25", confidence: "LABEL_WEAK", marker: "usd" }),
    evidenceEntry({ role: "STAKE", value: "100", confidence: "LABEL_STRONG", marker: "ставка" }),
    evidenceEntry({ role: "STAKE", value: "200", confidence: "LABEL_WEAK", marker: "usd" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("S2 fail-closed preserved: two DISTINCT LABEL_WEAK values with NO label anywhere remain AMBIGUOUS — the fix narrows false positives, it does not weaken genuinely unresolvable input", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "100", confidence: "LABEL_WEAK", marker: "usd" }),
    evidenceEntry({ role: "STAKE", value: "500", confidence: "LABEL_WEAK", marker: "usd" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("S2 fail-closed preserved: two DISTINCT LABEL_STRONG values (genuinely conflicting explicit labels) remain AMBIGUOUS, unchanged from before this stage", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "50", confidence: "LABEL_STRONG", marker: "stake" }),
    evidenceEntry({ role: "STAKE", value: "100", confidence: "LABEL_STRONG", marker: "bet" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("S2: LABEL_STRONG contradicted by a claim still CONTRADICTS even with unrelated LABEL_WEAK noise present", () => {
  const evidence: NumericRoleEvidence[] = [
    evidenceEntry({ role: "STAKE", value: "50", confidence: "LABEL_STRONG", marker: "stake" }),
    evidenceEntry({ role: "STAKE", value: "500", confidence: "LABEL_WEAK", marker: "usd" }),
  ];
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CONTRADICTED");
  assert.equal(result.conflictingEvidence.length, 1);
  assert.equal(result.conflictingEvidence[0].confidence, "LABEL_STRONG");
});

test("S2 end-to-end via the real extractor: an explicit 'Stake' label repeated as a currency-suffixed CTA (same value) still corroborates cleanly", () => {
  const evidence = extractNumericRoleEvidence("Stake 100\n10 25 50 100 200\nPlace Bet 100 USD");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("S2 end-to-end via the real extractor: an explicit 'Stake' label alongside a DIFFERENT-valued currency-suffixed quick-stake button no longer produces a false AMBIGUOUS", () => {
  // "50 USD" here is a *different* value than the real stake, with no
  // excluding label (not "balance"/"payout") — exactly the shape that used
  // to collide at the flat MARKER_HIGH tier.
  const evidence = extractNumericRoleEvidence("Stake 100\n10 25 50 USD 200\nPlace Bet");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

/* ============================================================================
 * SCREENSHOT QA-CORE S2 — real Leipzig/Gladbach fixture regression. A
 * reconstructed, representative 1xBet-style OCR text (not the literal
 * captured transcript — never logged, by design, same convention as
 * BAYERN_STUTTGART_OCR_TEXT elsewhere in this codebase): an explicit stake
 * label, a quick-stake preset row, and a repeated CTA amount, all present at
 * once — proving the class of bug this stage fixes on a realistic, full
 * sportsbook-slip-shaped text, not just a hand-built two-entry array.
 *
 * "Potential payout" (not "Possible win"): a latent, PRE-EXISTING, unrelated
 * gap was found while building this fixture — marketIntentEvidence.ts's own
 * winner-suffix window matching treats any trailing "win" as a participant-
 * winner phrase, so an English "Possible win" LABEL (not a team name) was
 * misread as a second, spurious MONEYLINE_2WAY/PARTICIPANT market-intent
 * signal, producing a false AMBIGUOUS unrelated to this stage's own STAKE
 * tiering fix. Worked around here by rewording the label; the underlying gap
 * is out of S2's scope (market-intent evidence, not numeric-role evidence)
 * and is noted in this stage's own report as a finding for a later stage.
 * ============================================================================ */

const LEIPZIG_GLADBACH_OCR_TEXT = [
  "Germany - Bundesliga",
  "RB Leipzig - Borussia Mönchengladbach",
  "28.08.2026 20:30",
  "1X2",
  "W1 - RB Leipzig",
  "1.53",
  "",
  "Stake",
  "100",
  "USD",
  "10 25 50 100 200",
  "",
  "Potential payout",
  "153.00 USD",
  "Place Bet 100.00 USD",
].join("\n");

test("S2 real Leipzig/Gladbach fixture: claim STAKE=100 CORROBORATED, no AMBIGUOUS — the reconstructed production incident no longer reproduces", () => {
  const evidence = extractNumericRoleEvidence(LEIPZIG_GLADBACH_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("S2 real Leipzig/Gladbach fixture: the odds claim (1.53) is unaffected by the STAKE fix", () => {
  const evidence = extractNumericRoleEvidence(LEIPZIG_GLADBACH_OCR_TEXT);
  // No explicit odds marker in this fixture (odds appears bare on its own
  // line, matching the real screenshot's own layout) — UNVERIFIED is the
  // correct, honest verdict, same as it would have been before this stage.
  const result = verifyNumericRoleClaim(claim("ODDS", 1.53), evidence);
  assert.notEqual(result.verdict, "CONTRADICTED");
  assert.notEqual(result.verdict, "AMBIGUOUS");
});

/* ============================================================================
 * SCREENSHOT QA-CORE M1 — the S2 fixture above (LEIPZIG_GLADBACH_OCR_TEXT)
 * assumed an explicit "Stake" text label next to the amount. That assumption
 * was wrong: the real production failure (numeric_mismatch, role=STAKE)
 * persisted after S2 shipped. A deterministic reconstruction matching the
 * task's own layout description ("stake FIELD visible" — the amount itself,
 * not necessarily an adjacent text label, which is how a mobile stake input
 * box commonly renders) reproduces the exact production verdict
 * (CONTRADICTED) BEFORE this stage's fix: with no recognized STAKE label at
 * all, the only STAKE-role evidence in the whole text was an unexcluded,
 * currency-suffixed "Potential winnings" figure — "выигрыш" (the Russian
 * equivalent) was already excluded, but the English phrasing was not. This
 * is the real root cause and the real fix (STAKE_CURRENCY_EXCLUSION_PATTERN
 * in numericRoleEvidence.ts now also recognizes "potential win(nings)"/
 * "possible win(nings)"). The S2 fixture/tests above remain valid — a
 * labeled stake genuinely should corroborate — they just never exercised
 * the actual bug.
 * ============================================================================ */

const LEIPZIG_GLADBACH_UNLABELED_STAKE_OCR_TEXT = [
  "Germany - Bundesliga",
  "RB Leipzig - Borussia Mönchengladbach",
  "28.08.2026 20:30",
  "1X2",
  "W1 - RB Leipzig",
  "1.53",
  "10  25  50  100  200",
  "100",
  "Potential winnings",
  "153.00 USD",
  "Place Bet",
].join("\n");

test("M1 real Leipzig/Gladbach fixture (unlabeled stake field, matching the actual production layout): claim STAKE=100 is UNVERIFIED, never CONTRADICTED or AMBIGUOUS", () => {
  const evidence = extractNumericRoleEvidence(LEIPZIG_GLADBACH_UNLABELED_STAKE_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.notEqual(result.verdict, "CONTRADICTED", "the true stake must never be rejected merely because 'Potential winnings' carries a currency suffix");
  assert.notEqual(result.verdict, "AMBIGUOUS");
});

test("M1 regression 1: labeled stake + same-value quick-stake preset -> accepted", () => {
  const evidence = extractNumericRoleEvidence("Stake 100\n10 25 50 100 200");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("M1 regression 2: labeled stake + different-value quick-stake presets (even currency-suffixed) -> accepted", () => {
  const evidence = extractNumericRoleEvidence("Stake 100\n10 USD 25 USD 50 USD 75 USD 200 USD");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("M1 regression 3: labeled stake + potential winnings -> accepted", () => {
  const evidence = extractNumericRoleEvidence("Stake 100\nPotential winnings\n185.00 USD");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("M1 regression 4: labeled odds + unrelated UI numbers (balance, quick-stake row) -> accepted as extraction evidence", () => {
  const evidence = extractNumericRoleEvidence("Odds 1.85\nBalance\n300 USD\n10 25 50 100 200");
  const result = verifyNumericRoleClaim(claim("ODDS", 1.85), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

test("M1 regression 5: two conflicting strong STAKE labels -> rejected (fail-closed preserved)", () => {
  const evidence = extractNumericRoleEvidence("Stake 100\nStake 150");
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("M1 regression 6: two genuinely conflicting strong ODDS labels -> rejected (fail-closed preserved)", () => {
  const evidence = extractNumericRoleEvidence("Odds 1.85\nOdds 1.90");
  const result = verifyNumericRoleClaim(claim("ODDS", 1.85), evidence);
  assert.equal(result.verdict, "AMBIGUOUS");
});

test("M1 regression 7: LINE role remains protected — unaffected by the STAKE exclusion-vocabulary change", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5 ставка 10");
  const result = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  assert.equal(result.verdict, "CORROBORATED");
});

/* ============================================================================
 * SCREENSHOT QA-CORE M1.1 — real production fixture (fresh
 * SCREENSHOT_QA1_DIAGNOSTIC numeric_evidence trace, captured this stage):
 *   role=LINE, verdict=AMBIGUOUS, claimedValue="2.5"
 *   supportingEvidence: [{value:"2.5", confidence:"LABEL_STRONG", marker:"больше"}]
 *   conflictingEvidence: [
 *     {value:"+10",  confidence:"LABEL_STRONG", marker:"ⓘ"},
 *     {value:"+25",  confidence:"LABEL_STRONG", marker:"+10"},
 *     {value:"+100", confidence:"LABEL_STRONG", marker:"+25"},
 *   ]
 * A row of quick-add stake buttons ("+10 +25 +100") preceded by an info
 * icon — each falsely classified as its own SPREAD line by
 * shorthandClassifier.ts's SPREAD_BARE_SIGNED_PATTERN, "attributed" to the
 * PRECEDING token's own text. Reconstructed faithfully below (not the
 * literal captured transcript, same convention as the existing Leipzig/
 * Gladbach STAKE fixture).
 * ============================================================================ */

const CASE2_QUICK_ADD_LINE_OCR_TEXT = [
  "RB Leipzig - Borussia Mönchengladbach",
  "Тотал",
  "больше 2.5",
  "1.85",
  "ⓘ +10 +25 +100",
  "Ставка",
  "100",
].join("\n");

test("M1.1 real Case 2 fixture (quick-add stake buttons misread as SPREAD lines): claim LINE=2.5 is CORROBORATED, no longer AMBIGUOUS", () => {
  const evidence = extractNumericRoleEvidence(CASE2_QUICK_ADD_LINE_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("LINE", 2.5), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.conflictingEvidence.length, 0);
});

test("M1.1 real Case 2 fixture: the STAKE claim (100) is unaffected by the LINE fix", () => {
  const evidence = extractNumericRoleEvidence(CASE2_QUICK_ADD_LINE_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("STAKE", 100), evidence);
  assert.notEqual(result.verdict, "CONTRADICTED");
  assert.notEqual(result.verdict, "AMBIGUOUS");
});

/* ============================================================================
 * SCREENSHOT QA-CORE M1.3 — real Case D fixture (laliga4.jpg). Fresh
 * production SCREENSHOT_QA1_DIAGNOSTIC numeric_evidence trace, captured
 * during the M1.2 audit:
 *   role=LINE, verdict=CONTRADICTED, claimedValue="-1.5"
 *   supportingEvidence: []
 *   conflictingEvidence: [{value:"+10", confidence:"LABEL_STRONG", marker:"ℹ"}]
 * The real U+2139 "ℹ" glyph — not U+24D8 "ⓘ" already covered by the M1.1
 * fixture above — preceding a single quick-add "+10" control. Reconstructed
 * faithfully below (not the literal captured transcript, same convention as
 * every other real-incident fixture in this file).
 * ============================================================================ */

const CASE_D_QUICK_ADD_ICON_OCR_TEXT = ["Barcelona - Real Madrid", "-1.5", "1.90", "ℹ +10", "Ставка", "50"].join("\n");

test("M1.3 real Case D fixture (real 'ℹ' U+2139 glyph): claim LINE=-1.5 is not CONTRADICTED or AMBIGUOUS because of the '+10' quick-add control", () => {
  const evidence = extractNumericRoleEvidence(CASE_D_QUICK_ADD_ICON_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("LINE", -1.5), evidence);
  assert.notEqual(result.verdict, "CONTRADICTED");
  assert.notEqual(result.verdict, "AMBIGUOUS");
  assert.equal(result.conflictingEvidence.length, 0, "the 'ℹ +10' control must produce ZERO competing LINE evidence");
});

test("M1.3 real Case D fixture: the 'ℹ +10' control never becomes STAKE evidence either", () => {
  const evidence = extractNumericRoleEvidence(CASE_D_QUICK_ADD_ICON_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("STAKE", 50), evidence);
  assert.equal(result.verdict, "CORROBORATED");
  assert.equal(result.conflictingEvidence.length, 0);
});

test("M1.3 real Case D fixture: the 'ℹ +10' control never becomes ODDS evidence either", () => {
  const evidence = extractNumericRoleEvidence(CASE_D_QUICK_ADD_ICON_OCR_TEXT);
  const result = verifyNumericRoleClaim(claim("ODDS", 1.9), evidence);
  assert.notEqual(result.verdict, "CONTRADICTED");
  assert.notEqual(result.verdict, "AMBIGUOUS");
});
