import { test } from "node:test";
import assert from "node:assert/strict";
import { IconBallFootball, IconBallBasketball, IconBallTennis, IconTrophy } from "@tabler/icons-react";
import { getSportIconComponent, HockeyPuckIcon } from "./sportIcons";
import { ACTIVE_STATUSES } from "./ActiveBetsScreen";
import type { RecentBet } from "./types";

// Component-level icon logic can't be rendered here (this project has no
// DOM-rendering test infra — jsdom/@testing-library were deliberately not
// added just for this task, matching the project's existing node:test-only
// convention). Instead this proves the exact data path ActiveBetsScreen's
// card list runs: filter recentBets through the real, exported
// ACTIVE_STATUSES set, then resolve each surviving bet's card icon via the
// real getSportIconComponent(bet.sport) — the same lookup <SportIcon>
// performs internally. getSportIconComponent's own mapping rules
// (case-insensitivity, per-sport correctness, hockey's local fallback) are
// already covered exhaustively in sportIcons.test.ts; this file is about
// the *filtering + per-card wiring*, not re-testing the icon map itself.

function bet(overrides: Partial<RecentBet> = {}): RecentBet {
  return {
    id: "bet-1",
    sport: "Football",
    event: "Real Madrid vs Barcelona",
    outcome: "Real Madrid Win",
    stake: "100",
    odds: "2.1",
    status: "CONFIRMED",
    createdAt: "2026-07-21T12:00:00.000Z",
    totalOdds: null,
    selections: [],
    ...overrides,
  };
}

// Mirrors ActiveBetsScreen's own `recentBets.filter((bet) =>
// ACTIVE_STATUSES.has(bet.status))` line exactly.
function activeCardIcons(recentBets: RecentBet[]) {
  return recentBets.filter((b) => ACTIVE_STATUSES.has(b.status)).map((b) => getSportIconComponent(b.sport));
}

test("ActiveBetsScreen: each active bet resolves to its own correct sport icon", () => {
  const bets = [
    bet({ id: "1", sport: "Football" }),
    bet({ id: "2", sport: "Tennis" }),
    bet({ id: "3", sport: "Basketball" }),
    bet({ id: "4", sport: "Hockey" }),
  ];

  assert.deepEqual(activeCardIcons(bets), [IconBallFootball, IconBallTennis, IconBallBasketball, HockeyPuckIcon]);
});

test("ActiveBetsScreen: a mixed-sport active list shows independent icons per card, in order", () => {
  const bets = [
    bet({ id: "1", sport: "Basketball" }),
    bet({ id: "2", sport: "Football" }),
    bet({ id: "3", sport: "Basketball" }),
    bet({ id: "4", sport: "Tennis" }),
  ];

  assert.deepEqual(activeCardIcons(bets), [
    IconBallBasketball,
    IconBallFootball,
    IconBallBasketball,
    IconBallTennis,
  ]);
});

test("ActiveBetsScreen: an unknown sport falls back to the neutral Trophy icon", () => {
  const bets = [bet({ id: "1", sport: "Darts" }), bet({ id: "2", sport: "" })];
  assert.deepEqual(activeCardIcons(bets), [IconTrophy, IconTrophy]);
});

test("ActiveBetsScreen: PENDING and CONFIRMED both count as active and get their own icon; settled/rejected bets are filtered out before icon resolution", () => {
  const bets = [
    bet({ id: "1", sport: "Football", status: "PENDING" }),
    bet({ id: "2", sport: "Tennis", status: "CONFIRMED" }),
    bet({ id: "3", sport: "Basketball", status: "SETTLED_WIN" }),
    bet({ id: "4", sport: "Hockey", status: "REJECTED" }),
  ];

  // Only the two active bets (1, 2) are ever passed through
  // getSportIconComponent — the settled/rejected ones never reach the card
  // list at all.
  assert.deepEqual(activeCardIcons(bets), [IconBallFootball, IconBallTennis]);
});

test("ActiveBetsScreen: sport icon resolution is case-insensitive per card, matching getSportIconComponent's own contract", () => {
  const bets = [bet({ id: "1", sport: "FOOTBALL" }), bet({ id: "2", sport: "tennis" })];
  assert.deepEqual(activeCardIcons(bets), [IconBallFootball, IconBallTennis]);
});
