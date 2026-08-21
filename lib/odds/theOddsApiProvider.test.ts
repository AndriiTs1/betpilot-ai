import { test } from "node:test";
import assert from "node:assert/strict";
import { TheOddsApiProvider } from "./theOddsApiProvider";
import type { CanonicalEvent, CanonicalSelection } from "./domain";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { OddsVerificationInput, TotalsVerificationInput, SpreadVerificationInput, TeamTotalVerificationInput } from "./oddsVerifier";
import { legacySelectionToCanonicalRequest } from "./legacyOddsBridge";

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

// Betting Markets V1, Phase 3.3 — same capturing-fake shape as
// capturingVerifyOddsFn above, for the new, independently-injected
// verifyTotalsOddsFn constructor parameter.
function capturingVerifyTotalsOddsFn(result: OddsCheckResult) {
  const calls: TotalsVerificationInput[] = [];
  const fn = async (input: TotalsVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}

// A verifyOddsFn that always throws — used to prove a TOTALS selection
// never reaches this (the h2h) function at all, complementing the
// totals-capturing helper above.
function throwingVerifyOddsFn(): typeof import("./oddsVerifier").verifyOdds {
  return (async () => {
    throw new Error("verifyOddsFn (h2h) must never be called for a TOTALS selection");
  }) as typeof import("./oddsVerifier").verifyOdds;
}

// Handicap Stage H1 — same capturing-fake shape as capturingVerifyOddsFn/
// capturingVerifyTotalsOddsFn above, for the new, independently-injected
// verifySpreadOddsFn constructor parameter.
function capturingVerifySpreadOddsFn(result: OddsCheckResult) {
  const calls: SpreadVerificationInput[] = [];
  const fn = async (input: SpreadVerificationInput): Promise<OddsCheckResult> => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}


// Individual Team Totals, Stage 3 — same capturing-fake shape as
// capturingVerifyOddsFn/capturingVerifyTotalsOddsFn/capturingVerifySpreadOddsFn
// above, for the new, independently-injected verifyTeamTotalsOddsFn
// constructor parameter.
function capturingVerifyTeamTotalsOddsFn(result: OddsCheckResult) {
  const calls: TeamTotalVerificationInput[] = [];
  const fn = async (input: TeamTotalVerificationInput): Promise<OddsCheckResult> => {
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

test("capabilities: moneyline + totals + spread + team_total markets are advertised — BTTS/double-chance are not current (Betting Markets V1 Phase 3.3 + Handicap Stage H1 + Individual Team Totals Stage 3 — TOTALS, SPREAD, and TEAM_TOTAL are now intentionally supported)", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.deepEqual(
    capabilities.supportedMarketTypes.slice().sort(),
    ["MONEYLINE_2WAY", "MONEYLINE_3WAY", "TOTALS", "SPREAD", "TEAM_TOTAL"].sort(),
  );
  for (const notCurrent of ["BOTH_TEAMS_TO_SCORE", "DOUBLE_CHANCE"] as const) {
    assert.ok(!capabilities.supportedMarketTypes.includes(notCurrent), `${notCurrent} must not be advertised as current`);
  }
});

test("capabilities: pre-match only, no event search/by-ID lookup, league selection supported (Step 16A)", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.equal(capabilities.livePrematchSupport, "PREMATCH_ONLY");
  assert.equal(capabilities.eventSearchSupported, false);
  assert.equal(capabilities.eventByIdLookupSupported, false);
  assert.equal(capabilities.leagueSelectionSupported, true);
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

// Root cause of the production "single-team query works, express doesn't"
// investigation: The Odds API account's usage quota was exhausted, every
// fetch failing with HTTP 401 and error_code OUT_OF_USAGE_CREDITS
// (oddsVerifier.ts's fetchOddsForSport parses this short, safe field out
// of the response body and embeds it in the note text — never the raw
// body). This must classify distinctly from a generic failure and from a
// bad API key, both retryable (the quota resets/plan can be upgraded).
test("adapter mapping: legacy OUT_OF_USAGE_CREDITS (HTTP 401) note maps to FAILED/PROVIDER_QUOTA_EXCEEDED (retryable)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: "The Odds API request failed with status 401 (OUT_OF_USAGE_CREDITS)" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_QUOTA_EXCEEDED");
  assert.equal(result.retryable, true);
  assert.equal(result.diagnosticCode, "LEGACY_QUOTA_EXCEEDED");
});

// A 401 that is NOT quota exhaustion (missing/invalid/revoked key) — must
// be distinguished from PROVIDER_QUOTA_EXCEEDED, and is NOT retryable
// (unlike every other PROVIDER_FAILURE reason): a bad key will not fix
// itself on a later attempt.
test("adapter mapping: legacy invalid-API-key (HTTP 401, no OUT_OF_USAGE_CREDITS) note maps to FAILED/PROVIDER_AUTH_FAILED (not retryable)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: "The Odds API request failed with status 401 (INVALID_KEY)" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_AUTH_FAILED");
  assert.equal(result.retryable, false);
});

// A bare 401 with no parsable error_code at all (e.g. a non-JSON body) must
// still classify as an auth failure, never silently fall back to the
// generic PROVIDER_UNAVAILABLE default.
test("adapter mapping: a bare HTTP 401 note with no provider error_code still maps to FAILED/PROVIDER_AUTH_FAILED", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request failed with status 401" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_AUTH_FAILED");
});

test("adapter mapping: legacy HTTP 429 note maps to FAILED/PROVIDER_RATE_LIMITED (retryable)", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request failed with status 429" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.reasonCode, "PROVIDER_RATE_LIMITED");
  assert.equal(result.retryable, true);
});

// A non-401/429 status with a provider error_code present (e.g. a 500 with
// some unrelated code) still degrades to the generic PROVIDER_UNAVAILABLE —
// only 401/429 get specific sub-classification.
test("adapter mapping: a non-401/429 status with a provider error_code still maps to the generic FAILED/PROVIDER_UNAVAILABLE", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ note: "The Odds API request failed with status 503 (SERVICE_UNAVAILABLE)" }),
  );
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

// Step 15H — replaces the old NOT_CHECKED-short-circuit test: a null
// submittedOdds must now reach verifyOddsFn (lookup attempted) instead of
// short-circuiting before ever calling it. See the dedicated Step 15H
// section below for the full set of null-input behaviors (A-D).
test("adapter mapping: no submittedOdds anywhere now reaches verifyOddsFn instead of short-circuiting to NOT_CHECKED", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(calls.length, 1, "the legacy verifier must now be called even with nothing submitted to check against");
  assert.equal(calls[0].odds, null, "the adapter must pass odds:null through untouched, never inventing a value");
  assert.notEqual(result.status, "NOT_CHECKED", "NOT_CHECKED is no longer produced for a null submittedOdds");
});

test("adapter mapping: request-level submittedOdds overrides selection.submittedOdds", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }), submittedOdds: "3.00" });

  assert.equal(calls[0].odds, 3.0);
});

test("adapter mapping: an unsupported market (BOTH_TEAMS_TO_SCORE) never reaches the legacy verifier — FAILED/MARKET_NOT_SUPPORTED (SPREAD moved to its own Handicap Stage H1 tests below — it is no longer unsupported)", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ marketType: "BOTH_TEAMS_TO_SCORE", selectionType: "YES", participant: undefined, line: undefined }),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

test("adapter mapping: TOTALS for a non-football sport is not yet supported — FAILED/MARKET_NOT_SUPPORTED, football-only this phase (Betting Markets V1, Phase 3.3)", async () => {
  const { fn, calls } = capturingVerifyTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ sport: "BASKETBALL", event: { ...FOOTBALL_EVENT, sport: "BASKETBALL" }, marketType: "TOTALS", selectionType: "OVER", line: "220.5" }),
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Stage BA-2A — end-to-end proof: a shorthand TEAM_TOTAL/SPREAD message,     */
/* once correctly classified by lib/odds/legacyOddsBridge.ts (which now      */
/* delegates to lib/odds/shorthandClassifier.ts), is safely rejected as      */
/* MARKET_NOT_SUPPORTED by this adapter's existing allowlist gate — never    */
/* silently verified as MONEYLINE, and no provider support was added for     */
/* either market to make this pass.                                         */
/* -------------------------------------------------------------------------- */

test("end-to-end: 'Арсенал ИТБ 1.5' (TEAM_TOTAL shorthand) is classified correctly and routes ONLY to team-total verification (Individual Team Totals Stage 3) — never becomes a MONEYLINE bet, never MARKET_NOT_SUPPORTED", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал ИТБ 1.5",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "TEAM_TOTAL");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0, "the h2h verifier must never be called for a TEAM_TOTAL selection");
  assert.equal(teamTotalCalls.length, 1, "the team-total verifier must be called exactly once");
  assert.equal(teamTotalCalls[0].participant, "Арсенал");
  assert.equal(teamTotalCalls[0].direction, "OVER");
  assert.equal(teamTotalCalls[0].line, "1.5");
});

test("end-to-end: 'Арсенал Ф1(-1.5)' (SPREAD shorthand) is classified correctly and routes ONLY to spread verification (Handicap Stage H1) — never becomes a MONEYLINE bet", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1(-1.5)",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0, "the h2h verifier must never be called for a SPREAD selection");
  assert.equal(spreadCalls.length, 1, "the spread verifier must be called exactly once");
  assert.equal(spreadCalls[0].participant, "Арсенал");
  assert.equal(spreadCalls[0].line, "-1.5");
});

/* -------------------------------------------------------------------------- */
/* BA-2C Step 1B — production regression: a bare Ф1/Ф2 token (the AI's own   */
/* dedicated `line` field carries the number, leaving the free-text          */
/* selection lineless) used to fall through shorthandClassifier's own        */
/* mandatory-signed-number requirement into the generic, lossless            */
/* PARTICIPANT fallback — reaching this adapter as a real, verifiable        */
/* MONEYLINE_2WAY selection and getting fuzzy-matched to a genuine "team to  */
/* win" price (the exact production incident: "Арсенал Ф1(-1.5) ставка 10"   */
/* previewed as "Arsenal F1 — MONEYLINE, verified 1.16, confirmable"). Fixed */
/* in lib/odds/shorthandClassifier.ts by allowing SPREAD's bare/prefixed     */
/* token forms to match with no embedded number (embeddedLine: null),        */
/* exactly mirroring TEAM_TOTAL's pre-existing bare-token precedent —        */
/* legacyOddsBridge.ts's existing line-precedence rule then reads the real   */
/* line from LegacyVerifiableSelection.line, unchanged.                     */
/* -------------------------------------------------------------------------- */

test("end-to-end: bare 'Ф1' selection with the line stated in the separate `line` field — SPREAD, never MONEYLINE (root cause of the production incident)", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Ф1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.notEqual(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.line, "-1.5");
  // No participant name appears anywhere in this selection text, and the
  // event has two participants — classifyBettingSelectionText correctly
  // refuses to guess which team the spread applies to (participant: null).
  assert.equal(request.selection.participant, undefined);

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: request.selection });

  // validateCanonicalSelection's structural gate (domain.ts: "SPREAD
  // requires participant") runs BEFORE the supportedMarketTypes allowlist
  // check, so a genuinely participant-less SPREAD is rejected as
  // INVALID_INPUT rather than MARKET_NOT_SUPPORTED — a different, even
  // earlier-firing safe rejection, not a regression: still FAILED, still
  // never confirmable, still never reaches the h2h verifier.
  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0, "the h2h verifier must never be called — this must never be priced as a moneyline 'team to win' selection");
});

test("end-to-end: 'Арсенал Ф1' (participant + bare token, no embedded number) with the line stated separately — SPREAD, participant attributed, routes only to spread verification, never a fabricated 'Arsenal Win'", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Арсенал");
  assert.equal(spreadCalls[0].line, "-1.5");
});

test("end-to-end: 'Арсенал Ф1 -1.5 ставка 10' shape (whitespace-separated embedded line) — SPREAD, routes only to spread verification, never MONEYLINE", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1 -1.5",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].line, "-1.5");
});

test("end-to-end: 'Арсенал Ф1:-1.5 ставка 10' shape (colon-separated embedded line) — SPREAD, routes only to spread verification, never MONEYLINE", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1:-1.5",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].line, "-1.5");
});

test("end-to-end: 'Арсенал Ф2(+1) ставка 10' shape (positive line) — SPREAD, routes only to spread verification, never MONEYLINE", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф2(+1)",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.line, "1"); // normalizeLineString strips the redundant "+" (unsigned means positive)

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].line, "1");
});

test("end-to-end: full fixture 'Арсенал — Ковентри' + participant-attributed 'Арсенал Ф1' selection, line stated separately — SPREAD, correct participant, routes only to spread verification, never MONEYLINE (the exact production incident's shape, now correctly verifiable under Handicap Stage H1)", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал — Ковентри",
    selection: "Арсенал Ф1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.line, "-1.5");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.event.participants.length, 2);
  assert.equal(request.selection.event.participants[0].name, "Арсенал");
  assert.equal(request.selection.event.participants[1].name, "Ковентри");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0, "the exact production incident's fixture must never reach the h2h 'team to win' verifier");
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Арсенал");
  assert.equal(spreadCalls[0].line, "-1.5");
});

test("end-to-end: full fixture 'Арсенал — Ковентри' + completely bare 'Ф1' selection (no participant anywhere in the text) — still safely rejected, never a guessed participant, never MONEYLINE", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал — Ковентри",
    selection: "Ф1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.line, "-1.5");
  // classifyBettingSelectionText never guesses which of the two known
  // participants an unattributed bare token belongs to — participant stays
  // unset rather than being fabricated from event context.
  assert.equal(request.selection.participant, undefined);

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0, "the exact production incident's fixture must never reach the h2h 'team to win' verifier");
});

test("end-to-end sanity check: 'Арсенал победа ставка 10' is completely unaffected — still a real, verifiable MONEYLINE selection", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал — Ковентри",
    selection: "Арсенал победа",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.participant?.name, "Арсенал");

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const provider = new TheOddsApiProvider(fn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1, "a real, supported MONEYLINE selection must still reach the h2h verifier exactly once");
});

/* -------------------------------------------------------------------------- */
/* BA-2C, Step 1C — production regression fix: the actual production        */
/* incident's shape (Latin "F1"/"Arsenal F1" as the AI's own romanization of */
/* the player's Cyrillic "Ф1") is now correctly classified as SPREAD and     */
/* safely rejected as unsupported — never a fabricated "Arsenal Win"        */
/* MONEYLINE selection priced at a real market odds.                        */
/* -------------------------------------------------------------------------- */

test("end-to-end: the exact production incident's shape — event 'Arsenal — Coventry City', selection 'F1', line stated separately — SPREAD, never MONEYLINE, never a verified 'Arsenal Win' price", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "F1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.notEqual(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.selectionType, "PARTICIPANT");
  assert.equal(request.selection.line, "-1.5");

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const provider = new TheOddsApiProvider(fn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  // No participant name appears anywhere in "F1" alone against a
  // two-participant event — validateCanonicalSelection's structural gate
  // ("SPREAD requires participant") fires before the market-support check,
  // exactly the same precedent already established for the bare-Cyrillic
  // case. Either way: FAILED, non-confirmable, never priced.
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0, "must never reach the h2h verifier — must never be priced as a moneyline 'Arsenal Win' selection");
});

test("end-to-end: 'Arsenal F1' (participant-attributed Latin token), line stated separately — SPREAD, participant Arsenal, routes only to spread verification, never MONEYLINE — never priced as 'Arsenal Win'", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal F1",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.notEqual(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  // CRITICAL: the h2h fake is primed to return a plausible "Arsenal Win"
  // price (1.16, the exact number from the real production incident) —
  // proving that even though a MONEYLINE-shaped price WAS available, this
  // SPREAD selection never touched it.
  assert.equal(h2hCalls.length, 0, "must never reach the h2h verifier — this is the exact production incident's fixture and must never be priced as 'Arsenal Win'");
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Arsenal");
  assert.equal(spreadCalls[0].line, "-1.5");
  assert.notEqual(result.currentOdds, "1.16", "must never surface the moneyline price as if it were the spread price");
});

test("end-to-end: 'Arsenal F1(-1.5)' (Latin token with an embedded line, no separate line field) — SPREAD, routes only to spread verification, never MONEYLINE", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal F1(-1.5)",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Arsenal");
  assert.equal(spreadCalls[0].line, "-1.5");
});

test("end-to-end sanity check: 'Арсенал победа ставка 10' remains completely unaffected by the Latin F1/F2 widening", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Арсенал победа",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.participant?.name, "Арсенал");

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const provider = new TheOddsApiProvider(fn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1, "a real, supported MONEYLINE selection must still reach the h2h verifier exactly once");
});

/* -------------------------------------------------------------------------- */
/* H3 Production Fix — the SECOND production incident, discovered after      */
/* e7c5303: BA-2D correctly recognized SPREAD, but legacySelectionToCanonicalRequest */
/* (the function that ACTUALLY builds the request real odds verification     */
/* uses) independently reclassified the bare "Арсенал" selection with no     */
/* knowledge of the market hint "Фора" at all, silently reaching             */
/* MONEYLINE_2WAY and pricing it at Arsenal's real moneyline odds (1.16 —    */
/* the exact figure from the real production report). This proves the fix:  */
/* the same request, now built WITH the market hint threaded through, routes*/
/* only to spread verification — h2h is primed with the exact same 1.16     */
/* price and proven never called.                                           */
/* -------------------------------------------------------------------------- */

test("H3 production fix end-to-end: bare 'Арсенал' + market hint 'Фора' + line '-1.5' — canonical SPREAD, routes ONLY to spread verification, h2h (primed with the exact real production price 1.16) is NEVER called", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Арсенал",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.notEqual(request.selection.marketType, "MONEYLINE_2WAY");
  assert.equal(request.selection.participant?.name, "Арсенал");
  assert.equal(request.selection.line, "-1.5");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 0, "must never reach the h2h verifier — this is the exact second production incident's fixture and must never be priced as 'Arsenal Win' at 1.16");
  assert.equal(spreadCalls.length, 1);
  assert.equal(spreadCalls[0].participant, "Арсенал");
  assert.equal(spreadCalls[0].line, "-1.5");
  assert.notEqual(result.currentOdds, "1.16", "must never surface the moneyline price as if it were the spread price");
});

test("H3 production fix end-to-end: EN 'Arsenal' + market hint 'Handicap' + line '-1.5' — same proof, h2h never called even though a throwing fake would catch any accidental call", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal",
    marketRawText: "Handicap",
    submittedOdds: null,
    line: "-1.5",
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");

  // A throwing h2h fake — if this is ever called, the test fails loudly via
  // an unhandled/rejected promise rather than silently, the strongest form
  // of "never called" this test suite's own conventions already use.
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), undefined, capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 })).fn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
});

test("H3 production fix: MONEYLINE safety preserved through the full provider path — 'Arsenal Win' + market hint 'Handicap' still routes to h2h, never spread", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal Win",
    marketRawText: "Handicap",
    submittedOdds: 1.16,
    line: null,
  });
  assert.equal(request.selection.marketType, "MONEYLINE_2WAY");

  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 1, "a real, confident MONEYLINE claim must still reach h2h — the market hint never suppresses a genuine MONEYLINE routing");
  assert.equal(spreadCalls.length, 0);
});

/* ============================================================================
 * Handicap Stage H1 — SPREAD exact-line provider verification.
 * H4-B5 — the old "standard whole/half lines only" capability gate is
 * removed: any exact decimal line (standard OR Asian quarter,
 * ±0.25/±0.75/±1.25/±1.75) now routes to real spread verification the
 * same way. findSpreadOutcome()/verifySpreadOdds() (lib/odds/oddsVerifier.ts)
 * already handled arbitrary exact lines with zero restriction before this
 * stage — removing the gate is the entire production change; this section
 * proves that removal, plus every safety boundary that must remain intact
 * (no MONEYLINE/TOTALS fallback, no rounding/nearest-line substitution,
 * standard-line regression, auto-settlement still deferred).
 * ============================================================================ */

function spreadSelection(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "FOOTBALL",
    event: {
      sport: "FOOTBALL",
      name: "Arsenal vs Coventry City",
      participants: [{ name: "Arsenal" }, { name: "Coventry City" }],
      period: "FULL_GAME",
      homeParticipantIndex: 0,
      awayParticipantIndex: 1,
    },
    marketType: "SPREAD",
    period: "FULL_GAME",
    selectionType: "PARTICIPANT",
    participant: { name: "Arsenal" },
    line: "-1.5",
    submittedOdds: "1.9",
    ...overrides,
  };
}

test("H4-B5: quarter line -1.25 now reaches the real spread verifier and becomes VERIFIED — the old capability gate is gone", async () => {
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "VERIFIED");
  assert.equal(spreadCalls.length, 1, "a quarter line must reach the real spread verifier exactly once, same as a standard line");
  assert.equal(spreadCalls[0].line, "-1.25", "the exact requested line must be forwarded unchanged — never rounded/substituted");
});

test("H4-B5: the full 8-line quarter matrix (±0.25/±0.75/±1.25/±1.75) AND the full standard-line set (0/±0.5/±1/±1.5/±2) are ALL routed to the spread verifier identically — no line-value-based routing distinction remains", async () => {
  const quarterLines = ["-1.75", "-1.25", "-0.75", "-0.25", "0.25", "0.75", "1.25", "1.75"];
  const standardLines = ["-2", "-1.5", "-1", "-0.5", "0", "0.5", "1", "1.5", "2"];

  for (const line of [...quarterLines, ...standardLines]) {
    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
    const result = await provider.verifySelection({ selection: spreadSelection({ line }) });
    assert.equal(result.status, "VERIFIED", `expected ${line} to be routed to and verified by the spread verifier`);
    assert.equal(calls.length, 1, `expected ${line} to reach the spread verifier exactly once`);
    assert.equal(calls[0].line, line, `expected the exact line ${line} to be forwarded unchanged`);
  }
});

test("H4-B5: an unavailable exact quarter line fails safely (SELECTION_NOT_FOUND), it is not merely 'no longer rejected as a quarter line' — no rounding, no nearest-line substitution, no fabricated odds", async () => {
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: 'Could not match spread selection "Arsenal -1.25" for "Arsenal vs Coventry City" (LINE_NOT_AVAILABLE)' }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.equal(result.diagnosticCode, "LEGACY_SPREAD_LINE_NOT_AVAILABLE");
  assert.equal(calls.length, 1, "the spread verifier IS called (this is real verification failing honestly), not a pre-emptive gate rejection");
});

/* ============================================================================
 * H4-B5 — participant safety and multi-team coverage. The requested
 * participant/event must reach the (now single, unified) spread verifier
 * completely unchanged and un-flipped, for a quarter line exactly as it
 * always has for a standard line. Real event resolution now happens
 * entirely inside verifySpreadOddsFn itself (no separate adapter-level
 * mechanism remains) — see oddsVerifier.test.ts for the full
 * fetch-to-matchedEvent parity proof; these adapter-level tests prove what
 * this file is responsible for: the exact input forwarded.
 * ============================================================================ */

test("H4-B5: participant safety — 'Arsenal -1.25' forwards participant 'Arsenal' to the spread verifier, never Coventry, and never mutates the canonical selection", async () => {
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const selection = spreadSelection({ line: "-1.25", participant: { name: "Arsenal" } });
  const snapshotSelection = JSON.parse(JSON.stringify(selection));

  await provider.verifySelection({ selection });

  assert.equal(calls[0].participant, "Arsenal");
  assert.notEqual(calls[0].participant, "Coventry City");
  assert.deepEqual(selection, snapshotSelection, "the canonical selection itself must never be mutated");
});

test("H4-B5: generic multi-team coverage — Real Madrid/Barcelona and Manchester United/Chelsea quarter-line bets each forward their own correct participant/event, unchanged, no hardcoded team-specific logic", async () => {
  const cases: Array<{ eventName: string; home: string; away: string; participant: string }> = [
    { eventName: "Real Madrid vs Barcelona", home: "Real Madrid", away: "Barcelona", participant: "Real Madrid" },
    { eventName: "Manchester United vs Chelsea", home: "Manchester United", away: "Chelsea", participant: "Manchester United" },
  ];

  for (const c of cases) {
    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

    const result = await provider.verifySelection({
      selection: spreadSelection({
        line: "-1.25",
        event: {
          sport: "FOOTBALL",
          name: c.eventName,
          participants: [{ name: c.home }, { name: c.away }],
          period: "FULL_GAME",
          homeParticipantIndex: 0,
          awayParticipantIndex: 1,
        },
        participant: { name: c.participant },
      }),
    });

    assert.equal(result.status, "VERIFIED", c.eventName);
    assert.equal(calls.length, 1, c.eventName);
    assert.equal(calls[0].participant, c.participant, c.eventName);
    assert.equal(calls[0].event, c.eventName, c.eventName);
  }
});

test("H4-B5: standard-line vs quarter-line parity — 'Arsenal -1.5' and 'Arsenal -1.25' forward the IDENTICAL sport+event string to the spread verifier, which is what actually resolves the event — the line value has no bearing on which event is looked up", async () => {
  const { fn: spreadFnStandard, calls: standardCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const standardProvider = new TheOddsApiProvider(undefined, undefined, spreadFnStandard);
  await standardProvider.verifySelection({ selection: spreadSelection({ line: "-1.5" }) });

  const { fn: spreadFnQuarter, calls: quarterCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const quarterProvider = new TheOddsApiProvider(undefined, undefined, spreadFnQuarter);
  await quarterProvider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(standardCalls[0].event, quarterCalls[0].event);
  assert.equal(standardCalls[0].sport, quarterCalls[0].sport);
});

test("H3.1 regression: 'Arsenal -2' (a different standard line) resolves the SAME event as 'Arsenal -1.5' at the full provider level", async () => {
  const spreadFn = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 })).fn;

  const provider1 = new TheOddsApiProvider(undefined, undefined, spreadFn);
  const result1 = await provider1.verifySelection({ selection: spreadSelection({ line: "-1.5" }) });

  const provider2 = new TheOddsApiProvider(undefined, undefined, spreadFn);
  const result2 = await provider2.verifySelection({ selection: spreadSelection({ line: "-2" }) });

  assert.equal(result1.matchedEvent?.event.name, result2.matchedEvent?.event.name);
  assert.equal(result1.matchedEvent?.reference.eventId, result2.matchedEvent?.reference.eventId);
});

/* ============================================================================
 * H4-B5 — natural-language RU/UA/EN full-path: a quarter line now reaches
 * REAL spread verification through legacySelectionToCanonicalRequest ->
 * TheOddsApiProvider.verifySelection, exactly like a standard line already
 * does. H3's own classification behavior (which WORDS mean "SPREAD") is
 * completely unchanged by this stage — only what happens AFTER
 * classification (real verification vs. capability rejection) is different.
 * ============================================================================ */

test("H4-B5 full-path: 'Arsenal handicap -1.5' (EN, natural-language, standard line) still classifies as SPREAD and reaches real spread verification — unchanged regression", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal handicap -1.5",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.5");

  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1, "a standard-line natural-language SPREAD selection must reach the real spread verifier exactly once");
});

test("H4-B5 full-path: 'Arsenal Asian handicap -1.25' (EN, natural-language, quarter line) classifies as SPREAD AND now reaches real spread verification — becomes VERIFIED/confirmable", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal Asian handicap -1.25",
    submittedOdds: 1.91,
  });
  // H3 classification, unchanged: correctly classified as SPREAD, quarter
  // line preserved exactly, never rounded or dropped.
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.25");

  // H4-B5: the gate that used to block this is gone.
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1, "H3 vocabulary recognition now reaches real spread verification for a quarter line too");
  assert.equal(calls[0].line, "-1.25");
  assert.equal(calls[0].participant, "Arsenal");
});

test("H4-B5 full-path: RU 'Арсенал азиатская фора -1.25' and UA 'Арсенал азійська фора -1.25' both classify as SPREAD and reach real spread verification, identically to the EN form — language never affects capability", async () => {
  for (const selection of ["Арсенал азиатская фора -1.25", "Арсенал азійська фора -1.25"]) {
    const request = legacySelectionToCanonicalRequest({
      sport: "Football",
      event: "Arsenal — Coventry City",
      selection,
      submittedOdds: 1.91,
    });
    assert.equal(request.selection.marketType, "SPREAD", selection);
    assert.equal(request.selection.line, "-1.25", selection);

    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
    const result = await provider.verifySelection({ selection: request.selection });

    assert.equal(result.status, "VERIFIED", selection);
    assert.equal(calls.length, 1, selection);
    assert.equal(calls[0].line, "-1.25", selection);
  }
});

test("H4-B5 full-path: RU 'Арсенал фора -1.5' and 'Арсенал азійська фора -1.25' resolve identically (same event/sport forwarded) — the quarter line only changes verification depth, never event routing", async () => {
  const standardRequest = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Фора",
    submittedOdds: null,
    line: "-1.5",
  });
  const { fn: standardSpreadFn, calls: standardCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const standardProvider = new TheOddsApiProvider(undefined, undefined, standardSpreadFn);
  await standardProvider.verifySelection({ selection: standardRequest.selection });

  const quarterRequest = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Ковентрі",
    selection: "Арсенал",
    marketRawText: "Азійська фора",
    submittedOdds: null,
    line: "-1.25",
  });
  assert.equal(quarterRequest.selection.marketType, "SPREAD");
  assert.equal(quarterRequest.selection.line, "-1.25");

  const { fn: quarterSpreadFn, calls: quarterCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const quarterProvider = new TheOddsApiProvider(undefined, undefined, quarterSpreadFn);
  await quarterProvider.verifySelection({ selection: quarterRequest.selection });

  assert.equal(standardCalls[0].event, quarterCalls[0].event);
  assert.equal(standardCalls[0].sport, quarterCalls[0].sport);
});

/* -------------------------------------------------------------------------- */
/* H4-B5 — MONEYLINE/TOTALS regression: unaffected by SPREAD gate removal.   */
/* -------------------------------------------------------------------------- */

test("H4-B5 regression: MONEYLINE verification is completely unaffected by the SPREAD gate removal", async () => {
  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const provider = new TheOddsApiProvider(h2hFn);

  const moneylineSelection: CanonicalSelection = {
    sport: "FOOTBALL",
    event: { sport: "FOOTBALL", name: "Arsenal vs Coventry City", participants: [{ name: "Arsenal" }, { name: "Coventry City" }], period: "FULL_GAME", homeParticipantIndex: 0, awayParticipantIndex: 1 },
    marketType: "MONEYLINE_2WAY",
    period: "FULL_GAME",
    selectionType: "PARTICIPANT",
    participant: { name: "Arsenal" },
    submittedOdds: "1.16",
  };

  const result = await provider.verifySelection({ selection: moneylineSelection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 1);
});

test("H4-B5 regression: TOTALS verification is completely unaffected by the SPREAD gate removal", async () => {
  const { fn: totalsFn, calls: totalsCalls } = capturingVerifyTotalsOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const provider = new TheOddsApiProvider(undefined, totalsFn);

  const totalsSelection: CanonicalSelection = {
    sport: "FOOTBALL",
    event: { sport: "FOOTBALL", name: "Arsenal vs Coventry City", participants: [{ name: "Arsenal" }, { name: "Coventry City" }], period: "FULL_GAME", homeParticipantIndex: 0, awayParticipantIndex: 1 },
    marketType: "TOTALS",
    period: "FULL_GAME",
    selectionType: "OVER",
    line: "2.5",
    submittedOdds: "1.9",
  };

  const result = await provider.verifySelection({ selection: totalsSelection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(totalsCalls.length, 1);
});

test("Handicap H1: no MONEYLINE fallback when the spread verifier itself fails to find a price — FAILED, non-confirmable, h2h never attempted", async () => {
  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: 'Could not match spread selection "Arsenal -1.5" for "Arsenal vs Coventry City" (LINE_NOT_AVAILABLE)' }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.equal(result.diagnosticCode, "LEGACY_SPREAD_LINE_NOT_AVAILABLE");
  assert.equal(h2hCalls.length, 0, "an unavailable spread price must NEVER fall back to h2h/moneyline verification, under any failure condition");
  assert.equal(spreadCalls.length, 1);
});

test("Handicap H1: no MONEYLINE fallback when the spread provider itself is unavailable (network/HTTP failure) — FAILED, h2h never attempted", async () => {
  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.16 }));
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: "The Odds API request failed with status 500" }),
  );
  const provider = new TheOddsApiProvider(h2hFn, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(h2hCalls.length, 0);
  assert.equal(spreadCalls.length, 1);
});

test("Handicap H1: wrong participant — SELECTION_NOT_FOUND, never falls back to a different market or team", async () => {
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: 'Could not match spread selection "Arsenal -1.5" for "Arsenal vs Coventry City" (PARTICIPANT_NOT_FOUND)' }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.equal(result.diagnosticCode, "LEGACY_SPREAD_PARTICIPANT_NOT_FOUND");
  assert.equal(calls.length, 1);
});

test("Handicap H1: spreads market absent on the bookmaker — SELECTION_NOT_FOUND", async () => {
  const { fn: spreadFn } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: 'Could not match spread selection "Arsenal -1.5" for "Arsenal vs Coventry City" (MARKET_ABSENT)' }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.diagnosticCode, "LEGACY_SPREAD_MARKET_ABSENT");
});

test("Handicap H1: provider reference metadata for a VERIFIED spread — provider/providerEventId/bookmaker/market/line/participant all populated, mirroring MONEYLINE/TOTALS exactly", async () => {
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn({
    matched: true,
    withinTolerance: true,
    sourceOdds: 1.85,
    submittedOdds: 1.9,
    discrepancyPercent: -2.63,
    bookmaker: "Pinnacle",
    note: null,
    providerEventId: "evt-spread-meta",
    providerSportKey: "soccer_epl",
    eventStartTime: "2026-08-15T18:00:00.000Z",
    homeTeamName: "Arsenal",
    awayTeamName: "Coventry City",
    competitionName: "Premier League",
  });
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.provider, "THE_ODDS_API");
  assert.equal(result.matchedEvent?.reference.eventId, "evt-spread-meta");
  assert.equal(result.matchedEvent?.reference.sportKey, "soccer_epl");
  assert.equal(result.matchedEvent?.event.participants[0]?.name, "Arsenal");
  assert.equal(result.matchedEvent?.event.participants[1]?.name, "Coventry City");
  assert.equal(result.bookmaker, "Pinnacle");
  assert.equal(result.matchedOutcome?.marketType, "SPREAD");
  assert.equal(result.matchedOutcome?.line, "-1.5");
  assert.equal(result.matchedOutcome?.participant?.name, "Arsenal");
  assert.equal(result.matchedOutcome?.marketReference?.marketKey, "spreads");
  assert.equal(result.matchedOutcome?.currentOdds, "1.85");
  assert.equal(calls.length, 1);
});

test("Handicap H1: a standard-line SPREAD selection never reaches h2h even when h2h is wired to throw on any call — a stronger proof than a call-count assertion alone", async () => {
  const { fn: spreadFn } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection() });

  assert.equal(result.status, "VERIFIED", "if h2h had been called, throwingVerifyOddsFn would have thrown and this test would fail with an unhandled rejection instead of reaching this assertion");
});

/* ============================================================================
 * H4-B5, Sections 10/11 — MONEYLINE/TOTALS fallback must be IMPOSSIBLE for a
 * quarter-line SPREAD request, in BOTH the successful-verification case and
 * the exact-line-unavailable case. A throwing h2h/totals fake is a stronger
 * proof than a call-count assertion alone: if either were ever called, the
 * throw would surface as an unhandled rejection instead of the assertion
 * below being reached at all.
 * ============================================================================ */

test("H4-B5: a quarter-line SPREAD request that successfully VERIFIES never reaches h2h, even when h2h is wired to throw on any call", async () => {
  const { fn: spreadFn } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "VERIFIED", "if h2h had been called, throwingVerifyOddsFn would have thrown");
});

test("H4-B5: a quarter-line SPREAD request whose exact line is UNAVAILABLE still never reaches h2h — non-confirmable, never a MONEYLINE substitution", async () => {
  const { fn: spreadFn } = capturingVerifySpreadOddsFn(
    baseLegacyResult({ note: 'Could not match spread selection "Arsenal -1.25" for "Arsenal vs Coventry City" (LINE_NOT_AVAILABLE)' }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "FAILED", "if h2h had been called, throwingVerifyOddsFn would have thrown");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
});

test("H4-B5: a quarter-line SPREAD request never reaches TOTALS verification, even when TOTALS is wired to throw on any call — no SPREAD request may silently become TOTALS", async () => {
  const { fn: spreadFn } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.91 }));
  const throwingTotalsFn: typeof import("./oddsVerifier").verifyTotalsOdds = (async () => {
    throw new Error("verifyTotalsOddsFn must never be called for a SPREAD selection");
  }) as typeof import("./oddsVerifier").verifyTotalsOdds;
  const provider = new TheOddsApiProvider(undefined, throwingTotalsFn, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "VERIFIED", "if TOTALS verification had been called, throwingTotalsFn would have thrown");
});

test("Handicap H1: capabilities advertise SPREAD only now that real routing exists — never advertised without a working verifySpreadOddsFn path", () => {
  const provider = new TheOddsApiProvider();
  assert.ok(provider.getCapabilities().supportedMarketTypes.includes("SPREAD"));
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

test("adapter mapping: never fabricates providerTimestamp — legacy provides none", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0, bookmaker: "Pinnacle" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.providerTimestamp, undefined);
});

test("adapter mapping: matchedEvent stays undefined when legacy carries no provider event metadata (Stage 3.1 fields absent from the fixture)", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0, bookmaker: "Pinnacle" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.matchedEvent, undefined, "no providerEventId/providerSportKey on the legacy result means nothing to honestly construct matchedEvent from");
});

// Stage 3.1 — matchedOutcome is populated from data the adapter already
// legitimately has (the already-validated CanonicalSelection it was given,
// plus the real matched price) — this is NOT fabrication, and is
// independent of whether matchedEvent could be built (that depends only on
// provider event metadata, a separate concern).
test("adapter mapping: matchedOutcome IS populated from the canonical selection + matched price, independent of matchedEvent", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0, bookmaker: "Pinnacle" }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.deepEqual(result.matchedOutcome, {
    marketType: "MONEYLINE_3WAY",
    period: "FULL_GAME",
    selectionType: "HOME",
    participant: undefined,
    // Betting Markets V1, Phase 3.3 — line is now always present on
    // ProviderOutcome (undefined for every non-TOTALS market, populated
    // only for TOTALS — see buildMatchedOutcome's own comment).
    line: undefined,
    currentOdds: "2",
    bookmaker: "Pinnacle",
    marketReference: { provider: "THE_ODDS_API", marketKey: "h2h" },
  });
  assert.equal(result.matchedOutcome?.outcomeReference, undefined, "never a synthetic outcome id — The Odds API has no stable outcome id/key");
});

test("adapter mapping: a null legacy bookmaker never becomes a fabricated string", async () => {
  const { fn } = capturingVerifyOddsFn(baseLegacyResult({ note: "The Odds API request timed out after 8000ms", bookmaker: null }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.bookmaker, undefined);
});

/* -------------------------------------------------------------------------- */
/* Betting Markets V1, Phase 3.3 — TOTALS routed through verifyTotalsOddsFn   */
/* -------------------------------------------------------------------------- */

function totalsSelection(overrides: Partial<CanonicalSelection> = {}): CanonicalSelection {
  return {
    sport: "FOOTBALL",
    event: FOOTBALL_EVENT,
    marketType: "TOTALS",
    period: "FULL_GAME",
    selectionType: "OVER",
    line: "2.5",
    submittedOdds: "1.9",
    ...overrides,
  };
}

test("adapter mapping: TOTALS routes to verifyTotalsOddsFn, never verifyOddsFn (h2h)", async () => {
  const { fn: totalsFn, calls: totalsCalls } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection() });

  assert.equal(result.status, "VERIFIED");
  assert.equal(totalsCalls.length, 1);
  assert.equal(totalsCalls[0].direction, "OVER");
  assert.equal(totalsCalls[0].line, "2.5");
  assert.equal(totalsCalls[0].sport, "football");
  assert.equal(totalsCalls[0].event, "Manchester United vs Chelsea");
  assert.equal(totalsCalls[0].odds, 1.9);
});

test("adapter mapping: TOTALS UNDER routes direction through correctly", async () => {
  const { fn: totalsFn, calls: totalsCalls } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.95, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  await provider.verifySelection({ selection: totalsSelection({ selectionType: "UNDER", line: "3.5" }) });

  assert.equal(totalsCalls[0].direction, "UNDER");
  assert.equal(totalsCalls[0].line, "3.5");
});

test("adapter mapping: TOTALS VERIFIED result carries matchedOutcome with marketReference.marketKey 'totals' and the canonical line", async () => {
  const { fn: totalsFn } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection() });

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.matchedOutcome?.marketType, "TOTALS");
  assert.equal(result.matchedOutcome?.selectionType, "OVER");
  assert.equal(result.matchedOutcome?.line, "2.5");
  assert.deepEqual(result.matchedOutcome?.marketReference, { provider: "THE_ODDS_API", marketKey: "totals" });
});

test("adapter mapping: TOTALS ODDS_CHANGED when the legacy result is matched but outside tolerance", async () => {
  const { fn: totalsFn } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: false, sourceOdds: 2.5, bookmaker: "Pinnacle", discrepancyPercent: 31.58 }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection() });

  assert.equal(result.status, "ODDS_CHANGED");
  assert.equal(result.currentOdds, "2.5");
});

test("adapter mapping: a TOTALS-specific legacy failure note classifies to FAILED/SELECTION_NOT_FOUND, never a misleading VERIFIED", async () => {
  const { fn: totalsFn } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ note: 'Could not match totals selection "OVER 2.5" for "Manchester United vs Chelsea" (LINE_NOT_AVAILABLE)' }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
});

test("adapter mapping: TOTALS event-not-found classifies identically to h2h's own EVENT_NOT_FOUND", async () => {
  const { fn: totalsFn } = capturingVerifyTotalsOddsFn(
    baseLegacyResult({ note: 'No matching event found for "Manchester United vs Chelsea" in soccer_epl' }),
  );
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "EVENT_NOT_FOUND");
});

test("adapter mapping: TOTALS with no line at all fails structural validation (INVALID_INPUT) before ever reaching verifyTotalsOddsFn", async () => {
  const { fn: totalsFn, calls } = capturingVerifyTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(throwingVerifyOddsFn(), totalsFn);

  const result = await provider.verifySelection({ selection: totalsSelection({ line: undefined }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "INVALID_INPUT");
  assert.equal(calls.length, 0);
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

test("football league resolution: an unrecognized football league returns LEAGUE_NOT_SUPPORTED and never calls the provider (Step 16A — no more silent EPL/generic fallback)", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.0 }));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Europa League" } }) });

  assert.equal(calls.length, 0, "an unsupported league must never reach the provider — no unrelated competition is ever queried");
  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "LEAGUE_NOT_SUPPORTED");
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
  // Step 16A — "La  Ligaa" is not an exact recognized name (extra
  // whitespace normalizes away, but the trailing "aa" typo does not) —
  // LEAGUE_NOT_SUPPORTED, never a silent fallback to an unrelated
  // competition.
  const result = await provider.verifySelection({ selection: moneyline3Way({ league: { name: "La  Ligaa" } }) });
  assert.equal(calls.length, 0);
  assert.equal(result.reasonCode, "LEAGUE_NOT_SUPPORTED");
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

/* -------------------------------------------------------------------------- */
/* Step 15H — submittedOdds: null (provider-price lookup, adapter wiring)     */
/* -------------------------------------------------------------------------- */

test("Step 15H: submittedOdds:null + successful lookup returns a VERIFIED result carrying the provider-promoted price", async () => {
  const { fn, calls } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.15,
      submittedOdds: 2.15, // Step 15G's own promotion: price adopted as submittedOdds
      discrepancyPercent: 0,
      bookmaker: "Pinnacle",
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].odds, null);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.currentOdds, "2.15");
  assert.equal(result.submittedOdds, "2.15", "the promoted provider price, not the original null request value");
  assert.equal(result.acceptedOdds, "2.15");
  assert.equal(result.bookmaker, "Pinnacle");
});

test("Step 15H: submittedOdds:null + event not found preserves null submitted odds (no fabricated value)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: false,
      submittedOdds: null, // Step 15G: nothing to promote on a failed lookup
      note: `No matching event found for "Manchester United vs Chelsea" in soccer_epl`,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "EVENT_NOT_FOUND");
  assert.equal(result.submittedOdds, null);
});

test("Step 15H: submittedOdds:null + selection not found preserves null submitted odds (no fabricated value)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: false,
      submittedOdds: null,
      bookmaker: "Pinnacle",
      note: `Could not match selection "1" to a bookmaker outcome`,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.equal(result.submittedOdds, null);
});

test("Step 15H: submittedOdds:null + provider unavailable preserves the existing provider failure result", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: false,
      submittedOdds: null,
      note: "ODDS_API_KEY is not configured",
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: undefined }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.submittedOdds, null);
});

test("Step 15H: numeric submittedOdds is never round-tripped through Number/String — original request string preserved exactly", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.1, submittedOdds: 2.1, discrepancyPercent: 0 }),
  );
  const provider = new TheOddsApiProvider(fn);

  // "2.10" would lose its trailing zero if re-stringified from a parsed
  // Number (2.1) instead of being passed through as the original string.
  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.10" }) });

  assert.equal(result.submittedOdds, "2.10");
});

// ---------------------------------------------------------------------
// Stage 3.1 — provider event references (matchedEvent) end to end through
// the adapter, given a legacy result carrying oddsVerifier.ts's own new
// providerEventId/providerSportKey/eventStartTime fields.
// ---------------------------------------------------------------------

const PROVIDER_EVENT_ID = "evt-provider-abc123";
const PROVIDER_SPORT_KEY = "soccer_epl";
const EVENT_START_TIME = "2026-08-15T18:00:00.000Z";

test("Stage 3.1: VERIFIED contains matchedEvent when the legacy result carries provider event metadata", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.15,
      bookmaker: "Pinnacle",
      providerEventId: PROVIDER_EVENT_ID,
      providerSportKey: PROVIDER_SPORT_KEY,
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }) });

  assert.equal(result.status, "VERIFIED");
  assert.ok(result.matchedEvent, "matchedEvent must be present");
  assert.equal(result.matchedEvent?.reference.eventId, PROVIDER_EVENT_ID);
  assert.equal(result.matchedEvent?.reference.sportKey, PROVIDER_SPORT_KEY);
  assert.equal(result.matchedEvent?.reference.provider, "THE_ODDS_API");
  assert.equal(result.matchedEvent?.event.startTime, EVENT_START_TIME);
});

test("Stage 3.1: ODDS_CHANGED contains matchedEvent when the legacy result carries provider event metadata", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: false,
      sourceOdds: 2.15,
      discrepancyPercent: 16.28,
      bookmaker: "Pinnacle",
      providerEventId: PROVIDER_EVENT_ID,
      providerSportKey: PROVIDER_SPORT_KEY,
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.50" }) });

  assert.equal(result.status, "ODDS_CHANGED");
  assert.ok(result.matchedEvent, "matchedEvent must be present");
  assert.equal(result.matchedEvent?.reference.eventId, PROVIDER_EVENT_ID);
  assert.equal(result.matchedEvent?.reference.sportKey, PROVIDER_SPORT_KEY);
});

test("Stage 3.1: ProviderEventReference.eventId is exactly legacyResult.providerEventId — never synthesized, never derived from event text", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.15,
      providerEventId: "some-opaque-provider-id-9f8e7d",
      providerSportKey: PROVIDER_SPORT_KEY,
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }) });

  assert.equal(result.matchedEvent?.reference.eventId, "some-opaque-provider-id-9f8e7d");
});

test("Stage 3.1: ProviderEventReference.sportKey is exactly the endpoint key the legacy layer reports — never re-derived from league/sport display text", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.15,
      providerEventId: PROVIDER_EVENT_ID,
      providerSportKey: "soccer_italy_serie_a",
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ league: { name: "Serie A" }, submittedOdds: "2.15" }) });

  assert.equal(result.matchedEvent?.reference.sportKey, "soccer_italy_serie_a");
});

test("Stage 3.1: canonical matchedEvent.event.startTime is exactly legacyResult.eventStartTime (the provider's own commence_time, already ISO-normalized upstream)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: true,
      withinTolerance: true,
      sourceOdds: 2.15,
      providerEventId: PROVIDER_EVENT_ID,
      providerSportKey: PROVIDER_SPORT_KEY,
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }) });

  assert.equal(result.matchedEvent?.event.startTime, EVENT_START_TIME);
});

test("Stage 3.1: no synthetic provider IDs — matchedEvent absent when legacy result has no providerEventId, even though the event genuinely matched", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.15, bookmaker: "Pinnacle" }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way({ submittedOdds: "2.15" }) });

  assert.equal(result.status, "VERIFIED", "sanity: the check itself still succeeds without provider event metadata");
  assert.equal(result.matchedEvent, undefined, "must never fabricate an id from the event name, team names, or anything else");
});

test("Stage 3.1: matchedEvent is also present on a FAILED result when the event was found but the selection/bookmaker didn't match", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({
      matched: false,
      note: 'Could not match selection "X" to a bookmaker outcome',
      bookmaker: "Pinnacle",
      providerEventId: PROVIDER_EVENT_ID,
      providerSportKey: PROVIDER_SPORT_KEY,
      eventStartTime: EVENT_START_TIME,
    }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
  assert.ok(result.matchedEvent, "the event was genuinely found, even though the selection wasn't — matchedEvent must still be present");
  assert.equal(result.matchedEvent?.reference.eventId, PROVIDER_EVENT_ID);
  assert.equal(result.matchedOutcome, undefined, "no price was ever matched, so there is nothing honest to build matchedOutcome from");
});

test("Stage 3.1: matchedEvent is absent on a FAILED result when the event itself was never found (EVENT_NOT_FOUND)", async () => {
  const { fn } = capturingVerifyOddsFn(
    baseLegacyResult({ matched: false, note: 'No matching event found for "X vs Y" in soccer_epl' }),
  );
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "EVENT_NOT_FOUND");
  assert.equal(result.matchedEvent, undefined);
});

/* ============================================================================
 * Individual Team Totals, Stage 3 — production-path proof. Both the RU
 * shorthand form and the EN natural-language form must reach the SAME
 * canonical verification request shape (TEAM_TOTAL/participant/OVER-UNDER/
 * exact line) through the REAL production bridge
 * (legacySelectionToCanonicalRequest, the function buildBetSlipPreview.ts
 * actually calls) and this adapter's verifySelection() — never a separate,
 * parallel code path.
 * ============================================================================ */

test("Individual Team Totals Stage 3 (19): RU 'Марсель ТБ 1,5' (comma decimal) reaches TEAM_TOTAL verification as Marseille/OVER/1.5", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Ligue 1",
    event: "Марсель vs Страсбург",
    selection: "Марсель ТБ 1,5",
    submittedOdds: null,
  });

  assert.equal(request.selection.marketType, "TEAM_TOTAL");
  assert.equal(request.selection.participant?.name, "Марсель");
  assert.equal(request.selection.line, "1.5", "the comma must already be canonicalized to a dot by the time it reaches the provider request");

  const { fn: teamTotalFn, calls } = capturingVerifyTeamTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.53 }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, undefined, teamTotalFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].participant, "Марсель");
  assert.equal(calls[0].direction, "OVER");
  assert.equal(calls[0].line, "1.5");
});

test("Individual Team Totals Stage 3 (20): EN 'Marseille Over 1.5' — the exact verified production bug input — reaches the SAME canonical verification request shape", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Ligue 1",
    event: "Marseille vs Strasbourg",
    selection: "Marseille Over 1.5",
    submittedOdds: null,
  });

  assert.equal(request.selection.marketType, "TEAM_TOTAL");
  assert.equal(request.selection.participant?.name, "Marseille");
  assert.equal(request.selection.line, "1.5");

  const { fn: teamTotalFn, calls } = capturingVerifyTeamTotalsOddsFn(
    baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.53 }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, undefined, teamTotalFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].participant, "Marseille");
  assert.equal(calls[0].direction, "OVER");
  assert.equal(calls[0].line, "1.5");
});

test("Individual Team Totals Stage 3 (15): existing MONEYLINE behavior is completely unaffected — a MONEYLINE_3WAY selection still routes only to verifyOddsFn", async () => {
  const { fn: h2hFn, calls: h2hCalls } = capturingVerifyOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 2.1 }));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(h2hFn, undefined, undefined, teamTotalFn);

  const result = await provider.verifySelection({ selection: moneyline3Way() });

  assert.equal(result.status, "VERIFIED");
  assert.equal(h2hCalls.length, 1);
  assert.equal(teamTotalCalls.length, 0, "TEAM_TOTAL's verifier must never be called for a MONEYLINE selection");
});

test("Individual Team Totals Stage 3 (16): existing bare TOTALS behavior is completely unaffected — routes only to verifyTotalsOddsFn, never verifyTeamTotalsOddsFn", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal vs Chelsea",
    selection: "Over 2.5",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "TOTALS");

  const { fn: totalsFn, calls: totalsCalls } = capturingVerifyTotalsOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.8 }));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(undefined, totalsFn, undefined, teamTotalFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(totalsCalls.length, 1);
  assert.equal(teamTotalCalls.length, 0, "TEAM_TOTAL's verifier must never be called for a bare TOTALS selection");
});

test("Individual Team Totals Stage 3 (17): existing SPREAD behavior is completely unaffected — routes only to verifySpreadOddsFn, never verifyTeamTotalsOddsFn", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1(-1.5)",
    submittedOdds: null,
  });
  assert.equal(request.selection.marketType, "SPREAD");

  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
  const { fn: teamTotalFn, calls: teamTotalCalls } = capturingVerifyTeamTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn, teamTotalFn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "VERIFIED");
  assert.equal(spreadCalls.length, 1);
  assert.equal(teamTotalCalls.length, 0, "TEAM_TOTAL's verifier must never be called for a SPREAD selection");
});

test("Individual Team Totals Stage 3: TEAM_TOTAL for a non-football sport is not yet supported — FAILED/MARKET_NOT_SUPPORTED, same football-only restriction as TOTALS", async () => {
  const { fn: teamTotalFn, calls } = capturingVerifyTeamTotalsOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(undefined, undefined, undefined, teamTotalFn);

  const result = await provider.verifySelection({
    selection: {
      sport: "TENNIS",
      event: TENNIS_EVENT,
      marketType: "TEAM_TOTAL",
      period: "MATCH",
      selectionType: "OVER",
      participant: { name: "Carlos Alcaraz" },
      line: "22.5",
      submittedOdds: undefined,
    },
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

test("Individual Team Totals Stage 3: an unavailable TEAM_TOTAL result classifies as SELECTION_NOT_FOUND, never a generic/unclassified failure", async () => {
  const { fn: teamTotalFn } = capturingVerifyTeamTotalsOddsFn(
    baseLegacyResult({ matched: false, note: 'Could not match team total selection "Marseille OVER 1.5" for "Marseille vs Strasbourg" (LINE_NOT_AVAILABLE)' }),
  );
  const provider = new TheOddsApiProvider(undefined, undefined, undefined, teamTotalFn);

  const request = legacySelectionToCanonicalRequest({
    sport: "Ligue 1",
    event: "Marseille vs Strasbourg",
    selection: "Marseille Over 1.5",
    submittedOdds: null,
  });

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "SELECTION_NOT_FOUND");
});
