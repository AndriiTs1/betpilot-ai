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
