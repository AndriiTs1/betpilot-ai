import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTicketSelectionOdds, resolveTicketStatusBadge, type BetTicketSelection } from "./BetTicket";

// Stage M4.9 — CLEAN EXPRESS CURRENT-ODDS UX. This project deliberately has
// no DOM-rendering test infra (see e.g. ActiveBetsScreen.test.ts's own
// comment, and components/bets/SelectionRow.test.ts's identical pattern),
// so the two rendering decisions this stage fixed — which odds value the
// main line shows, and whether a status badge appears — are extracted as
// pure functions and tested directly here.
//
// Root cause this proves fixed: BetTicket.tsx (the submitted/confirmed
// ticket screen) has its own inline per-selection rendering, never routed
// through components/bets/SelectionRow.tsx, so it never picked up Stage
// M4.1's "current price only" fix — it kept showing the submitted/
// screenshot odds on the main line, a separate "Current: X" line, and a
// "Verified"/"Odds changed" badge for every EXPRESS leg. These functions
// now reuse SelectionRow.tsx's own getOddsPresentation directly.

function selection(overrides: Partial<BetTicketSelection> = {}): BetTicketSelection {
  return {
    sport: "Football",
    league: null,
    event: "Alavés vs Getafe",
    selection: "Getafe",
    market: "Match Winner",
    odds: 3.7,
    currentOdds: null,
    oddsStatus: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// resolveTicketSelectionOdds
// ---------------------------------------------------------------------

// The exact production reproduction this stage fixes: submitted 3.70,
// current 3.87 (ODDS_CHANGED). The player must see 3.87 exactly once —
// never 3.70, never both.
test("resolveTicketSelectionOdds: ODDS_CHANGED leg (submitted 3.70, current 3.87) resolves to 3.87, never the submitted 3.70", () => {
  const result = resolveTicketSelectionOdds(selection({ odds: 3.7, currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" }));
  assert.equal(result, 3.87);
  assert.notEqual(result, 3.7);
});

// The second reported leg: submitted 2.38, current 2.45, VERIFIED.
test("resolveTicketSelectionOdds: VERIFIED leg (submitted 2.38, current 2.45) resolves to 2.45, never the submitted 2.38", () => {
  const result = resolveTicketSelectionOdds(selection({ odds: 2.38, currentOdds: 2.45, oddsStatus: "VERIFIED" }));
  assert.equal(result, 2.45);
  assert.notEqual(result, 2.38);
});

test("resolveTicketSelectionOdds: NOT_FOUND/UNAVAILABLE/PENDING never resolve to a fabricated value — null, not the stale submitted odds", () => {
  for (const oddsStatus of ["NOT_FOUND", "UNAVAILABLE", "PENDING"] as const) {
    const result = resolveTicketSelectionOdds(selection({ odds: 3.7, currentOdds: null, oddsStatus }));
    assert.equal(result, null, `${oddsStatus} must resolve to null, never a fabricated price`);
  }
});

// SINGLE selections never set oddsStatus (toBetTicketData's own contract,
// locked in by BetScreen.test.ts) — selection.odds is already Stage M4.8's
// accepted price, so it must pass through completely unchanged.
test("resolveTicketSelectionOdds: SINGLE (oddsStatus null) passes selection.odds through unchanged — already the accepted price", () => {
  assert.equal(resolveTicketSelectionOdds(selection({ odds: 2.04, currentOdds: null, oddsStatus: null })), 2.04);
});

test("resolveTicketSelectionOdds: a null odds field on a SINGLE-shaped selection stays null, never fabricated", () => {
  assert.equal(resolveTicketSelectionOdds(selection({ odds: null, oddsStatus: null })), null);
});

// ---------------------------------------------------------------------
// resolveTicketStatusBadge
// ---------------------------------------------------------------------

test("resolveTicketStatusBadge: VERIFIED never renders a badge", () => {
  assert.equal(resolveTicketStatusBadge(selection({ currentOdds: 2.45, oddsStatus: "VERIFIED" })), null);
});

test("resolveTicketStatusBadge: ODDS_CHANGED never renders a badge — identical treatment to VERIFIED, no 'odds changed' label surfaced to the player", () => {
  assert.equal(resolveTicketStatusBadge(selection({ currentOdds: 3.87, oddsStatus: "ODDS_CHANGED" })), null);
});

test("resolveTicketStatusBadge: a genuinely non-confirmable status (NOT_FOUND/UNAVAILABLE/PENDING) still shows its badge — explains the absence of a price, never a real one", () => {
  for (const oddsStatus of ["NOT_FOUND", "UNAVAILABLE", "PENDING"] as const) {
    assert.equal(resolveTicketStatusBadge(selection({ currentOdds: null, oddsStatus })), oddsStatus);
  }
});

test("resolveTicketStatusBadge: SINGLE (oddsStatus null) never renders a badge", () => {
  assert.equal(resolveTicketStatusBadge(selection({ oddsStatus: null })), null);
});
