import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSelectionToEnglish } from "./normalizeSelectionToEnglish";

// ---------------------------------------------------------------------
// Football 1X2
// ---------------------------------------------------------------------

test("П1 -> Home Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "П1" }), "Home Win");
});

test("Победа 1 -> Home Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа 1" }), "Home Win");
});

test("Победа хозяев -> Home Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа хозяев" }), "Home Win");
});

test("Home team win -> Home Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Home team win" }), "Home Win");
});

test("П2 -> Away Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "П2" }), "Away Win");
});

test("Победа 2 -> Away Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа 2" }), "Away Win");
});

test("Победа гостей -> Away Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа гостей" }), "Away Win");
});

test("Away team win -> Away Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Away team win" }), "Away Win");
});

test("Ничья -> Draw", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Ничья" }), "Draw");
});

test("bare X (Latin) -> Draw", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "X" }), "Draw");
});

test("bare Х (Cyrillic) -> Draw", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Х" }), "Draw");
});

// ---------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------

test("ТБ 2.5 -> Over 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "ТБ 2.5" }), "Over 2.5 Goals");
});

test("Тотал больше 2.5 -> Over 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Тотал больше 2.5" }), "Over 2.5 Goals");
});

test("More than 2.5 -> Over 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "More than 2.5" }), "Over 2.5 Goals");
});

test("ТМ 2.5 -> Under 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "ТМ 2.5" }), "Under 2.5 Goals");
});

test("Тотал меньше 2.5 -> Under 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Тотал меньше 2.5" }), "Under 2.5 Goals");
});

test("Less than 2.5 -> Under 2.5 Goals", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Less than 2.5" }), "Under 2.5 Goals");
});

test("a total for a non-football sport is normalized without a guessed unit", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Over 220.5", sport: "Basketball" }), "Over 220.5");
});

// ---------------------------------------------------------------------
// Both teams to score
// ---------------------------------------------------------------------

test("Обе забьют -> Both Teams to Score — Yes", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Обе забьют" }), "Both Teams to Score — Yes");
});

test("Обе забьют — Да -> Both Teams to Score — Yes", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Обе забьют — Да" }), "Both Teams to Score — Yes");
});

test("Обе забьют — Нет -> Both Teams to Score — No", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Обе забьют — Нет" }), "Both Teams to Score — No");
});

// ---------------------------------------------------------------------
// Double chance
// ---------------------------------------------------------------------

test("1X -> Home or Draw", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "1X" }), "Home or Draw");
});

test("X2 -> Draw or Away", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "X2" }), "Draw or Away");
});

test("12 -> Home or Away", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "12" }), "Home or Away");
});

// ---------------------------------------------------------------------
// Named winner selections
// ---------------------------------------------------------------------

test("Победа Arsenal -> Arsenal Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа Arsenal" }), "Arsenal Win");
});

test("Arsenal победит -> Arsenal Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Arsenal победит" }), "Arsenal Win");
});

test("Победа Carlos Alcaraz -> Carlos Alcaraz Win", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа Carlos Alcaraz" }), "Carlos Alcaraz Win");
});

test("Carlos Alcaraz Win remains unchanged", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Carlos Alcaraz Win" }), "Carlos Alcaraz Win");
});

test("Chelsea Win / Arsenal Win (already-English named winners) remain unchanged", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Chelsea Win" }), "Chelsea Win");
  assert.equal(normalizeSelectionToEnglish({ selection: "Arsenal Win" }), "Arsenal Win");
});

test("a named winner is never mapped to Home Win / Away Win, even for a tennis/basketball/hockey/esports market", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа Carlos Alcaraz", sport: "Tennis" }), "Carlos Alcaraz Win");
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа Lakers", sport: "Basketball" }), "Lakers Win");
  assert.notEqual(normalizeSelectionToEnglish({ selection: "Победа Carlos Alcaraz", sport: "Tennis" }), "Home Win");
});

// ---------------------------------------------------------------------
// Unknown / ambiguous values are preserved, never guessed
// ---------------------------------------------------------------------

test("an unrecognized selection is returned completely unchanged", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Handicap -1.5 (Team A)" }), "Handicap -1.5 (Team A)");
});

test("an empty string is returned unchanged, not crashed on", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "" }), "");
});

test("does not silently guess a result for ambiguous bare 'Победа' with no name/number", () => {
  // "Победа" alone has no name/number to extract — the generic
  // "Победа <name>" pattern only matches when something follows.
  assert.equal(normalizeSelectionToEnglish({ selection: "Победа" }), "Победа");
});

// ---------------------------------------------------------------------
// Idempotency (defense-in-depth call sites normalize an already-normalized
// value — must never double-transform or corrupt it)
// ---------------------------------------------------------------------

test("normalizing an already-normalized value is a no-op", () => {
  const once = normalizeSelectionToEnglish({ selection: "Обе забьют — Да" });
  const twice = normalizeSelectionToEnglish({ selection: once });
  assert.equal(once, "Both Teams to Score — Yes");
  assert.equal(twice, once);
});

// ---------------------------------------------------------------------
// Structured context (sport/event/market) is accepted but never required
// ---------------------------------------------------------------------

test("SINGLE-shaped input (selection only, no sport/event/market) normalizes correctly", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "П1" }), "Home Win");
});

test("EXPRESS-leg-shaped input (full structured context) normalizes correctly", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "ТБ 2.5",
      sport: "Football",
      event: "Real Madrid vs Barcelona",
      market: "Total Goals",
    }),
    "Over 2.5 Goals",
  );
});

// ---------------------------------------------------------------------
// Handicap Stage H2 — SPREAD canonical display (participant + line)
// ---------------------------------------------------------------------

test("SPREAD: Arsenal / -1.5 -> 'Arsenal -1.5' (negative half-line)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal F1", marketType: "SPREAD", participant: "Arsenal", line: "-1.5" }),
    "Arsenal -1.5",
  );
});

test("SPREAD: Real Madrid / -1 -> 'Real Madrid -1' (negative whole-line)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Real Madrid F1", marketType: "SPREAD", participant: "Real Madrid", line: "-1" }),
    "Real Madrid -1",
  );
});

test("SPREAD: Coventry City / 1.5 -> 'Coventry City +1.5' (positive half-line gets an explicit +)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Coventry City F2", marketType: "SPREAD", participant: "Coventry City", line: "1.5" }),
    "Coventry City +1.5",
  );
});

test("SPREAD: Barcelona / 1 -> 'Barcelona +1' (positive whole-line gets an explicit +)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Barcelona F2", marketType: "SPREAD", participant: "Barcelona", line: "1" }),
    "Barcelona +1",
  );
});

test("SPREAD: Manchester United / -0.5 -> 'Manchester United -0.5'", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Manchester United F1", marketType: "SPREAD", participant: "Manchester United", line: "-0.5" }),
    "Manchester United -0.5",
  );
});

test("SPREAD: Chelsea / 0.5 -> 'Chelsea +0.5'", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Chelsea F2", marketType: "SPREAD", participant: "Chelsea", line: "0.5" }),
    "Chelsea +0.5",
  );
});

test("SPREAD: a zero line displays with no sign at all ('Participant 0', not '+0')", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Juventus F1", marketType: "SPREAD", participant: "Juventus", line: "0" }),
    "Juventus 0",
  );
});

test("SPREAD: multi-word participant name is preserved verbatim in the display label", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "X", marketType: "SPREAD", participant: "Manchester United", line: "-2" }),
    "Manchester United -2",
  );
});

test("SPREAD: raw Latin shorthand ('Arsenal F1') never leaks into the final label when canonical participant/line are present — the display comes entirely from the canonical fields, not from parsing `selection`", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal F1", marketType: "SPREAD", participant: "Arsenal", line: "-1.5" }),
    "Arsenal -1.5",
  );
});

test("SPREAD: raw Cyrillic shorthand ('Арсенал Ф1(-1.5)') never leaks into the final label either — same canonical-fields-first rule, independent of input language", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Арсенал Ф1(-1.5)", marketType: "SPREAD", participant: "Arsenal", line: "-1.5" }),
    "Arsenal -1.5",
  );
});

test("SPREAD: input language does not affect the rendered label — RU/UA/EN raw text with the identical canonical participant+line all render identically", () => {
  const canonical = { marketType: "SPREAD", participant: "Arsenal", line: "-1.5" } as const;
  assert.equal(normalizeSelectionToEnglish({ selection: "Арсенал Ф1(-1.5)", ...canonical }), "Arsenal -1.5");
  assert.equal(normalizeSelectionToEnglish({ selection: "Арсенал F1(-1.5)", ...canonical }), "Arsenal -1.5");
  assert.equal(normalizeSelectionToEnglish({ selection: "Arsenal F1(-1.5)", ...canonical }), "Arsenal -1.5");
  assert.equal(normalizeSelectionToEnglish({ selection: "Arsenal -1.5", ...canonical }), "Arsenal -1.5");
});

test("SPREAD branch does not fire when marketType is missing — falls through to the existing raw-text path unchanged (regression: 'Handicap -1.5 (Team A)' with no marketType stays untouched)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Handicap -1.5 (Team A)", participant: "Team A", line: "-1.5" }),
    "Handicap -1.5 (Team A)",
  );
});

test("SPREAD branch does not fire when participant is missing — falls through to the safe raw-text fallback rather than fabricating a label", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal F1", marketType: "SPREAD", line: "-1.5" }),
    "Arsenal F1",
  );
});

test("SPREAD branch does not fire when line is missing — falls through to the safe raw-text fallback rather than fabricating a label", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal F1", marketType: "SPREAD", participant: "Arsenal" }),
    "Arsenal F1",
  );
});

test("SPREAD branch does not fire for a malformed (non-decimal) line — falls through rather than rendering a garbled label", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal F1", marketType: "SPREAD", participant: "Arsenal", line: "not-a-number" }),
    "Arsenal F1",
  );
});

test("SPREAD branch never fires for MONEYLINE — 'Arsenal Win' stays unchanged even if a participant happens to be passed alongside it", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Arsenal Win", marketType: "MONEYLINE_2WAY", participant: "Arsenal", line: null }),
    "Arsenal Win",
  );
});

test("SPREAD branch never fires for TOTALS — 'Over 2.5' with a marketType of TOTALS still renders via the existing Over/Under path, not the SPREAD path", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Over 2.5", marketType: "TOTALS", participant: null, line: "2.5" }),
    "Over 2.5 Goals",
  );
});

// ---------------------------------------------------------------------
// Stage M4.6 — generic "don't double the line" dedup guard.
//
// Root cause this proves fixed: lib/odds/legacyOddsBridge.ts's market-hint
// SPREAD reconstruction path (classifyBettingSelectionTextWithMarketHint,
// triggered when a natural-language market hint like "Handicap" forces a
// SPREAD classification of an otherwise-unparsed selection string) can
// leave the FULL raw text, including an already-visible parenthesized
// line, as the canonical participant name (e.g. participant: "Barcelona
// (-2)"), while the separately-submitted line field is still correctly
// "-2" — so the old unconditional `${participant} ${formattedLine}`
// concatenation doubled it: "Barcelona (-2) -2". The fix must be generic
// (not Barcelona/team-specific) and must never suppress a line that
// genuinely isn't already shown.
// ---------------------------------------------------------------------

test("SPREAD dedup: participant already containing the line ('Barcelona (-2)') renders only once, not doubled", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Barcelona (-2)", marketType: "SPREAD", participant: "Barcelona (-2)", line: "-2" }),
    "Barcelona (-2)",
  );
});

test("SPREAD dedup: a positive line embedded without an explicit '+' ('Coventry City (1.5)') still matches and is not doubled", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Coventry City (1.5)",
      marketType: "SPREAD",
      participant: "Coventry City (1.5)",
      line: "1.5",
    }),
    "Coventry City (1.5)",
  );
});

test("SPREAD dedup: a clean participant with NO embedded line ('Barcelona') still gets the line appended exactly once — the fix never hides real line information", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Barcelona F2(-2)", marketType: "SPREAD", participant: "Barcelona", line: "-2" }),
    "Barcelona -2",
  );
});

test("SPREAD dedup: this is not team/name-specific — the same rule applies to an unrelated participant/line pair ('Real Madrid (-1)')", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Real Madrid (-1)", marketType: "SPREAD", participant: "Real Madrid (-1)", line: "-1" }),
    "Real Madrid (-1)",
  );
  // And the clean-participant case for the same team+line still appends normally.
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Real Madrid F1", marketType: "SPREAD", participant: "Real Madrid", line: "-1" }),
    "Real Madrid -1",
  );
});

test("TOTALS is entirely unaffected by the SPREAD dedup guard — 'Over 2.5' with an embedded line still renders exactly once, never 'Over 2.5 2.5'", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Over 2.5", marketType: "TOTALS", participant: null, line: "2.5" }),
    "Over 2.5 Goals",
  );
});

test("TOTALS: a parenthesized embedded line ('Over (2.5)') is untouched by the dedup guard and rendered exactly once (unchanged pre-existing behavior)", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Over (2.5)", marketType: "TOTALS", participant: null, line: "2.5" }),
    "Over (2.5)",
  );
});

test("MONEYLINE is unaffected by the SPREAD dedup guard — display unchanged", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "Arsenal Win", marketType: "MONEYLINE_2WAY" }), "Arsenal Win");
  assert.equal(normalizeSelectionToEnglish({ selection: "П1" }), "Home Win");
});

test("existing call sites (no marketType/participant/line fields at all) are completely unaffected — every pre-H2 test above this section still exercises the exact same code path", () => {
  assert.equal(normalizeSelectionToEnglish({ selection: "П1" }), "Home Win");
  assert.equal(normalizeSelectionToEnglish({ selection: "ТБ 2.5" }), "Over 2.5 Goals");
});

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 5B — canonical TEAM_TOTAL display            */
/* -------------------------------------------------------------------------- */

// Root-cause fixture (real production bug): the raw AI-extracted text
// ("Интер ТБ 1,5") never matches OVER_PATTERN/UNDER_PATTERN below (a leading
// participant name defeats the anchor), so before this branch existed the
// line was silently lost — the selection fell all the way through to the
// "preserve original unchanged" fallback.

test("TEAM_TOTAL OVER: participant/line render from canonical fields, never from raw text", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Интер ТБ 1,5",
      marketType: "TEAM_TOTAL",
      selectionType: "OVER",
      participant: "Интер",
      line: "1.5",
    }),
    "Интер · Team total over 1.5",
  );
});

test("TEAM_TOTAL UNDER: participant/line render from canonical fields", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Интер ТМ 2,5",
      marketType: "TEAM_TOTAL",
      selectionType: "UNDER",
      participant: "Интер",
      line: "2.5",
    }),
    "Интер · Team total under 2.5",
  );
});

test("TEAM_TOTAL: away participant is preserved, not defaulted to the home team", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Монца ТБ 1.5",
      marketType: "TEAM_TOTAL",
      selectionType: "OVER",
      participant: "Монца",
      line: "1.5",
    }),
    "Монца · Team total over 1.5",
  );
});

test("TEAM_TOTAL: an English-spelling participant renders identically (not RU-specific, no transliteration involved)", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Inter Milan Over 1.5",
      marketType: "TEAM_TOTAL",
      selectionType: "OVER",
      participant: "Inter Milan",
      line: "1.5",
    }),
    "Inter Milan · Team total over 1.5",
  );
});

for (const value of ["1", "1.5", "2", "2.5"]) {
  test(`TEAM_TOTAL: exact line ${value} survives with no rounding/nearest-line substitution`, () => {
    assert.equal(
      normalizeSelectionToEnglish({
        selection: "Интер ТБ",
        marketType: "TEAM_TOTAL",
        selectionType: "OVER",
        participant: "Интер",
        line: value,
      }),
      `Интер · Team total over ${value}`,
    );
  });
}

test("TEAM_TOTAL branch does not fire when selectionType is missing — falls through to the safe raw-text fallback rather than fabricating a label", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Интер ТБ 1,5", marketType: "TEAM_TOTAL", participant: "Интер", line: "1.5" }),
    "Интер ТБ 1,5",
  );
});

test("TEAM_TOTAL branch does not fire when participant is missing — falls through to the safe raw-text fallback", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Интер ТБ 1,5", marketType: "TEAM_TOTAL", selectionType: "OVER", line: "1.5" }),
    "Интер ТБ 1,5",
  );
});

test("TEAM_TOTAL branch does not fire when line is missing — falls through to the safe raw-text fallback", () => {
  assert.equal(
    normalizeSelectionToEnglish({ selection: "Интер ТБ", marketType: "TEAM_TOTAL", selectionType: "OVER", participant: "Интер" }),
    "Интер ТБ",
  );
});

test("TEAM_TOTAL branch does not fire for a malformed (non-decimal) line — falls through rather than rendering a garbled label", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Интер ТБ 1,5",
      marketType: "TEAM_TOTAL",
      selectionType: "OVER",
      participant: "Интер",
      line: "not-a-number",
    }),
    "Интер ТБ 1,5",
  );
});

test("TEAM_TOTAL branch never fires for TOTALS (ordinary match total) — the existing Over/Under raw-text path is unaffected and never gains a participant", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Over 2.5",
      marketType: "TOTALS",
      selectionType: "OVER",
      participant: null,
      line: "2.5",
    }),
    "Over 2.5 Goals",
  );
});

test("TEAM_TOTAL branch never fires for SPREAD — SPREAD's own branch still takes priority for marketType SPREAD, even with a selectionType present", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Arsenal F1",
      marketType: "SPREAD",
      selectionType: "PARTICIPANT",
      participant: "Arsenal",
      line: "-1.5",
    }),
    "Arsenal -1.5",
  );
});

test("TEAM_TOTAL branch never fires for MONEYLINE — 'Interr Win' stays unchanged even if selectionType/participant happen to be passed alongside it", () => {
  assert.equal(
    normalizeSelectionToEnglish({
      selection: "Arsenal Win",
      marketType: "MONEYLINE_2WAY",
      selectionType: "PARTICIPANT",
      participant: "Arsenal",
    }),
    "Arsenal Win",
  );
});
