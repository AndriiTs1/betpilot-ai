import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOddsCheckToSelectionStatus } from "./mapOddsStatus";
import type { OddsCheckResult } from "@/types/oddsSnapshot";

function result(overrides: Partial<OddsCheckResult>): OddsCheckResult {
  return {
    matched: false,
    withinTolerance: null,
    sourceOdds: null,
    submittedOdds: 1.5,
    discrepancyPercent: null,
    bookmaker: null,
    note: null,
    ...overrides,
  };
}

test("mapOddsStatus: matched + withinTolerance=true -> VERIFIED", () => {
  const r = result({ matched: true, withinTolerance: true, sourceOdds: 1.5, discrepancyPercent: 0 });
  assert.equal(mapOddsCheckToSelectionStatus(r), "VERIFIED");
});

test("mapOddsStatus: matched + withinTolerance=false -> ODDS_CHANGED", () => {
  const r = result({ matched: true, withinTolerance: false, sourceOdds: 1.9, discrepancyPercent: 12 });
  assert.equal(mapOddsCheckToSelectionStatus(r), "ODDS_CHANGED");
});

test("mapOddsStatus: not matched (event/selection not found) -> NOT_FOUND", () => {
  const r = result({ matched: false, note: 'No matching event found for "X" in soccer_epl' });
  assert.equal(mapOddsCheckToSelectionStatus(r), "NOT_FOUND");
});

test("mapOddsStatus: not matched with no reasonCode at all (older/hand-built OddsCheckResult) -> NOT_FOUND, unchanged backward-compatible fallback", () => {
  // Stage 4.2B1 — before this stage, `note` was the only (unparsed) signal
  // here; a value with no `reasonCode` set at all (any caller that predates
  // this stage, or bypasses lib/odds/legacyOddsBridge.ts) must behave
  // exactly as before: NOT_FOUND for any matched:false, no exceptions.
  const unsupportedSport = result({ note: 'Sport/league "Darts" is not mapped to a The Odds API sport_key' });
  const providerError = result({ note: "The Odds API request failed with status 500" });
  assert.equal(mapOddsCheckToSelectionStatus(unsupportedSport), "NOT_FOUND");
  assert.equal(mapOddsCheckToSelectionStatus(providerError), "NOT_FOUND");
});

/* -------------------------------------------------------------------------- */
/* Stage 4.2B1 — root cause fix (Stage 4.2A audit): a technical provider     */
/* failure must now surface as UNAVAILABLE, distinct from a genuine         */
/* NOT_FOUND, via the reasonCode lib/odds/legacyOddsBridge.ts now threads   */
/* through instead of discarding.                                           */
/* -------------------------------------------------------------------------- */

test("mapOddsStatus: not matched + reasonCode PROVIDER_UNAVAILABLE -> UNAVAILABLE", () => {
  const r = result({ reasonCode: "PROVIDER_UNAVAILABLE" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "UNAVAILABLE");
});

test("mapOddsStatus: not matched + reasonCode PROVIDER_TIMEOUT -> UNAVAILABLE", () => {
  const r = result({ reasonCode: "PROVIDER_TIMEOUT" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "UNAVAILABLE");
});

test("mapOddsStatus: not matched + reasonCode PROVIDER_INVALID_RESPONSE -> UNAVAILABLE", () => {
  const r = result({ reasonCode: "PROVIDER_INVALID_RESPONSE" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "UNAVAILABLE");
});

test("mapOddsStatus: not matched + reasonCode PROVIDER_RATE_LIMITED -> UNAVAILABLE", () => {
  const r = result({ reasonCode: "PROVIDER_RATE_LIMITED" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "UNAVAILABLE");
});

test("mapOddsStatus: not matched + reasonCode EVENT_NOT_FOUND -> still NOT_FOUND (real absence, not a provider failure)", () => {
  const r = result({ reasonCode: "EVENT_NOT_FOUND" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "NOT_FOUND");
});

test("mapOddsStatus: not matched + reasonCode SELECTION_NOT_FOUND -> still NOT_FOUND", () => {
  const r = result({ reasonCode: "SELECTION_NOT_FOUND" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "NOT_FOUND");
});

test("mapOddsStatus: not matched + reasonCode SPORT_NOT_SUPPORTED -> still NOT_FOUND", () => {
  const r = result({ reasonCode: "SPORT_NOT_SUPPORTED" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "NOT_FOUND");
});

test("mapOddsStatus: not matched + reasonCode outside the technical-failure whitelist (AMBIGUOUS_EVENT) -> still NOT_FOUND, not widened beyond the four named provider reasons", () => {
  const r = result({ reasonCode: "AMBIGUOUS_EVENT" });
  assert.equal(mapOddsCheckToSelectionStatus(r), "NOT_FOUND");
});

test("mapOddsStatus: matched:true is never reinterpreted by reasonCode (VERIFIED/ODDS_CHANGED logic unchanged)", () => {
  const verified = result({ matched: true, withinTolerance: true, reasonCode: "NONE" });
  const oddsChanged = result({ matched: true, withinTolerance: false, reasonCode: "ODDS_OUTSIDE_TOLERANCE" });
  assert.equal(mapOddsCheckToSelectionStatus(verified), "VERIFIED");
  assert.equal(mapOddsCheckToSelectionStatus(oddsChanged), "ODDS_CHANGED");
});

test("mapOddsStatus: no result at all (odds check never ran) -> UNAVAILABLE", () => {
  assert.equal(mapOddsCheckToSelectionStatus(null), "UNAVAILABLE");
});

test("mapOddsStatus: a rejected/exception outcome maps to UNAVAILABLE via null", () => {
  // The intended integration (a later stage): Promise.allSettled per
  // selection, where a `rejected` entry is converted to `null` before
  // being handed to this function — see mapOddsStatus.ts's doc comment for
  // why that conversion belongs to the caller, not this pure mapper.
  const settled: PromiseSettledResult<OddsCheckResult>[] = [
    { status: "rejected", reason: new Error("boom") },
  ];

  const outcome = settled[0].status === "rejected" ? null : settled[0].value;
  assert.equal(mapOddsCheckToSelectionStatus(outcome), "UNAVAILABLE");
});
