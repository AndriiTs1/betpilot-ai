import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBettingSelectionText } from "./shorthandClassifier";

/* -------------------------------------------------------------------------- */
/* Moneyline — bare 1X2 tokens (parity with the removed legacyOddsBridge.ts   */
/* HOME_TOKENS/DRAW_TOKENS/AWAY_TOKENS fixtures)                              */
/* -------------------------------------------------------------------------- */

test("classifyBettingSelectionText: HOME tokens (1/П1/P1/home)", () => {
  for (const input of ["1", "П1", "п1", "P1", "p1", "Home", "home"]) {
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

test("classifyBettingSelectionText: AWAY tokens (2/П2/P2/away)", () => {
  for (const input of ["2", "П2", "п2", "P2", "p2", "Away", "away"]) {
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

test("classifyBettingSelectionText: 'Арсенал ТБ 2.5' with knownParticipantNames resolves to TOTALS/OVER/2.5 — the exact production regression case", () => {
  const result = classifyBettingSelectionText("Арсенал ТБ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.embeddedLine, "2.5");
});

test("classifyBettingSelectionText: 'Арсенал ТМ 2.5' with knownParticipantNames resolves to TOTALS/UNDER/2.5", () => {
  const result = classifyBettingSelectionText("Арсенал ТМ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "UNDER");
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

test("classifyBettingSelectionText: BA-2A concatenated-string production regression is unaffected by the widened separator grammar", () => {
  const result = classifyBettingSelectionText("Арсенал ТБ 2.5", ["Арсенал"]);
  assert.equal(result.marketType, "TOTALS");
  assert.equal(result.selectionType, "OVER");
  assert.equal(result.embeddedLine, "2.5");
});
