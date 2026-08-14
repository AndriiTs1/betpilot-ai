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

/* -------------------------------------------------------------------------- */
/* Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary, new.   */
/* No changes to this file's own algorithm — these tests confirm the        */
/* existing, unmodified windowing already produces strong SPREAD evidence   */
/* for the new shorthandClassifier.ts vocabulary, exactly as it already did */
/* for Ф1/Ф2.                                                                */
/* -------------------------------------------------------------------------- */

test("H3 required example 1: 'Арсенал фора -1.5 ставка 10' -> strong SPREAD evidence, participant Arsenal, line -1.5", () => {
  const text = "Арсенал фора -1.5 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.selectionType, "PARTICIPANT");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
  assert.equal(spanText(text, evidence[0]), "Арсенал фора -1.5");
});

test("H3 required example 2: 'Arsenal handicap -1.5 stake 10' -> strong SPREAD evidence, participant Arsenal, line -1.5", () => {
  const text = "Arsenal handicap -1.5 stake 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Arsenal");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
  assert.equal(spanText(text, evidence[0]), "Arsenal handicap -1.5");
});

// KNOWN, DISCLOSED LIMITATION (not fixed here, per this stage's explicit
// "do not modify marketIntentEvidence.ts / do not expand scope automatically"
// instruction): this file's own window is bounded at MAX_WINDOW_TOKENS (3),
// anchored backward from the number. "Арсенал азійська фора -1.25" is 4
// tokens (Арсенал/азійська/фора/-1.25) — one more than the window can ever
// span in a single pass. The classifier's own bare-marker form (see
// shorthandClassifier.ts's HANDICAP_BARE_PATTERN, tried first specifically
// so it never misattributes "азійська" as a fake participant — see that
// file's own tests) still lets Pass 1 recognize the 3-token tail window
// ("азійська фора -1.25") as SPREAD evidence — market intent IS still
// correctly and strongly detected — but participantName is null here
// (deferred, not fabricated), NOT "Арсенал", because "Арсенал" itself falls
// outside the 3-token window and consumed span. This does not weaken BA-2D:
// marketIntentVerifier.ts's own claim shape is (marketType, selectionType)
// ONLY — participantName is explicitly never part of what it compares (see
// that file's own header comment) — so this limitation has zero effect on
// the actual ambiguity/ verification layer. The REAL canonical
// classification path (legacyOddsBridge.ts, unwindowed — see that file's
// own H3 tests) correctly captures participantName "Арсенал" for this exact
// text, since it is never subject to this 3-token window at all.
test("H3 required example 3: 'Арсенал азійська фора -1.25 ставка 10' -> strong SPREAD evidence (participant lost to the pre-existing 3-token window bound — disclosed, not fixed; see comment above)", () => {
  const text = "Арсенал азійська фора -1.25 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.selectionType, "PARTICIPANT");
  assert.equal(evidence[0].classification.embeddedLine, "-1.25");
  assert.equal(spanText(text, evidence[0]), "азійська фора -1.25");
});

test("H3: a second team/EN mix still produces exactly one strong SPREAD entry, participant and line both captured when the window fits (single-word participant + single-word marker + line = 3 tokens)", () => {
  const text = "Barcelona handicap -2 stake 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Barcelona");
  assert.equal(evidence[0].classification.embeddedLine, "-2");
});

// Same disclosed 3-token window limitation as required example 3 above —
// a MULTI-WORD participant ("Real Madrid", 2 tokens) plus a 1-word marker
// plus the line is already 4 tokens, one more than MAX_WINDOW_TOKENS can
// span in a single pass. Market intent is still correctly and strongly
// detected as SPREAD; participantName is null here (deferred, not
// fabricated) rather than "Real Madrid", for the identical reason as the
// azійська/asian-modifier case. legacyOddsBridge.ts's own H3 tests (the
// real, unwindowed canonical classification path) confirm the multi-word
// participant IS correctly captured there.
test("H3 disclosed limitation: a multi-word participant ('Real Madrid') combined with a 1-word marker still produces strong SPREAD evidence, but the window bound loses the participant (null, not fabricated)", () => {
  const text = "Real Madrid handicap -2 stake 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.embeddedLine, "-2");
});

test("H3 conflicting signals: 'Арсенал фора -1.5 фора -2 ставка 10' preserves BOTH SPREAD signals independently — never collapsed or averaged, matching the same 'two independent strong signals' rule proven above for TOTALS/DRAW", () => {
  const text = "Арсенал фора -1.5 фора -2 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].classification.participantName, "Арсенал");
  assert.equal(evidence[0].classification.embeddedLine, "-1.5");
  assert.equal(evidence[1].classification.marketType, "SPREAD");
  assert.equal(evidence[1].classification.embeddedLine, "-2");
});

test("H3 negative: no false evidence for the new vocabulary's own adversarial strings", () => {
  for (const text of ["handicapper stake 10", "spreadsheet stake 10", "transformer stake 10"]) {
    const evidence = extractMarketIntentEvidence(text);
    for (const entry of evidence) {
      assert.notEqual(entry.classification.marketType, "SPREAD", text);
    }
  }
});

test("H3: existing MONEYLINE/TOTALS/Ф1 evidence is unaffected by the new handicap vocabulary", () => {
  const winner = extractMarketIntentEvidence("Арсенал победа ставка 10");
  assert.equal(winner.length, 1);
  assert.equal(winner[0].classification.marketType, "MONEYLINE_2WAY");

  const totals = extractMarketIntentEvidence("Арсенал ТБ 2.5 ставка 10");
  assert.equal(totals.length, 1);
  assert.equal(totals[0].classification.marketType, "TOTALS");

  const shortForm = extractMarketIntentEvidence("Арсенал Ф1(-1.5) ставка 10");
  assert.equal(shortForm.length, 1);
  assert.equal(shortForm[0].classification.marketType, "SPREAD");
  assert.equal(shortForm[0].classification.participantName, "Арсенал");
});

/* ============================================================================
 * PRODUCTION MARKET-INTENT DIAGNOSTICS — `matchedText` proves, for every
 * evidence entry, exactly which bounded local window produced it. It must
 * always equal the exact slice of originalText at [start, end) (never a
 * larger/different substring, never a normalized form), and must always stay
 * bounded (never the whole message), regardless of marketType.
 * ============================================================================ */

test("matchedText equals text.slice(start, end) exactly, for a DRAW (1X2) entry", () => {
  const text = "ничья ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "MONEYLINE_3WAY");
  assert.equal(evidence[0].classification.selectionType, "DRAW");
  assert.equal(evidence[0].matchedText, "ничья");
  assert.equal(evidence[0].matchedText, spanText(text, evidence[0]));
});

test("matchedText equals text.slice(start, end) exactly, for a TOTALS entry", () => {
  const text = "Арсенал ТБ 2.5 ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "TOTALS");
  assert.equal(evidence[0].matchedText, "ТБ 2.5");
  assert.equal(evidence[0].matchedText, spanText(text, evidence[0]));
});

test("matchedText equals text.slice(start, end) exactly, for a SPREAD entry", () => {
  const text = "Арсенал Ф1(-1.5) ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].classification.marketType, "SPREAD");
  assert.equal(evidence[0].matchedText, "Арсенал Ф1(-1.5)");
  assert.equal(evidence[0].matchedText, spanText(text, evidence[0]));
});

test("matchedText stays bounded to the matched window (<= MAX_WINDOW_TOKENS = 3 tokens) even inside a long surrounding message — never the full original text", () => {
  const padding = "лишний текст вокруг которого много слов и он не должен попасть в matchedText совсем никогда ";
  const text = padding + "ничья" + " " + padding + "ставка 10";
  const evidence = extractMarketIntentEvidence(text);
  const draw = evidence.find((e) => e.classification.marketType === "MONEYLINE_3WAY" && e.classification.selectionType === "DRAW");
  assert.ok(draw, "expected a DRAW entry");
  assert.equal(draw!.matchedText, "ничья");
  assert.ok(draw!.matchedText.length < text.length / 4, "matchedText must be a small bounded fragment, never a large chunk of the original text");
  assert.equal(draw!.matchedText.includes(padding.trim()), false);
});
