import { test } from "node:test";
import assert from "node:assert/strict";
import { TheOddsApiProvider } from "./theOddsApiProvider";
import type { CanonicalEvent, CanonicalSelection } from "./domain";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { OddsVerificationInput } from "./oddsVerifier";

const FOOTBALL_EVENT: CanonicalEvent = {
  sport: "FOOTBALL",
  name: "Manchester United vs Chelsea",
  participants: [{ name: "Manchester United" }, { name: "Chelsea" }],
  period: "FULL_GAME",
  homeParticipantIndex: 0,
  awayParticipantIndex: 1,
};

const TENNIS_EVENT: CanonicalEvent = {
  sport: "TENNIS",
  name: "Carlos Alcaraz vs Novak Djokovic",
  participants: [{ name: "Carlos Alcaraz" }, { name: "Novak Djokovic" }],
  period: "MATCH",
};

function moneyline3Way(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "FOOTBALL",
    event: FOOTBALL_EVENT,
    marketType: "MONEYLINE_3WAY",
    period: "FULL_GAME",
    selectionType: "HOME",
    submittedOdds: "2.15",
    ...overrides,
  };
}

function capturingVerifyOddsFn(result: OddsCheckResult) {
  const calls: OddsVerificationInput[] = [];
  const fn = async (input: OddsVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

function baseLegacyResult(overrides: Partial<OddsCheckResult>): OddsCheckResult {
  return {
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds: 2.15,
    discrepancyPercent: null,
    bookmaker: null,
    note: null,
    ...overrides,
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/* -------------------------------------------------------------------------- */
/* Group C — provider capabilities                                            */
/* -------------------------------------------------------------------------- */

test("capabilities: only the four current MVP sports plus American Football are advertised", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.deepEqual(
    capabilities.supportedSports.slice().sort(),
    ["AMERICAN_FOOTBALL", "BASKETBALL", "FOOTBALL", "ICE_HOCKEY", "TENNIS"].sort(),
  );
  assert.ok(!capabilities.supportedSports.includes("UNKNOWN"));
});

test("capabilities: only moneyline markets are advertised — totals/spread/BTTS/double-chance are not current", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.deepEqual(capabilities.supportedMarketTypes.slice().sort(), ["MONEYLINE_2WAY", "MONEYLINE_3WAY"].sort());
  for (const notCurrent of ["TOTALS", "SPREAD", "BOTH_TEAMS_TO_SCORE", "DOUBLE_CHANCE"] as const) {
    assert.ok(!capabilities.supportedMarketTypes.includes(notCurrent), `${notCurrent} must not be advertised as current`);
  }
});

test("capabilities: pre-match only, no event search/by-ID lookup, league selection not supported", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.equal(capabilities.livePrematchSupport, "PREMATCH_ONLY");
  assert.equal(capabilities.eventSearchSupported, false);
  assert.equal(capabilities.eventByIdLookupSupported, false);
  assert.equal(capabilities.leagueSelectionSupported, false);
  assert.deepEqual(capabilities.regions, ["eu"]);
});

test("healthCheck: reports unhealthy when ODDS_API_KEY is unset, makes no network call", async () => {
  const previous = process.env.ODDS_API_KEY;
  delete process.env.ODDS_API_KEY;
  try {
    const provider = new TheOddsApiProvider();
    const health = await provider.healthCheck();
    assert.equal(health.healthy, false);
    assert.equal(health.reasonCode, "PROVIDER_UNAVAILABLE");
    assert.equal(health.diagnosticCode, "MISSING_API_KEY");
    assert.match(health.checkedAt, ISO_DATE_RE);
  } finally {
    if (previous !== undefined) process.env.ODDS_API_KEY = previous;
  }
});

test("healthCheck: reports healthy when ODDS_API_KEY is set", async () => {
  const previous = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "test-key";
  try {
    const provider = new TheOddsApiProvider();
    const health = await provider.healthCheck();
    assert.equal(health.healthy, true);
    assert.equal(health.reasonCode, undefined);
  } finally {
    if (previous === undefined) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previous;
  }
});

test("findEvents and getEventMarkets return an honest not-implemented result, never throw", async () => {
  const provider = new TheOddsApiProvider();

  const findResult = await provider.findEvents({ sport: "FOOTBALL" });
  assert.equal(findResult.ok, false);
  if (!findResult.ok) {
    assert.equal(findResult.retryable, false);
    assert.match(findResult.message, /not implemented/i);
  }

  const marketsResult = await provider.getEventMarkets({
    eventReference: { provider: "THE_ODDS_API", eventId: "x" },
    marketTypes: ["MONEYLINE_3WAY"],
  });
  assert.equal(marketsResult.ok, false);
});

/* -------------------------------------------------------------------------- */
/* Group D — adapter mapping (dependency-injected verifyOdds, no network)     */
/* -------------------------------------------------------------------------- */

test("adapter mapping: legacy VERIFIED (matched + withinTolerance) maps to VERIFIED with acceptedOdds = currentOdds", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.1, discrepancyPercent: 2.38, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.reasonCode, "NONE");
  assert.equal(result.currentOdds, "2.1");
  assert.equal(result.acceptedOdds, "2.1");
  assert.equal(result.differencePercentage, "2.38");
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.provider, "THE_ODDS_API");
  assert.match(result.checkedAt, ISO_DATE_RE);
});

test("adapter mapping: legacy ODDS_CHANGED (matched + not withinTolerance) maps to ODDS_CHANGED with acceptedOdds null", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: false, sourceOdds: 1.5, discrepancyPercent: 43.33, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "ODDS_CHANGED");
  assert.equal(result.reasonCode, "ODDS_OUTSIDE_TOLERANCE");
  assert.equal(result.currentOdds, "1.5");
  assert.equal(result.acceptedOdds, null);
});

test("adapter mapping: legacy 'sport not mapped' note maps to FAILED/SPORT_NOT_SUPPORTED", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: 'Sport/league "cricket" is not mapped to a The Odds API sport_key' }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SPORT_NOT_SUPPORTED");
  assert.equal(result.acceptedOdds, null);
});

test("adapter mapping: legacy 'no matching event' note maps to FAILED/EVENT_NOT_FOUND", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: 'No matching event found for "Manchester United vs Chelsea" in soccer_epl' }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "EVENT_NOT_FOUND");
});

test("adapter mapping: legacy 'no bookmaker odds available' note maps to FAILED/SELECTION_NOT_FOUND", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: 'No bookmaker odds available for "Manchester United vs Chelsea"' }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
});

test("adapter mapping: legacy 'could not match selection' note maps to FAILED/SELECTION_NOT_FOUND, preserves bookmaker", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: 'Could not match selection "home" to a bookmaker outcome', bookmaker: "Bet365" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.equal(result.bookmaker, "Bet365");
});

test("adapter mapping: legacy timeout note maps to FAILED/PROVIDER_TIMEOUT (retryable)", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request timed out after 8000ms" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_TIMEOUT");
  assert.equal(result.retryable, true);
});

test("adapter mapping: legacy 'ODDS_API_KEY is not configured' maps to FAILED/PROVIDER_UNAVAILABLE (retryable)", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "ODDS_API_KEY is not configured" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.retryable, true);
});

test("adapter mapping: legacy HTTP-failure note maps to FAILED/PROVIDER_UNAVAILABLE", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request failed with status 500: oops" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
});

test("adapter mapping: legacy 'unexpected response shape' note maps to FAILED/PROVIDER_INVALID_RESPONSE", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "Unexpected response shape from The Odds API" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_INVALID_RESPONSE");
  assert.equal(result.retryable, true);
});

test("adapter mapping: an unrecognized legacy note falls back to the conservative FAILED/PROVIDER_UNAVAILABLE default", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "some note oddsVerifier.ts does not currently produce" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.diagnosticCode, "LEGACY_UNCLASSIFIED_FAILURE");
});

test("adapter mapping: no submittedOdds anywhere yields NOT_CHECKED/NOT_CHECKED without calling verifyOdds", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(result.status, "NOT_CHECKED");
  assert.equal(result.reasonCode, "NOT_CHECKED");
  assert.equal(result.acceptedOdds, null);
  assert.equal(calls.length, 0, "the legacy verifier must not be called when there is nothing to check");
});

test("adapter mapping: request-level submittedOdds overrides selection.submittedOdds", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }), submittedOdds: "3.00" });

  assert.equal(calls[0].odds, 3.0);
});

test("adapter mapping: an unsupported market (TOTALS) never reaches the legacy verifier — FAILED/MARKET_NOT_SUPPORTED", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ marketType: "TOTALS", selectionType: "OVER", line: "2.5" }),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

test("adapter mapping: sport UNKNOWN never reaches the legacy verifier — FAILED/SPORT_NOT_SUPPORTED", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ sport: "UNKNOWN", event: { ...FOOTBALL_EVENT, sport: "UNKNOWN" } }),
  });

  assert.equal(result.reasonCode, "SPORT_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

test("adapter mapping: malformed submittedOdds yields FAILED/INVALID_INPUT without calling the legacy verifier", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "not-a-number" }) });

  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0);
});

test("adapter mapping: a structurally invalid selection (MONEYLINE_2WAY + DRAW) yields FAILED/INVALID_INPUT", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ marketType: "MONEYLINE_2WAY", selectionType: "DRAW" }),
  });

  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0);
});

test("adapter mapping: constructs the exact legacy request shape for a HOME selection", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.15 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ selectionType: "HOME", submittedOdds: "2.15" }) });

  assert.deepEqual(calls[0], {
    sport: "football",
    event: "Manchester United vs Chelsea",
    selection: "home",
    odds: 2.15,
  });
});

test("adapter mapping: PARTICIPANT selectionType passes the participant's name through as free text (tennis)", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.8 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({
    selection: {
      sport: "TENNIS",
      event: TENNIS_EVENT,
      marketType: "MONEYLINE_2WAY",
      period: "MATCH",
      selectionType: "PARTICIPANT",
      participant: { name: "Carlos Alcaraz" },
      submittedOdds: "1.85",
    },
  });

  assert.equal(calls[0].sport, "tennis");
  assert.equal(calls[0].selection, "Carlos Alcaraz");
});

test("adapter mapping: never fabricates matchedEvent, matchedOutcome, or providerTimestamp — legacy provides none of these", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0, bookmaker: "Pinnacle" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.matchedEvent, undefined);
  assert.equal(result.matchedOutcome, undefined);
  assert.equal(result.providerTimestamp, undefined);
});

test("adapter mapping: a null legacy bookmaker never becomes a fabricated string", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request timed out after 8000ms", bookmaker: null }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.bookmaker, undefined);
});

/* -------------------------------------------------------------------------- */
/* Step 7A — football-league compatibility fix                                */
/* -------------------------------------------------------------------------- */

test("football league resolution: La Liga produces legacy sport 'la liga'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "La Liga" } }) });

  assert.equal(calls[0].sport, "la liga");
});

test("football league resolution: Serie A produces legacy sport 'serie a'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Serie A" } }) });

  assert.equal(calls[0].sport, "serie a");
});

test("football league resolution: Bundesliga produces legacy sport 'bundesliga'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Bundesliga" } }) });

  assert.equal(calls[0].sport, "bundesliga");
});

test("football league resolution: Ligue 1 produces legacy sport 'ligue 1'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Ligue 1" } }) });

  assert.equal(calls[0].sport, "ligue 1");
});

test("football league resolution: UEFA Champions League produces legacy sport 'champions league'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "UEFA Champions League" } }) });

  assert.equal(calls[0].sport, "champions league");
});

test("football league resolution: the 'Champions League' naming variant also produces legacy sport 'champions league'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Champions League" } }) });

  assert.equal(calls[0].sport, "champions league");
});

test("football league resolution: Premier League produces legacy sport 'premier league'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Premier League" } }) });

  assert.equal(calls[0].sport, "premier league");
});

test("football league resolution: generic FOOTBALL with no league falls back to 'football'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: undefined }) });

  assert.equal(calls[0].sport, "football");
});

test("football league resolution: an unrecognized football league falls back to 'football'", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Europa League" } }) });

  assert.equal(calls[0].sport, "football");
});

test("football league resolution: a non-football sport ignores any football-league value and preserves its own existing sport alias", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.8 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({
    selection: {
      sport: "TENNIS",
      event: TENNIS_EVENT,
      marketType: "MONEYLINE_2WAY",
      period: "MATCH",
      selectionType: "PARTICIPANT",
      participant: { name: "Carlos Alcaraz" },
      submittedOdds: "1.85",
      // A league value on a non-football sport must never influence
      // resolveLegacyFootballSport, which is only ever consulted when
      // selection.sport === "FOOTBALL".
      league: { name: "La Liga" },
    },
  });

  assert.equal(calls[0].sport, "tennis");
});

test("football league resolution: whitespace/case normalization applies only to exact recognized names", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "  LA   LIGA  " } }) });
  assert.equal(calls[0].sport, "la liga");

  calls.length = 0;
  await provider.verifySelection({ selection: moneyline3Way({ league: { name: "La  Ligaa" } }) });
  assert.equal(calls[0].sport, "football");
});

test("football league resolution: no provider sport_key is ever emitted — only the same human-readable legacy alias strings oddsVerifier.ts already accepts", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  for (const league of ["La Liga", "Serie A", "Bundesliga", "Ligue 1", "UEFA Champions League", "Premier League"]) {
    calls.length = 0;
    await provider.verifySelection({ selection: moneyline3Way({ league: { name: league } }) });
    assert.doesNotMatch(calls[0].sport, /^soccer_/, "must never be a raw The Odds API sport_key");
  }
});
