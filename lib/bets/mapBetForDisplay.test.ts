import { test } from "node:test";
import assert from "node:assert/strict";
import { mapBetForDisplay, type BetLikeForDisplay, type DisplaySelection } from "./mapBetForDisplay";

function selection(overrides: Partial<DisplaySelection> = {}): DisplaySelection {
  return {
    id: "sel-1",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    odds: "2.10",
    ...overrides,
  };
}

function bet(overrides: Partial<BetLikeForDisplay> = {}): BetLikeForDisplay {
  return {
    id: "bet-1",
    type: "SINGLE",
    status: "CONFIRMED",
    stake: "100",
    odds: "2.10",
    totalOdds: null,
    createdAt: "2026-07-21T12:00:00.000Z",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    selections: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// SINGLE
// ---------------------------------------------------------------------

test("SINGLE bet with one selection: displayTitle/displaySubtitle come from that selection, not legacy fields", () => {
  const b = bet({
    event: "WRONG LEGACY EVENT", // proves selections win when both exist
    outcome: "WRONG LEGACY OUTCOME",
    selections: [selection({ event: "Liverpool vs Arsenal", outcome: "Liverpool Win" })],
  });

  const display = mapBetForDisplay(b);

  assert.equal(display.selectionCount, 1);
  assert.equal(display.displayTitle, "Liverpool vs Arsenal");
  assert.equal(display.displaySubtitle, "Liverpool Win");
  assert.equal(display.selections.length, 1);
  assert.equal(display.selections[0].event, "Liverpool vs Arsenal");
});

test("a bet with selections never falls back to legacy Bet.event, even if legacy fields are present", () => {
  const b = bet({
    event: "Legacy Event That Should Never Appear",
    selections: [selection({ event: "Real Selection Event" })],
  });

  const display = mapBetForDisplay(b);
  assert.equal(display.displayTitle, "Real Selection Event");
  assert.doesNotMatch(display.displayTitle, /Legacy Event/);
});

// ---------------------------------------------------------------------
// EXPRESS
// ---------------------------------------------------------------------

test("EXPRESS bet with two selections: title shows the count and the first leg, all selections are exposed", () => {
  const b = bet({
    type: "EXPRESS",
    sport: "Football",
    event: null,
    outcome: null,
    odds: null,
    totalOdds: "3.75",
    selections: [
      selection({ id: "sel-1", event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win" }),
      selection({ id: "sel-2", sport: "Tennis", event: "Alcaraz vs Sinner", outcome: "Alcaraz Win", odds: "1.80" }),
    ],
  });

  const display = mapBetForDisplay(b);

  assert.equal(display.selectionCount, 2);
  assert.equal(display.displayTitle, "Экспресс ×2 · Real Madrid vs Barcelona");
  assert.equal(display.selections.length, 2);
  assert.equal(display.selections[0].id, "sel-1");
  assert.equal(display.selections[1].id, "sel-2");
  assert.equal(display.totalOdds, "3.75");
});

test("EXPRESS with three or more selections: count and order are preserved", () => {
  const b = bet({
    type: "EXPRESS",
    event: null,
    outcome: null,
    odds: null,
    totalOdds: "6.20",
    selections: [
      selection({ id: "sel-1" }),
      selection({ id: "sel-2" }),
      selection({ id: "sel-3" }),
    ],
  });

  const display = mapBetForDisplay(b);
  assert.equal(display.selectionCount, 3);
  assert.deepEqual(
    display.selections.map((s) => s.id),
    ["sel-1", "sel-2", "sel-3"],
  );
});

test("deterministic selection order: the mapper preserves whatever order it was given, never re-sorts", () => {
  const b = bet({
    type: "EXPRESS",
    event: null,
    outcome: null,
    selections: [selection({ id: "sel-c" }), selection({ id: "sel-a" }), selection({ id: "sel-b" })],
  });

  const display = mapBetForDisplay(b);
  assert.deepEqual(
    display.selections.map((s) => s.id),
    ["sel-c", "sel-a", "sel-b"],
  );
});

// ---------------------------------------------------------------------
// Total odds / potential payout
// ---------------------------------------------------------------------

test("totalOdds is displayed from the Bet-level totalOdds field, preferred over per-selection/legacy odds", () => {
  const b = bet({ odds: "2.10", totalOdds: "5.55", selections: [selection({ odds: "1.90" })] });
  const display = mapBetForDisplay(b);
  assert.equal(display.totalOdds, "5.55");
  assert.equal(display.potentialPayout, "555.00"); // 100 * 5.55
});

test("potentialPayout falls back to the legacy odds field when totalOdds is null", () => {
  const b = bet({ stake: "40", odds: "1.85", totalOdds: null, selections: [selection()] });
  const display = mapBetForDisplay(b);
  assert.equal(display.potentialPayout, "74.00"); // 40 * 1.85
});

test("potentialPayout is null when neither totalOdds nor odds is known", () => {
  const b = bet({ odds: null, totalOdds: null, selections: [selection({ odds: null })] });
  const display = mapBetForDisplay(b);
  assert.equal(display.potentialPayout, null);
});

// ---------------------------------------------------------------------
// Legacy fallback (no selections)
// ---------------------------------------------------------------------

test("legacy bet with no selections falls back safely to Bet.event/outcome/odds", () => {
  const b = bet({
    event: "Chelsea vs Tottenham",
    outcome: "Chelsea Win",
    odds: "2.20",
    selections: [],
  });

  const display = mapBetForDisplay(b);

  assert.equal(display.selectionCount, 1);
  assert.equal(display.displayTitle, "Chelsea vs Tottenham");
  assert.equal(display.displaySubtitle, "Chelsea Win");
  assert.equal(display.selections[0].sport, "Football");
  assert.equal(display.selections[0].odds, "2.20");
});

test("a genuinely empty legacy bet (no selections and no legacy event/outcome) never throws, shows the neutral fallback", () => {
  const b = bet({ event: null, outcome: null, selections: [] });
  const display = mapBetForDisplay(b);

  assert.equal(display.selectionCount, 0);
  assert.equal(display.displayTitle, "—");
  assert.equal(display.displaySubtitle, null);
  assert.deepEqual(display.selections, []);
});

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------

test("a very long event name passes through unchanged — truncation is a CSS concern, not this mapper's", () => {
  const longEvent = "A".repeat(300) + " vs " + "B".repeat(300);
  const b = bet({ selections: [selection({ event: longEvent })] });
  const display = mapBetForDisplay(b);
  assert.equal(display.displayTitle, longEvent);
  assert.equal(display.displayTitle.length, longEvent.length);
});

test("nullable optional fields (odds, totalOdds) are passed through as null, never coerced to a string or 0", () => {
  const b = bet({ odds: null, totalOdds: null, selections: [selection({ odds: null })] });
  const display = mapBetForDisplay(b);
  assert.equal(display.totalOdds, null);
  assert.equal(display.selections[0].odds, null);
});

// ---------------------------------------------------------------------
// English-only selection labels (temporary product rule, not full i18n)
// ---------------------------------------------------------------------

test("an existing stored SINGLE bet (legacy fallback, no BetSelection rows) with a Russian outcome displays in English", () => {
  const b = bet({
    event: "Spartak vs CSKA",
    outcome: "П1",
    selections: [],
  });

  const display = mapBetForDisplay(b);

  assert.equal(display.displaySubtitle, "Home Win");
  assert.equal(display.selections[0].outcome, "Home Win");
});

test("an existing stored EXPRESS bet's Russian-language legs all display in English, order preserved", () => {
  const b = bet({
    type: "EXPRESS",
    event: null,
    outcome: null,
    totalOdds: "5.10",
    selections: [
      selection({ id: "sel-1", outcome: "Победа 1" }),
      selection({ id: "sel-2", outcome: "Ничья" }),
      selection({ id: "sel-3", outcome: "Обе забьют — Да" }),
    ],
  });

  const display = mapBetForDisplay(b);

  assert.deepEqual(
    display.selections.map((s) => s.outcome),
    ["Home Win", "Draw", "Both Teams to Score — Yes"],
  );
  assert.equal(display.displaySubtitle, "Home Win");
});

test("an unrecognized already-stored outcome is left exactly as stored", () => {
  const b = bet({ selections: [selection({ outcome: "Handicap -1.5 (Team A)" })] });
  const display = mapBetForDisplay(b);
  assert.equal(display.selections[0].outcome, "Handicap -1.5 (Team A)");
});

test("does not mutate the source bet or its selections array/objects", () => {
  const originalSelections = [selection({ id: "sel-1" }), selection({ id: "sel-2" })];
  const b = bet({ type: "EXPRESS", event: null, outcome: null, selections: originalSelections });
  const snapshotBet = JSON.parse(JSON.stringify(b));
  const snapshotSelections = JSON.parse(JSON.stringify(originalSelections));

  mapBetForDisplay(b);

  assert.deepEqual(b, snapshotBet);
  assert.deepEqual(originalSelections, snapshotSelections);
  // The returned selections array is a distinct copy, not the same
  // reference as the input — mutating the result must never be able to
  // reach back into the caller's original array.
  const display = mapBetForDisplay(b);
  assert.notEqual(display.selections, b.selections);
});
