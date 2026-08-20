import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FINAL_STATUSES } from "./HistoryScreen";
import { ACTIVE_STATUSES } from "./ActiveBetsScreen";
import type { RecentBet } from "./types";

// No DOM-rendering test infra exists in this repo (see
// components/miniapp/ActiveBetsScreen.test.ts's own header comment) — this
// proves the exact filtering HistoryScreen's card list runs:
// `recentBets.filter((bet) => FINAL_STATUSES.has(bet.status))`.

function bet(overrides: Partial<RecentBet> = {}): RecentBet {
  return {
    id: "bet-1",
    type: "SINGLE",
    sport: "Football",
    event: "Arsenal vs Coventry City",
    outcome: "Arsenal -1",
    stake: "100",
    odds: "1.9",
    status: "SETTLED_WIN",
    createdAt: "2026-07-21T12:00:00.000Z",
    totalOdds: null,
    homeTeamName: null,
    awayTeamName: null,
    competitionName: null,
    eventStartTime: null,
    selections: [],
    ...overrides,
  };
}

function historyBets(recentBets: RecentBet[]): RecentBet[] {
  return recentBets.filter((b) => FINAL_STATUSES.has(b.status));
}

// H4-B4, required tests 1/2/5/6 — HALF_WIN/HALF_LOSS classified as final,
// shown in History.
test("HistoryScreen: SETTLED_HALF_WIN is classified as final and appears in History", () => {
  const bets = [bet({ id: "1", status: "SETTLED_HALF_WIN" })];
  assert.deepEqual(
    historyBets(bets).map((b) => b.id),
    ["1"],
  );
});

test("HistoryScreen: SETTLED_HALF_LOSS is classified as final and appears in History", () => {
  const bets = [bet({ id: "1", status: "SETTLED_HALF_LOSS" })];
  assert.deepEqual(
    historyBets(bets).map((b) => b.id),
    ["1"],
  );
});

// H4-B4, required tests 3/4 — HALF_WIN/HALF_LOSS never shown as Active.
test("HistoryScreen/ActiveBetsScreen: SETTLED_HALF_WIN is never active", () => {
  assert.equal(ACTIVE_STATUSES.has("SETTLED_HALF_WIN"), false);
});

test("HistoryScreen/ActiveBetsScreen: SETTLED_HALF_LOSS is never active", () => {
  assert.equal(ACTIVE_STATUSES.has("SETTLED_HALF_LOSS"), false);
});

test("HistoryScreen: a mixed list correctly separates active from final, including both HALF_* statuses", () => {
  const bets = [
    bet({ id: "1", status: "PENDING" }),
    bet({ id: "2", status: "CONFIRMED" }),
    bet({ id: "3", status: "SETTLED_WIN" }),
    bet({ id: "4", status: "SETTLED_LOSS" }),
    bet({ id: "5", status: "VOID" }),
    bet({ id: "6", status: "REJECTED" }),
    bet({ id: "7", status: "SETTLED_HALF_WIN" }),
    bet({ id: "8", status: "SETTLED_HALF_LOSS" }),
  ];

  assert.deepEqual(
    historyBets(bets).map((b) => b.id),
    ["3", "4", "5", "6", "7", "8"],
  );
  assert.deepEqual(
    bets.filter((b) => ACTIVE_STATUSES.has(b.status)).map((b) => b.id),
    ["1", "2"],
  );
});

// H4-B4 — ACTIVE_STATUSES and FINAL_STATUSES together must exactly
// partition every real BetStatus value: no bet can appear in both screens,
// and none can vanish from both (the exact bug this stage fixed for
// HALF_*).
test("HistoryScreen/ActiveBetsScreen: every BetStatus value is classified as exactly one of active or final, no overlap, no gap", () => {
  const ALL_BET_STATUSES = [
    "PENDING",
    "CONFIRMED",
    "REJECTED",
    "SETTLED_WIN",
    "SETTLED_LOSS",
    "VOID",
    "SETTLED_HALF_WIN",
    "SETTLED_HALF_LOSS",
  ];

  for (const status of ALL_BET_STATUSES) {
    const isActive = ACTIVE_STATUSES.has(status);
    const isFinal = FINAL_STATUSES.has(status);
    assert.notEqual(isActive, isFinal, `${status} must be classified as exactly one of active/final`);
  }
});

// Regression — existing statuses unchanged.
test("HistoryScreen: WIN/LOSS/VOID/REJECTED regression — still classified as final, unchanged", () => {
  const bets = [
    bet({ id: "1", status: "SETTLED_WIN" }),
    bet({ id: "2", status: "SETTLED_LOSS" }),
    bet({ id: "3", status: "VOID" }),
    bet({ id: "4", status: "REJECTED" }),
  ];
  assert.deepEqual(
    historyBets(bets).map((b) => b.id),
    ["1", "2", "3", "4"],
  );
});

test("HistoryScreen: CONFIRMED/PENDING regression — still excluded from History, unchanged", () => {
  const bets = [bet({ id: "1", status: "PENDING" }), bet({ id: "2", status: "CONFIRMED" })];
  assert.deepEqual(historyBets(bets), []);
});

test("HistoryScreen: title/empty-state are translated via t(), never hardcoded literals — StatusBadge itself (shared with the operator dashboard) is untouched", () => {
  const source = readFileSync(fileURLToPath(new URL("./HistoryScreen.tsx", import.meta.url)), "utf8");

  assert.match(source, /import \{ useLocale \} from "\.\/LocaleProvider";/);
  assert.match(source, /\{t\("history\.title"\)\}/);
  assert.match(source, /\{t\("history\.emptyState"\)\}/);
  assert.equal(source.includes('>История<'), false);
  assert.match(source, /<StatusBadge status=\{bet\.status\} \/>/);
});
