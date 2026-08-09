import { test } from "node:test";
import assert from "node:assert/strict";
import { TheOddsApiProvider } from "./theOddsApiProvider";
import type { CanonicalEvent, CanonicalSelection } from "./domain";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { OddsVerificationInput, TotalsVerificationInput, SpreadVerificationInput } from "./oddsVerifier";
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

test("capabilities: moneyline + totals + spread markets are advertised — BTTS/double-chance are not current (Betting Markets V1 Phase 3.3 + Handicap Stage H1 — TOTALS and SPREAD now intentionally supported)", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.deepEqual(capabilities.supportedMarketTypes.slice().sort(), ["MONEYLINE_2WAY", "MONEYLINE_3WAY", "TOTALS", "SPREAD"].sort());
  for (const notCurrent of ["BOTH_TEAMS_TO_SCORE", "DOUBLE_CHANCE", "TEAM_TOTAL"] as const) {
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

test("end-to-end: 'Арсенал ИТБ 1.5' (TEAM_TOTAL shorthand) is classified correctly and safely rejected as MARKET_NOT_SUPPORTED — never becomes a MONEYLINE bet", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал ИТБ 1.5",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "TEAM_TOTAL");

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0, "the h2h verifier must never be called for an unsupported market");
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

/* ============================================================================
 * Handicap Stage H1 — SPREAD exact-line provider verification.
 * Standard whole/half lines only; quarter lines remain non-confirmable.
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

test("Handicap H1: quarter line -1.25 is non-confirmable — MARKET_NOT_SUPPORTED, and the spread verifier is never even called (capability gate fires first)", async () => {
  const { fn: spreadFn, calls: spreadCalls } = capturingVerifySpreadOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);

  const result = await provider.verifySelection({ selection: spreadSelection({ line: "-1.25" }) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(result.diagnosticCode, "ADAPTER_SPREAD_QUARTER_LINE_UNSUPPORTED_H1");
  assert.equal(spreadCalls.length, 0, "H1's capability gate must reject a quarter line BEFORE any provider call — the market stays SPREAD, only verification is skipped");
});

test("Handicap H1: every quarter line in the required set (±0.25/±0.75/±1.25/±1.75) is rejected; every standard line in the required set (0/±0.5/±1/±1.5/±2) is routed to the spread verifier", async () => {
  const quarterLines = ["-1.75", "-1.25", "-0.75", "-0.25", "0.25", "0.75", "1.25", "1.75"];
  const standardLines = ["-2", "-1.5", "-1", "-0.5", "0", "0.5", "1", "1.5", "2"];

  for (const line of quarterLines) {
    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({}));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
    const result = await provider.verifySelection({ selection: spreadSelection({ line }) });
    assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED", `expected ${line} to be rejected as a quarter line`);
    assert.equal(calls.length, 0, `expected ${line} to never reach the spread verifier`);
  }

  for (const line of standardLines) {
    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({ matched: true, withinTolerance: true, sourceOdds: 1.9 }));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
    const result = await provider.verifySelection({ selection: spreadSelection({ line }) });
    assert.equal(result.status, "VERIFIED", `expected ${line} to be routed to and verified by the spread verifier`);
    assert.equal(calls.length, 1, `expected ${line} to reach the spread verifier exactly once`);
  }
});

/* ============================================================================
 * Handicap Stage H3 — natural-language RU/UA/EN handicap vocabulary.
 * Critical full-path proof (Section 13): H3 only widens which WORDS a
 * player can use to say "SPREAD" — it must have ZERO effect on H1's own
 * capability gate. A standard-line natural-language selection reaches real
 * spread verification exactly like Ф1/Ф2 already does; a quarter-line
 * natural-language selection is classified as SPREAD (H3 works) but is
 * STILL rejected as MARKET_NOT_SUPPORTED before any provider call (H1's
 * gate, completely untouched by this stage).
 * ============================================================================ */

test("Handicap H3 full-path: 'Arsenal handicap -1.5' (natural-language, standard line) classifies as SPREAD and reaches real spread verification, exactly like 'Arsenal F1(-1.5)' already does", async () => {
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

test("Handicap H3 full-path: 'Arsenal Asian handicap -1.25' (natural-language, quarter line) classifies as SPREAD but is rejected as MARKET_NOT_SUPPORTED by H1's UNCHANGED capability gate — the spread verifier is never called, and it never becomes confirmable", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Arsenal — Coventry City",
    selection: "Arsenal Asian handicap -1.25",
    submittedOdds: 1.9,
  });
  // H3 proof: correctly classified as SPREAD, quarter line preserved
  // exactly, never rounded or dropped.
  assert.equal(request.selection.marketType, "SPREAD");
  assert.equal(request.selection.participant?.name, "Arsenal");
  assert.equal(request.selection.line, "-1.25");

  // H1 proof (unchanged): the exact same gate that already blocks
  // "Арсенал Ф1(-1.25)" blocks this natural-language form too.
  const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(result.diagnosticCode, "ADAPTER_SPREAD_QUARTER_LINE_UNSUPPORTED_H1");
  assert.equal(calls.length, 0, "H3 vocabulary recognition must never bypass H1's quarter-line capability gate");
});

test("Handicap H3 full-path: RU 'Арсенал азиатская фора -1.25' and UA 'Арсенал азійська фора -1.25' both hit the identical H1 quarter-line gate as the EN form — language never affects capability", async () => {
  for (const selection of ["Арсенал азиатская фора -1.25", "Арсенал азійська фора -1.25"]) {
    const request = legacySelectionToCanonicalRequest({
      sport: "Football",
      event: "Arsenal — Coventry City",
      selection,
      submittedOdds: 1.9,
    });
    assert.equal(request.selection.marketType, "SPREAD", selection);
    assert.equal(request.selection.line, "-1.25", selection);

    const { fn: spreadFn, calls } = capturingVerifySpreadOddsFn(baseLegacyResult({}));
    const provider = new TheOddsApiProvider(undefined, undefined, spreadFn);
    const result = await provider.verifySelection({ selection: request.selection });

    assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED", selection);
    assert.equal(result.diagnosticCode, "ADAPTER_SPREAD_QUARTER_LINE_UNSUPPORTED_H1", selection);
    assert.equal(calls.length, 0, selection);
  }
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
