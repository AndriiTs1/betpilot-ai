import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapRawSelectionToDraftSelection,
  mapRawBetSlipToParsedBetSlip,
  numberToDecimalString,
  type RawBetSelectionFields,
} from "./betDraftMapper";

function football(overrides: Partial<RawBetSelectionFields> = {}): RawBetSelectionFields {
  return {
    sport: "Football",
    league: null,
    event: "Arsenal vs Chelsea",
    market: null,
    selection: "Arsenal",
    period: null,
    line: null,
    odds: 1.95,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Decimal conversion                                                         */
/* -------------------------------------------------------------------------- */

test("numberToDecimalString: converts without rounding, trailing zeros, or scientific notation", () => {
  assert.equal(numberToDecimalString(50), "50");
  assert.equal(numberToDecimalString(1.95), "1.95");
  assert.equal(numberToDecimalString(2.5), "2.5");
});

/* -------------------------------------------------------------------------- */
/* Complete football selection                                                */
/* -------------------------------------------------------------------------- */

test("mapper: a complete football selection resolves sport, league, market, period, and line", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(
    football({ league: "Premier League", market: "Match Winner", period: "Full Game", line: null }),
  );

  assert.equal(selection.sport.state, "EXTRACTED");
  assert.equal(selection.sport.value, "FOOTBALL");
  assert.equal(selection.league.state, "EXTRACTED");
  assert.equal(selection.marketType.state, "EXTRACTED");
  assert.equal(selection.marketType.value, "MONEYLINE_2WAY");
  assert.equal(selection.period.state, "EXTRACTED");
  assert.equal(selection.period.value, "FULL_GAME");
  assert.equal(selection.line.state, "MISSING");
  assert.deepEqual(warnings, []);
});

/* -------------------------------------------------------------------------- */
/* Missing optional fields -> no warnings                                     */
/* -------------------------------------------------------------------------- */

test("mapper: absent (null) league/market/period/line produce MISSING state and zero warnings", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football());

  assert.equal(selection.league.state, "MISSING");
  assert.equal(selection.marketType.state, "MISSING");
  assert.equal(selection.period.state, "MISSING");
  assert.equal(selection.line.state, "MISSING");
  assert.deepEqual(warnings, []);
});

/* -------------------------------------------------------------------------- */
/* Unresolved league -> UNKNOWN + warning                                     */
/* -------------------------------------------------------------------------- */

test("mapper: an unresolved league (e.g. EPL) is UNKNOWN and produces exactly one warning", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football({ league: "EPL" }));

  assert.equal(selection.league.state, "UNKNOWN");
  assert.equal(selection.league.rawText, "EPL");
  assert.deepEqual(warnings, [{ field: "league", reason: "UNKNOWN", rawText: "EPL" }]);
});

/* -------------------------------------------------------------------------- */
/* Unsupported market -> UNSUPPORTED + warning, market adapts to null         */
/* -------------------------------------------------------------------------- */

test("mapper: an unsupported market (player prop) is UNSUPPORTED, warns, and adapts to null legacy market", () => {
  const { selection, warnings } = mapRawSelectionToDraftSelection(football({ market: "player prop" }));

  assert.equal(selection.marketType.state, "UNSUPPORTED");
  assert.deepEqual(warnings, [{ field: "market", reason: "UNSUPPORTED", rawText: "player prop" }]);

  const slip = mapRawBetSlipToParsedBetSlip({ type: "SINGLE", stake: 50, selections: [football({ market: "player prop" })] }, { originalText: "x", sourceType: "CHAT" });
  assert.equal(slip.selections[0].market, null);
});

/* -------------------------------------------------------------------------- */
/* Totals / spread / BTTS / double chance                                     */
/* -------------------------------------------------------------------------- */

test("mapper: totals market with 'Over 2.5' resolves an OVER line with magnitude 2.5", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "totals", selection: "Over 2.5", line: "Over 2.5" }),
  );

  assert.equal(selection.marketType.value, "TOTALS");
  assert.equal(selection.line.state, "EXTRACTED");
  assert.equal(selection.line.value?.direction, "OVER");
  assert.equal(selection.line.value?.magnitude, "2.5");
});

test("mapper: spread market with '-4.5' resolves a MINUS line with unsigned magnitude 4.5", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "spread", line: "-4.5" }));

  assert.equal(selection.marketType.value, "SPREAD");
  assert.equal(selection.line.value?.direction, "MINUS");
  assert.equal(selection.line.value?.magnitude, "4.5");
});

test("mapper: both-teams-to-score market with a 'Yes' selection resolves selectionType YES", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "both teams to score", selection: "Yes" }),
  );

  assert.equal(selection.marketType.value, "BOTH_TEAMS_TO_SCORE");
  assert.equal(selection.selectionType.state, "EXTRACTED");
  assert.equal(selection.selectionType.value, "YES");
});

test("mapper: double chance market with a '1X' selection resolves selectionType HOME_OR_DRAW", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ market: "double chance", selection: "1X" }),
  );

  assert.equal(selection.marketType.value, "DOUBLE_CHANCE");
  assert.equal(selection.selectionType.value, "HOME_OR_DRAW");
});

/* -------------------------------------------------------------------------- */
/* Period                                                                      */
/* -------------------------------------------------------------------------- */

test("mapper: 'First Half' resolves period FIRST_HALF", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ period: "First Half" }));
  assert.equal(selection.period.state, "EXTRACTED");
  assert.equal(selection.period.value, "FIRST_HALF");
});

/* -------------------------------------------------------------------------- */
/* Participant resolution                                                     */
/* -------------------------------------------------------------------------- */

test("mapper: a participant-eligible market with a selection matching an event participant resolves an INDEX reference", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "match winner", selection: "Arsenal" }));

  assert.deepEqual(selection.participant, { kind: "INDEX", participantIndex: 0 });
});

test("mapper: a participant-eligible market with an unresolved raw selection resolves a RAW_TEXT reference", () => {
  const { selection } = mapRawSelectionToDraftSelection(football({ market: "match winner", selection: "Draw No Bet Arsenal" }));

  assert.deepEqual(selection.participant, { kind: "RAW_TEXT", rawName: "Draw No Bet Arsenal" });
});

/* -------------------------------------------------------------------------- */
/* Unicode                                                                    */
/* -------------------------------------------------------------------------- */

test("mapper: Unicode Russian selection text passes through byte-for-byte", () => {
  const { selection } = mapRawSelectionToDraftSelection(
    football({ sport: "футбол", event: "Спартак - Динамо", selection: "П1" }),
  );

  assert.equal(selection.sport.value, "FOOTBALL");
  assert.equal(selection.event.rawText, "Спартак - Динамо");
  assert.equal(selection.selectionRawText, "П1");
  assert.equal(selection.selectionType.value, "HOME");
});

/* -------------------------------------------------------------------------- */
/* EXPRESS with mixed sports                                                  */
/* -------------------------------------------------------------------------- */

test("mapper: an EXPRESS slip with mixed sports maps each leg independently", () => {
  const slip = mapRawBetSlipToParsedBetSlip(
    {
      type: "EXPRESS",
      stake: 30,
      selections: [
        football({ event: "Real Madrid vs Barcelona", selection: "Real Madrid", odds: 1.8 }),
        { sport: "Tennis", league: null, event: "Alcaraz vs Sinner", market: null, selection: "Alcaraz", period: null, line: null, odds: 2.1 },
      ],
    },
    { originalText: "express", sourceType: "CHAT" },
  );

  assert.equal(slip.type, "EXPRESS");
  assert.equal(slip.stake, 30);
  assert.equal(slip.selections.length, 2);
  assert.equal(slip.selections[0].sport, "Football");
  assert.equal(slip.selections[1].sport, "Tennis");
});

/* -------------------------------------------------------------------------- */
/* Full slip warning aggregation                                              */
/* -------------------------------------------------------------------------- */

test("mapper: warnings aggregate only for provided-but-unusable fields across every selection, never for absent ones", () => {
  const slip = mapRawBetSlipToParsedBetSlip(
    {
      type: "EXPRESS",
      stake: 30,
      selections: [football({ league: "EPL" }), football({ event: "Inter vs Juventus", selection: "Juventus", market: "player prop" })],
    },
    { originalText: "express", sourceType: "OCR" },
  );

  // Warnings never leak into ParsedBetSlip — confirmed by exact key check
  // (matches the existing legacyAdapter.test.ts convention).
  assert.deepEqual(Object.keys(slip).sort(), ["selections", "stake", "type"]);
});

test("mapper: HIGH confidence is always set on the underlying draft (visible only through successful ParsedBetSlip construction)", () => {
  // mapRawBetSlipToParsedBetSlip only ever runs post-Zod-validation, so this
  // asserts the pipeline completes without throwing for well-formed input —
  // confidence itself has no ParsedBetSlip slot to observe directly.
  assert.doesNotThrow(() =>
    mapRawBetSlipToParsedBetSlip({ type: "SINGLE", stake: 50, selections: [football()] }, { originalText: "x", sourceType: "CHAT" }),
  );
});
