import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDraftSport,
  normalizeDraftLeague,
  splitDraftEventParticipants,
  normalizeScheduledStartTime,
  normalizeDraftMarket,
  normalizeDraftSelection,
  normalizeDraftPeriod,
  normalizeDecimalString,
  normalizeDraftLine,
} from "./normalize";

/* -------------------------------------------------------------------------- */
/* Sport                                                                       */
/* -------------------------------------------------------------------------- */

test("normalizeDraftSport: current aliases resolve to the correct canonical Sport", () => {
  assert.deepEqual(normalizeDraftSport("Football"), { state: "EXTRACTED", value: "FOOTBALL", rawText: "Football" });
  assert.equal(normalizeDraftSport("soccer").value, "FOOTBALL");
  assert.equal(normalizeDraftSport("футбол").value, "FOOTBALL");
  assert.equal(normalizeDraftSport("Basketball").value, "BASKETBALL");
  assert.equal(normalizeDraftSport("баскетбол").value, "BASKETBALL");
  assert.equal(normalizeDraftSport("nba").value, "BASKETBALL");
  assert.equal(normalizeDraftSport("Tennis").value, "TENNIS");
  assert.equal(normalizeDraftSport("теннис").value, "TENNIS");
  assert.equal(normalizeDraftSport("atp").value, "TENNIS");
  assert.equal(normalizeDraftSport("wta").value, "TENNIS");
  assert.equal(normalizeDraftSport("hockey").value, "ICE_HOCKEY");
  assert.equal(normalizeDraftSport("ice hockey").value, "ICE_HOCKEY");
  assert.equal(normalizeDraftSport("хоккей").value, "ICE_HOCKEY");
  assert.equal(normalizeDraftSport("nhl").value, "ICE_HOCKEY");
  assert.equal(normalizeDraftSport("american football").value, "AMERICAN_FOOTBALL");
  assert.equal(normalizeDraftSport("nfl").value, "AMERICAN_FOOTBALL");
});

test("normalizeDraftSport: deferred recognized sports return UNSUPPORTED, not guessed", () => {
  for (const deferred of ["cricket", "rugby", "esports", "mma", "boxing", "volleyball", "baseball", "golf"]) {
    const field = normalizeDraftSport(deferred);
    assert.equal(field.state, "UNSUPPORTED");
    assert.equal(field.value, null);
    assert.equal(field.rawText, deferred);
  }
});

test("normalizeDraftSport: unrecognized text returns UNKNOWN, preserving rawText", () => {
  const field = normalizeDraftSport("quidditch");
  assert.equal(field.state, "UNKNOWN");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "quidditch");
});

test("normalizeDraftSport: absent/blank text returns MISSING", () => {
  assert.equal(normalizeDraftSport(null).state, "MISSING");
  assert.equal(normalizeDraftSport(undefined).state, "MISSING");
  assert.equal(normalizeDraftSport("   ").state, "MISSING");
});

test("normalizeDraftSport: league text in a sport slot is never guessed into FOOTBALL by this function alone", () => {
  const field = normalizeDraftSport("La Liga");
  assert.equal(field.state, "UNKNOWN");
});

/* -------------------------------------------------------------------------- */
/* League                                                                      */
/* -------------------------------------------------------------------------- */

test("normalizeDraftLeague: the six approved football league names resolve exactly", () => {
  assert.deepEqual(normalizeDraftLeague("La Liga", "FOOTBALL").value, { rawText: "La Liga", resolvedName: "La Liga" });
  assert.deepEqual(normalizeDraftLeague("Serie A", "FOOTBALL").value, { rawText: "Serie A", resolvedName: "Serie A" });
  assert.deepEqual(normalizeDraftLeague("Bundesliga", "FOOTBALL").value, { rawText: "Bundesliga", resolvedName: "Bundesliga" });
  assert.deepEqual(normalizeDraftLeague("Ligue 1", "FOOTBALL").value, { rawText: "Ligue 1", resolvedName: "Ligue 1" });
  assert.deepEqual(normalizeDraftLeague("Champions League", "FOOTBALL").value, {
    rawText: "Champions League",
    resolvedName: "UEFA Champions League",
  });
  assert.deepEqual(normalizeDraftLeague("Premier League", "FOOTBALL").value, {
    rawText: "Premier League",
    resolvedName: "Premier League",
  });
});

test("normalizeDraftLeague: Champions League naming variant (UEFA Champions League) resolves to the same name", () => {
  const field = normalizeDraftLeague("UEFA Champions League", "FOOTBALL");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value?.resolvedName, "UEFA Champions League");
});

test("normalizeDraftLeague: EPL is unresolved — UNKNOWN, rawText preserved, no fabricated resolution", () => {
  const field = normalizeDraftLeague("EPL", "FOOTBALL");
  assert.equal(field.state, "UNKNOWN");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "EPL");
});

test("normalizeDraftLeague: England Premier League is unresolved — UNKNOWN, rawText preserved", () => {
  const field = normalizeDraftLeague("England Premier League", "FOOTBALL");
  assert.equal(field.state, "UNKNOWN");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "England Premier League");
});

test("normalizeDraftLeague: exact-match normalization tolerates case and whitespace, never fuzzy matches", () => {
  assert.equal(normalizeDraftLeague("  LA   LIGA  ", "FOOTBALL").value?.resolvedName, "La Liga");
  assert.equal(normalizeDraftLeague("la liga", "FOOTBALL").value?.resolvedName, "La Liga");
  // A near-miss must NOT resolve — proves this is exact lookup, not fuzzy.
  assert.equal(normalizeDraftLeague("la ligue", "FOOTBALL").state, "UNKNOWN");
  assert.equal(normalizeDraftLeague("la  ligaa", "FOOTBALL").state, "UNKNOWN");
});

test("normalizeDraftLeague: no sport_key or other provider identifier ever appears in the resolved value", () => {
  const field = normalizeDraftLeague("La Liga", "FOOTBALL");
  const serialized = JSON.stringify(field);
  assert.doesNotMatch(serialized, /^.*soccer_.*$/);
});

test("normalizeDraftLeague: NBA/NHL are preserved as raw league text without a claimed resolution", () => {
  const nba = normalizeDraftLeague("NBA", "BASKETBALL");
  assert.equal(nba.state, "UNKNOWN");
  assert.equal(nba.value, null);
  assert.equal(nba.rawText, "NBA");

  const nhl = normalizeDraftLeague("NHL", "ICE_HOCKEY");
  assert.equal(nhl.state, "UNKNOWN");
  assert.equal(nhl.rawText, "NHL");
});

test("normalizeDraftLeague: ATP Rome is UNSUPPORTED, never treated as a football-style league", () => {
  const field = normalizeDraftLeague("ATP Rome", "TENNIS");
  assert.equal(field.state, "UNSUPPORTED");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "ATP Rome");
});

test("normalizeDraftLeague: absent league text returns MISSING", () => {
  assert.equal(normalizeDraftLeague(null, "FOOTBALL").state, "MISSING");
  assert.equal(normalizeDraftLeague("", "FOOTBALL").state, "MISSING");
});

/* -------------------------------------------------------------------------- */
/* Event participant splitting                                                */
/* -------------------------------------------------------------------------- */

test("splitDraftEventParticipants: 'vs' separator splits into two ordered participants", () => {
  assert.deepEqual(splitDraftEventParticipants("Arsenal vs Chelsea"), [
    { index: 0, rawName: "Arsenal" },
    { index: 1, rawName: "Chelsea" },
  ]);
});

test("splitDraftEventParticipants: 'v' separator splits correctly", () => {
  assert.deepEqual(splitDraftEventParticipants("Arsenal v Chelsea"), [
    { index: 0, rawName: "Arsenal" },
    { index: 1, rawName: "Chelsea" },
  ]);
});

test("splitDraftEventParticipants: hyphen separator splits correctly", () => {
  assert.deepEqual(splitDraftEventParticipants("Real Madrid - Barcelona"), [
    { index: 0, rawName: "Real Madrid" },
    { index: 1, rawName: "Barcelona" },
  ]);
});

test("splitDraftEventParticipants: en dash separator splits correctly", () => {
  assert.deepEqual(splitDraftEventParticipants("Real Madrid – Barcelona"), [
    { index: 0, rawName: "Real Madrid" },
    { index: 1, rawName: "Barcelona" },
  ]);
});

test("splitDraftEventParticipants: em dash separator splits correctly", () => {
  assert.deepEqual(splitDraftEventParticipants("Real Madrid — Barcelona"), [
    { index: 0, rawName: "Real Madrid" },
    { index: 1, rawName: "Barcelona" },
  ]);
});

test("splitDraftEventParticipants: an internal hyphen inside a team name (Saint-Étienne) is never split", () => {
  assert.deepEqual(splitDraftEventParticipants("Saint-Étienne vs Marseille"), [
    { index: 0, rawName: "Saint-Étienne" },
    { index: 1, rawName: "Marseille" },
  ]);
});

test("splitDraftEventParticipants: an unsplittable event (no recognized separator) yields empty participants", () => {
  assert.deepEqual(splitDraftEventParticipants("Manchester United Chelsea"), []);
});

test("splitDraftEventParticipants: a slash separator remains unsplit (documented Step 8 limitation, not fixed here)", () => {
  assert.deepEqual(splitDraftEventParticipants("Nadal / Alcaraz"), []);
});

test("splitDraftEventParticipants: more than two sides is rejected to empty, never guessed", () => {
  assert.deepEqual(splitDraftEventParticipants("A vs B vs C"), []);
});

/* -------------------------------------------------------------------------- */
/* Scheduled start time                                                       */
/* -------------------------------------------------------------------------- */

test("normalizeScheduledStartTime: explicit local datetime + Europe/Zurich preserves the timezone (bracket notation)", () => {
  const field = normalizeScheduledStartTime("2026-08-14 15:00 Europe/Zurich");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, "2026-08-14T15:00:00[Europe/Zurich]");
});

test("normalizeScheduledStartTime: no Z suffix is ever fabricated for a named-zone input", () => {
  const field = normalizeScheduledStartTime("2026-08-14 15:00 Europe/Zurich");
  assert.equal(field.value?.endsWith("Z"), false);
});

test("normalizeScheduledStartTime: no numeric UTC offset is ever fabricated for a named-zone input", () => {
  const field = normalizeScheduledStartTime("2026-08-14 15:00 Europe/Zurich");
  assert.doesNotMatch(field.value ?? "", /[+-]\d{2}:\d{2}$/);
});

test("normalizeScheduledStartTime: an explicit numeric UTC offset is accepted as a validated ISO-8601 offset datetime", () => {
  const field = normalizeScheduledStartTime("2026-08-14T15:00:00+02:00");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, "2026-08-14T15:00:00+02:00");
});

test("normalizeScheduledStartTime: a negative numeric UTC offset is also accepted", () => {
  const field = normalizeScheduledStartTime("2026-08-14T15:00:00-05:00");
  assert.equal(field.value, "2026-08-14T15:00:00-05:00");
});

test("normalizeScheduledStartTime: 'Saturday 3pm' never becomes an ISO timestamp", () => {
  const field = normalizeScheduledStartTime("Saturday 3pm");
  assert.equal(field.state, "UNKNOWN");
  assert.equal(field.value, null);
  assert.equal(field.rawText, "Saturday 3pm");
});

test("normalizeScheduledStartTime: '14 August 3pm' (no year, informal) is UNKNOWN", () => {
  assert.equal(normalizeScheduledStartTime("14 August 3pm").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: date and time without any timezone/offset is UNKNOWN, never defaulted", () => {
  assert.equal(normalizeScheduledStartTime("2026-08-14 15:00").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: timezone and time without a date is UNKNOWN", () => {
  assert.equal(normalizeScheduledStartTime("15:00 Europe/Zurich").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: an invalid calendar date (month 13, hour 25, minute 99) is rejected, never rolled over", () => {
  assert.equal(normalizeScheduledStartTime("2026-13-40 25:99 Europe/Zurich").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: an invalid day for the given month (April 31) is rejected", () => {
  assert.equal(normalizeScheduledStartTime("2026-04-31 15:00 Europe/Zurich").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: a valid leap day (2028-02-29, 2028 is a leap year) is EXTRACTED", () => {
  const field = normalizeScheduledStartTime("2028-02-29 15:00 Europe/Zurich");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, "2028-02-29T15:00:00[Europe/Zurich]");
});

test("normalizeScheduledStartTime: an invalid leap day (2026-02-29, 2026 is not a leap year) is rejected", () => {
  assert.equal(normalizeScheduledStartTime("2026-02-29 15:00 Europe/Zurich").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: malformed IANA-zone syntax (no Area/Location slash) is rejected", () => {
  assert.equal(normalizeScheduledStartTime("2026-08-14 15:00 Zurich").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: a syntactically-plausible but non-existent IANA zone is rejected (zone identity is verified, not just syntax)", () => {
  // "Foo/Bar" matches the Area/Location shape but is not a real IANA zone
  // — this proves isRecognizedIanaZone() checks real zone identity via
  // Intl.DateTimeFormat, not merely the regex shape.
  assert.equal(normalizeScheduledStartTime("2026-08-14 15:00 Foo/Bar").state, "UNKNOWN");
});

test("normalizeScheduledStartTime: a real multi-segment IANA zone (America/Argentina/Buenos_Aires) is accepted", () => {
  const field = normalizeScheduledStartTime("2026-08-14 15:00 America/Argentina/Buenos_Aires");
  assert.equal(field.state, "EXTRACTED");
  assert.equal(field.value, "2026-08-14T15:00:00[America/Argentina/Buenos_Aires]");
});

test("normalizeScheduledStartTime: explicit non-zero seconds are preserved exactly, never dropped", () => {
  const field = normalizeScheduledStartTime("2026-08-14 15:00:37 Europe/Zurich");
  assert.equal(field.value, "2026-08-14T15:00:37[Europe/Zurich]");
});

test("normalizeScheduledStartTime: source rawText is preserved exactly on both EXTRACTED and UNKNOWN results", () => {
  const extracted = normalizeScheduledStartTime("  2026-08-14 15:00 Europe/Zurich  ");
  assert.equal(extracted.rawText, "2026-08-14 15:00 Europe/Zurich");

  const unknown = normalizeScheduledStartTime("  Saturday 3pm  ");
  assert.equal(unknown.rawText, "Saturday 3pm");
});

test("normalizeScheduledStartTime: absent text returns MISSING", () => {
  assert.equal(normalizeScheduledStartTime(null).state, "MISSING");
  assert.equal(normalizeScheduledStartTime("").state, "MISSING");
});

/* -------------------------------------------------------------------------- */
/* Market                                                                      */
/* -------------------------------------------------------------------------- */

test("normalizeDraftMarket: every MVP canonical market resolves via its closed alias", () => {
  assert.equal(normalizeDraftMarket("1X2").value, "MONEYLINE_3WAY");
  assert.equal(normalizeDraftMarket("Match Winner").value, "MONEYLINE_2WAY");
  assert.equal(normalizeDraftMarket("Moneyline").value, "MONEYLINE_2WAY");
  assert.equal(normalizeDraftMarket("Double Chance").value, "DOUBLE_CHANCE");
  assert.equal(normalizeDraftMarket("Totals").value, "TOTALS");
  assert.equal(normalizeDraftMarket("Handicap").value, "SPREAD");
  assert.equal(normalizeDraftMarket("Spread").value, "SPREAD");
  assert.equal(normalizeDraftMarket("Both Teams to Score").value, "BOTH_TEAMS_TO_SCORE");
  assert.equal(normalizeDraftMarket("BTTS").value, "BOTH_TEAMS_TO_SCORE");
});

test("normalizeDraftMarket: a deferred recognized market resolves to its enum value but state UNSUPPORTED, never actionable", () => {
  for (const [text, expectedEnum] of [
    ["Player Prop", "PLAYER_PROP"],
    ["Team Total", "TEAM_TOTAL"],
    ["Correct Score", "EXACT_SCORE"],
    ["Draw No Bet", "DRAW_NO_BET"],
    ["Outright", "OUTRIGHT"],
  ] as const) {
    const field = normalizeDraftMarket(text);
    assert.equal(field.state, "UNSUPPORTED");
    assert.equal(field.value, null, `${text} must not carry a value even though ${expectedEnum} is recognized`);
    assert.equal(field.rawText, text);
  }
});

test("normalizeDraftMarket: unrecognized text remains UNKNOWN", () => {
  const field = normalizeDraftMarket("Special Bookmaker Combo Bet");
  assert.equal(field.state, "UNKNOWN");
});

test("normalizeDraftMarket: absent text returns MISSING", () => {
  assert.equal(normalizeDraftMarket(null).state, "MISSING");
});

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

test("normalizeDraftSelection: home/draw/away tokens classify correctly", () => {
  assert.equal(normalizeDraftSelection("1", "MONEYLINE_3WAY", []).selectionType.value, "HOME");
  assert.equal(normalizeDraftSelection("П1", "MONEYLINE_3WAY", []).selectionType.value, "HOME");
  assert.equal(normalizeDraftSelection("X", "MONEYLINE_3WAY", []).selectionType.value, "DRAW");
  assert.equal(normalizeDraftSelection("ничья", "MONEYLINE_3WAY", []).selectionType.value, "DRAW");
  assert.equal(normalizeDraftSelection("2", "MONEYLINE_3WAY", []).selectionType.value, "AWAY");
  assert.equal(normalizeDraftSelection("away", "MONEYLINE_3WAY", []).selectionType.value, "AWAY");
});

test("normalizeDraftSelection: yes/no tokens classify correctly", () => {
  assert.equal(normalizeDraftSelection("yes", "BOTH_TEAMS_TO_SCORE", []).selectionType.value, "YES");
  assert.equal(normalizeDraftSelection("да", "BOTH_TEAMS_TO_SCORE", []).selectionType.value, "YES");
  assert.equal(normalizeDraftSelection("no", "BOTH_TEAMS_TO_SCORE", []).selectionType.value, "NO");
  assert.equal(normalizeDraftSelection("нет", "BOTH_TEAMS_TO_SCORE", []).selectionType.value, "NO");
});

test("normalizeDraftSelection: over/under tokens classify correctly", () => {
  assert.equal(normalizeDraftSelection("Over", "TOTALS", []).selectionType.value, "OVER");
  assert.equal(normalizeDraftSelection("Under", "TOTALS", []).selectionType.value, "UNDER");
});

test("normalizeDraftSelection: double-chance tokens classify correctly", () => {
  assert.equal(normalizeDraftSelection("1X", "DOUBLE_CHANCE", []).selectionType.value, "HOME_OR_DRAW");
  assert.equal(normalizeDraftSelection("X2", "DOUBLE_CHANCE", []).selectionType.value, "DRAW_OR_AWAY");
  assert.equal(normalizeDraftSelection("12", "DOUBLE_CHANCE", []).selectionType.value, "HOME_OR_AWAY");
});

test("normalizeDraftSelection: an exact participant-name match resolves to an INDEX reference", () => {
  const participants = [
    { index: 0, rawName: "Real Madrid" },
    { index: 1, rawName: "Barcelona" },
  ];
  const result = normalizeDraftSelection("Real Madrid", "MONEYLINE_2WAY", participants);
  assert.equal(result.selectionType.value, "PARTICIPANT");
  assert.deepEqual(result.participant, { kind: "INDEX", participantIndex: 0 });
});

test("normalizeDraftSelection: an unresolved participant name is preserved as RAW_TEXT, never fuzzy-matched", () => {
  const participants = [
    { index: 0, rawName: "Real Madrid" },
    { index: 1, rawName: "Barcelona" },
  ];
  const result = normalizeDraftSelection("Real Madrid Win", "MONEYLINE_2WAY", participants);
  assert.equal(result.selectionType.value, "PARTICIPANT");
  assert.deepEqual(result.participant, { kind: "RAW_TEXT", rawName: "Real Madrid Win" });
});

test("normalizeDraftSelection: free text under an unsupported market is never classified as PARTICIPANT (not made actionable)", () => {
  const result = normalizeDraftSelection("Ronaldo to score anytime", "PLAYER_PROP", []);
  assert.equal(result.selectionType.state, "UNKNOWN");
  assert.equal(result.participant, null);
});

test("normalizeDraftSelection: free text with no market at all is never classified as PARTICIPANT", () => {
  const result = normalizeDraftSelection("Some free text", undefined, []);
  assert.equal(result.selectionType.state, "UNKNOWN");
  assert.equal(result.participant, null);
});

/* -------------------------------------------------------------------------- */
/* Period                                                                      */
/* -------------------------------------------------------------------------- */

test("normalizeDraftPeriod: every existing supported Period resolves", () => {
  assert.equal(normalizeDraftPeriod("Full Game").value, "FULL_GAME");
  assert.equal(normalizeDraftPeriod("Regulation").value, "REGULATION");
  assert.equal(normalizeDraftPeriod("First Half").value, "FIRST_HALF");
  assert.equal(normalizeDraftPeriod("Second Half").value, "SECOND_HALF");
  assert.equal(normalizeDraftPeriod("First Quarter").value, "FIRST_QUARTER");
  assert.equal(normalizeDraftPeriod("Match").value, "MATCH");
  assert.equal(normalizeDraftPeriod("Set").value, "SET");
});

test("normalizeDraftPeriod: missing period is MISSING, never defaulted to FULL_GAME", () => {
  const field = normalizeDraftPeriod(null);
  assert.equal(field.state, "MISSING");
  assert.notEqual(field.value, "FULL_GAME");
});

test("normalizeDraftPeriod: unrecognized text is UNKNOWN", () => {
  assert.equal(normalizeDraftPeriod("Third Quarter").state, "UNKNOWN");
});

/* -------------------------------------------------------------------------- */
/* Decimal values                                                             */
/* -------------------------------------------------------------------------- */

test("normalizeDecimalString: plain and signed decimals normalize correctly", () => {
  assert.equal(normalizeDecimalString("2.5"), "2.5");
  assert.equal(normalizeDecimalString("-0.5"), "-0.5");
  assert.equal(normalizeDecimalString("+4.5"), "4.5");
  assert.equal(normalizeDecimalString("3"), "3");
  assert.equal(normalizeDecimalString("0"), "0");
});

test("normalizeDecimalString: decimal comma normalizes to a dot, without rounding", () => {
  assert.equal(normalizeDecimalString("2,5"), "2.5");
  assert.equal(normalizeDecimalString("1,95"), "1.95");
});

test("normalizeDecimalString: malformed input (multiple separators) is rejected", () => {
  assert.equal(normalizeDecimalString("1.234.5"), null);
  assert.equal(normalizeDecimalString("1,234,5"), null);
  assert.equal(normalizeDecimalString("1,2.5"), null);
});

test("normalizeDecimalString: empty numeric content is rejected", () => {
  assert.equal(normalizeDecimalString(""), null);
  assert.equal(normalizeDecimalString("   "), null);
});

test("normalizeDecimalString: non-numeric text is rejected", () => {
  assert.equal(normalizeDecimalString("abc"), null);
  assert.equal(normalizeDecimalString("2.5x"), null);
});

test("normalizeDecimalString: Infinity-like input is rejected, never returned as a string", () => {
  assert.equal(normalizeDecimalString("Infinity"), null);
  assert.equal(normalizeDecimalString("-Infinity"), null);
  assert.equal(normalizeDecimalString("NaN"), null);
});

/* -------------------------------------------------------------------------- */
/* Line                                                                        */
/* -------------------------------------------------------------------------- */

test("normalizeDraftLine: 'Over 2.5' produces the documented representation", () => {
  const field = normalizeDraftLine("Over 2.5");
  assert.equal(field.state, "EXTRACTED");
  assert.deepEqual(field.value, { rawText: "2.5", magnitude: "2.5", direction: "OVER" });
});

test("normalizeDraftLine: 'Under 3' produces the documented representation", () => {
  const field = normalizeDraftLine("Under 3");
  assert.deepEqual(field.value, { rawText: "3", magnitude: "3", direction: "UNDER" });
});

test("normalizeDraftLine: '-0.5' produces the documented representation", () => {
  const field = normalizeDraftLine("-0.5");
  assert.deepEqual(field.value, { rawText: "-0.5", magnitude: "0.5", direction: "MINUS" });
});

test("normalizeDraftLine: '+4.5' produces the documented representation", () => {
  const field = normalizeDraftLine("+4.5");
  assert.deepEqual(field.value, { rawText: "+4.5", magnitude: "4.5", direction: "PLUS" });
});

test("normalizeDraftLine: a bare number with no explicit side has direction NONE", () => {
  const field = normalizeDraftLine("2.5");
  assert.deepEqual(field.value, { rawText: "2.5", magnitude: "2.5", direction: "NONE" });
});

test("normalizeDraftLine: decimal comma is normalized into magnitude, while rawText preserves the original literal source", () => {
  const field = normalizeDraftLine("Over 2,5");
  // magnitude must be the normalized, dot-separated, ready-to-use decimal
  // — rawText, per this file's own "preserves the original source
  // representation" rule, keeps the comma exactly as written.
  assert.deepEqual(field.value, { rawText: "2,5", magnitude: "2.5", direction: "OVER" });
});

test("normalizeDraftLine: zero is represented without a spurious sign", () => {
  const field = normalizeDraftLine("0");
  assert.deepEqual(field.value, { rawText: "0", magnitude: "0", direction: "NONE" });
});

test("normalizeDraftLine: malformed numeric content returns UNKNOWN, not a fabricated line", () => {
  assert.equal(normalizeDraftLine("Over abc").state, "UNKNOWN");
  assert.equal(normalizeDraftLine("Over").state, "UNKNOWN");
});

test("normalizeDraftLine: Infinity-like input returns UNKNOWN, never a line with an infinite magnitude", () => {
  assert.equal(normalizeDraftLine("Over Infinity").state, "UNKNOWN");
});

test("normalizeDraftLine: the same sign is never encoded in both magnitude and direction", () => {
  const field = normalizeDraftLine("-0.5");
  if (field.state === "EXTRACTED") {
    assert.doesNotMatch(field.value.magnitude, /^-/);
    assert.equal(field.value.direction, "MINUS");
  }
});

test("normalizeDraftLine: absent text returns MISSING", () => {
  assert.equal(normalizeDraftLine(null).state, "MISSING");
  assert.equal(normalizeDraftLine("").state, "MISSING");
});
