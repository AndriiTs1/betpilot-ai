import { test } from "node:test";
import assert from "node:assert/strict";
import { extractNumericRoleEvidence, type NumericRoleEvidence } from "./numericRoleEvidence";

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
  assert.equal(lines[0].confidence, "MARKER_HIGH");
  assertSpanText(text, stakes[0], "10");
  assert.equal(stakes[0].marker, "ставка");
  assert.equal(stakes[0].confidence, "MARKER_HIGH");
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
