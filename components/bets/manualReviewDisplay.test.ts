import { test } from "node:test";
import assert from "node:assert/strict";
import {
  determineManualReviewViewState,
  mapNeedsReviewBetForDisplay,
  type NeedsReviewBetApi,
  type NeedsReviewSelectionApi,
} from "./manualReviewDisplay";

function selection(overrides: Partial<NeedsReviewSelectionApi> = {}): NeedsReviewSelectionApi {
  return {
    id: "sel-1",
    sport: "FOOTBALL",
    market: "MONEYLINE_3WAY",
    selection: "Fenerbahce Win",
    participant: "Fenerbahce",
    odds: "1.85",
    providerName: "THE_ODDS_API",
    providerEventId: "evt-1",
    eventStartTime: "2026-07-28T12:00:00.000Z",
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function bet(overrides: Partial<NeedsReviewBetApi> = {}): NeedsReviewBetApi {
  return {
    id: "bet-1",
    type: "SINGLE",
    status: "CONFIRMED",
    player: { id: "player-1", name: "Alice" },
    stake: "100",
    odds: "2.00",
    totalOdds: null,
    potentialPayout: "200.00",
    providerName: "THE_ODDS_API",
    providerEventId: "evt-1",
    providerSportKey: "soccer_epl",
    eventStartTime: "2026-07-28T12:00:00.000Z",
    settlementRetryCount: 3,
    lastSettlementAttemptAt: "2026-07-29T03:00:00.000Z",
    lastSettlementErrorCode: "EVENT_NOT_FOUND",
    lastSettlementErrorMessage: "Provider response did not include this event this cycle.",
    settlementReviewReason: "EVENT_NOT_FOUND_MAX_RETRIES",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-29T03:00:00.000Z",
    selections: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 4/5. SINGLE / EXPRESS card content                                         */
/* -------------------------------------------------------------------------- */

test("4. SINGLE bet maps to a fully-populated display shape", () => {
  const display = mapNeedsReviewBetForDisplay(bet());

  assert.equal(display.isExpress, false);
  assert.equal(display.playerName, "Alice");
  assert.equal(display.stake, "100");
  assert.equal(display.effectiveOdds, "2.00"); // odds, since totalOdds is null
  assert.equal(display.potentialPayout, "200.00");
  assert.equal(display.retryCount, 3);
  assert.equal(display.lastErrorCode, "EVENT_NOT_FOUND");
});

test("4b. effectiveOdds prefers totalOdds over odds when both are present", () => {
  const display = mapNeedsReviewBetForDisplay(bet({ odds: "1.50", totalOdds: "6.00" }));
  assert.equal(display.effectiveOdds, "6.00");
});

test("5. EXPRESS bet carries its selections through to the display shape", () => {
  const legs = [selection({ id: "s1" }), selection({ id: "s2", providerEventId: "evt-2" })];
  const display = mapNeedsReviewBetForDisplay(bet({ type: "EXPRESS", selections: legs }));

  assert.equal(display.isExpress, true);
  assert.deepEqual(display.selections, legs);
});

/* -------------------------------------------------------------------------- */
/* 6. Review reason becomes operator text, never a raw enum-only string       */
/* -------------------------------------------------------------------------- */

test("6. review reason is converted to human text, never left as the raw enum key alone", () => {
  const display = mapNeedsReviewBetForDisplay(bet({ settlementReviewReason: "PARTICIPANT_MISMATCH" }));
  assert.equal(display.reviewReasonLabel, "Participant could not be matched");
  assert.notEqual(display.reviewReasonLabel, "PARTICIPANT_MISMATCH");
});

test("6b. a null review reason degrades to the shared em-dash fallback, not a blank/crash", () => {
  const display = mapNeedsReviewBetForDisplay(bet({ settlementReviewReason: null }));
  assert.equal(display.reviewReasonLabel, "—");
});

/* -------------------------------------------------------------------------- */
/* 7. retryCount / last error are present on the display shape                */
/* -------------------------------------------------------------------------- */

test("7. retryCount and last technical error are both present and unmodified", () => {
  const display = mapNeedsReviewBetForDisplay(bet({ settlementRetryCount: 2, lastSettlementErrorMessage: "Structural data problem detected during expiry sweep: MISSING_PROVIDER_REFERENCE." }));
  assert.equal(display.retryCount, 2);
  assert.equal(display.lastErrorMessage, "Structural data problem detected during expiry sweep: MISSING_PROVIDER_REFERENCE.");
});

test("7b. a bet with no automatic attempt yet (sweep-only escalation) shows the em-dash fallback for last attempt, not a crash", () => {
  const display = mapNeedsReviewBetForDisplay(bet({ lastSettlementAttemptAt: null }));
  assert.equal(display.lastAttemptDisplay, "—");
});

/* -------------------------------------------------------------------------- */
/* View state (loading / empty / error / list)                                */
/* -------------------------------------------------------------------------- */

test("1. loading state: initial load, no error yet", () => {
  assert.equal(determineManualReviewViewState({ bets: null, error: null, isInitialLoad: true }), "loading");
});

test("2. empty state: load finished, zero bets, no error", () => {
  assert.equal(determineManualReviewViewState({ bets: [], error: null, isInitialLoad: false }), "empty");
});

test("3. error state takes priority over an empty/null bets list", () => {
  assert.equal(determineManualReviewViewState({ bets: null, error: "Failed", isInitialLoad: false }), "error");
  assert.equal(determineManualReviewViewState({ bets: [], error: "Failed", isInitialLoad: false }), "error");
});

test("list state: load finished, at least one bet, no error", () => {
  assert.equal(determineManualReviewViewState({ bets: [{}], error: null, isInitialLoad: false }), "list");
});

test("a background refresh error (isInitialLoad already false) never re-shows loading", () => {
  assert.notEqual(determineManualReviewViewState({ bets: [{}], error: null, isInitialLoad: false }), "loading");
});
