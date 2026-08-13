import { test } from "node:test";
import assert from "node:assert/strict";
import { getOddsPresentation } from "./SelectionRow";

// UI Polish task — Bet Preview Cards. This project deliberately has no
// DOM-rendering test infra (see e.g. ActiveBetsScreen.test.ts's own
// comment), so the odds-presentation decision is extracted as a pure
// function (getOddsPresentation) and tested directly here, exactly as
// BetPreviewCard.test.ts already does for isProviderUnavailable.
//
// M4.1 — CLEAN PLAYER ODDS UX rewrote this function: it now takes only
// currentOdds (never the submitted/screenshot value), and VERIFIED /
// ODDS_CHANGED render IDENTICALLY — there is no more "dual" comparison
// mode. A player must only ever see BetPilot's current offer.

test("VERIFIED with a current odds value: one prominent value", () => {
  const result = getOddsPresentation("VERIFIED", 1.16);
  assert.deepEqual(result, { mode: "prominent", value: 1.16 });
});

test("VERIFIED with odds auto-promoted from the provider (the only value that ever existed): still one prominent value", () => {
  const result = getOddsPresentation("VERIFIED", 1.46);
  assert.deepEqual(result, { mode: "prominent", value: 1.46 });
});

// The exact production reproduction this stage fixes: screenshot odds 2.01,
// provider current odds 1.39. ODDS_CHANGED must render exactly like
// VERIFIED — one clean current-odds value, never the screenshot number,
// never a "Submitted 2.01 / Current 1.39" comparison.
test("ODDS_CHANGED renders identically to VERIFIED: one prominent value, the current odds only — never the submitted/screenshot odds, never a dual comparison", () => {
  const result = getOddsPresentation("ODDS_CHANGED", 1.39);
  assert.deepEqual(result, { mode: "prominent", value: 1.39 });
  assert.notEqual((result as { value?: number }).value, 2.01);
});

test("NOT_FOUND never returns prominent — no misleading verified-looking value", () => {
  const result = getOddsPresentation("NOT_FOUND", null);
  assert.deepEqual(result, { mode: "unavailable" });
});

test("UNAVAILABLE never returns prominent — no misleading verified-looking value", () => {
  const result = getOddsPresentation("UNAVAILABLE", null);
  assert.deepEqual(result, { mode: "unavailable" });
});

test("a null/undefined oddsStatus (review-context rows that never set it) falls back to unavailable, never prominent", () => {
  assert.deepEqual(getOddsPresentation(null, 1.5), { mode: "unavailable" });
  assert.deepEqual(getOddsPresentation(undefined, 1.5), { mode: "unavailable" });
});

// A confirmable status with no current odds at all (shouldn't happen in
// practice — buildBetSlipPreview.ts only sets VERIFIED/ODDS_CHANGED when a
// real sourceOdds was found) must still degrade safely rather than crash or
// fabricate a value.
test("VERIFIED/ODDS_CHANGED with a missing current odds degrades to unavailable, never a fabricated prominent value", () => {
  assert.deepEqual(getOddsPresentation("VERIFIED", null), { mode: "unavailable" });
  assert.deepEqual(getOddsPresentation("ODDS_CHANGED", null), { mode: "unavailable" });
});
