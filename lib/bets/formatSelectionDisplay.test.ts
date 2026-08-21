import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSelectionDisplay } from "./formatSelectionDisplay";

// ---------------------------------------------------------------------
// RU betting-terminology localization — presentation only. Every input
// here is one of lib/bets/normalizeSelectionToEnglish.ts's own known
// English output shapes (never raw/unnormalized text) — see this module's
// own header comment for the full rationale.
// ---------------------------------------------------------------------

test("RU: a named participant WIN ('<Name> Win') becomes '<Name> · Победа', market suppressed as redundant", () => {
  const result = formatSelectionDisplay("Марсель Win", "Match Winner", "ru");
  assert.equal(result.selection, "Марсель · Победа");
  assert.equal(result.market, null);
});

test("RU: DRAW becomes 'Ничья', market kept (not redundant without a named winner)", () => {
  const result = formatSelectionDisplay("Draw", "Match Winner", "ru");
  assert.equal(result.selection, "Ничья");
  assert.equal(result.market, "Победитель матча");
});

test("RU: OVER 2.5 becomes 'Больше 2.5'", () => {
  const result = formatSelectionDisplay("Over 2.5 Goals", null, "ru");
  assert.equal(result.selection, "Больше 2.5");
  assert.equal(result.market, null);
});

test("RU: UNDER 2.5 becomes 'Меньше 2.5'", () => {
  const result = formatSelectionDisplay("Under 2.5 Goals", null, "ru");
  assert.equal(result.selection, "Меньше 2.5");
});

test("RU: OVER/UNDER also work without the ' Goals' suffix (non-football)", () => {
  assert.equal(formatSelectionDisplay("Over 21.5", null, "ru").selection, "Больше 21.5");
  assert.equal(formatSelectionDisplay("Under 21.5", null, "ru").selection, "Меньше 21.5");
});

test("RU: generic HOME_WIN/AWAY_WIN (no participant name known) localize without a redundant market", () => {
  const home = formatSelectionDisplay("Home Win", "Match Winner", "ru");
  assert.equal(home.selection, "Победа хозяев");
  assert.equal(home.market, null);

  const away = formatSelectionDisplay("Away Win", "1X2", "ru");
  assert.equal(away.selection, "Победа гостей");
  assert.equal(away.market, null);
});

test("RU: double chance and both-teams-to-score phrasings localize, market kept (not a redundant Match Winner pairing)", () => {
  assert.equal(formatSelectionDisplay("Home or Draw", "Match Winner", "ru").selection, "Победа хозяев или ничья");
  assert.equal(formatSelectionDisplay("Draw or Away", null, "ru").selection, "Ничья или победа гостей");
  assert.equal(formatSelectionDisplay("Home or Away", null, "ru").selection, "Победа хозяев или гостей");

  const btts = formatSelectionDisplay("Both Teams to Score — Yes", "Both Teams to Score", "ru");
  assert.equal(btts.selection, "Обе забьют — Да");
  assert.equal(btts.market, "Обе забьют");

  assert.equal(formatSelectionDisplay("Both Teams to Score — No", null, "ru").selection, "Обе забьют — Нет");
});

test("RU: market terminology is localized independently when the selection isn't a win outcome", () => {
  assert.equal(formatSelectionDisplay("Draw", "Moneyline", "ru").market, "Победитель матча");
  assert.equal(formatSelectionDisplay("Draw", "Total Goals", "ru").market, "Тотал голов");
});

// Requirement 5 — EN must remain correct/unchanged in meaning: EN is the
// identity function (the input strings ARE already the correct English
// display text), so nothing is reconstructed for EN.
test("EN: every input passes through completely unchanged", () => {
  assert.deepEqual(formatSelectionDisplay("Марсель Win", "Match Winner", "en"), {
    selection: "Марсель Win",
    market: "Match Winner",
  });
  assert.deepEqual(formatSelectionDisplay("Draw", "Match Winner", "en"), { selection: "Draw", market: "Match Winner" });
  assert.deepEqual(formatSelectionDisplay("Over 2.5 Goals", null, "en"), { selection: "Over 2.5 Goals", market: null });
});

// Requirement 6 — EXPRESS with mixed selections: each leg is localized
// independently by calling this same formatter once per leg (proven at the
// unit level here; the actual per-leg call site is
// components/miniapp/BetTicket.tsx's selections.map(), see BetTicket.test.ts).
test("EXPRESS: mixed legs (named win / draw / totals) each localize independently, with no cross-leg state", () => {
  const legs = [
    formatSelectionDisplay("Марсель Win", "Match Winner", "ru"),
    formatSelectionDisplay("Draw", "Match Winner", "ru"),
    formatSelectionDisplay("Over 2.5 Goals", "Total Goals", "ru"),
  ];

  assert.deepEqual(legs[0], { selection: "Марсель · Победа", market: null });
  assert.deepEqual(legs[1], { selection: "Ничья", market: "Победитель матча" });
  assert.deepEqual(legs[2], { selection: "Больше 2.5", market: "Тотал голов" });
});

// Requirement 7 — fallback safety: an unrecognized (future/unknown)
// selection or market string is never guessed at, never blank, never
// throws — the existing English/canonical value is preserved.
test("Fallback safety: an unrecognized selection is returned unchanged for RU, never blank/thrown", () => {
  const result = formatSelectionDisplay("Some Future Market Phrasing", "Some Future Market", "ru");
  assert.equal(result.selection, "Some Future Market Phrasing");
  assert.equal(result.market, "Some Future Market");
});

test("Fallback safety: a SPREAD-style '<Name> <signed line>' selection (no fixed literal phrasing) passes through unchanged", () => {
  const result = formatSelectionDisplay("Barcelona -1.5", "Spread", "ru");
  assert.equal(result.selection, "Barcelona -1.5");
  assert.equal(result.market, "Spread");
});

test("Fallback safety: empty/whitespace market never throws and is treated as absent", () => {
  assert.equal(formatSelectionDisplay("Draw", "", "ru").market, "");
});

// Requirement 8 — this formatter has no concept of ticket status at all
// (it only ever receives selection/market/locale); calling it repeatedly
// with the exact same selection/market across every status transition
// must always produce the identical result.
test("Status-independence: identical (selection, market, locale) input always produces identical output, regardless of ticket status", () => {
  const first = formatSelectionDisplay("Марсель Win", "Match Winner", "ru");
  const second = formatSelectionDisplay("Марсель Win", "Match Winner", "ru");
  assert.deepEqual(first, second);
});

// Requirement 9 — team/participant names are carried through byte-for-byte,
// never translated/mutated, whether Cyrillic or Latin.
test("Team/participant names are never translated or mutated, in either script", () => {
  assert.equal(formatSelectionDisplay("Марсель Win", null, "ru").selection, "Марсель · Победа");
  assert.equal(formatSelectionDisplay("Arsenal Win", null, "ru").selection, "Arsenal · Победа");
  assert.equal(formatSelectionDisplay("Carlos Alcaraz Win", null, "ru").selection, "Carlos Alcaraz · Победа");
});


test("RU totals preserve the numeric line in the user-facing label", () => {
  assert.deepEqual(
    formatSelectionDisplay("Over 2.5 Goals", "Total Goals", "ru"),
    { selection: "Тотал больше 2.5", market: "Тотал голов" },
  );

  assert.deepEqual(
    formatSelectionDisplay("Under 2.5 Goals", "Total Goals", "ru"),
    { selection: "Тотал меньше 2.5", market: "Тотал голов" },
  );
});

test("RU totals preserve different valid lines instead of hardcoding 2.5", () => {
  assert.equal(
    formatSelectionDisplay("Over 3.5 Goals", "Totals", "ru").selection,
    "Тотал больше 3.5",
  );

  assert.equal(
    formatSelectionDisplay("Under 1.5 Goals", "Totals", "ru").selection,
    "Тотал меньше 1.5",
  );
});

test("EN totals remain byte-for-byte unchanged", () => {
  assert.deepEqual(
    formatSelectionDisplay("Over 2.5 Goals", "Total Goals", "en"),
    { selection: "Over 2.5 Goals", market: "Total Goals" },
  );
});
