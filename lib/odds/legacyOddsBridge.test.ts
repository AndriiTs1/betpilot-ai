import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacySportToCanonical,
  legacyFootballLeagueFromSportString,
  legacySelectionTextToCanonical,
  legacySelectionToCanonicalRequest,
  verificationResultToLegacyOddsCheck,
} from "./legacyOddsBridge";
import { createVerifiedResult, createOddsChangedResult, createFailedResult, createNotCheckedResult } from "./verification";

const CHECKED_AT = "2026-07-24T00:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* legacySportToCanonical                                                     */
/* -------------------------------------------------------------------------- */

test("legacySportToCanonical: generic sport names map to the canonical enum", () => {
  assert.equal(legacySportToCanonical("Football"), "FOOTBALL");
  assert.equal(legacySportToCanonical("football"), "FOOTBALL");
  assert.equal(legacySportToCanonical("soccer"), "FOOTBALL");
  assert.equal(legacySportToCanonical("Basketball"), "BASKETBALL");
  assert.equal(legacySportToCanonical("Tennis"), "TENNIS");
  assert.equal(legacySportToCanonical("hockey"), "ICE_HOCKEY");
  assert.equal(legacySportToCanonical("ice hockey"), "ICE_HOCKEY");
  assert.equal(legacySportToCanonical("american football"), "AMERICAN_FOOTBALL");
  assert.equal(legacySportToCanonical("nfl"), "AMERICAN_FOOTBALL");
});

test("legacySportToCanonical: Cyrillic aliases map correctly (currently-reachable oddsVerifier.ts keys)", () => {
  assert.equal(legacySportToCanonical("футбол"), "FOOTBALL");
  assert.equal(legacySportToCanonical("баскетбол"), "BASKETBALL");
  assert.equal(legacySportToCanonical("теннис"), "TENNIS");
  assert.equal(legacySportToCanonical("хоккей"), "ICE_HOCKEY");
});

test("legacySportToCanonical: an unrecognized sport string maps to UNKNOWN", () => {
  assert.equal(legacySportToCanonical("Cricket"), "UNKNOWN");
  assert.equal(legacySportToCanonical(""), "UNKNOWN");
});

test("legacySportToCanonical: football-league-specific strings still coarsely map to the single FOOTBALL enum bucket (by design, not a regression)", () => {
  // Canonical Sport genuinely has no slot for "which league" — that is a
  // deliberate design constraint of the approved Step 4/5 domain
  // (docs/ODDS_PROVIDER_DESIGN.md Section 3/4), not a bug. This assertion
  // stays true even after the Step 7A compatibility fix: the league
  // distinction oddsVerifier.ts's SPORT_KEY_ALIASES cares about ("la
  // liga" -> soccer_spain_la_liga vs. generic "football" -> soccer_epl)
  // is preserved SEPARATELY via legacyFootballLeagueFromSportString()
  // below, not by this function — see the companion test immediately
  // after this one, and legacySelectionToCanonicalRequest's request-level
  // round-trip tests further down, for proof the distinction is not lost
  // end to end.
  for (const leagueSpecific of ["la liga", "serie a", "bundesliga", "ligue 1", "champions league", "premier league"]) {
    assert.equal(legacySportToCanonical(leagueSpecific), "FOOTBALL");
  }
});

test("legacyFootballLeagueFromSportString: recognized football-league strings produce the correct honest CanonicalLeague", () => {
  assert.deepEqual(legacyFootballLeagueFromSportString("la liga"), { name: "La Liga" });
  assert.deepEqual(legacyFootballLeagueFromSportString("serie a"), { name: "Serie A" });
  assert.deepEqual(legacyFootballLeagueFromSportString("bundesliga"), { name: "Bundesliga" });
  assert.deepEqual(legacyFootballLeagueFromSportString("ligue 1"), { name: "Ligue 1" });
  assert.deepEqual(legacyFootballLeagueFromSportString("champions league"), { name: "UEFA Champions League" });
  assert.deepEqual(legacyFootballLeagueFromSportString("UEFA Champions League"), { name: "UEFA Champions League" });
  assert.deepEqual(legacyFootballLeagueFromSportString("premier league"), { name: "Premier League" });
});

test("legacyFootballLeagueFromSportString: generic football aliases never fabricate a league", () => {
  for (const generic of ["football", "Football", "soccer", "футбол"]) {
    assert.equal(legacyFootballLeagueFromSportString(generic), undefined);
  }
});

test("legacyFootballLeagueFromSportString: an unrecognized or non-football sport string produces no league", () => {
  assert.equal(legacyFootballLeagueFromSportString("europa league"), undefined);
  assert.equal(legacyFootballLeagueFromSportString("basketball"), undefined);
  assert.equal(legacyFootballLeagueFromSportString("cricket"), undefined);
});

test("legacyFootballLeagueFromSportString: whitespace/case normalization works only for exact recognized names", () => {
  assert.deepEqual(legacyFootballLeagueFromSportString("  LA   LIGA  "), { name: "La Liga" });
  assert.equal(legacyFootballLeagueFromSportString("la  liguee"), undefined);
});

/* -------------------------------------------------------------------------- */
/* legacySelectionTextToCanonical                                             */
/* -------------------------------------------------------------------------- */

test("legacySelectionTextToCanonical: 1X2 shorthand and spelling variants classify as HOME/DRAW/AWAY", () => {
  for (const home of ["1", "П1", "p1", "Home", " home "]) {
    const result = legacySelectionTextToCanonical(home);
    assert.equal(result.selectionType, "HOME");
    assert.equal(result.marketType, "MONEYLINE_3WAY");
  }
  for (const draw of ["X", "х", "Draw", "ничья"]) {
    const result = legacySelectionTextToCanonical(draw);
    assert.equal(result.selectionType, "DRAW");
  }
  for (const away of ["2", "П2", "p2", "Away"]) {
    const result = legacySelectionTextToCanonical(away);
    assert.equal(result.selectionType, "AWAY");
  }
});

test("legacySelectionTextToCanonical: combined double-chance notation is NOT classified as a single HOME/DRAW/AWAY token", () => {
  for (const combined of ["1X", "X2", "12"]) {
    const result = legacySelectionTextToCanonical(combined);
    assert.equal(result.selectionType, "PARTICIPANT");
  }
});

test("legacySelectionTextToCanonical: a full team name or any other free text falls back to PARTICIPANT with the raw text preserved verbatim", () => {
  for (const text of ["Real Madrid Win", "Manchester City Win", "Over 2.5", "Carlos Alcaraz"]) {
    const result = legacySelectionTextToCanonical(text);
    assert.equal(result.selectionType, "PARTICIPANT");
    assert.equal(result.marketType, "MONEYLINE_2WAY");
    assert.equal(result.participant?.name, text);
  }
});

/* -------------------------------------------------------------------------- */
/* legacySelectionToCanonicalRequest                                          */
/* -------------------------------------------------------------------------- */

test("request mapping: football HOME selection", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Chelsea", selection: "1", submittedOdds: 2.1 });
  assert.equal(request.selection.sport, "FOOTBALL");
  assert.equal(request.selection.event.name, "Arsenal vs Chelsea");
  assert.equal(request.selection.selectionType, "HOME");
  assert.equal(request.selection.marketType, "MONEYLINE_3WAY");
  assert.equal(request.selection.submittedOdds, "2.1");
});

test("request mapping: football AWAY selection", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Chelsea", selection: "away", submittedOdds: 3.4 });
  assert.equal(request.selection.selectionType, "AWAY");
  assert.equal(request.selection.marketType, "MONEYLINE_3WAY");
});

test("request mapping: football DRAW selection", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Chelsea", selection: "X", submittedOdds: 3.2 });
  assert.equal(request.selection.selectionType, "DRAW");
  assert.equal(request.selection.marketType, "MONEYLINE_3WAY");
});

test("request mapping: basketball PARTICIPANT (team name) selection", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Basketball",
    event: "Lakers vs Celtics",
    selection: "Lakers Win",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.sport, "BASKETBALL");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
  assert.equal(request.selection.participant?.name, "Lakers Win");
});

test("request mapping: tennis PARTICIPANT (player name) selection", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Tennis",
    event: "Carlos Alcaraz vs Novak Djokovic",
    selection: "Carlos Alcaraz",
    submittedOdds: 1.85,
  });
  assert.equal(request.selection.sport, "TENNIS");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
  assert.equal(request.selection.participant?.name, "Carlos Alcaraz");
});

test("request mapping: submitted odds are preserved exactly as a decimal string", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 1.95 });
  assert.equal(request.selection.submittedOdds, "1.95");
});

test("request mapping: no league or provider IDs are ever fabricated for generic football", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 1.95 });
  assert.equal(request.selection.league, undefined);
  assert.equal(request.selection.event.league, undefined);
  assert.equal(request.previouslyResolvedEventReference, undefined);
});

test("request mapping: each recognized football-league sport string produces the correct CanonicalLeague on both selection and event", () => {
  const cases: [string, { name: string }][] = [
    ["La Liga", { name: "La Liga" }],
    ["Serie A", { name: "Serie A" }],
    ["Bundesliga", { name: "Bundesliga" }],
    ["Ligue 1", { name: "Ligue 1" }],
    ["Champions League", { name: "UEFA Champions League" }],
    ["Premier League", { name: "Premier League" }],
  ];
  for (const [sport, expectedLeague] of cases) {
    const request = legacySelectionToCanonicalRequest({ sport, event: "A vs B", selection: "1", submittedOdds: 1.95 });
    assert.deepEqual(request.selection.sport, "FOOTBALL");
    assert.deepEqual(request.selection.league, expectedLeague);
    assert.deepEqual(request.selection.event.league, expectedLeague);
  }
});

test("request mapping: acceptedOdds/currentOdds are never set at request-mapping time", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 1.95 });
  assert.equal("acceptedOdds" in request.selection, false);
  assert.equal("currentOdds" in request.selection, false);
});

test("request mapping: a splittable 'TeamA vs TeamB' event produces two honest, ordered participants", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Chelsea", selection: "1", submittedOdds: 2.0 });
  assert.deepEqual(request.selection.event.participants, [{ name: "Arsenal" }, { name: "Chelsea" }]);
  // Parsed order is preserved, but no home/away claim is asserted — the
  // parsed string never reliably says which team the provider considers
  // "home" (see legacyOddsBridge.ts's own comment).
  assert.equal(request.selection.event.homeParticipantIndex, undefined);
  assert.equal(request.selection.event.awayParticipantIndex, undefined);
});

test("request mapping: 'v'/'-'/'–'/'—' separators are all recognized for participant splitting, same as the vs form", () => {
  for (const event of ["Real Madrid v Barcelona", "Real Madrid - Barcelona", "Real Madrid – Barcelona", "Real Madrid — Barcelona"]) {
    const request = legacySelectionToCanonicalRequest({ sport: "Football", event, selection: "1", submittedOdds: 2.0 });
    assert.deepEqual(request.selection.event.participants, [{ name: "Real Madrid" }, { name: "Barcelona" }]);
  }
});

test("request mapping: an unsplittable event string yields an honestly empty participants list, not a fabricated single participant", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Manchester United Chelsea", selection: "1", submittedOdds: 2.0 });
  assert.deepEqual(request.selection.event.participants, []);
  // The full, unsplit string is still preserved as event.name — this is
  // the field TheOddsApiProvider actually reads for matching.
  assert.equal(request.selection.event.name, "Manchester United Chelsea");
});

test("request mapping: only MONEYLINE_2WAY/MONEYLINE_3WAY are ever produced — never Totals/Spread/BTTS/Double Chance", () => {
  const inputs = ["1", "X", "2", "Real Madrid Win", "Over 2.5", "Both teams to score", "-1.5"];
  for (const selection of inputs) {
    const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection, submittedOdds: 2.0 });
    assert.ok(["MONEYLINE_2WAY", "MONEYLINE_3WAY"].includes(request.selection.marketType));
  }
});

/* -------------------------------------------------------------------------- */
/* verificationResultToLegacyOddsCheck                                        */
/* -------------------------------------------------------------------------- */

test("result mapping: VERIFIED reconstructs matched:true, withinTolerance:true", () => {
  const result = createVerifiedResult({ submittedOdds: "2.15", currentOdds: "2.10", differencePercentage: "2.38", bookmaker: "Pinnacle", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.deepEqual(oddsCheck, {
    matched: true,
    withinTolerance: true,
    sourceOdds: 2.1,
    submittedOdds: 2.15,
    discrepancyPercent: 2.38,
    bookmaker: "Pinnacle",
    note: null,
  });
});

test("result mapping: ODDS_CHANGED reconstructs matched:true, withinTolerance:false", () => {
  const result = createOddsChangedResult({ submittedOdds: "2.15", currentOdds: "1.5", differencePercentage: "43.33", bookmaker: "Pinnacle", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { oddsCheck } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(oddsCheck?.matched, true);
  assert.equal(oddsCheck?.withinTolerance, false);
  assert.equal(oddsCheck?.sourceOdds, 1.5);
});

test("result mapping: FAILED/EVENT_NOT_FOUND reconstructs matched:false (not exception-mapped)", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.withinTolerance, null);
  assert.equal(oddsCheck?.sourceOdds, null);
});

test("result mapping: FAILED/SELECTION_NOT_FOUND reconstructs matched:false and preserves bookmaker if present", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "SELECTION_NOT_FOUND", bookmaker: "Bet365" });
  const { oddsCheck } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.bookmaker, "Bet365");
});

test("result mapping: FAILED/SPORT_NOT_SUPPORTED reconstructs matched:false", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "SPORT_NOT_SUPPORTED" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
});

test("result mapping: FAILED/PROVIDER_TIMEOUT (a real, returned legacy failure) reconstructs matched:false, NOT exception-mapped", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_TIMEOUT", diagnosticCode: "LEGACY_FETCH_TIMEOUT" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
});

test("result mapping: FAILED/PROVIDER_UNAVAILABLE from a normal legacy note (not a thrown exception) reconstructs matched:false, NOT exception-mapped", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_API_KEY_MISSING" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
});

test("result mapping: FAILED/PROVIDER_UNAVAILABLE with diagnosticCode ODDS_PROVIDER_UNEXPECTED_ERROR (a thrown verifyOddsFn) reconstructs oddsCheck: null, exception-mapped", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "ODDS_PROVIDER_UNEXPECTED_ERROR" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, true);
  assert.equal(oddsCheck, null);
});

test("result mapping: NOT_CHECKED reconstructs matched:false", () => {
  const result = createNotCheckedResult({ submittedOdds: null, provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
});

test("result mapping: note is always reconstructed as null (fetched-but-never-read downstream)", () => {
  const verified = verificationResultToLegacyOddsCheck(
    createVerifiedResult({ submittedOdds: "2.0", currentOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT }),
    2.0,
  );
  const failed = verificationResultToLegacyOddsCheck(
    createFailedResult({ submittedOdds: "2.0", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" }),
    2.0,
  );
  assert.equal(verified.oddsCheck?.note, null);
  assert.equal(failed.oddsCheck?.note, null);
});
