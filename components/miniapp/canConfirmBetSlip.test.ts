import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canConfirmBetSlip,
  hasUnresolvedSingleOdds,
  hasUnverifiedOddsStatus,
  getConfirmButtonLabel,
} from "./canConfirmBetSlip";
import type { BetPreviewSuccess, BetPreviewSelection } from "./betPreviewApi";

function singleSelection(overrides: Partial<BetPreviewSelection> = {}): BetPreviewSelection {
  return {
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    market: null,
    selection: "Real Madrid Win",
    submittedOdds: 2.1,
    currentOdds: 2.1,
    oddsStatus: "VERIFIED",
    bookmaker: "Pinnacle",
    discrepancyPercent: 0,
    ...overrides,
  };
}

// Default fixture is a realistic, fully-resolved SINGLE — exactly 1
// selection with real numeric odds, matching what buildBetSlipPreview.ts
// always produces for SINGLE (never an empty selections array).
function previewSuccess(overrides: Partial<BetPreviewSuccess> = {}): BetPreviewSuccess {
  return {
    preview: { type: "SINGLE", stake: 100, totalOdds: 2.1, potentialWin: 210, selections: [singleSelection()] },
    previewToken: "a-real-token",
    ...overrides,
  };
}

test("canConfirmBetSlip: SINGLE preview with a token and resolved numeric odds is confirmable when the form is ready", () => {
  const preview = previewSuccess();
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("canConfirmBetSlip: EXPRESS preview with a token is confirmable when the form is ready", () => {
  // Stage 12, Phase 4, Step 5's core requirement: EXPRESS is no longer
  // excluded just because of its type — only previewToken !== null gates.
  // Step 15J.1 does not change this — the new odds invariant is SINGLE-only.
  const preview = previewSuccess({
    preview: { type: "EXPRESS", stake: 40, totalOdds: 3.06, potentialWin: 122.4, selections: [] },
    previewToken: "a-real-express-token",
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("canConfirmBetSlip: EXPRESS preview with no token (unresolved odds) is not confirmable", () => {
  const preview = previewSuccess({
    preview: { type: "EXPRESS", stake: 40, totalOdds: null, potentialWin: null, selections: [] },
    previewToken: null,
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: SINGLE preview with no token is not confirmable (unchanged SINGLE behavior)", () => {
  const preview = previewSuccess({ previewToken: null });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: no preview at all is never confirmable", () => {
  assert.equal(canConfirmBetSlip(true, null), false);
});

test("canConfirmBetSlip: not ready is never confirmable, even with a valid token and resolved odds", () => {
  assert.equal(canConfirmBetSlip(false, previewSuccess()), false);
});

// ---------------------------------------------------------------------
// Step 15J.1 — SINGLE null-odds confirmation is blocked client-side too,
// mirroring the backend's ODDS_REQUIRED_BEFORE_CONFIRMATION invariant
// (app/api/miniapp/bets/text/confirm/route.ts: payload.odds === null).
// ---------------------------------------------------------------------

test("Step 15J.1 (A): SINGLE + previewToken + effective odds null -> canConfirmBetSlip returns false", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null, currentOdds: null, oddsStatus: "UNAVAILABLE" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("Step 15J.1 (B): SINGLE + previewToken + provider-promoted numeric odds -> canConfirmBetSlip returns true", () => {
  // Provider-promoted odds are indistinguishable, at this layer, from a
  // manually-submitted number — buildBetSlipPreview.ts's
  // effectiveSubmittedOdds already folds the promoted price into this exact
  // same submittedOdds field before the client ever sees it.
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.35,
      potentialWin: 235,
      selections: [singleSelection({ submittedOdds: 2.35, currentOdds: 2.35, oddsStatus: "VERIFIED" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("Step 15J.1 (C): SINGLE + manually submitted numeric odds -> canConfirmBetSlip returns true", () => {
  const preview = previewSuccess();
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("Step 15J.1 (D): SINGLE without previewToken -> canConfirmBetSlip returns false", () => {
  const preview = previewSuccess({ previewToken: null });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("Step 15J.1 (E): invalid numeric odds values (NaN, Infinity, zero, negative) are never confirmable", () => {
  for (const badOdds of [NaN, Infinity, -Infinity, 0, -1.5]) {
    const preview = previewSuccess({
      preview: {
        type: "SINGLE",
        stake: 100,
        totalOdds: null,
        potentialWin: null,
        selections: [singleSelection({ submittedOdds: badOdds })],
      },
    });
    assert.equal(canConfirmBetSlip(true, preview), false, `submittedOdds=${badOdds} must not be confirmable`);
  }
});

test("Step 15J.1 (J): non-SINGLE (EXPRESS) is unaffected by the new odds invariant — previewToken alone still gates it", () => {
  const preview = previewSuccess({
    preview: { type: "EXPRESS", stake: 40, totalOdds: 3.06, potentialWin: 122.4, selections: [] },
    previewToken: "a-real-express-token",
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
  assert.equal(hasUnresolvedSingleOdds(preview), false, "the SINGLE-only predicate must never fire for EXPRESS");
});

// ---------------------------------------------------------------------
// hasUnresolvedSingleOdds / getConfirmButtonLabel — the shared predicate
// and label helper both BetTextForm and BetScreenshotForm read, so
// "Odds unavailable" is derived from one place, never duplicated inline.
// ---------------------------------------------------------------------

test("hasUnresolvedSingleOdds: true for a SINGLE with null effective odds", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null })],
    },
  });
  assert.equal(hasUnresolvedSingleOdds(preview), true);
});

test("hasUnresolvedSingleOdds: false for a SINGLE with resolved numeric odds", () => {
  assert.equal(hasUnresolvedSingleOdds(previewSuccess()), false);
});

test("hasUnresolvedSingleOdds: false for null preview", () => {
  assert.equal(hasUnresolvedSingleOdds(null), false);
});

test("getConfirmButtonLabel: 'Confirming...' while a confirm request is in flight, regardless of odds", () => {
  assert.equal(getConfirmButtonLabel(true, previewSuccess()), "Confirming...");
  const unresolved = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null })],
    },
  });
  assert.equal(getConfirmButtonLabel(true, unresolved), "Confirming...");
});

test("getConfirmButtonLabel: 'Odds unavailable' for a SINGLE with null effective odds, not confirming", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null })],
    },
  });
  assert.equal(getConfirmButtonLabel(false, preview), "Odds unavailable");
});

test("getConfirmButtonLabel: 'Confirm bet' for a resolved SINGLE, not confirming", () => {
  assert.equal(getConfirmButtonLabel(false, previewSuccess()), "Confirm bet");
});

test("getConfirmButtonLabel: 'Confirm bet' for EXPRESS, never 'Odds unavailable'", () => {
  const preview = previewSuccess({
    preview: { type: "EXPRESS", stake: 40, totalOdds: 3.06, potentialWin: 122.4, selections: [] },
    previewToken: "a-real-express-token",
  });
  assert.equal(getConfirmButtonLabel(false, preview), "Confirm bet");
});

// ---------------------------------------------------------------------
// Final product decision — the odds provider must positively confirm a
// selection before the player may even attempt to confirm it. Mirrors
// lib/bets/verifyPreviewFreshness.ts's decideFreshnessOutcome server-side:
// NOT_FOUND/UNAVAILABLE/PENDING block, VERIFIED and ODDS_CHANGED don't.
// ---------------------------------------------------------------------

test("canConfirmBetSlip: SINGLE VERIFIED is confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "VERIFIED" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("canConfirmBetSlip: SINGLE ODDS_CHANGED is still confirmable (re-verifies and asks for reconfirmation server-side, never blocked client-side)", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "ODDS_CHANGED" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("canConfirmBetSlip: SINGLE NOT_FOUND is never confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "NOT_FOUND" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: SINGLE UNAVAILABLE is never confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "UNAVAILABLE" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: SINGLE PENDING is never confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "PENDING" })],
    },
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: EXPRESS with one NOT_FOUND selection among otherwise-VERIFIED legs is never confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "EXPRESS",
      stake: 40,
      totalOdds: 3.06,
      potentialWin: 122.4,
      selections: [
        singleSelection({ oddsStatus: "VERIFIED" }),
        singleSelection({ event: "Inter vs Juventus", oddsStatus: "NOT_FOUND" }),
      ],
    },
    previewToken: "a-real-express-token",
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: EXPRESS with every leg VERIFIED is confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "EXPRESS",
      stake: 40,
      totalOdds: 3.06,
      potentialWin: 122.4,
      selections: [
        singleSelection({ oddsStatus: "VERIFIED" }),
        singleSelection({ event: "Inter vs Juventus", oddsStatus: "VERIFIED" }),
      ],
    },
    previewToken: "a-real-express-token",
  });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("hasUnverifiedOddsStatus: true when any selection is NOT_FOUND/UNAVAILABLE/PENDING, false when every selection is VERIFIED/ODDS_CHANGED", () => {
  assert.equal(hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "NOT_FOUND" })]), true);
  assert.equal(hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "UNAVAILABLE" })]), true);
  assert.equal(hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "PENDING" })]), true);
  assert.equal(hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "VERIFIED" })]), false);
  assert.equal(hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "ODDS_CHANGED" })]), false);
  assert.equal(
    hasUnverifiedOddsStatus([singleSelection({ oddsStatus: "VERIFIED" }), singleSelection({ oddsStatus: "NOT_FOUND" })]),
    true,
    "one unverified leg among otherwise-fine legs still blocks",
  );
});
