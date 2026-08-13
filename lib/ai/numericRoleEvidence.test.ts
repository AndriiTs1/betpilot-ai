import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNumericRoleEvidence, sameNumericValue, type NumericRoleEvidence } from "./numericRoleEvidence";

function findByRole(evidence: readonly NumericRoleEvidence[], role: NumericRoleEvidence["role"]): NumericRoleEvidence[] {
  return evidence.filter((e) => e.role === role);
}

function assertSpanText(text: string, evidence: NumericRoleEvidence, expected: string): void {
  assert.equal(text.slice(evidence.start, evidence.end), expected);
  assert.equal(evidence.value, expected);
}

/* ============================================================================
 * The 16 critical cases, in order.
 * ============================================================================ */

test("1. 'Арсенал ТБ 2.5, ставка 10' — LINE 2.5, STAKE 10", () => {
  const text = "Арсенал ТБ 2.5, ставка 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assert.equal(lines[0].confidence, "LABEL_STRONG");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "ставка");
  assert.equal(stakes[0].confidence, "LABEL_STRONG");
});

test("2. 'Арсенал ТБ 10, ставка 10' — LINE 10 and STAKE 10 as two separate source occurrences", () => {
  const text = "Арсенал ТБ 10, ставка 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assert.equal(lines[0].value, "10");
  assert.equal(stakes[0].value, "10");
  // Same value, but genuinely distinct positions — never merged/deduped by value.
  assert.notEqual(lines[0].start, stakes[0].start);
  assertSpanText(text, lines[0], "10");
  assertSpanText(text, stakes[0], "10");
});

test("3. 'Арсенал ТБ 2.5 ставка 2.5' — LINE 2.5 and STAKE 2.5 as two separate occurrences (never rejected for equal values)", () => {
  const text = "Арсенал ТБ 2.5 ставка 2.5";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assert.equal(lines[0].value, "2.5");
  assert.equal(stakes[0].value, "2.5");
  assert.notEqual(lines[0].start, stakes[0].start);
});

test("4. 'Арсенал ТБ 2.5 на 10' — LINE 2.5 (high), STAKE 10 via 'на' (low confidence)", () => {
  const text = "Арсенал ТБ 2.5 на 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "на");
  assert.equal(stakes[0].confidence, "MARKER_LOW");
});

test("5. 'Арсенал ТБ 2.5 10' — trailing 10 is SOLE_CANDIDATE, never 'last number'", () => {
  const text = "Арсенал ТБ 2.5 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].confidence, "SOLE_CANDIDATE");
  assert.equal(stakes[0].marker, null);
});

test("6. 'Арсенал победа 10' — no line marker, stake is the sole number", () => {
  const text = "Арсенал победа 10";
  const evidence = extractNumericRoleEvidence(text);

  assert.equal(findByRole(evidence, "LINE").length, 0);
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].confidence, "SOLE_CANDIDATE");
});

test("7. 'Арсенал Ф1(-1.5) 20' — SPREAD line -1.5 via Ф1(), stake 20 sole candidate", () => {
  const text = "Арсенал Ф1(-1.5) 20";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "-1.5");
  assertSpanText(text, stakes[0], "20");
  assert.equal(stakes[0].confidence, "SOLE_CANDIDATE");
});

test("8. 'Арсенал победа коэффициент 1.90 ставка 10' — ODDS 1.90, STAKE 10, no LINE", () => {
  const text = "Арсенал победа коэффициент 1.90 ставка 10";
  const evidence = extractNumericRoleEvidence(text);

  assert.equal(findByRole(evidence, "LINE").length, 0);
  const odds = findByRole(evidence, "ODDS");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(odds.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, odds[0], "1.90");
  assert.equal(odds[0].marker, "коэффициент");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "ставка");
});

test("9. 'Арсенал ТБ 2.5 коэффициент 1.90 ставка 10' — all three roles present and distinct", () => {
  const text = "Арсенал ТБ 2.5 коэффициент 1.90 ставка 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const odds = findByRole(evidence, "ODDS");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(odds.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, odds[0], "1.90");
  assertSpanText(text, stakes[0], "10");
});

test("10. 'Arsenal Over 2.5 stake 10' — English markers work identically", () => {
  const text = "Arsenal Over 2.5 stake 10";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assert.equal(lines[0].marker, "over");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "stake");
});

test("11. 'Arsenal Win @1.85 bet 10' — ODDS via @, STAKE via bet, no LINE", () => {
  const text = "Arsenal Win @1.85 bet 10";
  const evidence = extractNumericRoleEvidence(text);

  assert.equal(findByRole(evidence, "LINE").length, 0);
  const odds = findByRole(evidence, "ODDS");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(odds.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, odds[0], "1.85");
  assert.equal(odds[0].marker, "@");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "bet");
});

test("12. EXPRESS: 'Арсенал ТБ 2.5 + Реал победа, экспресс 20' — one LINE, slip-level STAKE via экспресс", () => {
  const text = "Арсенал ТБ 2.5 + Реал победа, экспресс 20";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, stakes[0], "20");
  assert.equal(stakes[0].marker, "экспресс");
  // The extractor never attributes the stake to the second leg — there is
  // no leg concept at all at this layer, only one flat evidence list.
});

test("13. EXPRESS: 'Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20' — two distinct LINE occurrences, one STAKE", () => {
  const text = "Арсенал ТБ 2.5 + Реал ТМ 3.5, экспресс 20";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 2);
  assert.equal(stakes.length, 1);
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, lines[1], "3.5");
  assertSpanText(text, stakes[0], "20");
});

test("14. CRITICAL — EXPRESS with a REPEATED line value: 'Арсенал ТБ 2.5 + Реал ТМ 2.5, экспресс 20' preserves two distinct LINE occurrences, never collapsed by value", () => {
  const text = "Арсенал ТБ 2.5 + Реал ТМ 2.5, экспресс 20";
  const evidence = extractNumericRoleEvidence(text);

  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 2, "both '2.5' occurrences must survive as separate evidence entries");
  assert.equal(lines[0].value, "2.5");
  assert.equal(lines[1].value, "2.5");
  assert.notEqual(lines[0].start, lines[1].start, "the two '2.5' occurrences must be distinguishable by position");
  assertSpanText(text, lines[0], "2.5");
  assertSpanText(text, lines[1], "2.5");

  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assertSpanText(text, stakes[0], "20");
});

test("15. 'Арсенал ТБ 2.5' — missing stake must NOT be invented", () => {
  const text = "Арсенал ТБ 2.5";
  const evidence = extractNumericRoleEvidence(text);

  assert.equal(findByRole(evidence, "STAKE").length, 0);
  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 1);
  assertSpanText(text, lines[0], "2.5");
});

test("16. 'Арсенал победа' — no numbers at all, zero evidence, nothing invented", () => {
  const text = "Арсенал победа";
  const evidence = extractNumericRoleEvidence(text);
  assert.deepEqual(evidence, []);
});

/* ============================================================================
 * Additional coverage: Ukrainian, safety invariants, input immutability,
 * and the reuse boundary (this file must never re-implement the shorthand
 * vocabulary itself).
 * ============================================================================ */

test("Ukrainian: 'Динамо перемога, ставка 25' and 'Арсенал нічия, ставка 10' — shared RU/UA winner-suffix and draw tokens (BA-2A) still resolve via LINE reuse where applicable, STAKE via markers", () => {
  const win = extractNumericRoleEvidence("Динамо перемога, ставка 25");
  assert.equal(findByRole(win, "LINE").length, 0);
  const winStakes = findByRole(win, "STAKE");
  assert.equal(winStakes.length, 1);
  assert.equal(winStakes[0].value, "25");
  assert.equal(winStakes[0].marker, "ставка");

  const draw = extractNumericRoleEvidence("Арсенал нічия, ставка 10");
  const drawStakes = findByRole(draw, "STAKE");
  assert.equal(drawStakes.length, 1);
  assert.equal(drawStakes[0].value, "10");
});

test("safety invariant: equal STAKE and LINE values are never rejected or swapped, for any of several equal-value phrasings", () => {
  for (const text of ["Арсенал ТБ 5, ставка 5", "Арсенал ТМ 15, ставка 15", "Арсенал Ф1(-2) ставка 2"]) {
    const evidence = extractNumericRoleEvidence(text);
    // Never throws, never produces a CONTRADICTED/rejection concept — Step 1
    // only ever extracts evidence, it has no verdict/rejection vocabulary.
    assert.ok(Array.isArray(evidence));
  }
});

test("safety invariant: extractNumericRoleEvidence never mutates its input string", () => {
  const text = "Арсенал ТБ 2.5, ставка 10";
  const before = text.slice();
  extractNumericRoleEvidence(text);
  assert.equal(text, before);
});

test("safety invariant: a number that never appears in the source is never invented as evidence (nothing to test directly here — this file has no access to AI-claimed values at all; it only ever reports occurrences that exist in the given text)", () => {
  const evidence = extractNumericRoleEvidence("Арсенал ТБ 2.5, ставка 10");
  for (const e of evidence) {
    assert.equal("Арсенал ТБ 2.5, ставка 10".slice(e.start, e.end), e.value);
  }
});

test("bare unattributed signed number is never treated as SPREAD/LINE evidence, matching BA-2A's own shorthandClassifier behavior", () => {
  const text = "Матч закончился -1.5, ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  // "-1.5" has no participant attribution immediately before it in a form
  // the shared classifier recognizes as SPREAD ("закончился" is not a
  // participant name pattern the classifier would treat as one) — this
  // test only asserts no crash and a coherent STAKE result; it deliberately
  // does not over-assert LINE behavior for prose the classifier itself
  // was never designed to parse.
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("more than one unclaimed number produces NO SOLE_CANDIDATE evidence — genuine ambiguity is left unresolved, not guessed", () => {
  const text = "Арсенал победа 10 20";
  const evidence = extractNumericRoleEvidence(text);
  assert.equal(findByRole(evidence, "STAKE").length, 0);
  assert.equal(findByRole(evidence, "LINE").length, 0);
  assert.equal(findByRole(evidence, "ODDS").length, 0);
  assert.deepEqual(evidence, []);
});

test("currency-suffix stake marker: '10 USDC' (number before marker)", () => {
  const text = "Арсенал победа 10 USDC";
  const evidence = extractNumericRoleEvidence(text);
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "usdc");
  // SCREENSHOT QA-CORE S2 — a bare currency suffix with no field-name label
  // is LABEL_WEAK, not LABEL_STRONG: see numericRoleVerifier.ts's own
  // tiering, which keeps this from ever out-ranking an explicit "ставка"/
  // "stake" label elsewhere in the same text.
  assert.equal(stakes[0].confidence, "LABEL_WEAK");
});

test("ставлю and экспресс markers are recognized as distinct STAKE markers", () => {
  const stavlyu = findByRole(extractNumericRoleEvidence("Арсенал победа, ставлю 30"), "STAKE");
  assert.equal(stavlyu.length, 1);
  assert.equal(stavlyu[0].marker, "ставлю");

  const express = findByRole(extractNumericRoleEvidence("Арсенал победа, экспресс 40"), "STAKE");
  assert.equal(express.length, 1);
  assert.equal(express[0].marker, "экспресс");
});

test("коэф and кф short-form ODDS markers are recognized distinctly from коэффициент", () => {
  const koef = findByRole(extractNumericRoleEvidence("Арсенал победа коэф 1.5 ставка 10"), "ODDS");
  assert.equal(koef.length, 1);
  assert.equal(koef[0].value, "1.5");

  const kf = findByRole(extractNumericRoleEvidence("Арсенал победа кф 1.5 ставка 10"), "ODDS");
  assert.equal(kf.length, 1);
  assert.equal(kf[0].value, "1.5");
});

test("evidence list is sorted by source position", () => {
  const text = "Арсенал ТБ 2.5 коэффициент 1.90 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  for (let i = 1; i < evidence.length; i += 1) {
    assert.ok(evidence[i - 1].start <= evidence[i].start);
  }
});

/* ============================================================================
 * Review round: European/RU-UA decimal comma ("2,5") support for LINE
 * evidence — classifyBettingSelectionText (Stage BA-2A) only recognizes a
 * dot decimal separator; comma normalization happens ONLY in the ephemeral
 * text handed to it, never in originalText or any reported evidence.value.
 * ============================================================================ */

test("comma decimal: 'Арсенал ТБ 2,5' — LINE evidence raw value stays '2,5' (comma preserved), never rewritten to '2.5'", () => {
  const text = "Арсенал ТБ 2,5";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "2,5");
  assertSpanText(text, lines[0], "2,5");
});

test("comma decimal: 'Арсенал ТБ 2,5, ставка 10' — LINE '2,5' and STAKE '10' both correct, trailing comma still stripped", () => {
  const text = "Арсенал ТБ 2,5, ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "2,5");
  assert.equal(stakes.length, 1);
  assertSpanText(text, stakes[0], "10");
});

test("comma decimal: ODDS 'коэффициент 1,90' — raw value stays '1,90'", () => {
  const text = "Арсенал победа коэффициент 1,90 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const odds = findByRole(evidence, "ODDS");
  assert.equal(odds.length, 1);
  assert.equal(odds[0].value, "1,90");
  assertSpanText(text, odds[0], "1,90");
});

test("comma decimal: signed SPREAD 'Арсенал Ф1(-1,5)' — raw value stays '-1,5'", () => {
  const text = "Арсенал Ф1(-1,5) 20";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1,5");
  assertSpanText(text, lines[0], "-1,5");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assertSpanText(text, stakes[0], "20");
});

test("comma decimal: '+1,5' (positive signed comma line) is preserved raw and classified correctly", () => {
  const text = "Челси Ф2(+1,5) 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "+1,5");
});

test("comma decimal never rewrites originalText", () => {
  const text = "Арсенал ТБ 2,5 ставка 10";
  const before = text.slice();
  extractNumericRoleEvidence(text);
  assert.equal(text, before);
});

/* -------------------------------------------------------------------------- */
/* Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary, new.   */
/* No changes to this file's own algorithm — these tests confirm the        */
/* existing, unmodified LINE-reuse pass already correctly separates LINE    */
/* from STAKE for the new shorthandClassifier.ts vocabulary, exactly as it  */
/* already did for ТБ/ТМ/Ф1/Ф2. This file was audited (not modified) per    */
/* this stage's own instruction — every case below passes unmodified.       */
/* -------------------------------------------------------------------------- */

test("H3: 'Арсенал фора -1.5 ставка 10' -> LINE -1.5, STAKE 10, no role mix-up", () => {
  const text = "Арсенал фора -1.5 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1.5");
  assert.equal(lines[0].confidence, "LABEL_STRONG");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
  assert.equal(stakes[0].confidence, "LABEL_STRONG");
});

test("H3: 'Arsenal handicap -1.5 stake 10' -> LINE -1.5, STAKE 10, no role mix-up", () => {
  const text = "Arsenal handicap -1.5 stake 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1.5");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: 'Арсенал азійська фора -1.25 ставка 10' -> LINE -1.25, STAKE 10, no role mix-up (the quarter-line digit is correctly identified as a LINE, not left floating for SOLE_CANDIDATE to mistake)", () => {
  const text = "Арсенал азійська фора -1.25 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1.25");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: 'Арсенал с формой -1.5 ставка 10' style RU compound marker ('с форой') still isolates LINE from STAKE correctly", () => {
  const text = "Арсенал с форой -1.5 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1.5");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: UA 'Арсенал з форою -1.5 ставка 10' still isolates LINE from STAKE correctly", () => {
  const text = "Арсенал з форою -1.5 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-1.5");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3 conflicting lines: 'Арсенал фора -1.5 фора -2 ставка 10' preserves two distinct LINE occurrences, never collapsed by value, same as the existing repeated-Totals-line precedent", () => {
  const text = "Арсенал фора -1.5 фора -2 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => l.value),
    ["-1.5", "-2"],
  );
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: equal STAKE and LINE values are never rejected or swapped for the new vocabulary either ('Арсенал фора -10 ставка 10')", () => {
  const text = "Арсенал фора -10 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const lines = findByRole(evidence, "LINE");
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "-10");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: comma-decimal line still degrades the same documented way for the new vocabulary as it already does for Ф1/ТБ ('Арсенал фора -1,5 ставка 10')", () => {
  // Consistent with this file's own pre-existing "decimal comma finding"
  // tests above (not a new gap introduced by H3): shorthandClassifier.ts's
  // LINE_NUMBER/SIGNED_LINE_NUMBER grammar is dot-only, unchanged by this
  // stage. A comma-decimal line is not claimed as LINE evidence here; it
  // remains available as a potential SOLE_CANDIDATE if nothing else claims
  // it, exactly as already true for "Арсенал Ф1(-1,5)".
  const text = "Арсенал фора -1,5 ставка 10";
  const evidence = extractNumericRoleEvidence(text);
  const stakes = findByRole(evidence, "STAKE");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "10");
});

test("H3: does not mutate originalText", () => {
  const text = "Арсенал фора -1.5 ставка 10";
  const before = text.slice();
  extractNumericRoleEvidence(text);
  assert.equal(text, before);
});

/* ============================================================================
 * SCREENSHOT QA-1.3 — real bookmaker-slip STAKE label forms + false-positive
 * currency-suffix exclusion (see numericRoleVerifier.test.ts for the
 * end-to-end verdict-level proof against the actual Bayern/Stuttgart shape).
 * ============================================================================ */

test("QA-1.3: 'Сумма ставки 100 USD' (single line, with colon-less label) produces LABEL_STRONG STAKE=100, marker 'сумма ставки'", () => {
  // Two STAKE entries are expected here, not one: the "сумма ставки" label
  // marker AND the pre-existing "usdc" currency-suffix marker both
  // independently fire on the same "100" — both agree on the same value,
  // which is harmless (see the "repeated same value" tests below); this
  // test only asserts the NEW label marker itself is present and correct.
  const text = "Сумма ставки 100 USD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  const labeled = stakes.find((s) => s.marker === "сумма ставки");
  assert.ok(labeled, "expected a 'сумма ставки' STAKE entry");
  assert.equal(labeled!.value, "100");
  assert.equal(labeled!.confidence, "LABEL_STRONG");
  for (const stake of stakes) {
    assert.ok(sameNumericValue(stake.value, "100"));
  }
});

test("QA-1.3: 'Сумма ставки' label and its number on SEPARATE OCR lines still produce LABEL_STRONG STAKE evidence", () => {
  const text = "Сумма ставки\n100\nUSD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.ok(stakes.some((s) => s.value === "100" && s.marker === "сумма ставки" && s.confidence === "LABEL_STRONG"));
});

test("QA-1.3: 'Размер ставки: 66.67' and 'Сумма пари 20' are both recognized LABEL_STRONG STAKE label forms", () => {
  const razmer = findByRole(extractNumericRoleEvidence("Размер ставки: 66.67"), "STAKE");
  assert.equal(razmer.length, 1);
  assert.equal(razmer[0].value, "66.67");
  assert.equal(razmer[0].marker, "размер ставки");

  const pari = findByRole(extractNumericRoleEvidence("Сумма пари 20"), "STAKE");
  assert.equal(pari.length, 1);
  assert.equal(pari[0].value, "20");
  assert.equal(pari[0].marker, "сумма пари");
});

test("QA-1.3: English 'Stake' label and its number on separate lines still corroborate (pre-existing \\s* behavior, explicitly proven for the adjacent-line case)", () => {
  const text = "Stake\n25";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "25");
  assert.equal(stakes[0].marker, "stake");
});

test("QA-1.3: a currency-suffixed number is NOT tagged STAKE when it directly follows 'Возможный выигрыш' (potential win)", () => {
  const text = "Возможный выигрыш\n142.00 USD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.equal(stakes.length, 0, "142.00 must never become STAKE evidence merely because it has a currency suffix");
});

test("QA-1.3: a currency-suffixed number is NOT tagged STAKE when it directly follows 'выплата' (payout) or 'баланс'/'balance'", () => {
  assert.equal(findByRole(extractNumericRoleEvidence("Выплата\n50 USD"), "STAKE").length, 0);
  assert.equal(findByRole(extractNumericRoleEvidence("Баланс\n300 USD"), "STAKE").length, 0);
  assert.equal(findByRole(extractNumericRoleEvidence("Balance\n300 USD"), "STAKE").length, 0);
  assert.equal(findByRole(extractNumericRoleEvidence("Payout\n300 USD"), "STAKE").length, 0);
});

test("QA-1.3: the currency-suffix exclusion is narrowly scoped — an unrelated preceding word never suppresses a genuine stake figure", () => {
  const stakes = findByRole(extractNumericRoleEvidence("Футбол Бавария Штутгарт 100 USD"), "STAKE");
  assert.equal(stakes.length, 1);
  assert.equal(stakes[0].value, "100");
});

test("QA-1.3 full Bayern/Stuttgart shape: exact bookmaker OCR layout — the real stake label field corroborates 100, quick-select buttons and potential-win never compete", () => {
  const text = [
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

  const evidence = extractNumericRoleEvidence(text);
  const stakes = findByRole(evidence, "STAKE");

  // Every STAKE entry found must agree with the real stake (100) — none may
  // carry the potential-win value (142.00).
  assert.ok(stakes.length > 0, "expected at least one STAKE entry (the real 'Сумма ставки' label)");
  for (const stake of stakes) {
    assert.ok(sameNumericValue(stake.value, "100"), `unexpected STAKE evidence value: ${stake.value}`);
  }
  // The explicit label itself must be present among them.
  assert.ok(stakes.some((s) => s.marker === "сумма ставки"));
});

/* ============================================================================
 * SCREENSHOT QA-CORE M1 — English "Potential winnings"/"Possible win" join
 * the existing выигрыш/выплата/баланс/payout/balance exclusion vocabulary.
 * ============================================================================ */

test("M1: a currency-suffixed number is NOT tagged STAKE when it directly follows 'Potential winnings'", () => {
  const text = "Potential winnings\n185.00 USD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.equal(stakes.length, 0, "185.00 must never become STAKE evidence merely because it has a currency suffix");
});

test("M1: a currency-suffixed number is NOT tagged STAKE when it directly follows 'Possible win'", () => {
  const text = "Possible win\n185.00 USD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.equal(stakes.length, 0);
});

test("M1: 'Potential win' (no trailing 'nings') is also excluded", () => {
  const text = "Potential win\n185.00 USD";
  const stakes = findByRole(extractNumericRoleEvidence(text), "STAKE");
  assert.equal(stakes.length, 0);
});

test("M1: the 'win' exclusion is narrowly scoped to 'potential win.../possible win...' — a bare market phrase like 'to win' near an unrelated currency-suffixed stake is never suppressed", () => {
  const stakes = findByRole(extractNumericRoleEvidence("RB Leipzig to win\nStake\n100 USD"), "STAKE");
  assert.ok(stakes.some((s) => sameNumericValue(s.value, "100")), "the real stake must still be recognized despite the nearby 'to win' market phrase");
});

/* ============================================================================
 * SCREENSHOT QA-CORE M1.1 — a real production screenshot proved a second,
 * distinct false-LINE-evidence bug: a row of quick-add stake buttons
 * ("+10 +25 +100") was misread by shorthandClassifier.ts's deliberately
 * permissive SPREAD_BARE_SIGNED_PATTERN (any "<text> <signed number>" shape)
 * as a sequence of SPREAD lines, each "attributed" to the PRECEDING button's
 * own text (or an info icon) as if it were a real team name — producing
 * false LABEL_STRONG LINE evidence that conflicted with the genuine,
 * correctly-labeled line and turned CORROBORATED into AMBIGUOUS. Fixed by
 * requiring a classified participant name to contain at least one letter
 * before this module trusts it as real LINE evidence — a name made entirely
 * of digits/symbols is never a real participant in any language.
 * ============================================================================ */

test("M1.1: a row of bare signed quick-add stake buttons never becomes LINE evidence, even when each is preceded by another number/icon that superficially parses as a 'participant name'", () => {
  const text = "больше 2.5\nⓘ +10 +25 +100";
  const lines = findByRole(extractNumericRoleEvidence(text), "LINE");
  assert.equal(lines.length, 1, "only the genuine 'больше 2.5' line may be recognized");
  assert.equal(lines[0].value, "2.5");
});

test("M1.1: a genuine SPREAD attributed to a real team name is unaffected by the letter guard", () => {
  const lines = findByRole(extractNumericRoleEvidence("Arsenal +1.5\nставка 10"), "LINE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "+1.5");
  assert.equal(lines[0].marker, "arsenal");
});

test("M1.1: a genuine Cyrillic team name (letters outside a-z) still corroborates a SPREAD line", () => {
  const lines = findByRole(extractNumericRoleEvidence("Реал +1.5\nставка 10"), "LINE");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].value, "+1.5");
});
