import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPORTS,
  MARKET_TYPES,
  PERIODS,
  SELECTION_TYPES,
  isSport,
  isMarketType,
  isPeriod,
  isSelectionType,
  isDecimalString,
  validateCanonicalSelection,
  type CanonicalEvent,
  type CanonicalSelection,
} from "./domain";

const NBA_EVENT: CanonicalEvent = {
  sport: "BASKETBALL",
  name: "Lakers vs Celtics",
  participants: [{ name: "Lakers" }, { name: "Celtics" }],
  period: "FULL_GAME",
  homeParticipantIndex: 0,
  awayParticipantIndex: 1,
};

function moneyline2Way(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "BASKETBALL",
    event: NBA_EVENT,
    marketType: "MONEYLINE_2WAY",
    period: "FULL_GAME",
    selectionType: "HOME",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Group A — domain enum/value tests                                          */
/* -------------------------------------------------------------------------- */

test("Sport: exact serialized values, no provider-specific keys", () => {
  assert.deepEqual(SPORTS, ["FOOTBALL", "BASKETBALL", "TENNIS", "ICE_HOCKEY", "AMERICAN_FOOTBALL", "UNKNOWN"]);
  for (const sport of SPORTS) {
    assert.equal(JSON.stringify(sport), `"${sport}"`, "serializes as its own literal value");
    assert.doesNotMatch(sport, /soccer_epl|basketball_nba|icehockey_nhl|americanfootball_nfl|tennis_atp|tennis_wta/);
  }
});

test("MarketType: exact serialized values", () => {
  assert.deepEqual(MARKET_TYPES, [
    "MONEYLINE_2WAY",
    "MONEYLINE_3WAY",
    "DOUBLE_CHANCE",
    "TOTALS",
    "SPREAD",
    "BOTH_TEAMS_TO_SCORE",
    "DRAW_NO_BET",
    "TEAM_TOTAL",
    "EXACT_SCORE",
    "PLAYER_PROP",
    "OUTRIGHT",
    "UNKNOWN",
  ]);
});

test("Period: exact serialized values, REGULATION distinct from FULL_GAME", () => {
  assert.deepEqual(PERIODS, ["FULL_GAME", "REGULATION", "FIRST_HALF", "SECOND_HALF", "FIRST_QUARTER", "MATCH", "SET", "UNKNOWN"]);
  assert.notEqual("REGULATION" as string, "FULL_GAME" as string);
});

test("SelectionType: exact serialized values", () => {
  assert.deepEqual(SELECTION_TYPES, [
    "HOME",
    "DRAW",
    "AWAY",
    "PARTICIPANT",
    "HOME_OR_DRAW",
    "DRAW_OR_AWAY",
    "HOME_OR_AWAY",
    "OVER",
    "UNDER",
    "YES",
    "NO",
  ]);
});

test("UNKNOWN sport/market are recognized values but remain distinct from every real value", () => {
  assert.ok(isSport("UNKNOWN"));
  assert.ok(isMarketType("UNKNOWN"));
  assert.ok(!SPORTS.slice(0, -1).includes("UNKNOWN" as never));
});

test("isSport/isMarketType/isPeriod/isSelectionType reject unknown strings", () => {
  assert.equal(isSport("CRICKET"), false);
  assert.equal(isMarketType("SAME_GAME_PARLAY"), false);
  assert.equal(isPeriod("OVERTIME"), false);
  assert.equal(isSelectionType("HANDICAP"), false);
});

test("isDecimalString accepts plain decimals and rejects garbage", () => {
  assert.ok(isDecimalString("1.95"));
  assert.ok(isDecimalString("2"));
  assert.ok(isDecimalString("-1.5"));
  assert.equal(isDecimalString("1.95x"), false);
  assert.equal(isDecimalString(""), false);
  assert.equal(isDecimalString("NaN"), false);
});

/* -------------------------------------------------------------------------- */
/* validateCanonicalSelection — per-market structural rules                   */
/* -------------------------------------------------------------------------- */

test("validateCanonicalSelection: MONEYLINE_2WAY rejects DRAW", () => {
  const result = validateCanonicalSelection(moneyline2Way({ selectionType: "DRAW" }));
  assert.equal(result.ok, false);
});

test("validateCanonicalSelection: MONEYLINE_2WAY accepts HOME/AWAY", () => {
  assert.equal(validateCanonicalSelection(moneyline2Way({ selectionType: "HOME" })).ok, true);
  assert.equal(validateCanonicalSelection(moneyline2Way({ selectionType: "AWAY" })).ok, true);
});

test("validateCanonicalSelection: MONEYLINE_2WAY with PARTICIPANT requires a participant", () => {
  const missing = validateCanonicalSelection(moneyline2Way({ selectionType: "PARTICIPANT" }));
  assert.equal(missing.ok, false);

  const withParticipant = validateCanonicalSelection(
    moneyline2Way({ selectionType: "PARTICIPANT", participant: { name: "Carlos Alcaraz" } }),
  );
  assert.equal(withParticipant.ok, true);
});

test("validateCanonicalSelection: MONEYLINE_3WAY permits only HOME/DRAW/AWAY", () => {
  for (const selectionType of ["HOME", "DRAW", "AWAY"] as const) {
    assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "MONEYLINE_3WAY", selectionType })).ok, true);
  }
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "MONEYLINE_3WAY", selectionType: "PARTICIPANT", participant: { name: "x" } }))
      .ok,
    false,
  );
});

test("validateCanonicalSelection: DOUBLE_CHANCE permits only its three canonical combinations", () => {
  for (const selectionType of ["HOME_OR_DRAW", "DRAW_OR_AWAY", "HOME_OR_AWAY"] as const) {
    assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "DOUBLE_CHANCE", selectionType })).ok, true);
  }
  assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "DOUBLE_CHANCE", selectionType: "HOME" })).ok, false);
});

test("validateCanonicalSelection: TOTALS requires line and OVER/UNDER", () => {
  assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "TOTALS", selectionType: "OVER" })).ok, false);
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "TOTALS", selectionType: "OVER", line: "2.5" })).ok,
    true,
  );
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "TOTALS", selectionType: "HOME", line: "2.5" })).ok,
    false,
  );
});

test("validateCanonicalSelection: SPREAD requires participant and line", () => {
  assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "SPREAD", selectionType: "HOME" })).ok, false);
  assert.equal(
    validateCanonicalSelection(
      moneyline2Way({ marketType: "SPREAD", selectionType: "HOME", participant: { name: "Lakers" }, line: "-1.5" }),
    ).ok,
    true,
  );
});

test("validateCanonicalSelection: BOTH_TEAMS_TO_SCORE requires YES/NO", () => {
  assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "BOTH_TEAMS_TO_SCORE", selectionType: "YES" })).ok, true);
  assert.equal(validateCanonicalSelection(moneyline2Way({ marketType: "BOTH_TEAMS_TO_SCORE", selectionType: "HOME" })).ok, false);
});

test("validateCanonicalSelection: rejects a malformed line/submittedOdds decimal string", () => {
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "TOTALS", selectionType: "OVER", line: "two-point-five" })).ok,
    false,
  );
  assert.equal(validateCanonicalSelection(moneyline2Way({ submittedOdds: "not-a-number" })).ok, false);
});
