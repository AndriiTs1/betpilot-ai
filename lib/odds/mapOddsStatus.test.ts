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

test("mapOddsStatus: not matched (unsupported sport / provider error / timeout) -> also NOT_FOUND today", () => {
  // Documented, deliberate collapse: OddsCheckResult has no structured
  // reason field distinguishing "not found" from "technical failure" when
  // matched=false — both currently only differ by free-text `note`, which
  // this mapper does not parse. See mapOddsStatus.ts's doc comment.
  const unsupportedSport = result({ note: 'Sport/league "Darts" is not mapped to a The Odds API sport_key' });
  const providerError = result({ note: "The Odds API request failed with status 500" });
  assert.equal(mapOddsCheckToSelectionStatus(unsupportedSport), "NOT_FOUND");
  assert.equal(mapOddsCheckToSelectionStatus(providerError), "NOT_FOUND");
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
