import { test } from "node:test";
import assert from "node:assert/strict";
import { canConfirmBetSlip } from "./canConfirmBetSlip";
import type { BetPreviewSuccess } from "./betPreviewApi";

function previewSuccess(overrides: Partial<BetPreviewSuccess> = {}): BetPreviewSuccess {
  return {
    preview: { type: "SINGLE", stake: 100, totalOdds: 2.1, potentialWin: 210, selections: [] },
    previewToken: "a-real-token",
    ...overrides,
  };
}

test("canConfirmBetSlip: SINGLE preview with a token is confirmable when the form is ready", () => {
  const preview = previewSuccess({ preview: { ...previewSuccess().preview, type: "SINGLE" } });
  assert.equal(canConfirmBetSlip(true, preview), true);
});

test("canConfirmBetSlip: EXPRESS preview with a token is now confirmable when the form is ready", () => {
  // Stage 12, Phase 4, Step 5's core requirement: EXPRESS is no longer
  // excluded just because of its type — only previewToken !== null gates.
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

test("canConfirmBetSlip: not ready is never confirmable, even with a valid token", () => {
  assert.equal(canConfirmBetSlip(false, previewSuccess()), false);
});
