import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canConfirmBetSlip,
  hasUnresolvedSingleOdds,
  hasUnverifiedOddsStatus,
  getConfirmButtonLabel,
  isConfirmableSingleOdds,
  isOddsUnavailableForConfirm,
  isSingleSelectionOddsUnavailable,
  isRecoverableLeg,
} from "./canConfirmBetSlip";
import type { BetPreviewSuccess, BetPreviewSelection } from "./betPreviewApi";

function singleSelection(overrides: Partial<BetPreviewSelection> = {}): BetPreviewSelection {
  return {
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    market: null,
    selection: "Real Madrid Win",
    marketType: null,
    participant: null,
    selectionType: null,
    line: null,
    submittedOdds: 2.1,
    currentOdds: 2.1,
    oddsStatus: "VERIFIED",
    bookmaker: "Pinnacle",
    discrepancyPercent: 0,
    homeTeamName: null,
    awayTeamName: null,
    competitionName: null,
    eventStartTime: null,
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

// ---------------------------------------------------------------------
// Sector 1 correction (ADR-0002) — buildBetSlipPreview.ts now signs a
// previewToken for EXPRESS even when a leg is NOT_FOUND/UNAVAILABLE (a
// signed reference for exclusion, not a confirmability signal). This is
// the regression that matters now: a NON-NULL token must never, by itself,
// make an unverified-leg EXPRESS confirmable — hasUnverifiedOddsStatus
// (the oddsStatus-based gate) must still block it. Before this correction
// this exact combination (real token + unavailable leg) was structurally
// impossible to construct through buildBetSlipPreview, so this case was
// previously untestable against the real pipeline — see
// lib/bets/buildExpressLegExclusionPreview.test.ts's real production-path
// integration test for the end-to-end proof.
// ---------------------------------------------------------------------

test("canConfirmBetSlip: EXPRESS preview WITH a real token but one NOT_FOUND leg is still NOT confirmable — token presence never bypasses the oddsStatus gate", () => {
  const preview = previewSuccess({
    preview: {
      type: "EXPRESS",
      stake: 40,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ oddsStatus: "VERIFIED" }), singleSelection({ oddsStatus: "NOT_FOUND" })],
    },
    previewToken: "a-real-reference-token-with-an-unavailable-leg",
  });
  assert.equal(canConfirmBetSlip(true, preview), false);
});

test("canConfirmBetSlip: EXPRESS preview WITH a real token but one UNAVAILABLE leg is still NOT confirmable", () => {
  const preview = previewSuccess({
    preview: {
      type: "EXPRESS",
      stake: 40,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ oddsStatus: "VERIFIED" }), singleSelection({ oddsStatus: "UNAVAILABLE" })],
    },
    previewToken: "a-real-reference-token-with-an-unavailable-leg",
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

// ---------------------------------------------------------------------
// Stage M4.5 — CLEAN UNAVAILABLE-ODDS UX. isOddsUnavailableForConfirm is
// the exact predicate components/miniapp/BetTextForm.tsx and
// BetScreenshotForm.tsx now gate the Confirm button's *presence* on (not
// merely its disabled state) — this project has no DOM-rendering test
// infra (see BetPreviewCard.test.ts's own header comment), so the decision
// is proven here, at the pure-function level, exactly as every other
// confirmability rule in this file already is.
// ---------------------------------------------------------------------

test("isConfirmableSingleOdds: true for finite, positive submittedOdds", () => {
  assert.equal(isConfirmableSingleOdds(singleSelection({ submittedOdds: 2.1 })), true);
});

test("isConfirmableSingleOdds: false for null/NaN/Infinity/zero/negative submittedOdds, and for no selection at all", () => {
  for (const badOdds of [null, NaN, Infinity, -Infinity, 0, -1.5]) {
    assert.equal(
      isConfirmableSingleOdds(singleSelection({ submittedOdds: badOdds })),
      false,
      `submittedOdds=${badOdds} must not be confirmable`,
    );
  }
  assert.equal(isConfirmableSingleOdds(undefined), false);
});

test("isOddsUnavailableForConfirm: false for no preview at all", () => {
  assert.equal(isOddsUnavailableForConfirm(null), false);
});

test("isOddsUnavailableForConfirm: false for a SINGLE with real verified odds — the normal, successful preview is unaffected by this stage", () => {
  assert.equal(isOddsUnavailableForConfirm(previewSuccess()), false);
});

test("isOddsUnavailableForConfirm: false for a SINGLE ODDS_CHANGED — still confirmable (re-verifies server-side), so Confirm must remain visible", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: 2.1,
      potentialWin: 210,
      selections: [singleSelection({ oddsStatus: "ODDS_CHANGED" })],
    },
  });
  assert.equal(isOddsUnavailableForConfirm(preview), false);
});

test("isOddsUnavailableForConfirm: true for a SINGLE with unresolved (null) effective odds — matches the M4.4 production case (spread LINE_NOT_AVAILABLE)", () => {
  const preview = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 5,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null, currentOdds: null, oddsStatus: "NOT_FOUND" })],
    },
  });
  assert.equal(isOddsUnavailableForConfirm(preview), true);
});

test("isOddsUnavailableForConfirm: true for every SINGLE blocking oddsStatus (NOT_FOUND/UNAVAILABLE/PENDING)", () => {
  for (const oddsStatus of ["NOT_FOUND", "UNAVAILABLE", "PENDING"] as const) {
    const preview = previewSuccess({
      preview: {
        type: "SINGLE",
        stake: 100,
        totalOdds: null,
        potentialWin: null,
        selections: [singleSelection({ submittedOdds: null, currentOdds: null, oddsStatus })],
      },
    });
    assert.equal(isOddsUnavailableForConfirm(preview), true, `${oddsStatus} must be treated as odds-unavailable`);
  }
});

test("isOddsUnavailableForConfirm: false for an EXPRESS with every leg VERIFIED", () => {
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
  assert.equal(isOddsUnavailableForConfirm(preview), false);
});

test("isOddsUnavailableForConfirm: true for an EXPRESS with one unavailable leg among otherwise-verified legs — the Confirm button must not render", () => {
  const preview = previewSuccess({
    preview: {
      type: "EXPRESS",
      stake: 40,
      totalOdds: null,
      potentialWin: null,
      selections: [
        singleSelection({ oddsStatus: "VERIFIED" }),
        singleSelection({ event: "Inter vs Juventus", submittedOdds: null, currentOdds: null, oddsStatus: "NOT_FOUND" }),
      ],
    },
    previewToken: null,
  });
  assert.equal(isOddsUnavailableForConfirm(preview), true);
  // And confirmation itself is still impossible, unchanged by this stage.
  assert.equal(canConfirmBetSlip(true, preview), false);
});

// ---------------------------------------------------------------------
// M4.5 semantic review — isSingleSelectionOddsUnavailable is the
// presentation-layer predicate BetPreviewCard.tsx's PreviewCard/OddsStatus
// use to decide the "Potential win" row and the unavailable-odds notice.
// The regression this specifically guards: buildBetSlipPreview.ts's
// effectiveSubmittedOdds lets a screenshot's raw OCR'd price survive onto
// submittedOdds even when the provider lookup failed (see that file's own
// comment) — so isConfirmableSingleOdds ALONE (submittedOdds-only) would
// wrongly call a genuine NOT_FOUND selection "available" whenever the
// screenshot showed a real price. oddsStatus must win.
// ---------------------------------------------------------------------

test("isSingleSelectionOddsUnavailable: true for NOT_FOUND even when submittedOdds is a real, valid number (the screenshot-had-a-price regression)", () => {
  const selection = singleSelection({ submittedOdds: 1.9, currentOdds: null, oddsStatus: "NOT_FOUND" });
  // Sanity: this is exactly the case isConfirmableSingleOdds alone gets
  // wrong (submittedOdds looks fine in isolation) — proving the fix
  // actually needed oddsStatus, not just a coincidentally-passing test.
  assert.equal(isConfirmableSingleOdds(selection), true, "submittedOdds alone looks confirmable — this is the trap");
  assert.equal(isSingleSelectionOddsUnavailable(selection), true);
});

test("isSingleSelectionOddsUnavailable: true for UNAVAILABLE/PENDING regardless of submittedOdds", () => {
  for (const oddsStatus of ["UNAVAILABLE", "PENDING"] as const) {
    const selection = singleSelection({ submittedOdds: 1.9, currentOdds: null, oddsStatus });
    assert.equal(isSingleSelectionOddsUnavailable(selection), true, `${oddsStatus} must be unavailable`);
  }
});

test("isSingleSelectionOddsUnavailable: true for the defensive null-submittedOdds case even if oddsStatus were somehow VERIFIED", () => {
  const selection = singleSelection({ submittedOdds: null, oddsStatus: "VERIFIED" });
  assert.equal(isSingleSelectionOddsUnavailable(selection), true);
});

test("isSingleSelectionOddsUnavailable: false for a normal VERIFIED or ODDS_CHANGED selection with real odds — the successful preview is unaffected", () => {
  assert.equal(isSingleSelectionOddsUnavailable(singleSelection({ oddsStatus: "VERIFIED" })), false);
  assert.equal(isSingleSelectionOddsUnavailable(singleSelection({ oddsStatus: "ODDS_CHANGED" })), false);
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

// ---------------------------------------------------------------------
// Sector 1 (ADR-0002) — isRecoverableLeg: which legs get a Remove
// affordance in BetPreviewCard.tsx. Only NOT_FOUND/UNAVAILABLE — never
// VERIFIED/ODDS_CHANGED (out of Sector 1's approved scope) and never the
// reserved-but-unreachable PENDING.
// ---------------------------------------------------------------------

test("isRecoverableLeg: true for NOT_FOUND", () => {
  assert.equal(isRecoverableLeg(singleSelection({ oddsStatus: "NOT_FOUND" })), true);
});

test("isRecoverableLeg: true for UNAVAILABLE", () => {
  assert.equal(isRecoverableLeg(singleSelection({ oddsStatus: "UNAVAILABLE" })), true);
});

test("isRecoverableLeg: false for VERIFIED — Sector 1 never makes a verified leg removable", () => {
  assert.equal(isRecoverableLeg(singleSelection({ oddsStatus: "VERIFIED" })), false);
});

test("isRecoverableLeg: false for ODDS_CHANGED — a real, confirmed leg whose price moved is not 'unavailable'", () => {
  assert.equal(isRecoverableLeg(singleSelection({ oddsStatus: "ODDS_CHANGED" })), false);
});

test("isRecoverableLeg: false for PENDING (reserved, practically unreachable)", () => {
  assert.equal(isRecoverableLeg(singleSelection({ oddsStatus: "PENDING" })), false);
});

// Localization completion pass — `locale` defaults to "en" (every test
// above passes none and still asserts the exact original English label —
// zero behavior change for any pre-existing caller). The gating LOGIC
// (isConfirming / hasUnresolvedSingleOdds) is completely untouched; only
// the returned label text is locale-aware.
test("getConfirmButtonLabel: locale='ru' returns Russian labels for all three states", () => {
  assert.equal(getConfirmButtonLabel(true, previewSuccess(), "ru"), "Подтверждение...");

  const unresolved = previewSuccess({
    preview: {
      type: "SINGLE",
      stake: 100,
      totalOdds: null,
      potentialWin: null,
      selections: [singleSelection({ submittedOdds: null })],
    },
  });
  assert.equal(getConfirmButtonLabel(false, unresolved, "ru"), "Коэффициент недоступен");

  assert.equal(getConfirmButtonLabel(false, previewSuccess(), "ru"), "Подтвердить ставку");
});
