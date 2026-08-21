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
  normalizeLineString,
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
  // isDecimalString defines the CANONICAL shape — a leading "+" is never
  // canonical, even though normalizeLineString (below) accepts it as INPUT
  // and strips it. These are deliberately different contracts.
  assert.equal(isDecimalString("+1.5"), false);
});

/* -------------------------------------------------------------------------- */
/* normalizeLineString — Betting Markets V1 Phase 2 review fix                */
/* -------------------------------------------------------------------------- */

test("normalizeLineString: '+1.5' is accepted and canonicalized to '1.5' (redundant leading '+' stripped)", () => {
  assert.equal(normalizeLineString("+1.5"), "1.5");
  assert.equal(normalizeLineString("+2"), "2");
  assert.equal(normalizeLineString("+0"), "0");
});

test("normalizeLineString: '-1.5' passes through unchanged", () => {
  assert.equal(normalizeLineString("-1.5"), "-1.5");
});

test("normalizeLineString: '2.5' (unsigned, already canonical) passes through unchanged", () => {
  assert.equal(normalizeLineString("2.5"), "2.5");
  assert.equal(normalizeLineString("0"), "0");
});

test("normalizeLineString: malformed values are rejected (null), never coerced", () => {
  assert.equal(normalizeLineString("two-point-five"), null);
  assert.equal(normalizeLineString("1.5.5"), null);
  assert.equal(normalizeLineString(""), null);
  assert.equal(normalizeLineString("NaN"), null);
  assert.equal(normalizeLineString("++1.5"), null);
});

// H4-B5.6 — syntax must not broaden alongside the new trailing-zero
// canonicalization: every one of these was already rejected before this
// stage, and none of them become newly acceptable now.
test("H4-B5.6: invalid-line syntax that was already rejected stays rejected — trailing-zero canonicalization never broadens accepted syntax", () => {
  for (const malformed of ["2.", ".5", "--2", "2..5", "abc", "2.5.0", "1..0"]) {
    assert.equal(normalizeLineString(malformed), null, `"${malformed}" must remain rejected`);
  }
});

test("normalizeLineString: every output it produces is itself a valid isDecimalString (the canonical shape)", () => {
  for (const input of ["+1.5", "-1.5", "2.5", "0", "+0"]) {
    const normalized = normalizeLineString(input);
    assert.notEqual(normalized, null);
    assert.ok(isDecimalString(normalized as string), `normalizeLineString("${input}") = "${normalized}" must itself be canonical`);
  }
});

/* -------------------------------------------------------------------------- */
/* Individual Team Totals, Stage 2 — RU/UA decimal comma acceptance. A comma  */
/* is an alternate INPUT spelling of the same dot-decimal value, never a      */
/* second canonical form — every case here must produce byte-for-byte the    */
/* same output as its dot-decimal equivalent already produces above.         */
/* -------------------------------------------------------------------------- */

test("Individual Team Totals Stage 2 (1): '1,5' -> '1.5'", () => {
  assert.equal(normalizeLineString("1,5"), "1.5");
});

test("Individual Team Totals Stage 2 (2): '2,5' -> '2.5'", () => {
  assert.equal(normalizeLineString("2,5"), "2.5");
});

test("Individual Team Totals Stage 2 (3): '-1,5' is normalized correctly to '-1.5' — sign preserved, comma converted, byte-for-byte identical to '-1.5' input", () => {
  assert.equal(normalizeLineString("-1,5"), "-1.5");
  assert.equal(normalizeLineString("-1,5"), normalizeLineString("-1.5"));
});

test("Individual Team Totals Stage 2: '+1,5' canonicalizes exactly like '+1.5' already does — leading '+' stripped, comma converted, same output as a bare '1.5'", () => {
  assert.equal(normalizeLineString("+1,5"), "1.5");
  assert.equal(normalizeLineString("+1,5"), normalizeLineString("1.5"));
});

test("Individual Team Totals Stage 2 (4): existing dot decimals are completely unchanged by this stage", () => {
  assert.equal(normalizeLineString("1.5"), "1.5");
  assert.equal(normalizeLineString("2.5"), "2.5");
  assert.equal(normalizeLineString("-1.5"), "-1.5");
});

test("Individual Team Totals Stage 2 (5): whole numbers are unchanged — never coerced into a decimal, comma or otherwise", () => {
  assert.equal(normalizeLineString("2"), "2");
  assert.equal(normalizeLineString("3"), "3");
  assert.equal(normalizeLineString("-2"), "-2");
});

test("Individual Team Totals Stage 2 (9): malformed comma input remains rejected — a comma never widens accepted syntax beyond one single separator", () => {
  for (const malformed of ["1.5,3", "1,5.3", "1,,5", "1,5,5", ",5", "5,", "1,5,", "-,5"]) {
    assert.equal(normalizeLineString(malformed), null, `"${malformed}" must remain rejected`);
  }
});

test("Individual Team Totals Stage 2: comma-decimal trailing-zero canonicalization composes correctly with the H4-B5.6 rule — '1,50' -> '1.5', '2,00' -> '2'", () => {
  assert.equal(normalizeLineString("1,50"), "1.5");
  assert.equal(normalizeLineString("2,00"), "2");
  assert.equal(normalizeLineString("-1,250"), "-1.25");
});

test("Individual Team Totals Stage 2: comma-decimal exact-line safety — '1,25' must never canonicalize the same as '1,5' or '1.5'", () => {
  assert.notEqual(normalizeLineString("1,25"), normalizeLineString("1,5"));
  assert.notEqual(normalizeLineString("1,25"), normalizeLineString("1.5"));
  assert.equal(normalizeLineString("1,25"), "1.25");
});

test("Individual Team Totals Stage 2: comma-decimal signed zero collapses to unsigned '0', same as the dot form already does", () => {
  for (const form of ["0,0", "-0,0", "+0,00"]) {
    assert.equal(normalizeLineString(form), "0", `"${form}" must canonicalize to "0"`);
  }
});

test("Individual Team Totals Stage 2: representation-equivalence matrix now includes comma spellings alongside the existing dot-decimal group", () => {
  const groups: string[][] = [
    ["1.5", "1,5", "+1,50", "1,50"],
    ["-2", "-2,0", "-2.00", "-2,00"],
    ["2.5", "2,5", "+2,5"],
  ];
  for (const group of groups) {
    const canonical = group.map((form) => normalizeLineString(form));
    const first = canonical[0];
    assert.notEqual(first, null);
    for (let i = 1; i < canonical.length; i++) {
      assert.equal(canonical[i], first, `"${group[i]}" must canonicalize identically to "${group[0]}" (got "${canonical[i]}" vs "${first}")`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* H4-B5.6 — trailing fractional zero canonicalization. Root cause fixed:     */
/* a requested line of "-2.0" and a live provider point of -2 (which          */
/* canonicalizes via String(-2) -> "-2", never "-2.0") failed to string-match */
/* even though they are the identical handicap line. String manipulation     */
/* only — no Number()/parseFloat()/Math methods/toFixed() anywhere here.     */
/* -------------------------------------------------------------------------- */

test("H4-B5.6: the exact task specification examples canonicalize precisely as specified", () => {
  const cases: Array<[string, string]> = [
    ["-2.0", "-2"],
    ["-2.00", "-2"],
    ["+2.0", "2"],
    ["2.00", "2"],
    ["-1.50", "-1.5"],
    ["+1.50", "1.5"],
    ["-1.25", "-1.25"],
    ["+0.75", "0.75"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLineString(input), expected, `normalizeLineString("${input}") must be "${expected}"`);
  }
});

test("H4-B5.6: the exact conceptual examples from the stage's own spec", () => {
  const cases: Array<[string, string]> = [
    ["2", "2"],
    ["2.0", "2"],
    ["2.00", "2"],
    ["2.500", "2.5"],
    ["-2.000", "-2"],
    ["-1.250", "-1.25"],
    ["+0.750", "0.75"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeLineString(input), expected);
  }
});

test("H4-B5.6: representation equivalence matrix — every listed form of the same line canonicalizes to the identical string", () => {
  const groups: string[][] = [
    ["-2", "-2.0", "-2.00"],
    ["2", "+2.0", "2.00"],
    ["-1.5", "-1.50", "-1.500"],
    ["1.5", "+1.50"],
    ["-1.25", "-1.250"],
    ["0.75", "+0.750"],
  ];
  for (const group of groups) {
    const canonical = group.map((form) => normalizeLineString(form));
    const first = canonical[0];
    assert.notEqual(first, null);
    for (let i = 1; i < canonical.length; i++) {
      assert.equal(canonical[i], first, `"${group[i]}" must canonicalize identically to "${group[0]}" (got "${canonical[i]}" vs "${first}")`);
    }
  }
});

test("H4-B5.6: a trailing zero in a decimal digit that is NOT at the very end is never stripped — '2.05' stays '2.05', never becomes '2.5'", () => {
  assert.equal(normalizeLineString("2.05"), "2.05");
  assert.equal(normalizeLineString("-1.05"), "-1.05");
});

test("H4-B5.6: exact-line safety — trailing-zero canonicalization must never merge genuinely different quarter/standard lines", () => {
  const distinctPairs: Array<[string, string]> = [
    ["-1.25", "-1.5"],
    ["-0.75", "-0.5"],
    ["2.25", "2.5"],
    ["2.75", "3"],
    ["-1.25", "-1"],
  ];
  for (const [a, b] of distinctPairs) {
    assert.notEqual(normalizeLineString(a), normalizeLineString(b), `"${a}" must never canonicalize the same as "${b}"`);
  }
});

test("H4-B5.6: signed zero collapses to the unsigned canonical '0' — '-0'/'-0.0'/'+0.00' are all the same (no-handicap) line", () => {
  for (const form of ["0", "-0", "+0", "0.0", "-0.0", "+0.00", "0.00"]) {
    assert.equal(normalizeLineString(form), "0", `"${form}" must canonicalize to "0"`);
  }
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

test("Betting Markets V1 Phase 2 review fix: MONEYLINE_2WAY/3WAY with no line at all (undefined) remains valid — line is irrelevant to these markets", () => {
  assert.equal(validateCanonicalSelection(moneyline2Way({ selectionType: "HOME", line: undefined })).ok, true);
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "MONEYLINE_3WAY", selectionType: "DRAW", line: undefined })).ok,
    true,
  );
});

test("validateCanonicalSelection: rejects a malformed line/submittedOdds decimal string", () => {
  assert.equal(
    validateCanonicalSelection(moneyline2Way({ marketType: "TOTALS", selectionType: "OVER", line: "two-point-five" })).ok,
    false,
  );
  assert.equal(validateCanonicalSelection(moneyline2Way({ submittedOdds: "not-a-number" })).ok, false);
});
