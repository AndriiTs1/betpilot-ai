import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeParsedBet } from "./betSlip";
import type { ParsedBet } from "@/lib/ai/betParser";

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
