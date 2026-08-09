import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMarketIntentEvidence, type MarketIntentEvidence } from "./marketIntentEvidence";

function spanText(text: string, evidence: MarketIntentEvidence): string {
  return text.slice(evidence.start, evidence.end);
}

/* -------------------------------------------------------------------------- */
/* MONEYLINE / winner — RU / UA / EN                                          */
/* -------------------------------------------------------------------------- */

test("MONEYLINE: 'Арсенал победа ставка 10' -> one MONEYLINE_2WAY/PARTICIPANT('Арсенал') entry", () => {
  const text = "Арсенал победа ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[0].classification.selectionType, "PARTICIPANT");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].confidence, "TOKEN_MATCH");
  assert.equal(spanText(text, evidence[0]), "Арсенал победа");
});

test("MONEYLINE: 'Арсенал выиграет ставка 10' -> MONEYLINE_2WAY/PARTICIPANT('Арсенал')", () => {
  const evidence = extractMarketIntentEvidence("Арсенал выиграет ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
});

test("MONEYLINE: 'Арсенал перемога ставка 10' (Ukrainian) -> MONEYLINE_2WAY/PARTICIPANT('Арсенал')", () => {
  const evidence = extractMarketIntentEvidence("Арсенал перемога ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
});

test("MONEYLINE: 'Arsenal win stake 10' -> MONEYLINE_2WAY/PARTICIPANT('Arsenal')", () => {
  const evidence = extractMarketIntentEvidence("Arsenal win stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[0].classification.participantName, "Arsenal");
});

test("MONEYLINE: 'Arsenal to win stake 10' -> MONEYLINE_2WAY/PARTICIPANT('Arsenal'), the full 3-token suffix — not the narrower, incorrect 'to win' window", () => {
  // Regression guard for a real bug found during Step 2's own empirical
  // testing: WINNER_SUFFIX_REGEX's bare "win" alternative can match the
  // 2-token window "to win" in isolation (the space between "to" and "win"
  // satisfies its own \s+), producing a bogus participant "to" — only
  // trying the largest window FIRST avoids this.
  const text = "Arsenal to win stake 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[0].classification.participantName, "Arsenal");
  assert.notEqual(evidence[0].classification.participantName, "to");
  assert.equal(spanText(text, evidence[0]), "Arsenal to win");
});

/* -------------------------------------------------------------------------- */
/* DRAW — RU / UA / EN                                                        */
/* -------------------------------------------------------------------------- */

test("DRAW: 'ничья ставка 10' -> one MONEYLINE_3WAY/DRAW entry", () => {
  const text = "ничья ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_3WAY");
  assert.equal(evidence[0].classification.selectionType, "DRAW");
  assert.equal(spanText(text, evidence[0]), "ничья");
});

test("DRAW: 'нічия ставка 10' (Ukrainian) -> MONEYLINE_3WAY/DRAW", () => {
  const evidence = extractMarketIntentEvidence("нічия ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_3WAY");
  assert.equal(evidence[0].classification.selectionType, "DRAW");
});

test("DRAW: 'draw stake 10' (English) -> MONEYLINE_3WAY/DRAW", () => {
  const evidence = extractMarketIntentEvidence("draw stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_3WAY");
  assert.equal(evidence[0].classification.selectionType, "DRAW");
});

/* -------------------------------------------------------------------------- */
/* TOTALS — RU / EN, token separate from its line                             */
/* -------------------------------------------------------------------------- */

test("TOTALS: 'Арсенал ТБ 2.5 ставка 10' -> TOTALS/OVER, embeddedLine '2.5'", () => {
  const text = "Арсенал ТБ 2.5 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.selectionType, "OVER");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
  assert.equal(spanText(text, evidence[0]), "ТБ 2.5");
});

test("TOTALS: 'Арсенал ТМ 3 ставка 10' -> TOTALS/UNDER, embeddedLine '3'", () => {
  const evidence = extractMarketIntentEvidence("Арсенал ТМ 3 ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.selectionType, "UNDER");
  assert.equal(evidence[0].classification.embeddedLine, "3");
});

test("TOTALS: 'Arsenal over 2.5 stake 10' -> TOTALS/OVER, embeddedLine '2.5'", () => {
  const evidence = extractMarketIntentEvidence("Arsenal over 2.5 stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.selectionType, "OVER");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
});

test("TOTALS: 'Arsenal under 3 stake 10' -> TOTALS/UNDER, embeddedLine '3'", () => {
  const evidence = extractMarketIntentEvidence("Arsenal under 3 stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.selectionType, "UNDER");
  assert.equal(evidence[0].classification.embeddedLine, "3");
});

/* -------------------------------------------------------------------------- */
/* SPREAD — RU / mixed / EN, glued token+line                                 */
/* -------------------------------------------------------------------------- */

test("SPREAD: 'Арсенал Ф1(-1.5) ставка 10' -> SPREAD, participant 'Арсенал', line '-1.5' — the exact production-incident text", () => {
  const text = "Арсенал Ф1(-1.5) ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.selectionType, "PARTICIPANT");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
  assert.equal(spanText(text, evidence[0]), "Арсенал Ф1(-1.5)");
});

test("SPREAD: 'Арсенал F1(-1.5) ставка 10' (Latin token in an otherwise-Cyrillic message) -> SPREAD, same as pure Cyrillic", () => {
  const evidence = extractMarketIntentEvidence("Арсенал F1(-1.5) ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
});

test("SPREAD: 'Arsenal F1(-1.5) stake 10' (fully Latin) -> SPREAD, participant 'Arsenal', line '-1.5' — future-incident proof", () => {
  const evidence = extractMarketIntentEvidence("Arsenal F1(-1.5) stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Arsenal");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
});

test("SPREAD: 'Арсенал Ф2(+1.5) ставка 10' -> SPREAD, positive line '+1.5'", () => {
  const evidence = extractMarketIntentEvidence("Арсенал Ф2(+1.5) ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].classification.embeddedLine, "+1.5");
});

test("SPREAD: 'Arsenal F2(+1.5) stake 10' -> SPREAD, positive line '+1.5'", () => {
  const evidence = extractMarketIntentEvidence("Arsenal F2(+1.5) stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Arsenal");
  assert.equal(evidence[0].classification.embeddedLine, "+1.5");
});

/* -------------------------------------------------------------------------- */
/* CRITICAL FUTURE-INCIDENT PROOF                                             */
/* -------------------------------------------------------------------------- */

test("CRITICAL: 'Арсенал Ф1(-1.5) ставка 10' always produces strong SPREAD evidence, independent of any AI/canonical output — this step never compares against one", () => {
  const evidence = extractMarketIntentEvidence("Арсенал Ф1(-1.5) ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
});

test("CRITICAL: 'Arsenal F1(-1.5) stake 10' also always produces strong SPREAD evidence — the Latin form is not treated any differently", () => {
  const evidence = extractMarketIntentEvidence("Arsenal F1(-1.5) stake 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
});

/* -------------------------------------------------------------------------- */
/* Generic PARTICIPANT fallback exclusion                                     */
/* -------------------------------------------------------------------------- */

test("no evidence: 'Арсенал 10' — a bare team name and a number, no market-shape token anywhere", () => {
  assert.deepEqual(extractMarketIntentEvidence("Арсенал 10"), []);
});

test("no evidence: 'Arsenal 10'", () => {
  assert.deepEqual(extractMarketIntentEvidence("Arsenal 10"), []);
});

test("no evidence: 'ставка 10 на Арсенал'", () => {
  assert.deepEqual(extractMarketIntentEvidence("ставка 10 на Арсенал"), []);
});

test("no evidence: 'stake 10 on Arsenal'", () => {
  assert.deepEqual(extractMarketIntentEvidence("stake 10 on Arsenal"), []);
});

/* -------------------------------------------------------------------------- */
/* Multiple, independently-preserved evidence occurrences                     */
/* -------------------------------------------------------------------------- */

test("multiple evidence: 'Арсенал ТБ 2.5 ТМ 3.5 ставка 10' -> two separate TOTALS entries, never collapsed", () => {
  const text = "Арсенал ТБ 2.5 ТМ 3.5 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.selectionType, "OVER");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
  assert.equal(spanText(text, evidence[0]), "ТБ 2.5");
  assert.equal(evidence[1].classification.marketType, "TOTALS");
  assert.equal(evidence[1].classification.selectionType, "UNDER");
  assert.equal(evidence[1].classification.embeddedLine, "3.5");
  assert.equal(spanText(text, evidence[1]), "ТМ 3.5");
});

test("multiple evidence: 'ничья Арсенал победа ставка 10' -> two independent strong signals (DRAW and MONEYLINE), never merged into one fabricated match", () => {
  const text = "ничья Арсенал победа ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_3WAY");
  assert.equal(evidence[0].classification.selectionType, "DRAW");
  assert.equal(spanText(text, evidence[0]), "ничья");
  assert.equal(evidence[1].classification.marketType, "MONEYLINE_2WAY");
  assert.equal(evidence[1].classification.participantName, "Арсенал");
  assert.equal(spanText(text, evidence[1]), "Арсенал победа");
  // Neither entry's participant/text contains a fragment of the other
  // signal — proves the two were never merged into one 3-token match
  // ("ничья Арсенал победа" as a single fabricated PARTICIPANT).
  assert.notEqual(evidence[1].classification.participantName, "ничья Арсенал");
});

/* -------------------------------------------------------------------------- */
/* BA-2C punctuation regression — same forms already proven at the           */
/* classifier level, re-verified through this extractor                      */
/* -------------------------------------------------------------------------- */

test("punctuation regression: 'ТБ:2.5' still produces TOTALS evidence", () => {
  const evidence = extractMarketIntentEvidence("ТБ:2.5");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
});

test("punctuation regression: 'ТБ(2.5)' still produces TOTALS evidence", () => {
  const evidence = extractMarketIntentEvidence("ТБ(2.5)");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.embeddedLine, "2.5");
});

test("punctuation regression: 'F1:-1.5' still produces SPREAD evidence", () => {
  const evidence = extractMarketIntentEvidence("F1:-1.5");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
});

test("punctuation regression: 'F1(-1.5)' still produces SPREAD evidence", () => {
  const evidence = extractMarketIntentEvidence("F1(-1.5)");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
});

/* -------------------------------------------------------------------------- */
/* Decimal comma — audit only, no normalization added in this step           */
/* -------------------------------------------------------------------------- */

test("decimal comma finding: 'Арсенал ТБ 2,5 ставка 10' degrades to TOTALS evidence with NO line captured (shorthandClassifier's own LINE_NUMBER is dot-only) — not fixed in this step", () => {
  const evidence = extractMarketIntentEvidence("Арсенал ТБ 2,5 ставка 10");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].classification.embeddedLine, null);
});

test("decimal comma finding: 'Арсенал Ф1(-1,5) ставка 10' produces NO evidence at all (worse degradation than TOTALS — the comma breaks the paren-wrapped signed-number match entirely) — not fixed in this step", () => {
  assert.deepEqual(extractMarketIntentEvidence("Арсенал Ф1(-1,5) ставка 10"), []);
});

/* -------------------------------------------------------------------------- */
/* Negative / adversarial — no false market evidence                          */
/* -------------------------------------------------------------------------- */

test("negative: no false evidence for representative adversarial/unrelated strings", () => {
  for (const text of ["F1abc-1.5", "Staff1", "Sheff2", "шкаф1", "ТБabc2.5", "random text"]) {
    assert.deepEqual(extractMarketIntentEvidence(text), [], text);
  }
});

/* -------------------------------------------------------------------------- */
/* originalText is never mutated                                              */
/* -------------------------------------------------------------------------- */

test("originalText is never touched: evidence spans slice back to the exact original substring, byte-for-byte, for every source form (Cyrillic, Latin, mixed, punctuated)", () => {
  const cases = [
    "Арсенал победа ставка 10",
    "Arsenal to win stake 10",
    "ничья ставка 10",
    "Арсенал ТБ 2.5 ставка 10",
    "Арсенал Ф1(-1.5) ставка 10",
    "Arsenal F1(-1.5) stake 10",
    "ничья Арсенал победа ставка 10",
  ];
  for (const text of cases) {
    const original = text;
    const evidence = extractMarketIntentEvidence(text);
    assert.equal(text, original, "extractMarketIntentEvidence must never mutate its input");
    for (const entry of evidence) {
      assert.ok(entry.start >= 0 && entry.end <= text.length && entry.start < entry.end, text);
    }
  }
});
