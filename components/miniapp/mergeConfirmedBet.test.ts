import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfirmedBetIntoRecentBets, applyMiniAppDataAction } from "./mergeConfirmedBet";
import type { ConfirmedBet, ConfirmedExpressBet, ConfirmedExpressSelection } from "./betConfirmApi";
import type { RecentBet, MeResponse } from "./types";

// Data-freshness fix — root cause: GET /api/miniapp/me was only ever
// fetched once per Mini App session, so a freshly confirmed bet (SINGLE or
// EXPRESS) stayed invisible in Active Bets / Recent Activity / History
// until the app was closed and reopened. These tests cover the pure
// decision logic only (no React rendering — this project deliberately has
// no DOM-rendering test infra, see ActiveBetsScreen.test.ts's own comment);
// the thin fetch()/useState wiring in app/miniapp/page.tsx is exercised
// indirectly through these same functions, which is where all of the
// actual branching lives.

function existingBet(overrides: Partial<RecentBet> = {}): RecentBet {
  return {
    id: "bet-existing",
    type: "SINGLE",
    sport: "Tennis",
    event: "Djokovic vs Medvedev",
    outcome: "Djokovic Win",
    stake: "20",
    odds: "1.5",
    status: "PENDING",
    createdAt: "2026-07-20T10:00:00.000Z",
    totalOdds: "1.5",
    selections: [],
    ...overrides,
  };
}

function confirmedSingle(overrides: Partial<ConfirmedBet> = {}): ConfirmedBet {
  return {
    id: "bet-new-single",
    status: "PENDING",
    type: "SINGLE",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: 50,
    odds: 2.1,
    totalOdds: 2.1,
    createdAt: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

function confirmedExpressSelection(overrides: Partial<ConfirmedExpressSelection> = {}): ConfirmedExpressSelection {
  return {
    id: "sel-1",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    market: "Match Winner",
    odds: "1.8",
    currentOdds: "1.8",
    oddsStatus: "VERIFIED",
    ...overrides,
  };
}

function confirmedExpress(overrides: Partial<ConfirmedExpressBet> = {}): ConfirmedExpressBet {
  return {
    id: "bet-new-express",
    status: "PENDING",
    type: "EXPRESS",
    sport: "Football",
    event: null,
    outcome: null,
    odds: null,
    stake: "40",
    totalOdds: "3.06",
    createdAt: "2026-07-21T12:05:00.000Z",
    selections: [
      confirmedExpressSelection({ id: "sel-1", event: "Real Madrid vs Barcelona", outcome: "Real Madrid Win" }),
      confirmedExpressSelection({
        id: "sel-2",
        sport: "Tennis",
        event: "Inter Milan vs Juventus",
        outcome: "Over 2.5 Goals",
        market: null,
        odds: "1.7",
        currentOdds: null,
        oddsStatus: "UNAVAILABLE",
      }),
    ],
    ...overrides,
  };
}

function meResponse(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    player: { id: "player-1", name: "Test Player" },
    creditLimit: "10000",
    currentCredit: "0",
    remainingCredit: "10000",
    exposure: "20",
    pendingExposure: "0",
    availableCredit: "9980",
    recentBets: [existingBet()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// 1. SINGLE bet inserted
// ---------------------------------------------------------------------

test("mergeConfirmedBetIntoRecentBets: a confirmed SINGLE bet is inserted as exactly one item", () => {
  const result = mergeConfirmedBetIntoRecentBets([existingBet()], confirmedSingle());

  assert.equal(result.length, 2);
  assert.equal(result[0].id, "bet-new-single");
  assert.equal(result[0].type, "SINGLE");
  assert.equal(result[0].event, "Real Madrid vs Barcelona");
  assert.equal(result[0].outcome, "Real Madrid Win");
  assert.equal(result[0].stake, "50");
  assert.equal(result[0].odds, "2.1");
  assert.equal(result[0].totalOdds, "2.1");
  assert.equal(result[0].status, "PENDING");
  assert.deepEqual(result[0].selections, []);
});

test("mergeConfirmedBetIntoRecentBets: a SINGLE bet with null odds/totalOdds stays null, never fabricated", () => {
  const result = mergeConfirmedBetIntoRecentBets([], confirmedSingle({ odds: null, totalOdds: null }));
  assert.equal(result[0].odds, null);
  assert.equal(result[0].totalOdds, null);
});

// ---------------------------------------------------------------------
// 2. EXPRESS bet inserted with all selections preserved
// ---------------------------------------------------------------------

test("mergeConfirmedBetIntoRecentBets: a confirmed EXPRESS bet is inserted as exactly one parent Bet with all legs", () => {
  const result = mergeConfirmedBetIntoRecentBets([existingBet()], confirmedExpress());

  assert.equal(result.length, 2);
  const inserted = result[0];
  assert.equal(inserted.id, "bet-new-express");
  assert.equal(inserted.type, "EXPRESS");
  assert.equal(inserted.event, null);
  assert.equal(inserted.outcome, null);
  assert.equal(inserted.stake, "40");
  assert.equal(inserted.totalOdds, "3.06");
  assert.equal(inserted.selections.length, 2);
  assert.equal(inserted.selections[0].event, "Real Madrid vs Barcelona");
  assert.equal(inserted.selections[0].sport, "Football");
  assert.equal(inserted.selections[1].event, "Inter Milan vs Juventus");
  assert.equal(inserted.selections[1].sport, "Tennis");
  // Every leg is tagged with the parent bet's own id.
  assert.equal(inserted.selections[0].betId, "bet-new-express");
  assert.equal(inserted.selections[1].betId, "bet-new-express");
});

test("mergeConfirmedBetIntoRecentBets: EXPRESS is never given a synthesized single-selection fallback (unlike SINGLE)", () => {
  const result = mergeConfirmedBetIntoRecentBets([], confirmedExpress());
  assert.equal(result[0].selections.length, 2);
});

// ---------------------------------------------------------------------
// 3. Duplicate Bet IDs are deduplicated
// ---------------------------------------------------------------------

test("mergeConfirmedBetIntoRecentBets: calling with the same bet twice does not duplicate it", () => {
  const bet = confirmedSingle();
  const once = mergeConfirmedBetIntoRecentBets([existingBet()], bet);
  const twice = mergeConfirmedBetIntoRecentBets(once, bet);

  assert.equal(twice.filter((b) => b.id === "bet-new-single").length, 1);
  assert.equal(twice.length, 2); // the new bet + the one pre-existing bet, still just once each
});

test("mergeConfirmedBetIntoRecentBets: existing bets other than the duplicate are left completely intact", () => {
  const other = existingBet({ id: "bet-other", event: "Untouched Event" });
  const result = mergeConfirmedBetIntoRecentBets([other], confirmedSingle());

  const survivor = result.find((b) => b.id === "bet-other");
  assert.deepEqual(survivor, other);
});

// ---------------------------------------------------------------------
// 4. New bet ordered before older bets
// ---------------------------------------------------------------------

test("mergeConfirmedBetIntoRecentBets: the newly confirmed bet is prepended, before every existing bet", () => {
  const older1 = existingBet({ id: "older-1", createdAt: "2026-07-19T00:00:00.000Z" });
  const older2 = existingBet({ id: "older-2", createdAt: "2026-07-20T00:00:00.000Z" });
  const result = mergeConfirmedBetIntoRecentBets([older1, older2], confirmedSingle());

  assert.deepEqual(
    result.map((b) => b.id),
    ["bet-new-single", "older-1", "older-2"],
  );
});

// ---------------------------------------------------------------------
// 5. Background reconciliation replaces optimistic data with server result
// ---------------------------------------------------------------------

test("applyMiniAppDataAction: BACKGROUND_REFRESH_SUCCESS fully replaces state with the server-authoritative response", () => {
  const optimistic = meResponse({
    recentBets: mergeConfirmedBetIntoRecentBets([existingBet()], confirmedSingle()),
  });

  const serverAuthoritative = meResponse({
    recentBets: [
      { ...existingBet({ id: "bet-new-single" }), status: "PENDING" }, // now the real, server-persisted row
      existingBet(),
    ],
    exposure: "70", // a real server-computed figure, different from whatever the client guessed
  });

  const result = applyMiniAppDataAction(optimistic, { type: "BACKGROUND_REFRESH_SUCCESS", data: serverAuthoritative });

  assert.deepEqual(result, serverAuthoritative);
  // Confirms this is a full replace, not a field-by-field merge.
  assert.equal(result.exposure, "70");
});

// ---------------------------------------------------------------------
// 6. Background refresh failure preserves the optimistic bet
// ---------------------------------------------------------------------

test("applyMiniAppDataAction: BACKGROUND_REFRESH_FAILURE is a no-op — the optimistic bet stays exactly as it was", () => {
  const optimistic = meResponse({
    recentBets: mergeConfirmedBetIntoRecentBets([existingBet()], confirmedSingle()),
  });

  const result = applyMiniAppDataAction(optimistic, { type: "BACKGROUND_REFRESH_FAILURE" });

  assert.deepEqual(result, optimistic);
  assert.ok(result.recentBets.some((b) => b.id === "bet-new-single"));
});

test("applyMiniAppDataAction: BET_CONFIRMED never invents or changes wallet/exposure figures", () => {
  const before = meResponse({ exposure: "20", availableCredit: "9980", currentCredit: "0" });
  const after = applyMiniAppDataAction(before, { type: "BET_CONFIRMED", bet: confirmedSingle() });

  assert.equal(after.exposure, before.exposure);
  assert.equal(after.availableCredit, before.availableCredit);
  assert.equal(after.currentCredit, before.currentCredit);
  assert.equal(after.creditLimit, before.creditLimit);
  assert.equal(after.pendingExposure, before.pendingExposure);
});

test("applyMiniAppDataAction: BET_CONFIRMED status remains PENDING after player confirmation", () => {
  const after = applyMiniAppDataAction(meResponse(), { type: "BET_CONFIRMED", bet: confirmedSingle() });
  assert.equal(after.recentBets[0].status, "PENDING");
});

// ---------------------------------------------------------------------
// 7. Full round-trip: optimistic confirm -> background success reconciles;
//    optimistic confirm -> background failure preserves.
// ---------------------------------------------------------------------

test("applyMiniAppDataAction: full round trip — confirm then a successful background refresh reconciles cleanly", () => {
  let state = meResponse();
  state = applyMiniAppDataAction(state, { type: "BET_CONFIRMED", bet: confirmedExpress() });
  assert.ok(state.recentBets.some((b) => b.id === "bet-new-express"));

  const serverData = meResponse({ recentBets: [existingBet(), existingBet({ id: "bet-new-express" })] });
  state = applyMiniAppDataAction(state, { type: "BACKGROUND_REFRESH_SUCCESS", data: serverData });

  assert.deepEqual(state, serverData);
});

test("applyMiniAppDataAction: full round trip — confirm then a failed background refresh keeps the optimistic bet visible", () => {
  let state = meResponse();
  state = applyMiniAppDataAction(state, { type: "BET_CONFIRMED", bet: confirmedExpress() });
  state = applyMiniAppDataAction(state, { type: "BACKGROUND_REFRESH_FAILURE" });

  assert.ok(state.recentBets.some((b) => b.id === "bet-new-express"));
  assert.equal(state.recentBets[0].selections.length, 2);
});
