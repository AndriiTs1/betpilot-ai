import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacySportToCanonical,
  legacyFootballLeagueFromSportString,
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
/* legacySelectionToCanonicalRequest                                          */
/* -------------------------------------------------------------------------- */
//
// Stage BA-2A — the legacySelectionTextToCanonical()-specific unit tests
// that used to live here now live in lib/odds/shorthandClassifier.test.ts,
// testing the shared classifier that (now-removed) function was replaced
// by. What remains below tests legacySelectionToCanonicalRequest() itself.

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
  // Step 16A — winner-suffix stripping applies uniformly, not just to
  // football: "Lakers Win" -> "Lakers", the actual searchable name.
  const request = legacySelectionToCanonicalRequest({
    sport: "Basketball",
    event: "Lakers vs Celtics",
    selection: "Lakers Win",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.sport, "BASKETBALL");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
  assert.equal(request.selection.participant?.name, "Lakers");
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

test("request mapping: only MONEYLINE_2WAY/MONEYLINE_3WAY/TOTALS are ever produced — never Spread/BTTS/Double Chance (Betting Markets V1 Phase 3.2 — Totals now intentionally classifies, everything else still doesn't)", () => {
  const moneylineInputs = ["1", "X", "2", "Real Madrid Win", "Both teams to score", "-1.5"];
  for (const selection of moneylineInputs) {
    const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection, submittedOdds: 2.0 });
    assert.ok(
      ["MONEYLINE_2WAY", "MONEYLINE_3WAY"].includes(request.selection.marketType),
      `"${selection}" must not classify as TOTALS`,
    );
  }

  // "Over 2.5" moved out of the moneyline-only set above — this is the
  // Phase 3.2 change itself, not a regression: it now correctly classifies
  // as TOTALS instead of falling back to an opaque PARTICIPANT selection.
  const totalsRequest = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 2.0 });
  assert.equal(totalsRequest.selection.marketType, "TOTALS");
});

/* -------------------------------------------------------------------------- */
/* request mapping: line — Betting Markets V1 Phase 2 (+ review fix)          */
/* -------------------------------------------------------------------------- */

test("request mapping: a '+1.5' line is canonicalized to '1.5' (redundant leading '+' stripped, never rejected)", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry City",
    selection: "Coventry",
    submittedOdds: 1.9,
    line: "+1.5",
  });
  assert.equal(request.selection.line, "1.5");
});

test("request mapping: a '-1.5' line passes through unchanged", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry City",
    selection: "Arsenal",
    submittedOdds: 1.9,
    line: "-1.5",
  });
  assert.equal(request.selection.line, "-1.5");
});

test("request mapping: a '2.5' line (already canonical, unsigned) passes through unchanged", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry City",
    selection: "Over",
    submittedOdds: 1.9,
    line: "2.5",
  });
  assert.equal(request.selection.line, "2.5");
});

test("request mapping: null/undefined line is omitted (undefined), never fabricated", () => {
  const withNull = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 2.0, line: null });
  const withoutField = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 2.0 });
  assert.equal(withNull.selection.line, undefined);
  assert.equal(withoutField.selection.line, undefined);
});

test("request mapping: a genuinely malformed line is passed through unchanged (not silently dropped), so validateCanonicalSelection's own decimal-string check still rejects it downstream", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "A vs B",
    selection: "1",
    submittedOdds: 2.0,
    line: "not-a-number",
  });
  assert.equal(request.selection.line, "not-a-number");
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
    // Stage 3.1 — undefined: this fixture's VerificationResult carries no
    // matchedEvent (the createVerifiedResult() call above doesn't supply
    // one), so there is nothing honest to reconstruct these from.
    providerEventId: undefined,
    providerSportKey: undefined,
    eventStartTime: undefined,
    homeTeamName: undefined,
    awayTeamName: undefined,
    competitionName: undefined,
    // Stage 4.2B1 — createVerifiedResult() always sets reasonCode "NONE".
    reasonCode: "NONE",
  });
});

test("result mapping: ODDS_CHANGED reconstructs matched:true, withinTolerance:false", () => {
  const result = createOddsChangedResult({ submittedOdds: "2.15", currentOdds: "1.5", differencePercentage: "43.33", bookmaker: "Pinnacle", provider: "THE_ODDS_API", checkedAt: CHECKED_AT });
  const { oddsCheck } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(oddsCheck?.matched, true);
  assert.equal(oddsCheck?.withinTolerance, false);
  assert.equal(oddsCheck?.sourceOdds, 1.5);
  assert.equal(oddsCheck?.reasonCode, "ODDS_OUTSIDE_TOLERANCE");
});

test("result mapping: FAILED/EVENT_NOT_FOUND reconstructs matched:false (not exception-mapped)", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "EVENT_NOT_FOUND" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.withinTolerance, null);
  assert.equal(oddsCheck?.sourceOdds, null);
  // Stage 4.2B1 — the whole point of this stage: a real "not found" reason
  // must survive the bridge, not be silently dropped to null/undefined.
  assert.equal(oddsCheck?.reasonCode, "EVENT_NOT_FOUND");
});

test("result mapping: FAILED/SELECTION_NOT_FOUND reconstructs matched:false and preserves bookmaker if present", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "SELECTION_NOT_FOUND", bookmaker: "Bet365" });
  const { oddsCheck } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.bookmaker, "Bet365");
  assert.equal(oddsCheck?.reasonCode, "SELECTION_NOT_FOUND");
});

test("result mapping: FAILED/SPORT_NOT_SUPPORTED reconstructs matched:false", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "SPORT_NOT_SUPPORTED" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.reasonCode, "SPORT_NOT_SUPPORTED");
});

test("result mapping: FAILED/PROVIDER_TIMEOUT (a real, returned legacy failure) reconstructs matched:false, NOT exception-mapped", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_TIMEOUT", diagnosticCode: "LEGACY_FETCH_TIMEOUT" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  // Stage 4.2B1 — root cause fix: this technical failure reason must reach
  // the caller now, instead of being indistinguishable from EVENT_NOT_FOUND.
  assert.equal(oddsCheck?.reasonCode, "PROVIDER_TIMEOUT");
});

test("result mapping: FAILED/PROVIDER_UNAVAILABLE from a normal legacy note (not a thrown exception) reconstructs matched:false, NOT exception-mapped", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_UNAVAILABLE", diagnosticCode: "LEGACY_FETCH_API_KEY_MISSING" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.reasonCode, "PROVIDER_UNAVAILABLE");
});

test("result mapping: FAILED/PROVIDER_INVALID_RESPONSE reconstructs matched:false and preserves the reason", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_INVALID_RESPONSE" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.reasonCode, "PROVIDER_INVALID_RESPONSE");
});

test("result mapping: FAILED/PROVIDER_RATE_LIMITED reconstructs matched:false and preserves the reason", () => {
  const result = createFailedResult({ submittedOdds: "2.15", provider: "THE_ODDS_API", checkedAt: CHECKED_AT, reasonCode: "PROVIDER_RATE_LIMITED" });
  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result, 2.15);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.reasonCode, "PROVIDER_RATE_LIMITED");
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
  assert.equal(oddsCheck?.reasonCode, "NOT_CHECKED");
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

/* -------------------------------------------------------------------------- */
/* Step 15H — submittedOdds: null (provider-price lookup, bridge wiring)      */
/* -------------------------------------------------------------------------- */

test("request mapping: legacySelectionToCanonicalRequest accepts submittedOdds:null without throwing, and omits it rather than serializing 'null'", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    selection: "1",
    submittedOdds: null,
  });

  assert.equal(request.selection.submittedOdds, undefined);
});

test("request mapping: submittedOdds:null still produces the same event/selection classification as a numeric request", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    selection: "1",
    submittedOdds: null,
  });

  assert.equal(request.selection.marketType, "MONEYLINE_3WAY");
  assert.equal(request.selection.selectionType, "HOME");
  assert.deepEqual(request.selection.event.participants, [{ name: "Real Madrid" }, { name: "Barcelona" }]);
});

test("result mapping: a successful null-input lookup (VERIFIED) reconstructs submittedOdds from the verifier's own promoted result, not a caller-supplied value", () => {
  // The verifier (Step 15G) promoted the found price (2.15) into
  // submittedOdds — the bridge must report that promoted value, never a
  // stale or unrelated second argument.
  const result = createVerifiedResult({
    submittedOdds: "2.15",
    currentOdds: "2.15",
    differencePercentage: "0",
    bookmaker: "Pinnacle",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
  });

  const { oddsCheck } = verificationResultToLegacyOddsCheck(result);

  assert.deepEqual(oddsCheck, {
    matched: true,
    withinTolerance: true,
    sourceOdds: 2.15,
    submittedOdds: 2.15,
    discrepancyPercent: 0,
    bookmaker: "Pinnacle",
    note: null,
    providerEventId: undefined,
    providerSportKey: undefined,
    eventStartTime: undefined,
    homeTeamName: undefined,
    awayTeamName: undefined,
    competitionName: undefined,
    reasonCode: "NONE",
  });
});

test("result mapping: an unsuccessful null-input lookup preserves submittedOdds:null, never fabricating a value", () => {
  const result = createFailedResult({
    submittedOdds: null,
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    reasonCode: "EVENT_NOT_FOUND",
  });

  const { oddsCheck, wasExceptionMapped } = verificationResultToLegacyOddsCheck(result);

  assert.equal(wasExceptionMapped, false);
  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.submittedOdds, null);
});

test("result mapping: the (now-unused) second parameter, if supplied, never overrides the result's own submittedOdds", () => {
  // A caller (e.g. lib/bets/buildBetSlipPreview.ts, unmodified in this
  // step) may still pass a second positional argument — it must be fully
  // ignored, proving the derivation genuinely comes from result.submittedOdds
  // and not silently from this parameter.
  const result = createVerifiedResult({
    submittedOdds: "2.15",
    currentOdds: "2.15",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
  });

  const { oddsCheck } = verificationResultToLegacyOddsCheck(result, 999);

  assert.equal(oddsCheck?.submittedOdds, 2.15, "must reflect the result's own submittedOdds, not the ignored 999 argument");
});

// ---------------------------------------------------------------------
// Stage 3.1 — matchedEvent round-trips into OddsCheckResult's own
// providerEventId/providerSportKey/eventStartTime fields, so
// buildBetSlipPreview.ts has exactly one place to read provider event
// metadata from (the reconstructed oddsCheck), matching this bridge's
// existing "legacy shape is the one canonical read surface" convention.
// ---------------------------------------------------------------------

test("result mapping: VERIFIED round-trips matchedEvent into providerEventId/providerSportKey/eventStartTime", () => {
  const result = createVerifiedResult({
    submittedOdds: "2.15",
    currentOdds: "2.15",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    matchedEvent: {
      event: { sport: "FOOTBALL", name: "Manchester United vs Chelsea", participants: [], period: "FULL_GAME", startTime: "2026-08-15T18:00:00.000Z" },
      reference: { provider: "THE_ODDS_API", eventId: "evt-round-trip-1", sportKey: "soccer_epl" },
    },
  });

  const { oddsCheck } = verificationResultToLegacyOddsCheck(result);

  assert.equal(oddsCheck?.providerEventId, "evt-round-trip-1");
  assert.equal(oddsCheck?.providerSportKey, "soccer_epl");
  assert.equal(oddsCheck?.eventStartTime, "2026-08-15T18:00:00.000Z");
});

test("result mapping: FAILED round-trips matchedEvent too (event found, selection not matched)", () => {
  const result = createFailedResult({
    submittedOdds: "2.15",
    provider: "THE_ODDS_API",
    checkedAt: CHECKED_AT,
    reasonCode: "SELECTION_NOT_FOUND",
    matchedEvent: {
      event: { sport: "FOOTBALL", name: "Manchester United vs Chelsea", participants: [], period: "FULL_GAME", startTime: "2026-08-15T18:00:00.000Z" },
      reference: { provider: "THE_ODDS_API", eventId: "evt-round-trip-2", sportKey: "soccer_epl" },
    },
  });

  const { oddsCheck } = verificationResultToLegacyOddsCheck(result);

  assert.equal(oddsCheck?.matched, false);
  assert.equal(oddsCheck?.providerEventId, "evt-round-trip-2");
  assert.equal(oddsCheck?.providerSportKey, "soccer_epl");
});

/* ============================================================================
 * Betting Markets V1, Phase 3.2 — Totals (Over/Under) classification.
 *
 * Stage BA-2A — the classifyTotalsDirection()/legacySelectionTextToCanonical()
 * unit tests that used to live here now live in
 * lib/odds/shorthandClassifier.test.ts, testing the shared classifier those
 * two (now-removed) functions were replaced by. What remains below tests
 * legacySelectionToCanonicalRequest() itself — the full wiring from a legacy
 * free-text selection to a canonical VerifySelectionRequest — which is a
 * different, still-real thing to verify independently of the classifier it
 * calls. TheOddsApiProvider's capabilities/market gate is untouched — a
 * TOTALS selection still cannot become VERIFIED end-to-end through this file
 * alone (that gate is exercised in theOddsApiProvider.test.ts, not here).
 * ============================================================================ */

/* -------------------------------------------------------------------------- */
/* legacySelectionToCanonicalRequest — full wiring, required canonical output */
/* -------------------------------------------------------------------------- */

test("request mapping: 'Over 2.5' produces the exact required canonical output (marketType/selectionType/participant/line)", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "OVER");
  assert.equal(request.selection.participant, undefined);
  assert.equal(request.selection.line, "2.5");
});

test("request mapping: 'Under 2.5' produces the exact required canonical output (marketType/selectionType/participant/line)", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Under 2.5", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "UNDER");
  assert.equal(request.selection.participant, undefined);
  assert.equal(request.selection.line, "2.5");
});

test("request mapping: AI shape — selection is bare 'Over', line arrives separately via LegacyVerifiableSelection.line (the authoritative source)", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over", submittedOdds: 1.9, line: "3.5" });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "OVER");
  assert.equal(request.selection.line, "3.5");
});

test("request mapping: a separately-stated line is authoritative and is NEVER overwritten by a number embedded in the selection text", () => {
  // Deliberately conflicting: the free text says 2.5, the stated line says
  // 3.5 — the stated line must win, exactly per this phase's explicit
  // instruction not to re-extract/overwrite a valid separate line.
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 1.9, line: "3.5" });

  assert.equal(request.selection.line, "3.5");
});

test("request mapping: the embedded line is used ONLY as a backward-compatible fallback when no separate line was ever stated", () => {
  const withNullLine = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "ТБ 2.5", submittedOdds: 1.9, line: null });
  assert.equal(withNullLine.selection.line, "2.5");

  const withNoLineField = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "ТБ 2.5", submittedOdds: 1.9 });
  assert.equal(withNoLineField.selection.line, "2.5");
});

test("request mapping: '+2.5' (stated line) canonicalizes to '2.5', matching the domain-wide line convention", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over", submittedOdds: 1.9, line: "+2.5" });

  assert.equal(request.selection.line, "2.5");
});

test("request mapping: a bare 'Over' with NO line anywhere (neither stated nor embedded) produces line: undefined — validateCanonicalSelection's existing 'TOTALS requires line' rule rejects it downstream, no new validation code needed here", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.line, undefined);
});

test("request mapping: a malformed stated line passes through unchanged (never silently dropped), so validateCanonicalSelection's own decimal-string check rejects it downstream — same precedent as Phase 2's malformed-line handling", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 1.9, line: "not-a-number" });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.line, "not-a-number");
});

test("request mapping: ambiguous Over+Under text is rejected — falls back to the existing PARTICIPANT classification, never TOTALS", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over Under 2.5", submittedOdds: 1.9 });

  assert.notEqual(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
});

test("request mapping: existing MONEYLINE 1X2/team-name selections are completely unaffected by the Totals classifier", () => {
  const home = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "1", submittedOdds: 1.9 });
  assert.equal(home.selection.marketType, "MONEYLINE_3WAY");
  assert.equal(home.selection.selectionType, "HOME");

  const teamName = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Real Madrid Win", submittedOdds: 1.9 });
  assert.equal(teamName.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(teamName.selection.selectionType, "PARTICIPANT");
  assert.equal(teamName.selection.participant?.name, "Real Madrid");
});

test("request mapping: DRAW ('X'/'Draw'/'Ничья') is completely unaffected by the Totals classifier", () => {
  for (const selection of ["X", "х", "Draw", "Ничья"]) {
    const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection, submittedOdds: 1.9 });
    assert.equal(request.selection.marketType, "MONEYLINE_3WAY");
    assert.equal(request.selection.selectionType, "DRAW");
  }
});

test("request mapping: team totals ('Arsenal Over 1.5') are not classified as TOTALS yet — falls back to PARTICIPANT", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Arsenal Over 1.5", submittedOdds: 1.9 });

  assert.notEqual(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
});

test("request mapping: spreads/handicaps ('-1.5') are not classified as TOTALS yet — falls back to PARTICIPANT", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "-1.5", submittedOdds: 1.9 });

  assert.notEqual(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
});

/* -------------------------------------------------------------------------- */
/* Stage BA-2A — TEAM_TOTAL (ИТБ/ИТМ) and SPREAD (Ф1/Ф2, attributed signed    */
/* line) now classify honestly instead of falling back to PARTICIPANT. No    */
/* provider adapter supports verifying either yet — see                      */
/* theOddsApiProvider.test.ts's MARKET_NOT_SUPPORTED coverage for the        */
/* end-to-end safety proof that follows from this correct classification.    */
/* -------------------------------------------------------------------------- */

test("request mapping: 'Арсенал ИТБ 1.5' classifies as TEAM_TOTAL/OVER with participant + line — never MONEYLINE", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал ИТБ 1.5", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "TEAM_TOTAL");
  assert.equal(request.selection.selectionType, "OVER");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "1.5");
});

test("request mapping: 'Арсенал ИТМ 1.5' classifies as TEAM_TOTAL/UNDER — never MONEYLINE", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал ИТМ 1.5", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "TEAM_TOTAL");
  assert.equal(request.selection.selectionType, "UNDER");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "1.5");
});

test("request mapping: 'Арсенал Ф1(-1.5)' classifies as SPREAD with participant + line — never MONEYLINE", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал Ф1(-1.5)", submittedOdds: 1.9 });

  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

/* -------------------------------------------------------------------------- */
/* Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary, new.   */
/* This is the REAL, unwindowed production classification path              */
/* (legacySelectionToCanonicalRequest -> classifyBettingSelectionText on the */
/* full selection string) — unlike marketIntentEvidence.ts's own 3-token-    */
/* bounded evidence windowing, this path always sees the ENTIRE selection    */
/* text at once, so a multi-word participant combined with a multi-word     */
/* marker (e.g. "Арсенал азійська фора -1.25") is captured correctly here    */
/* even in the cases marketIntentEvidence.test.ts's own H3 tests disclose    */
/* as a windowing limitation for THAT file specifically.                     */
/* -------------------------------------------------------------------------- */

test("H3 request mapping: 'Арсенал фора -1.5' classifies as SPREAD with participant + line — never MONEYLINE", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал фора -1.5", submittedOdds: 1.9 });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 request mapping: 'Арсенал азійська фора -1.25' (4-word UA compound marker) — participant correctly captured, unlike the 3-token-windowed evidence extractor", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал азійська фора -1.25",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.25");
});

test("H3 request mapping: 'Real Madrid handicap -2' (multi-word EN participant) classifies as SPREAD with the full participant name — never MONEYLINE", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    selection: "Real Madrid handicap -2",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Real Madrid");
  assert.equal(request.selection.line, "-2");
});

test("H3 request mapping: prefix form 'handicap Arsenal -1.5' classifies as SPREAD with participant Arsenal", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Chelsea", selection: "handicap Arsenal -1.5", submittedOdds: 1.9 });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 request mapping: a shorthand handicap word concatenated with a team name (no separate event/selection split) still classifies correctly via the event's own split participants, mirroring the existing Ф1/ТБ production-regression precedent", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал фора -1.5",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 request mapping: existing markets (MONEYLINE/TOTALS) and existing Ф1 short form are unaffected by the new handicap vocabulary", () => {
  const win = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал победа", submittedOdds: 1.9 });
  assert.equal(win.selection.marketType, "MONEYLINE_2WAY");

  const totals = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал ТБ 2.5", submittedOdds: 1.9 });
  assert.equal(totals.selection.marketType, "TOTALS");

  const shortForm = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Челси", selection: "Арсенал Ф1(-1.5)", submittedOdds: 1.9 });
  assert.equal(shortForm.selection.marketType, "SPREAD");
  assert.equal(shortForm.selection.participant?.name, "Арсенал");
});

test("request mapping: a shorthand token concatenated with a team name (no separate event/selection split) still classifies correctly via the event's own split participants — the exact production regression case", () => {
  // The event string is split into participants by legacyEventToCanonical
  // BEFORE classification, so "Арсенал" is already a knownParticipantName
  // by the time the selection text is classified — closing the anchor gap
  // that let "Арсенал ТБ 2.5" (arriving as one concatenated field) fall
  // back to a fabricated MONEYLINE PARTICIPANT guess.
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал ТБ 2.5",
    submittedOdds: 1.9,
  });

  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "OVER");
  assert.equal(request.selection.line, "2.5");
});

test("request mapping: SINGLE and EXPRESS selections classify identically — legacySelectionToCanonicalRequest is a pure, per-selection function with no shared state across calls", () => {
  // Simulates a SINGLE bet (one call) and one leg of an EXPRESS bet (called
  // as part of a sequence of several) with the identical selection — both
  // must produce byte-for-byte the same classification, since
  // buildBetSlipPreview.ts calls this same function once per selection
  // regardless of BetType.
  const singleResult = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 1.9 });

  // "As part of EXPRESS": call it multiple times in a row, interleaved with
  // other selections, to prove no cross-call state leakage.
  legacySelectionToCanonicalRequest({ sport: "Basketball", event: "C vs D", selection: "1", submittedOdds: 1.5 });
  const expressLegResult = legacySelectionToCanonicalRequest({ sport: "Football", event: "A vs B", selection: "Over 2.5", submittedOdds: 1.9 });
  legacySelectionToCanonicalRequest({ sport: "Tennis", event: "E vs F", selection: "Under 3.5", submittedOdds: 2.1 });

  assert.deepEqual(singleResult.selection, expressLegResult.selection);
});

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — canonical classification now consults marketRawText   */
/* when `selection` alone falls to the generic PARTICIPANT fallback. This is */
/* the ACTUAL fix for the production bug: BA-2D (lib/ai/betDraftMapper.ts)   */
/* already correctly recognized SPREAD after the earlier e7c5303 fix, but    */
/* THIS function — the one that builds the request real odds verification   */
/* uses — independently reclassified the bare selection text with no        */
/* knowledge of the market hint at all, silently reaching MONEYLINE_2WAY.    */
/* -------------------------------------------------------------------------- */

// ---------------------------------------------------------------------
// Required field-shape tests A-E
// ---------------------------------------------------------------------

test("H3 field shape A: selection='Арсенал', market hint='Фора', line='-1.5' -> SPREAD, participant Арсенал, line -1.5", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 field shape B: selection='Арсенал', market hint=null, line='-1.5' -> preserves current safe behavior, MONEYLINE (never fabricates SPREAD without a hint)", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: null,
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.participant?.name, "Арсенал");
});

test("H3 field shape C: selection='Арсенал фора' (marker already inside selection), market hint='Фора', line='-1.5' -> SPREAD, participant Арсенал", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал фора",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 field shape D: selection='Арсенал -1.5' (line embedded in selection), market hint='Фора', line='-1.5' -> SPREAD, participant Арсенал", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал -1.5",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 field shape E: selection='Арсенал', market hint='Spread' (EN word on a RU selection), line='-1.5' -> SPREAD, participant Арсенал", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Spread",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
});

test("H3 field shape EN: selection='Arsenal', market hint='Handicap', line='-1.5' -> SPREAD, participant Arsenal", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry",
    selection: "Arsenal",
    marketRawText: "Handicap",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
});

// ---------------------------------------------------------------------
// Critical safety invariant — a market hint can never fabricate SPREAD
// from an already-meaningful selection classification
// ---------------------------------------------------------------------

test("H3 critical safety: 'Arsenal Win' + market hint 'Handicap' remains MONEYLINE — the hint never overrides a real, confident classification", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry",
    selection: "Arsenal Win",
    marketRawText: "Handicap",
    submittedOdds: 1.16,
    line: null,
  });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");
  assert.notEqual(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
});

test("H3 critical safety: 'Over 2.5' + market hint 'Handicap' remains TOTALS", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry",
    selection: "Over 2.5",
    marketRawText: "Handicap",
    submittedOdds: 1.9,
    line: null,
  });
  assert.equal(request.selection.marketType, "TOTALS");
  assert.equal(request.selection.selectionType, "OVER");
});

// ---------------------------------------------------------------------
// Natural-language production regression — the exact reported phrases
// ---------------------------------------------------------------------

test("H3 production regression: RU 'Арсенал фора -1.5 ставка 10' shape -> canonical SPREAD/Арсенал/-1.5", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 production regression: RU 'Арсенал с форой -1.5 ставка 10' shape -> canonical SPREAD/Арсенал/-1.5", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
});

test("H3 production regression: EN 'Arsenal handicap -1.5 stake 10' shape -> canonical SPREAD/Arsenal/-1.5", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry",
    selection: "Arsenal",
    marketRawText: "Handicap",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.5");
});

test("H3 production regression: EN 'Arsenal spread -1.5 stake 10' shape -> canonical SPREAD/Arsenal/-1.5", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Coventry",
    selection: "Arsenal",
    marketRawText: "Spread",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
});

// ---------------------------------------------------------------------
// Quarter-line invariant — canonicalizes to SPREAD, exact line preserved,
// never rounded. The H1 provider capability gate (unchanged, out of scope
// here) is what keeps it non-confirmable — this only proves canonicalization
// itself is correct and honest.
// ---------------------------------------------------------------------

test("H3 quarter-line: UA 'Арсенал азійська фора -1.25 ставка 10' shape -> canonical SPREAD/Арсенал/-1.25, exact line preserved, never rounded", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Азійська фора",
    submittedOdds: null,
    line: "-1.25",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.25");
  assert.notEqual(request.selection.line, "-1.5");
  assert.notEqual(request.selection.line, "-1");
});

// ---------------------------------------------------------------------
// MONEYLINE/TOTALS regression — existing behavior byte-for-byte unchanged
// ---------------------------------------------------------------------

test("H3 regression: 'Arsenal Win' (no market hint at all) -> MONEYLINE_2WAY, unchanged", () => {
  const request = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Coventry", selection: "Arsenal Win", submittedOdds: 1.16 });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");
});

test("H3 regression: 'Draw'/'Ничья' -> MONEYLINE_3WAY/DRAW, unchanged", () => {
  const en = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Coventry", selection: "Draw", submittedOdds: 3.4 });
  assert.equal(en.selection.marketType, "MONEYLINE_3WAY");
  assert.equal(en.selection.selectionType, "DRAW");

  const ru = legacySelectionToCanonicalRequest({ sport: "Football", event: "Арсенал vs Ковентрі", selection: "Ничья", submittedOdds: 3.4 });
  assert.equal(ru.selection.marketType, "MONEYLINE_3WAY");
  assert.equal(ru.selection.selectionType, "DRAW");
});

test("H3 regression: 'Over 2.5'/'Under 3' -> TOTALS, unchanged", () => {
  const over = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Coventry", selection: "Over 2.5", submittedOdds: 1.9 });
  assert.equal(over.selection.marketType, "TOTALS");
  assert.equal(over.selection.selectionType, "OVER");

  const under = legacySelectionToCanonicalRequest({ sport: "Football", event: "Arsenal vs Coventry", selection: "Under 3", submittedOdds: 1.9 });
  assert.equal(under.selection.marketType, "TOTALS");
  assert.equal(under.selection.selectionType, "UNDER");
});

test("H3 regression: existing Ф1/F1 short forms unaffected by the new marketRawText field being omitted entirely (optional, backward-compatible)", () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1(-1.5)",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");
});
