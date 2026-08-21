import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBettingSelectionText,
  classifyBettingSelectionTextWithMarketHint,
  stripTrailingWinnerSuffix,
  isBareMoneylineShorthandToken,
} from "./shorthandClassifier";

/* -------------------------------------------------------------------------- */
/* Moneyline — bare 1X2 tokens (parity with the removed legacyOddsBridge.ts   */
/* HOME_TOKENS/DRAW_TOKENS/AWAY_TOKENS fixtures)                              */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: HOME tokens (1/П1/P1/W1/home)", () => {
  for (const input of ["1", "П1", "п1", "P1", "p1", "W1", "w1", "Home", "home"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "MONEYLINE_3WAY", `"${input}"`);
    assert.equal(result.selectionType, "HOME", `"${input}"`);
    assert.equal(result.participantName, null);
    assert.equal(result.embeddedLine, null);
  }
});

test("classifyBettingSelectionText: DRAW tokens (X/Х/draw/ничья/нічия)", () => {
  for (const input of ["X", "x", "Х", "х", "Draw", "draw", "Ничья", "ничья", "Нічия", "нічия"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "MONEYLINE_3WAY", `"${input}"`);
    assert.equal(result.selectionType, "DRAW", `"${input}"`);
  }
});

test("classifyBettingSelectionText: AWAY tokens (2/П2/P2/W2/away)", () => {
  for (const input of ["2", "П2", "п2", "P2", "p2", "W2", "w2", "Away", "away"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "MONEYLINE_3WAY", `"${input}"`);
    assert.equal(result.selectionType, "AWAY", `"${input}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* Moneyline — winner-suffix phrases                                          */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: English winner-suffix stripping (parity)", () => {
  for (const input of ["Inter Win", "Inter to win", "Inter wins"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "MONEYLINE_2WAY", `"${input}"`);
    assert.equal(result.selectionType, "PARTICIPANT", `"${input}"`);
    assert.equal(result.participantName, "Inter", `"${input}"`);
  }
});

test("classifyBettingSelectionText: Russian/Ukrainian winner-suffix stripping (new)", () => {
  const cases: Array<[string, string]> = [
    ["Арсенал победа", "Арсенал"],
    ["Реал выиграет", "Реал"],
    ["Динамо перемога", "Динамо"],
  ];
  for (const [input, expectedParticipant] of cases) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "MONEYLINE_2WAY", `"${input}"`);
    assert.equal(result.selectionType, "PARTICIPANT", `"${input}"`);
    assert.equal(result.participantName, expectedParticipant, `"${input}"`);
  }
});

test("classifyBettingSelectionText: 'home team'/'away team' phrasing after suffix stripping", () => {
  const home = classifyBettingSelectionText("Home Win");
  assert.equal(home.selectionType, "HOME");
  const away = classifyBettingSelectionText("Away Team Wins");
  assert.equal(away.selectionType, "AWAY");
});

test("classifyBettingSelectionText: plain team name with no recognizable token is a lossless PARTICIPANT fallback", () => {
  for (const text of ["Real Madrid", "Manchester City", "Carlos Alcaraz"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "MONEYLINE_2WAY", `"${text}"`);
    assert.equal(result.selectionType, "PARTICIPANT", `"${text}"`);
    assert.equal(result.participantName, text, `"${text}"`);
  }
});

test("classifyBettingSelectionText: combined double-chance notation ('1X'/'X2'/'12') is NOT classified as a single HOME/DRAW/AWAY token — falls back to PARTICIPANT (parity: double-chance shorthand is out of BA-2A's scope)", () => {
  for (const combined of ["1X", "X2", "12"]) {
    const result = classifyBettingSelectionText(combined);
    assert.equal(result.selectionType, "PARTICIPANT", `"${combined}"`);
  }
});

test("classifyBettingSelectionText: 'Home win'/'home team wins'/'Away win'/'away team wins' resolve to HOME/AWAY, not PARTICIPANT (case-insensitive)", () => {
  for (const text of ["Home win", "home team wins", "HOME WINS"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.selectionType, "HOME", `"${text}"`);
    assert.equal(result.marketType, "MONEYLINE_3WAY");
  }
  for (const text of ["Away win", "away team wins", "AWAY WINS"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.selectionType, "AWAY", `"${text}"`);
    assert.equal(result.marketType, "MONEYLINE_3WAY");
  }
});

test("classifyBettingSelectionText: a real participant name is never damaged by the winner-suffix strip when there is no actual separating word boundary", () => {
  for (const text of ["Darwin", "Edwin", "Corwin"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.selectionType, "PARTICIPANT", `"${text}"`);
    assert.equal(result.participantName, text, `"${text}" must survive completely unmodified`);
  }
});

/* -------------------------------------------------------------------------- */
/* Totals (match) — parity with the removed classifyTotalsDirection fixtures  */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: every required OVER phrase family, embedded line captured", () => {
  for (const input of ["ТБ 2.5", "ТБ2.5", "тотал больше 2.5", "больше 2.5", "Over 2.5", "Over2.5", "O2.5"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.selectionType, "OVER", `"${input}"`);
    assert.equal(result.embeddedLine, "2.5", `"${input}"`);
  }
});

test("classifyBettingSelectionText: every required UNDER phrase family, embedded line captured", () => {
  for (const input of ["ТМ 2.5", "ТМ2.5", "тотал меньше 2.5", "меньше 2.5", "Under 2.5", "Under2.5", "U2.5"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.selectionType, "UNDER", `"${input}"`);
    assert.equal(result.embeddedLine, "2.5", `"${input}"`);
  }
});

test("classifyBettingSelectionText: totals — case-insensitive and tolerant of whitespace", () => {
  assert.equal(classifyBettingSelectionText("  over 2.5  ").selectionType, "OVER");
  assert.equal(classifyBettingSelectionText("OVER 2.5").selectionType, "OVER");
  assert.equal(classifyBettingSelectionText("тб 2.5").selectionType, "OVER");
});

test("classifyBettingSelectionText: bare 'Over'/'Under'/'ТБ' with no embedded number", () => {
  const over = classifyBettingSelectionText("Over");
  assert.equal(over.marketType, "TOTALS");
  assert.equal(over.selectionType, "OVER");
  assert.equal(over.embeddedLine, null);

  const tb = classifyBettingSelectionText("ТБ");
  assert.equal(tb.marketType, "TOTALS");
  assert.equal(tb.selectionType, "OVER");
  assert.equal(tb.embeddedLine, null);
});

test("classifyBettingSelectionText: a bare single letter 'O'/'U' with NO number is never recognized as totals", () => {
  assert.notEqual(classifyBettingSelectionText("O").marketType, "TOTALS");
  assert.notEqual(classifyBettingSelectionText("U").marketType, "TOTALS");
});

test("classifyBettingSelectionText: ambiguous text containing both Over and Under is never classified as totals", () => {
  assert.notEqual(classifyBettingSelectionText("Over Under 2.5").marketType, "TOTALS");
  assert.notEqual(classifyBettingSelectionText("Over/Under 2.5").marketType, "TOTALS");
});

test("classifyBettingSelectionText: ordinary moneyline text is never classified as totals", () => {
  for (const input of ["1", "X", "2", "Real Madrid Win", "Arsenal", "Home", "Away", "Draw"]) {
    assert.notEqual(classifyBettingSelectionText(input).marketType, "TOTALS", `"${input}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* H5-A3 — "Asian total" natural-language vocabulary (EN/RU/UA). Closes the  */
/* H5-A1-audited gap: quarter lines already worked through the existing      */
/* "тб"/"тотал больше"/"over" forms — only the ASIAN-prefixed and Ukrainian   */
/* "більше"/"менше" phrasing was unrecognized. Generic rule, never a special */
/* case for 2.25/2.75 specifically.                                          */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: every required EN/RU/UA 'Asian total' OVER phrase, exact quarter line captured, never invented/rounded", () => {
  const cases: Array<[string, string]> = [
    ["Asian total over 2.25", "2.25"],
    ["Asian total over 3.25", "3.25"],
    ["азиатский тотал больше 2.25", "2.25"],
    ["азиатский тотал больше 3.25", "3.25"],
    ["тотал більше 2.25", "2.25"],
    ["азійський тотал більше 2.25", "2.25"],
    ["азійський тотал більше 3.25", "3.25"],
  ];
  for (const [input, expectedLine] of cases) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.selectionType, "OVER", `"${input}"`);
    assert.equal(result.embeddedLine, expectedLine, `"${input}"`);
    assert.notEqual(result.marketType, "MONEYLINE_2WAY", `"${input}" must never fall through to MONEYLINE_2WAY`);
    assert.notEqual(result.marketType, "SPREAD", `"${input}" must never be confused with SPREAD`);
  }
});

test("classifyBettingSelectionText: every required EN/RU/UA 'Asian total' UNDER phrase, exact quarter line captured", () => {
  const cases: Array<[string, string]> = [
    ["Asian total under 2.75", "2.75"],
    ["Asian total under 3.75", "3.75"],
    ["азиатский тотал меньше 2.75", "2.75"],
    ["тотал менше 2.75", "2.75"],
    ["азійський тотал менше 2.75", "2.75"],
    ["азійський тотал менше 3.75", "3.75"],
  ];
  for (const [input, expectedLine] of cases) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.selectionType, "UNDER", `"${input}"`);
    assert.equal(result.embeddedLine, expectedLine, `"${input}"`);
    assert.notEqual(result.marketType, "MONEYLINE_2WAY", `"${input}" must never fall through to MONEYLINE_2WAY`);
    assert.notEqual(result.marketType, "SPREAD", `"${input}" must never be confused with SPREAD`);
  }
});

test("classifyBettingSelectionText: 'Asian total' vocabulary works generically for standard (non-quarter) lines too, not special-cased to 2.25/2.75", () => {
  assert.equal(classifyBettingSelectionText("Asian total over 2.5").embeddedLine, "2.5");
  assert.equal(classifyBettingSelectionText("азиатский тотал больше 3").embeddedLine, "3");
  assert.equal(classifyBettingSelectionText("тотал більше 2.5").embeddedLine, "2.5");
});

test("classifyBettingSelectionText: 'Asian total' phrasing is case-insensitive and tolerant of whitespace, matching the existing classifier convention", () => {
  assert.equal(classifyBettingSelectionText("ASIAN TOTAL OVER 2.25").selectionType, "OVER");
  assert.equal(classifyBettingSelectionText("  Asian Total Over 2.25  ").selectionType, "OVER");
  assert.equal(classifyBettingSelectionText("АЗІЙСЬКИЙ ТОТАЛ БІЛЬШЕ 2.25").selectionType, "OVER");
});

test("classifyBettingSelectionText: bare 'Asian total over'/'тотал більше' with NO embedded number is still recognized as TOTALS with embeddedLine null — never an invented/default line", () => {
  for (const input of ["Asian total over", "азиатский тотал больше", "азійський тотал більше", "тотал менше"]) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.embeddedLine, null, `"${input}" must never invent a line`);
  }
});

test("classifyBettingSelectionText: existing non-Asian TOTALS forms are completely unaffected by the new vocabulary", () => {
  for (const [input, direction, line] of [
    ["Over 2.5", "OVER", "2.5"],
    ["Under 3", "UNDER", "3"],
    ["Over 2.25", "OVER", "2.25"],
    ["Under 2.75", "UNDER", "2.75"],
    ["ТБ 2.5", "OVER", "2.5"],
    ["ТМ 3", "UNDER", "3"],
    ["ТБ 2.25", "OVER", "2.25"],
    ["ТМ 2.75", "UNDER", "2.75"],
    ["тотал больше 2.25", "OVER", "2.25"],
    ["тотал меньше 2.75", "UNDER", "2.75"],
  ] as const) {
    const result = classifyBettingSelectionText(input);
    assert.equal(result.marketType, "TOTALS", `"${input}"`);
    assert.equal(result.selectionType, direction, `"${input}"`);
    assert.equal(result.embeddedLine, line, `"${input}"`);
  }
});

test("classifyBettingSelectionText: SPREAD shorthand/natural-language remains unaffected by the new TOTALS vocabulary", () => {
  const a = classifyBettingSelectionText("Arsenal -1.5");
  assert.equal(a.marketType, "SPREAD");
  assert.equal(a.participantName, "Arsenal");
  assert.equal(a.embeddedLine, "-1.5");

  const b = classifyBettingSelectionText("Arsenal -0.75");
  assert.equal(b.marketType, "SPREAD");
  assert.equal(b.embeddedLine, "-0.75");

  const c = classifyBettingSelectionText("фора Arsenal -1.25");
  assert.equal(c.marketType, "SPREAD");
  assert.equal(c.participantName, "Arsenal");
  assert.equal(c.embeddedLine, "-1.25");
});

test("classifyBettingSelectionText: ordinary MONEYLINE participant text remains unaffected by the new TOTALS vocabulary", () => {
  for (const input of ["Real Madrid Win", "Arsenal", "Fenerbahce"]) {
    assert.notEqual(classifyBettingSelectionText(input).marketType, "TOTALS", `"${input}"`);
    assert.notEqual(classifyBettingSelectionText(input).marketType, "SPREAD", `"${input}"`);
  }
});

test("classifyBettingSelectionText: matching stays anchored — text merely CONTAINING 'over'/'under'/'больше'/'меньше'/'більше'/'менше' mid-string is never classified as TOTALS", () => {
  for (const input of ["Hangover 2.5", "Undertaker", "The Overwatch Team", "не больше 2.5", "gameover"]) {
    assert.notEqual(classifyBettingSelectionText(input).marketType, "TOTALS", `"${input}"`);
  }
});

/* -------------------------------------------------------------------------- */
/* Team totals — ИТБ/ИТМ, new                                                 */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: 'Арсенал ИТБ 1.5' -> TEAM_TOTAL/OVER, participant + line", () => {
  const result = classifyBettingSelectionText("Арсенал ИТБ 1.5");
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "1.5");
});

test("classifyBettingSelectionText: 'ИТБ Арсенал 1.5' (token before team) -> TEAM_TOTAL/OVER", () => {
  const result = classifyBettingSelectionText("ИТБ Арсенал 1.5");
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "1.5");
});

test("classifyBettingSelectionText: 'Арсенал ИТМ 1.5' -> TEAM_TOTAL/UNDER", () => {
  const result = classifyBettingSelectionText("Арсенал ИТМ 1.5");
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "1.5");
});

test("classifyBettingSelectionText: bare 'ИТБ 1.5' with no participant embedded -> TEAM_TOTAL, participantName null", () => {
  const result = classifyBettingSelectionText("ИТБ 1.5");
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, null);
  assert.equal(result.embeddedLine, "1.5");
});

test("classifyBettingSelectionText: TEAM_TOTAL is never confused with match TOTALS (ИТБ vs ТБ are distinct tokens)", () => {
  assert.equal(classifyBettingSelectionText("ТБ 2.5").marketType, "TOTALS");
  assert.equal(classifyBettingSelectionText("ИТБ 2.5").marketType, "TEAM_TOTAL");
});

/* -------------------------------------------------------------------------- */
/* Spread / handicap — Ф1/Ф2 and participant-attributed signed line, new     */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: 'Арсенал Ф1(-1.5)' -> SPREAD, participant + line", () => {
  const result = classifyBettingSelectionText("Арсенал Ф1(-1.5)");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.selectionType, "PARTICIPANT");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "-1.5");
});

test("classifyBettingSelectionText: 'Челси Ф2(+1)' -> SPREAD, participant + positive line", () => {
  const result = classifyBettingSelectionText("Челси Ф2(+1)");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Челси");
  assert.equal(result.embeddedLine, "+1");
});

test("classifyBettingSelectionText: 'Арсенал -1.5' (bare signed line attributed to a named participant) -> SPREAD", () => {
  const result = classifyBettingSelectionText("Арсенал -1.5");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "-1.5");
});

test("classifyBettingSelectionText: an UNATTRIBUTED bare signed line ('-1.5' alone, no participant) is never classified as SPREAD", () => {
  const result = classifyBettingSelectionText("-1.5");
  assert.notEqual(result.marketType, "SPREAD");
  assert.equal(result.selectionType, "PARTICIPANT");
});

/* -------------------------------------------------------------------------- */
/* knownParticipantNames — closes the anchor gap for a concatenated string    */
/* -------------------------------------------------------------------------- */

// Individual Team Totals, Stage 1 — CONTRACT CHANGE. These two tests
// previously asserted "Арсенал ТБ 2.5"/"Арсенал ТМ 2.5" resolve to bare
// MATCH TOTALS (TOTALS, participantName null), labeled "the exact production
// regression case" — that was the correct fix for a DIFFERENT, older bug
// (a team-name-glued shorthand token falling back to a fabricated
// MONEYLINE_2WAY/PARTICIPANT reading instead of being recognized as a
// totals token at all). It was never correct for what this exact shape
// actually means: a bettor who types a known team's name directly in front
// of ТБ/ТМ is asking for THAT TEAM's total, not the match's — and silently
// discarding the team name here was the verified root cause of the real
// production bug "Marseille Over 1.5 -> Not available" (it caused the
// selection to be queried as a match-total against the wrong line/market
// entirely, rather than the correct team-total market). This is a
// deliberate, intentional behavior change, not a regression: the contract
// is now TEAM_TOTAL + the stripped participant, matching what
// "Марсель ИТБ 2.5" already resolves to via the dedicated ИТБ/ИТМ token.
test("classifyBettingSelectionText: 'Арсенал ТБ 2.5' with knownParticipantNames resolves to TEAM_TOTAL/Арсенал/OVER/2.5 (was TOTALS pre-Stage-1; see comment above)", () => {
  const result = classifyBettingSelectionText("Арсенал ТБ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "2.5");
});

test("classifyBettingSelectionText: 'Арсенал ТМ 2.5' with knownParticipantNames resolves to TEAM_TOTAL/Арсенал/UNDER/2.5 (was TOTALS pre-Stage-1; see comment above)", () => {
  const result = classifyBettingSelectionText("Арсенал ТМ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "2.5");
});

test("classifyBettingSelectionText: without knownParticipantNames, the same concatenated string falls back to PARTICIPANT (no regression for existing callers)", () => {
  const result = classifyBettingSelectionText("Арсенал ТБ 2.5");
  assert.equal(result.marketType, "MONEYLINE_2WAY");
  assert.equal(result.selectionType, "PARTICIPANT");
  assert.equal(result.participantName, "Арсенал ТБ 2.5");
});

test("classifyBettingSelectionText: a knownParticipantNames entry that isn't actually a prefix of the text has no effect", () => {
  const result = classifyBettingSelectionText("Реал победа", ["Арсенал"]);
  assert.equal(result.marketType, "MONEYLINE_2WAY");
  assert.equal(result.selectionType, "PARTICIPANT");
  assert.equal(result.participantName, "Реал");
});

test("classifyBettingSelectionText: knownParticipantNames does not falsely strip a name that isn't whitespace-bounded (e.g. 'Арсеналец')", () => {
  const result = classifyBettingSelectionText("Арсеналец ТБ 2.5", ["Арсенал"]);
  // "Арсенал" is a prefix of "Арсеналец" but not followed by whitespace —
  // must not be stripped, so this stays an ordinary (unresolved) fallback.
  assert.equal(result.marketType, "MONEYLINE_2WAY");
  assert.equal(result.selectionType, "PARTICIPANT");
});

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 1 — deterministic input classification only. */
/* Full RU/EN coverage for the required MATCH TOTAL vs TEAM TOTAL contract:   */
/* explicit participant + ТБ/ТМ/Over/Under -> TEAM_TOTAL, participant         */
/* attached, exact line preserved; no participant -> stays MATCH TOTALS;      */
/* the dedicated ИТБ/ИТМ token continues to work unchanged (already correct  */
/* before this stage — matchTeamTotal recognizes it directly, no             */
/* knownParticipantNames needed); both event participants (Marseille AND     */
/* Strasbourg) are proven independently, never cross-attributed.             */
/* -------------------------------------------------------------------------- */

const MARSEILLE_STRASBOURG = ["Марсель", "Страсбург"];

test("Individual Team Totals Stage 1 (1): 'Марсель ТБ 1.5' -> TEAM_TOTAL/Марсель/OVER/1.5", () => {
  const result = classifyBettingSelectionText("Марсель ТБ 1.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "1.5");
});

test("Individual Team Totals Stage 1 (2): 'Марсель ТМ 2.5' -> TEAM_TOTAL/Марсель/UNDER/2.5", () => {
  const result = classifyBettingSelectionText("Марсель ТМ 2.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (3): 'Marseille Over 1.5' -> TEAM_TOTAL/Marseille/OVER/1.5 (the exact verified production bug input)", () => {
  const result = classifyBettingSelectionText("Marseille Over 1.5", ["Marseille", "Strasbourg"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Marseille");
  assert.equal(result.embeddedLine, "1.5");
});

test("Individual Team Totals Stage 1 (4): 'Marseille Under 2.5' -> TEAM_TOTAL/Marseille/UNDER/2.5", () => {
  const result = classifyBettingSelectionText("Marseille Under 2.5", ["Marseille", "Strasbourg"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Marseille");
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (5): 'Страсбург ТБ 1.5' -> TEAM_TOTAL/Страсбург/OVER/1.5 (the OTHER team in the same event — never cross-attributed to Марсель)", () => {
  const result = classifyBettingSelectionText("Страсбург ТБ 1.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Страсбург");
  assert.equal(result.embeddedLine, "1.5");
});

test("Individual Team Totals Stage 1 (6): 'Страсбург ТМ 2.5' -> TEAM_TOTAL/Страсбург/UNDER/2.5", () => {
  const result = classifyBettingSelectionText("Страсбург ТМ 2.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Страсбург");
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (7): 'Марсель ИТБ 1.5' -> TEAM_TOTAL/Марсель/OVER/1.5 (dedicated token, already worked before Stage 1 — no regression)", () => {
  const result = classifyBettingSelectionText("Марсель ИТБ 1.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "1.5");
});

test("Individual Team Totals Stage 1 (8): 'Марсель ИТМ 2.5' -> TEAM_TOTAL/Марсель/UNDER/2.5 (dedicated token, already worked before Stage 1 — no regression)", () => {
  const result = classifyBettingSelectionText("Марсель ИТМ 2.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (9): bare 'ТБ 2.5' (no participant in text) remains MATCH TOTALS — never invents a participant even when knownParticipantNames is non-empty", () => {
  const result = classifyBettingSelectionText("ТБ 2.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, null);
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (10): bare 'ТМ 2.5' (no participant in text) remains MATCH TOTALS — never invents a participant even when knownParticipantNames is non-empty", () => {
  const result = classifyBettingSelectionText("ТМ 2.5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, null);
  assert.equal(result.embeddedLine, "2.5");
});

test("Individual Team Totals Stage 1 (11): exact whole-number line '2' is never altered — 'Марсель ТБ 2' keeps embeddedLine '2', not '2.0'/'2.5'", () => {
  const result = classifyBettingSelectionText("Марсель ТБ 2", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "2");
});

test("Individual Team Totals Stage 1 (12): decimal line '1.5' is never altered — 'Марсель ТБ 1.5' keeps embeddedLine '1.5' exactly", () => {
  const result = classifyBettingSelectionText("Марсель ТБ 1.5", MARSEILLE_STRASBOURG);
  assert.equal(result.embeddedLine, "1.5");
});

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 2 — RU decimal comma. The comma is a valid   */
/* number SHAPE at this layer (LINE_NUMBER), captured RAW into embeddedLine   */
/* (still comma, unconverted) — the actual comma-to-dot conversion happens    */
/* centrally in domain.ts's normalizeLineString, proven at the               */
/* legacyOddsBridge.ts request-mapping layer below, not here.                 */
/* -------------------------------------------------------------------------- */

test("Individual Team Totals Stage 2: 'Марсель ТБ 1,5' -> TEAM_TOTAL/Марсель/OVER, embeddedLine raw '1,5' (comma preserved at this layer)", () => {
  const result = classifyBettingSelectionText("Марсель ТБ 1,5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "1,5");
});

test("Individual Team Totals Stage 2: 'Марсель ТМ 2,5' -> TEAM_TOTAL/Марсель/UNDER, embeddedLine raw '2,5'", () => {
  const result = classifyBettingSelectionText("Марсель ТМ 2,5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "2,5");
});

test("Individual Team Totals Stage 2: bare 'ТБ 2,5' -> TOTALS/OVER, no participant invented, embeddedLine raw '2,5'", () => {
  const result = classifyBettingSelectionText("ТБ 2,5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, null);
  assert.equal(result.embeddedLine, "2,5");
});

test("Individual Team Totals Stage 2: bare 'ТМ 1,5' -> TOTALS/UNDER, no participant invented", () => {
  const result = classifyBettingSelectionText("ТМ 1,5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "UNDER");
  assert.equal(result.participantName, null);
  assert.equal(result.embeddedLine, "1,5");
});

test("Individual Team Totals Stage 2: 'Марсель ИТБ 1,5' (dedicated token) also accepts the comma decimal", () => {
  const result = classifyBettingSelectionText("Марсель ИТБ 1,5", MARSEILLE_STRASBOURG);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.participantName, "Марсель");
  assert.equal(result.embeddedLine, "1,5");
});

test("Individual Team Totals Stage 2: colon/paren separator forms still work with a comma-decimal number ('ТБ:2,5', 'ТБ(2,5)')", () => {
  for (const text of ["ТБ:2,5", "ТБ(2,5)", "ТБ: 2,5", "ТБ (2,5)"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "TOTALS", text);
    assert.equal(result.embeddedLine, "2,5", text);
  }
});

test("Individual Team Totals Stage 2: a bare comma directly glued to the token (no digit before it) is still never accepted as a token-to-number separator — 'ТБ,2.5' does not classify as TOTALS", () => {
  const result = classifyBettingSelectionText("ТБ,2.5");
  assert.notEqual(result.marketType, "TOTALS");
});

test("Individual Team Totals Stage 2: existing dot-decimal behavior is completely unaffected by the comma widening", () => {
  const dotResult = classifyBettingSelectionText("Марсель ТБ 1.5", MARSEILLE_STRASBOURG);
  const commaResult = classifyBettingSelectionText("Марсель ТБ 1,5", MARSEILLE_STRASBOURG);
  assert.equal(dotResult.marketType, commaResult.marketType);
  assert.equal(dotResult.selectionType, commaResult.selectionType);
  assert.equal(dotResult.participantName, commaResult.participantName);
});

/* -------------------------------------------------------------------------- */
/* BA-2C, Step 1 — safe market-token separator tolerance                      */
/* -------------------------------------------------------------------------- */
//
// Widens the token<->number separator accepted for ТБ/ТМ/ИТБ/ИТМ/Ф1/Ф2 from
// whitespace-only to also include a colon and a fully parenthesized number
// — nothing else. Every case here is bare (no participant prefix), matching
// this stage's own REQUIRED TESTS list verbatim.

test("classifyBettingSelectionText: TOTALS separator tolerance (ТБ)", () => {
  for (const text of ["ТБ2.5", "ТБ 2.5", "ТБ:2.5", "ТБ: 2.5", "ТБ(2.5)", "ТБ (2.5)"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "TOTALS", text);
    assert.equal(result.selectionType, "OVER", text);
    assert.equal(result.embeddedLine, "2.5", text);
  }
});

test("classifyBettingSelectionText: TOTALS separator tolerance (ТМ)", () => {
  for (const text of ["ТМ3", "ТМ 3", "ТМ:3", "ТМ(3)"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "TOTALS", text);
    assert.equal(result.selectionType, "UNDER", text);
    assert.equal(result.embeddedLine, "3", text);
  }
});

test("classifyBettingSelectionText: TEAM_TOTAL separator tolerance (ИТБ)", () => {
  for (const text of ["ИТБ1.5", "ИТБ 1.5", "ИТБ:1.5", "ИТБ(1.5)"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "TEAM_TOTAL", text);
    assert.equal(result.selectionType, "OVER", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, "1.5", text);
  }
});

test("classifyBettingSelectionText: TEAM_TOTAL separator tolerance (ИТМ)", () => {
  for (const text of ["ИТМ1.5", "ИТМ 1.5", "ИТМ:1.5", "ИТМ(1.5)"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "TEAM_TOTAL", text);
    assert.equal(result.selectionType, "UNDER", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, "1.5", text);
  }
});

test("classifyBettingSelectionText: SPREAD separator tolerance (Ф1, negative line) — bare, no participant", () => {
  for (const text of ["Ф1(-1.5)", "Ф1 (-1.5)", "Ф1 -1.5", "Ф1:-1.5", "Ф1: -1.5"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, "-1.5", text);
  }
});

test("classifyBettingSelectionText: SPREAD separator tolerance (Ф2, positive line) — bare, no participant", () => {
  for (const text of ["Ф2(+1.5)", "Ф2 (+1.5)", "Ф2 +1.5", "Ф2:+1.5"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, "+1.5", text);
  }
});

test("classifyBettingSelectionText: SPREAD separator tolerance with a real participant prefix — sign is never dropped or flipped", () => {
  for (const [text, expectedLine] of [
    ["Арсенал Ф1(-1.5)", "-1.5"],
    ["Арсенал Ф1 (-1.5)", "-1.5"],
    ["Арсенал Ф1:-1.5", "-1.5"],
    ["Арсенал Ф1: -1.5", "-1.5"],
    ["Челси Ф2(+1.5)", "+1.5"],
    ["Челси Ф2 (+1.5)", "+1.5"],
    ["Челси Ф2:+1.5", "+1.5"],
  ] as const) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.embeddedLine, expectedLine, text);
  }
});

test("classifyBettingSelectionText: separator tolerance is case-insensitive with extra whitespace", () => {
  assert.deepEqual(classifyBettingSelectionText("тб:2.5"), classifyBettingSelectionText("ТБ:2.5"));
  assert.deepEqual(classifyBettingSelectionText("итб(1.5)"), classifyBettingSelectionText("ИТБ(1.5)"));
  const spaced = classifyBettingSelectionText("ТБ  :   2.5");
  assert.equal(spaced.marketType, "TOTALS");
  assert.equal(spaced.embeddedLine, "2.5");
  const spacedColon = classifyBettingSelectionText("Ф1   :   -1.5");
  assert.equal(spacedColon.marketType, "SPREAD");
  assert.equal(spacedColon.embeddedLine, "-1.5");
  const spacedParen = classifyBettingSelectionText("ф1  (  -1.5  )");
  assert.equal(spacedParen.marketType, "SPREAD");
  assert.equal(spacedParen.embeddedLine, "-1.5");
});

test("classifyBettingSelectionText: negative/adversarial separator forms never become the intended canonical market", () => {
  for (const text of ["ТБ::2.5", "ТБ((2.5))", "ТБabc2.5"]) {
    assert.notEqual(classifyBettingSelectionText(text).marketType, "TOTALS", text);
  }
  assert.notEqual(classifyBettingSelectionText("ИТБabc1.5").marketType, "TEAM_TOTAL");
  assert.notEqual(classifyBettingSelectionText("Ф1abc-1.5").marketType, "SPREAD");
});

test("classifyBettingSelectionText: adversarial forms still lose nothing — they fall to the lossless PARTICIPANT fallback, never an empty/fabricated result", () => {
  for (const text of ["ТБ::2.5", "ТБ((2.5))", "ТБabc2.5", "ИТБabc1.5", "Ф1abc-1.5"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "MONEYLINE_2WAY", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, text, text);
  }
});

test("classifyBettingSelectionText: BA-2A concatenated-string case is unaffected by the widened separator grammar (Individual Team Totals Stage 1 — now resolves to TEAM_TOTAL/Арсенал, not bare TOTALS; see the dedicated contract-change tests above)", () => {
  const result = classifyBettingSelectionText("Арсенал ТБ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "2.5");
});

/* -------------------------------------------------------------------------- */
/* BA-2C Step 1B — production regression fix: a bare/prefixed Ф1/Ф2 token    */
/* with NO embedded number (the AI's own dedicated `line` field carries it   */
/* instead) must still classify as SPREAD, exactly mirroring TEAM_TOTAL's    */
/* existing bare-token precedent — never fall through to the lossless        */
/* PARTICIPANT fallback, which is what let a real production message reach  */
/* the odds provider as a fabricated, verifiable "Arsenal Win" moneyline    */
/* selection.                                                                */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: bare 'Ф1'/'Ф2' with no embedded number -> SPREAD, embeddedLine null (never PARTICIPANT)", () => {
  for (const text of ["Ф1", "Ф2", "ф1", "ф2"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, null, text);
  }
});

test("classifyBettingSelectionText: 'Арсенал Ф1' (participant + bare token, no embedded number) -> SPREAD, participant attributed, embeddedLine null", () => {
  const result = classifyBettingSelectionText("Арсенал Ф1");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.selectionType, "PARTICIPANT");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, null);
});

test("classifyBettingSelectionText: 'Челси Ф2' (participant + bare token, no embedded number) -> SPREAD, participant attributed, embeddedLine null", () => {
  const result = classifyBettingSelectionText("Челси Ф2");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Челси");
  assert.equal(result.embeddedLine, null);
});

test("classifyBettingSelectionText: bare Ф1/Ф2 with a garbled remainder still never becomes SPREAD (mandatory-content invariant is preserved for non-empty remainders)", () => {
  for (const text of ["Ф1abc-1.5", "Ф1abc", "Ф2xyz+1"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
  }
});

/* -------------------------------------------------------------------------- */
/* BA-2C, Step 1C — production regression fix: Latin F1/F2 as a canonical    */
/* alias of Cyrillic Ф1/Ф2. Root cause: a real production message typed in   */
/* Cyrillic ("Арсенал Ф1(-1.5)") was extracted by the AI with the selection  */
/* text romanized to Latin ("Arsenal F1"), which this classifier previously  */
/* never recognized at all — falling to the fabricated MONEYLINE_2WAY/      */
/* PARTICIPANT fallback and getting priced as a real "Arsenal Win" bet.      */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: bare Latin 'F1'/'F2'/'f1'/'f2' -> SPREAD, embeddedLine null", () => {
  for (const text of ["F1", "F2", "f1", "f2"]) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, null, text);
    assert.equal(result.embeddedLine, null, text);
  }
});

test("classifyBettingSelectionText: Latin F1/F2 embedded-line separator tolerance mirrors Cyrillic exactly", () => {
  for (const [text, expectedLine] of [
    ["F1(-1.5)", "-1.5"],
    ["F2(+1.5)", "+1.5"],
    ["F1 -1.5", "-1.5"],
    ["F2 +1.5", "+1.5"],
    ["F1:-1.5", "-1.5"],
    ["F2:+1.5", "+1.5"],
  ] as const) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.embeddedLine, expectedLine, text);
  }
});

test("classifyBettingSelectionText: participant-prefixed Latin F1/F2 ('Arsenal F1', with and without an embedded line) -> SPREAD, participant attributed correctly", () => {
  for (const [text, expectedLine] of [
    ["Arsenal F1", null],
    ["Arsenal F2", null],
    ["Arsenal F1(-1.5)", "-1.5"],
    ["Arsenal F2(+1.5)", "+1.5"],
    ["Arsenal F1 -1.5", "-1.5"],
    ["Arsenal F2 +1.5", "+1.5"],
  ] as const) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.selectionType, "PARTICIPANT", text);
    assert.equal(result.participantName, "Arsenal", text);
    assert.equal(result.embeddedLine, expectedLine, text);
  }
});

test("classifyBettingSelectionText: Latin F1/F2 with a garbled remainder never becomes SPREAD (same mandatory-content invariant as Cyrillic)", () => {
  for (const text of ["F1abc-1.5", "F2foo+1", "F1abc", "F2xyz"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
  }
});

test("classifyBettingSelectionText: an ordinary word merely CONTAINING 'f1'/'f2' (Latin or Cyrillic) is never accidentally recognized as SPREAD", () => {
  // The letter-boundary guard added alongside the Latin widening also closes
  // a latent pre-existing gap: "шкаф1" ("cabinet" + "1") could previously
  // lazily match participant="шка", token="ф1" — now rejected for both
  // scripts uniformly.
  for (const text of ["off1", "Buff2", "Staff1", "Sheff2", "шкаф1", "Штраф1"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
    assert.equal(result.participantName, text, text);
  }
});

test("classifyBettingSelectionText: Cyrillic SPREAD forms are completely unaffected by the Latin widening", () => {
  const cyrillicCases: Array<[string, string | null, string | null]> = [
    ["Ф1", null, null],
    ["Ф2", null, null],
    ["Ф1(-1.5)", null, "-1.5"],
    ["Ф2(+1.5)", null, "+1.5"],
    ["Арсенал Ф1(-1.5)", "Арсенал", "-1.5"],
  ];
  for (const [text, expectedParticipant, expectedLine] of cyrillicCases) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.participantName, expectedParticipant, text);
    assert.equal(result.embeddedLine, expectedLine, text);
  }
});

/* -------------------------------------------------------------------------- */
/* Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary, new.    */
/* Same canonical result as Ф1/Ф2: marketType SPREAD, selectionType          */
/* PARTICIPANT. Vocabulary only — no new market type, no rounding, no sign   */
/* changes.                                                                   */
/* -------------------------------------------------------------------------- */

function assertSpread(text: string, expectedParticipant: string | null, expectedLine: string | null): void {
  const result = classifyBettingSelectionText(text);
  assert.equal(result.marketType, "SPREAD", text);
  assert.equal(result.selectionType, "PARTICIPANT", text);
  assert.equal(result.participantName, expectedParticipant, text);
  assert.equal(result.embeddedLine, expectedLine, text);
}

// ---------------------------------------------------------------------
// RU forms
// ---------------------------------------------------------------------

test("RU: 'Арсенал фора -1.5' -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Арсенал фора -1.5", "Арсенал", "-1.5");
});

test("RU: 'Арсенал с форой -1.5' -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Арсенал с форой -1.5", "Арсенал", "-1.5");
});

test("RU: 'фора Арсенал -1.5' (prefix form) -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("фора Арсенал -1.5", "Арсенал", "-1.5");
});

test("RU: 'Арсенал фора +1.5' -> SPREAD, participant Arsenal, positive line +1.5", () => {
  assertSpread("Арсенал фора +1.5", "Арсенал", "+1.5");
});

test("RU: 'Арсенал с форой +1.5' -> SPREAD, participant Arsenal, positive line +1.5", () => {
  assertSpread("Арсенал с форой +1.5", "Арсенал", "+1.5");
});

test("RU: 'Арсенал азиатская фора -1.25' -> SPREAD, participant Arsenal, quarter line -1.25 (recognition only — H1 gate still blocks confirmability elsewhere)", () => {
  assertSpread("Арсенал азиатская фора -1.25", "Арсенал", "-1.25");
});

test("RU: 'азиатская фора Арсенал -1.25' (prefix form) -> SPREAD, participant Arsenal, quarter line -1.25", () => {
  assertSpread("азиатская фора Арсенал -1.25", "Арсенал", "-1.25");
});

// ---------------------------------------------------------------------
// UA forms
// ---------------------------------------------------------------------

test("UA: 'Арсенал з форою -1.5' -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Арсенал з форою -1.5", "Арсенал", "-1.5");
});

test("UA: 'Арсенал фора -1.5' (UA player using the RU-shared base word) -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Арсенал фора -1.5", "Арсенал", "-1.5");
});

test("UA: 'фора Арсенал -1.5' (prefix form) -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("фора Арсенал -1.5", "Арсенал", "-1.5");
});

test("UA: 'Арсенал азійська фора -1.25' -> SPREAD, participant Arsenal, quarter line -1.25", () => {
  assertSpread("Арсенал азійська фора -1.25", "Арсенал", "-1.25");
});

test("UA: 'азійська фора Арсенал -1.25' (prefix form) -> SPREAD, participant Arsenal, quarter line -1.25", () => {
  assertSpread("азійська фора Арсенал -1.25", "Арсенал", "-1.25");
});

// ---------------------------------------------------------------------
// EN forms
// ---------------------------------------------------------------------

test("EN: 'Arsenal handicap -1.5' -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Arsenal handicap -1.5", "Arsenal", "-1.5");
});

test("EN: 'Arsenal spread -1.5' -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("Arsenal spread -1.5", "Arsenal", "-1.5");
});

test("EN: 'handicap Arsenal -1.5' (prefix form) -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("handicap Arsenal -1.5", "Arsenal", "-1.5");
});

test("EN: 'spread Arsenal -1.5' (prefix form) -> SPREAD, participant Arsenal, line -1.5", () => {
  assertSpread("spread Arsenal -1.5", "Arsenal", "-1.5");
});

test("EN: 'Arsenal Asian handicap -1.25' -> SPREAD, participant Arsenal, quarter line -1.25", () => {
  assertSpread("Arsenal Asian handicap -1.25", "Arsenal", "-1.25");
});

test("EN: 'Asian handicap Arsenal -1.25' (prefix form) -> SPREAD, participant Arsenal, quarter line -1.25", () => {
  assertSpread("Asian handicap Arsenal -1.25", "Arsenal", "-1.25");
});

test("EN: no separate ASIAN_HANDICAP marketType is ever produced — 'Arsenal Asian handicap -1.25' classifies as exactly the same marketType string as 'Arsenal handicap -1.5'", () => {
  const asian = classifyBettingSelectionText("Arsenal Asian handicap -1.25");
  const plain = classifyBettingSelectionText("Arsenal handicap -1.5");
  assert.equal(asian.marketType, plain.marketType);
  assert.equal(asian.marketType, "SPREAD");
});

// ---------------------------------------------------------------------
// Participant extraction — no hardcoded team names, multi-word names
// ---------------------------------------------------------------------

test("participant extraction: 'Manchester United handicap -0.5' -> participant 'Manchester United' (multi-word, negative half-line)", () => {
  assertSpread("Manchester United handicap -0.5", "Manchester United", "-0.5");
});

test("participant extraction: 'Real Madrid spread -1' -> participant 'Real Madrid' (multi-word, negative whole-line)", () => {
  assertSpread("Real Madrid spread -1", "Real Madrid", "-1");
});

test("participant extraction: 'Coventry City handicap +1.5' -> participant 'Coventry City' (multi-word, positive half-line)", () => {
  assertSpread("Coventry City handicap +1.5", "Coventry City", "+1.5");
});

test("participant extraction: 'Chelsea spread +0.5' -> participant Chelsea", () => {
  assertSpread("Chelsea spread +0.5", "Chelsea", "+0.5");
});

test("participant extraction: 'Barcelona handicap +1' -> participant Barcelona", () => {
  assertSpread("Barcelona handicap +1", "Barcelona", "+1");
});

// ---------------------------------------------------------------------
// Sign / line safety — exact preservation, no rounding, no sign removal
// ---------------------------------------------------------------------

test("sign/line safety: every required line shape is preserved byte-for-byte", () => {
  const cases: Array<[string, string]> = [
    ["Arsenal handicap -1.5", "-1.5"],
    ["Arsenal handicap +1.5", "+1.5"],
    ["Arsenal handicap -1", "-1"],
    ["Arsenal handicap +1", "+1"],
    ["Arsenal handicap -0.5", "-0.5"],
    ["Arsenal handicap +0.5", "+0.5"],
    ["Arsenal Asian handicap -1.25", "-1.25"],
    ["Arsenal Asian handicap +0.75", "+0.75"],
  ];
  for (const [text, expectedLine] of cases) {
    const result = classifyBettingSelectionText(text);
    assert.equal(result.marketType, "SPREAD", text);
    assert.equal(result.embeddedLine, expectedLine, text);
  }
});

test("sign/line safety: a quarter line is never rounded or normalized to the nearest half line", () => {
  const result = classifyBettingSelectionText("Arsenal handicap -1.25");
  assert.equal(result.embeddedLine, "-1.25");
  assert.notEqual(result.embeddedLine, "-1.5");
  assert.notEqual(result.embeddedLine, "-1");
});

// ---------------------------------------------------------------------
// No semantic substitution — distinct lines/handicap mentions in ONE
// selection string are never collapsed; the classifier picks whichever the
// text's own grammar resolves to, never silently averaging/choosing.
// Multi-signal AMBIGUITY across an entire raw message is a separate
// concern (BA-2D/BA-2B, proven via marketIntentEvidence.test.ts below) —
// this classifier only ever receives one resolved selection string.
// ---------------------------------------------------------------------

test("no substitution: 'Arsenal handicap -1.5' and 'Arsenal handicap -2' remain distinct, never collapsed to the same line", () => {
  const a = classifyBettingSelectionText("Arsenal handicap -1.5");
  const b = classifyBettingSelectionText("Arsenal handicap -2");
  assert.equal(a.embeddedLine, "-1.5");
  assert.equal(b.embeddedLine, "-2");
  assert.notEqual(a.embeddedLine, b.embeddedLine);
});

// ---------------------------------------------------------------------
// Existing short-form regression — byte-for-byte unchanged
// ---------------------------------------------------------------------

test("regression: existing Ф1/Ф2/F1/F2 short forms are completely unaffected by the new natural-language vocabulary", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["Ф1(-1.5)", null, "-1.5"],
    ["Ф2(+1.5)", null, "+1.5"],
    ["F1(-1.5)", null, "-1.5"],
    ["F2(+1.5)", null, "+1.5"],
    ["Арсенал Ф1:-1.5", "Арсенал", "-1.5"],
    ["Арсенал Ф1(-1.5)", "Арсенал", "-1.5"],
    ["Arsenal -1.5", "Arsenal", "-1.5"],
  ];
  for (const [text, expectedParticipant, expectedLine] of cases) {
    assertSpread(text, expectedParticipant, expectedLine);
  }
});

// ---------------------------------------------------------------------
// Bare / unattributed handicap forms — participantName null, resolved from
// context by the caller if at all (same contract as TEAM_TOTAL_BARE_PATTERN)
// ---------------------------------------------------------------------

test("bare handicap forms: marker + line alone (no participant in the string) -> SPREAD, participantName null", () => {
  const cases: Array<[string, string]> = [
    ["фора -1.5", "-1.5"],
    ["handicap -1.5", "-1.5"],
    ["spread -1.5", "-1.5"],
    ["азиатская фора -1.25", "-1.25"],
    ["азійська фора -1.25", "-1.25"],
    ["asian handicap -1.25", "-1.25"],
  ];
  for (const [text, expectedLine] of cases) {
    assertSpread(text, null, expectedLine);
  }
});

test("bare marker with no line at all -> SPREAD, both participantName and embeddedLine null", () => {
  assertSpread("фора", null, null);
  assertSpread("handicap", null, null);
});

// ---------------------------------------------------------------------
// Punctuation — reuses the existing signed-line-suffix grammar (colon,
// parens, whitespace) already proven for Ф1/Ф2; no new punctuation rules.
// ---------------------------------------------------------------------

test("punctuation: colon separator ('Arsenal handicap: -1.5', 'Арсенал фора: -1.5') is accepted, same as the existing Ф1/Ф2 grammar", () => {
  assertSpread("Arsenal handicap: -1.5", "Arsenal", "-1.5");
  assertSpread("Арсенал фора: -1.5", "Арсенал", "-1.5");
});

test("punctuation: a doubled/malformed separator with no cleanly-trailing signed number is rejected, not silently tolerated", () => {
  // Deliberately excludes a case like "Arsenal handicap:: -1.5" here: that
  // text DOES still classify as SPREAD, but via the separate, pre-existing,
  // unrelated-to-H3 SPREAD_BARE_SIGNED_PATTERN fallback ("Participant
  // <anything> -N" — already true before this stage, exactly as true for
  // "Arsenal !!! -1.5" or "Arsenal xyz garbage -1.5") — not because the new
  // marker-aware parsing tolerated the malformed "::" punctuation. These
  // cases below have no cleanly-trailing signed number at the string's very
  // end at all, so that pre-existing fallback cannot rescue them either —
  // isolating what the new marker-specific remainder validation itself
  // actually rejects.
  for (const text of ["Arsenal handicap((-1.5))", "Arsenal handicap::", "Arsenal handicap(-1.5", "Arsenal handicap: abc"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
  }
});

// ---------------------------------------------------------------------
// Adversarial / false positives — narrow word boundaries, no substring
// collisions with unrelated words
// ---------------------------------------------------------------------

test("adversarial: 'handicapper' alone is never classified as SPREAD (не a truncated 'handicap' match)", () => {
  const result = classifyBettingSelectionText("handicapper");
  assert.notEqual(result.marketType, "SPREAD");
  assert.equal(result.participantName, "handicapper");
});

test("adversarial: 'spreadsheet' alone is never classified as SPREAD", () => {
  const result = classifyBettingSelectionText("spreadsheet");
  assert.notEqual(result.marketType, "SPREAD");
  assert.equal(result.participantName, "spreadsheet");
});

test("adversarial: 'transformer' alone is never classified as SPREAD (unrelated word, sanity check)", () => {
  const result = classifyBettingSelectionText("transformer");
  assert.notEqual(result.marketType, "SPREAD");
  assert.equal(result.participantName, "transformer");
});

test("adversarial: a multi-word phrase containing 'handicapper'/'spreadsheet' (no trailing line) never gets truncated into a fabricated SPREAD marker match", () => {
  // No trailing signed number here deliberately — with one present (e.g.
  // "Manchester handicapper -1.5"), the result WOULD be SPREAD, but via the
  // separate, pre-existing, unrelated-to-H3 SPREAD_BARE_SIGNED_PATTERN
  // fallback (see the punctuation test above's own comment for the same
  // "Arsenal !!! -1.5"-style precedent) — not because "handicapper" was
  // mistaken for the "handicap" marker. These cases isolate that specific
  // question: does the marker-aware parsing itself ever strip "handicap"/
  // "spread" out of a longer word as if it were the real marker.
  for (const text of ["Manchester handicapper", "Arsenal spreadsheet", "Manchester handicapper club"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
  }
});

test("adversarial: 'фора' embedded inside an unrelated Cyrillic word is never accidentally recognized as a handicap MARKER (the pre-existing bare-signed 'Participant -N' form is a separate, unrelated concern already covered elsewhere)", () => {
  // "семафора" ("semaphore") and "платформа" ("platform") both contain the
  // literal substring "фора"/"форма" but have no space before it — the
  // natural-language handicap patterns require real whitespace (\s+)
  // between participant and marker, so a single glued word can never be
  // split by THEM. Neither word carries a trailing signed number here, so
  // the pre-existing (unrelated to H3) bare-signed "Participant -N" pattern
  // never enters into it either — both simply fall to the generic
  // PARTICIPANT fallback.
  for (const text of ["семафора", "платформа"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
    assert.equal(result.participantName, text, text);
  }
});

test("adversarial: an ordinary sentence merely containing the substrings 'handicap'/'spread'/'фора' as part of a longer unrelated word is never recognized", () => {
  for (const text of ["handicapping", "widespread", "спреды"]) {
    const result = classifyBettingSelectionText(text);
    assert.notEqual(result.marketType, "SPREAD", text);
  }
});

// ---------------------------------------------------------------------
// Generic multi-team coverage — several teams, RU/UA/EN, positive and
// negative lines, no team-specific logic anywhere in the classifier
// ---------------------------------------------------------------------

test("generic multi-team coverage: several teams across RU/UA/EN forms, positive and negative lines, all resolve correctly with no team-specific code", () => {
  const cases: Array<[string, string, string]> = [
    ["Arsenal handicap -1.5", "Arsenal", "-1.5"],
    ["Coventry City handicap +1.5", "Coventry City", "+1.5"],
    ["Real Madrid spread -1", "Real Madrid", "-1"],
    ["Barcelona spread +1", "Barcelona", "+1"],
    ["Manchester United handicap -0.5", "Manchester United", "-0.5"],
    ["Chelsea handicap +0.5", "Chelsea", "+0.5"],
    ["Реал Мадрид фора -1", "Реал Мадрид", "-1"],
    ["Барселона фора +1", "Барселона", "+1"],
    ["Челсі фора -0.5", "Челсі", "-0.5"],
  ];
  for (const [text, expectedParticipant, expectedLine] of cases) {
    assertSpread(text, expectedParticipant, expectedLine);
  }
});

// ---------------------------------------------------------------------
// Existing markets — MONEYLINE/TOTALS unaffected by the new vocabulary
// ---------------------------------------------------------------------

test("existing markets regression: MONEYLINE and TOTALS classification is completely unaffected by the new handicap vocabulary", () => {
  const winner = classifyBettingSelectionText("Арсенал победа");
  assert.equal(winner.marketType, "MONEYLINE_2WAY");
  assert.equal(winner.participantName, "Арсенал");

  const draw = classifyBettingSelectionText("ничья");
  assert.equal(draw.marketType, "MONEYLINE_3WAY");
  assert.equal(draw.selectionType, "DRAW");

  const over = classifyBettingSelectionText("ТБ 2.5");
  assert.equal(over.marketType, "TOTALS");
  assert.equal(over.selectionType, "OVER");
  assert.equal(over.embeddedLine, "2.5");

  const under = classifyBettingSelectionText("ТМ 3");
  assert.equal(under.marketType, "TOTALS");
  assert.equal(under.selectionType, "UNDER");
  assert.equal(under.embeddedLine, "3");
});

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — classifyBettingSelectionTextWithMarketHint            */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionTextWithMarketHint: 'Арсенал' + market hint 'Фора' -> SPREAD, participant Arsenal (the exact production bug shape)", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал", "Фора");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.selectionType, "PARTICIPANT");
  assert.equal(result.participantName, "Арсенал");
});

test("classifyBettingSelectionTextWithMarketHint: 'Арсенал' + market hint 'Handicap' (EN word, RU selection) -> SPREAD, participant Арсенал", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал", "Handicap");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Арсенал");
});

test("classifyBettingSelectionTextWithMarketHint: 'Arsenal' + market hint 'Spread' -> SPREAD, participant Arsenal", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Arsenal", "Spread");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Arsenal");
});

test("classifyBettingSelectionTextWithMarketHint: 'Арсенал' + market hint 'Азійська фора' -> SPREAD, participant Арсенал", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал", "Азійська фора");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Арсенал");
});

test("classifyBettingSelectionTextWithMarketHint: multi-word participant + market hint still resolves correctly ('Manchester United' + 'Handicap')", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Manchester United", "Handicap");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Manchester United");
});

test("classifyBettingSelectionTextWithMarketHint: null market hint -> behaves exactly like classifyBettingSelectionText alone", () => {
  const withHint = classifyBettingSelectionTextWithMarketHint("Арсенал", null);
  const without = classifyBettingSelectionText("Арсенал");
  assert.deepEqual(withHint, without);
  assert.equal(withHint.marketType, "MONEYLINE_2WAY");
});

test("classifyBettingSelectionTextWithMarketHint: empty/whitespace-only market hint -> behaves exactly like no hint at all", () => {
  const empty = classifyBettingSelectionTextWithMarketHint("Арсенал", "");
  const whitespace = classifyBettingSelectionTextWithMarketHint("Арсенал", "   ");
  assert.equal(empty.marketType, "MONEYLINE_2WAY");
  assert.equal(whitespace.marketType, "MONEYLINE_2WAY");
});

test("classifyBettingSelectionTextWithMarketHint: undefined market hint -> behaves exactly like no hint at all", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал", undefined);
  assert.equal(result.marketType, "MONEYLINE_2WAY");
});

test("classifyBettingSelectionTextWithMarketHint safety: a real, confident MONEYLINE selection ('Arsenal Win') is NEVER overridden by a contradictory market hint ('Handicap')", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Arsenal Win", "Handicap");
  assert.equal(result.marketType, "MONEYLINE_2WAY");
  assert.equal(result.participantName, "Arsenal");
});

test("classifyBettingSelectionTextWithMarketHint safety: a real, confident TOTALS selection ('Over 2.5') is NEVER overridden by a contradictory market hint ('Handicap')", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Over 2.5", "Handicap");
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "OVER");
});

test("classifyBettingSelectionTextWithMarketHint safety: an existing bare Ф1/F1 SPREAD selection is unaffected by a redundant market hint", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал Ф1(-1.5)", "Фора");
  assert.equal(result.marketType, "SPREAD");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "-1.5");
});

test("classifyBettingSelectionTextWithMarketHint: an unrecognized market hint ('Premier League') never fabricates a market", () => {
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал", "Premier League");
  assert.equal(result.marketType, "MONEYLINE_2WAY");
  assert.equal(result.participantName, "Арсенал");
});

test("classifyBettingSelectionTextWithMarketHint: knownParticipantNames still apply exactly as they do for classifyBettingSelectionText alone", () => {
  // "Арсенал ТБ 2.5" arriving as one concatenated selection field, "Арсенал"
  // known from the event split — the participant-stripping loop runs
  // BEFORE this function's own market-hint fallback, unaffected by it.
  // Individual Team Totals, Stage 1 — resolves to TEAM_TOTAL/Арсенал now,
  // not bare TOTALS (see the classifyBettingSelectionText tests above for
  // the full contract-change rationale).
  const result = classifyBettingSelectionTextWithMarketHint("Арсенал ТБ 2.5", null, ["Арсенал", "Челси"]);
  assert.equal(result.marketType, "TEAM_TOTAL");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.participantName, "Арсенал");
  assert.equal(result.embeddedLine, "2.5");
});

/* -------------------------------------------------------------------------- */
/* SCREENSHOT QA-CORE S1 — exported helpers, reused by                        */
/* lib/ai/ocrParticipantClaimNormalizer.ts                                   */
/* -------------------------------------------------------------------------- */

test("stripTrailingWinnerSuffix: strips a trailing English/Russian/Ukrainian winner suffix", () => {
  assert.equal(stripTrailingWinnerSuffix("Bayern Win"), "Bayern");
  assert.equal(stripTrailingWinnerSuffix("RB Leipzig to win"), "RB Leipzig");
  assert.equal(stripTrailingWinnerSuffix("Inter wins"), "Inter");
  assert.equal(stripTrailingWinnerSuffix("Арсенал победа"), "Арсенал");
});

test("stripTrailingWinnerSuffix: a name with no winner suffix is returned unchanged (trimmed)", () => {
  assert.equal(stripTrailingWinnerSuffix("Bayern Munich"), "Bayern Munich");
  assert.equal(stripTrailingWinnerSuffix("  Real Madrid  "), "Real Madrid");
});

test("isBareMoneylineShorthandToken: recognizes every HOME/DRAW/AWAY token, case-insensitively", () => {
  for (const token of ["1", "п1", "P1", "w1", "W1", "home", "Home"]) {
    assert.equal(isBareMoneylineShorthandToken(token), true, token);
  }
  for (const token of ["x", "Draw", "ничья"]) {
    assert.equal(isBareMoneylineShorthandToken(token), true, token);
  }
  for (const token of ["2", "п2", "P2", "w2", "W2", "away", "Away"]) {
    assert.equal(isBareMoneylineShorthandToken(token), true, token);
  }
});

test("isBareMoneylineShorthandToken: a real participant name or word is never mistaken for a shorthand token", () => {
  for (const token of ["Bayern", "Real", "Madrid", "Leipzig", "Win", "Arsenal"]) {
    assert.equal(isBareMoneylineShorthandToken(token), false, token);
  }
});
