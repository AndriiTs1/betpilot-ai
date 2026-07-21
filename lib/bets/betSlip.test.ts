import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeParsedBet, normalizeParsedImageBet } from "./betSlip";
import type { ParsedBet, ParseImageBetResult } from "@/lib/ai/betParser";

test("betSlip: normalizeParsedBet wraps the old SINGLE parser shape unchanged", () => {
  const oldSingle: ParsedBet = {
    valid: true,
    sport: "Football",
    event: "Manchester City vs Chelsea",
    selection: "Manchester City Win",
    stake: 75,
    odds: 1.95,
  };

  const slip = normalizeParsedBet(oldSingle);

  assert.deepEqual(slip, {
    type: "SINGLE",
    stake: 75,
    selections: [
      { sport: "Football", event: "Manchester City vs Chelsea", market: null, selection: "Manchester City Win", submittedOdds: 1.95 },
    ],
  });
});

test("betSlip: normalizeParsedBet preserves null odds", () => {
  const oldSingle: ParsedBet = {
    valid: true,
    sport: "Tennis",
    event: "Djokovic vs Medvedev",
    selection: "Djokovic Win",
    stake: 20,
    odds: null,
  };

  const slip = normalizeParsedBet(oldSingle);
  assert.equal(slip.selections[0].submittedOdds, null);
});

test("betSlip: normalizeParsedImageBet passes through the SINGLE branch", () => {
  const imageResult: Extract<ParseImageBetResult, { valid: true }> = {
    valid: true,
    type: "SINGLE",
    bet: {
      valid: true,
      sport: "Basketball",
      event: "Lakers vs Celtics",
      selection: "Lakers Win",
      stake: 50,
      odds: 1.8,
    },
  };

  const slip = normalizeParsedImageBet(imageResult);
  assert.equal(slip.type, "SINGLE");
  assert.equal(slip.selections.length, 1);
  assert.equal(slip.selections[0].event, "Lakers vs Celtics");
});

test("betSlip: normalizeParsedImageBet maps PARLAY to EXPRESS", () => {
  const imageResult: Extract<ParseImageBetResult, { valid: true }> = {
    valid: true,
    type: "PARLAY",
    stake: 50,
    selections: [
      { sport: "Football", event: "Real Madrid vs Barcelona", selection: "Real Madrid Win", odds: 1.8 },
      { sport: "Football", event: "Inter vs Juventus", selection: "Over 2.5", odds: 1.7 },
    ],
  };

  const slip = normalizeParsedImageBet(imageResult);

  assert.equal(slip.type, "EXPRESS");
  assert.equal(slip.stake, 50);
  assert.equal(slip.selections.length, 2);
  assert.equal(slip.selections[0].submittedOdds, 1.8);
  assert.equal(slip.selections[1].submittedOdds, 1.7);
  // market is always null today — nothing populates it yet (see betSlip.ts).
  assert.equal(slip.selections[0].market, null);
});
