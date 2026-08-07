import { test } from "node:test";
import assert from "node:assert/strict";
import { TheOddsApiProvider } from "./theOddsApiProvider";
import type { CanonicalEvent, CanonicalSelection } from "./domain";
import type { OddsCheckResult } from "@/types/oddsSnapshot";
import type { OddsVerificationInput, TotalsVerificationInput } from "./oddsVerifier";
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

test("capabilities: moneyline + totals markets are advertised — spread/BTTS/double-chance are not current (Betting Markets V1, Phase 3.3 — TOTALS now intentionally supported)", () => {
  const provider = new TheOddsApiProvider();
  const capabilities = provider.getCapabilities();

  assert.deepEqual(capabilities.supportedMarketTypes.slice().sort(), ["MONEYLINE_2WAY", "MONEYLINE_3WAY", "TOTALS"].sort());
  for (const notCurrent of ["SPREAD", "BOTH_TEAMS_TO_SCORE", "DOUBLE_CHANCE"] as const) {
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

test("adapter mapping: an unsupported market (SPREAD) never reaches the legacy verifier — FAILED/MARKET_NOT_SUPPORTED", async () => {
  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({
    selection: moneyline3Way({ marketType: "SPREAD", selectionType: "HOME", participant: { name: "Manchester United" }, line: "-1.5" }),
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

test("end-to-end: 'Арсенал Ф1(-1.5)' (SPREAD shorthand) is classified correctly and safely rejected as MARKET_NOT_SUPPORTED — never becomes a MONEYLINE bet", async () => {
  const request = legacySelectionToCanonicalRequest({
    sport: "Football",
    event: "Арсенал vs Челси",
    selection: "Арсенал Ф1(-1.5)",
    submittedOdds: 1.9,
  });
  assert.equal(request.selection.marketType, "SPREAD");

  const { fn, calls } = capturingVerifyOddsFn(baseLegacyResult({}));
  const provider = new TheOddsApiProvider(fn);

  const result = await provider.verifySelection({ selection: request.selection });

  assert.equal(result.status, "FAILED");
  assert.equal(result.reasonCode, "MARKET_NOT_SUPPORTED");
  assert.equal(calls.length, 0, "the h2h verifier must never be called for an unsupported market");
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
