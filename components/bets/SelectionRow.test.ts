import { test } from "node:test";
import assert from "node:assert/strict";
import { getOddsPresentation } from "./SelectionRow";

// UI Polish task — Bet Preview Cards. This project deliberately has no
// DOM-rendering test infra (see e.g. ActiveBetsScreen.test.ts's own
// comment), so the odds-presentation decision is extracted as a pure
// function (getOddsPresentation) and tested directly here, exactly as
// BetPreviewCard.test.ts already does for isProviderUnavailable.

test("VERIFIED with submitted odds equal to current odds: one prominent value, not a duplicated Odds/Current pair", () => {
  const result = getOddsPresentation("VERIFIED", 1.16, 1.16);
  assert.deepEqual(result, { mode: "prominent", value: 1.16 });
});

// The exact production reproduction this task references: an EXPRESS leg
// where the player never typed odds, so the provider's own price was
// promoted as both submitted and current — numerically equal.
test("VERIFIED with only currentOdds known (odds auto-promoted from the provider): still one prominent value", () => {
  const result = getOddsPresentation("VERIFIED", null, 1.46);
  assert.deepEqual(result, { mode: "prominent", value: 1.46 });
});

test("ODDS_CHANGED with genuinely different submitted/current values: both shown, clearly labeled, current is the prominent one", () => {
  const result = getOddsPresentation("ODDS_CHANGED", 2.1, 1.95);
  assert.deepEqual(result, { mode: "dual", submitted: 2.1, current: 1.95 });
});

test("NOT_FOUND never returns prominent or dual mode — no misleading verified-looking value", () => {
  const result = getOddsPresentation("NOT_FOUND", 2.1, null);
  assert.equal(result.mode, "plain");
});

test("UNAVAILABLE never returns prominent or dual mode — no misleading verified-looking value", () => {
  const result = getOddsPresentation("UNAVAILABLE", null, null);
  assert.deepEqual(result, { mode: "plain", odds: null, currentOdds: null });
});

test("a null/undefined oddsStatus (review-context rows that never set it) falls back to plain, never prominent", () => {
  assert.equal(getOddsPresentation(null, 1.5, 1.5).mode, "plain");
  assert.equal(getOddsPresentation(undefined, 1.5, 1.5).mode, "plain");
});

// ODDS_CHANGED is a real status, but if either figure is somehow missing
// there's nothing valid to show as a "dual" pair — must degrade to plain
// rather than rendering an incomplete/misleading comparison.
test("ODDS_CHANGED with a missing figure degrades to plain, never a partial dual display", () => {
  assert.equal(getOddsPresentation("ODDS_CHANGED", null, 1.95).mode, "plain");
  assert.equal(getOddsPresentation("ODDS_CHANGED", 2.1, null).mode, "plain");
});
