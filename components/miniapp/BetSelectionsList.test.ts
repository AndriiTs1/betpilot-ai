import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSelectionsForDisplay } from "./BetSelectionsList";
import type { MiniAppBetSelection } from "./types";

// Component-level rendering can't be tested here (this project has no
// DOM-rendering test infra — see ActiveBetsScreen.test.ts's own comment on
// why). Instead this tests the real, exported normalizeSelectionsForDisplay
// function BetSelectionsList's render body calls directly, unmodified — the
// same mirrors-the-component's-own-line convention ActiveBetsScreen.test.ts
// already established. Both ActiveBetsScreen.tsx and HistoryScreen.tsx
// import this same single BetSelectionsList component (confirmed: no
// per-screen variant exists), so this one suite covers both Active and
// History at once, rather than duplicating the same cases per screen.

function sel(overrides: Partial<MiniAppBetSelection> = {}): MiniAppBetSelection {
  return {
    id: "sel-1",
    betId: "bet-1",
    sport: "Football",
    event: "Arsenal vs Coventry City",
    outcome: "Arsenal F1(-1.5)",
    odds: "1.91",
    createdAt: "2026-07-21T12:00:00.000Z",
    updatedAt: "2026-07-21T12:00:00.000Z",
    ...overrides,
  };
}

test("SPREAD: 'Arsenal F1(-1.5)' + canonicalMarketType SPREAD + canonicalParticipant Arsenal + line -1.5 -> 'Arsenal -1.5'", () => {
  const [result] = normalizeSelectionsForDisplay([
    sel({ outcome: "Arsenal F1(-1.5)", canonicalMarketType: "SPREAD", canonicalParticipant: "Arsenal", line: "-1.5" }),
  ]);
  assert.equal(result.outcome, "Arsenal -1.5");
});

test("SPREAD: 'Arsenal F1(-2)' + canonicalMarketType SPREAD + canonicalParticipant Arsenal + line -2 -> 'Arsenal -2'", () => {
  const [result] = normalizeSelectionsForDisplay([
    sel({ outcome: "Arsenal F1(-2)", canonicalMarketType: "SPREAD", canonicalParticipant: "Arsenal", line: "-2" }),
  ]);
  assert.equal(result.outcome, "Arsenal -2");
});

test("SPREAD: 'Coventry City F2(+1.5)' + canonicalMarketType SPREAD + canonicalParticipant Coventry City + line 1.5 -> 'Coventry City +1.5'", () => {
  const [result] = normalizeSelectionsForDisplay([
    sel({
      outcome: "Coventry City F2(+1.5)",
      canonicalMarketType: "SPREAD",
      canonicalParticipant: "Coventry City",
      line: "1.5",
    }),
  ]);
  assert.equal(result.outcome, "Coventry City +1.5");
});

test("regression: MONEYLINE ('Arsenal Win') is unaffected even with canonical fields present", () => {
  const [result] = normalizeSelectionsForDisplay([
    sel({ outcome: "Arsenal Win", canonicalMarketType: "MONEYLINE_2WAY", canonicalParticipant: "Arsenal" }),
  ]);
  assert.equal(result.outcome, "Arsenal Win");
});

test("regression: TOTALS ('Over 2.5') is unaffected — renders via the existing Over/Under path, not the SPREAD path", () => {
  const [result] = normalizeSelectionsForDisplay([sel({ outcome: "Over 2.5", canonicalMarketType: "TOTALS", line: "2.5" })]);
  assert.equal(result.outcome, "Over 2.5 Goals");
});

test("multiple selections keep independent normalization, order preserved", () => {
  const results = normalizeSelectionsForDisplay([
    sel({ id: "a", outcome: "Real Madrid Win", canonicalMarketType: "MONEYLINE_2WAY" }),
    sel({
      id: "b",
      outcome: "Manchester United F1(-0.5)",
      canonicalMarketType: "SPREAD",
      canonicalParticipant: "Manchester United",
      line: "-0.5",
    }),
    sel({ id: "c", outcome: "Chelsea F2(+0.5)", canonicalMarketType: "SPREAD", canonicalParticipant: "Chelsea", line: "0.5" }),
  ]);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["Real Madrid Win", "Manchester United -0.5", "Chelsea +0.5"],
  );
});

test("safety: SPREAD marketType without a participant falls back to the raw stored text, never fabricating one", () => {
  const [result] = normalizeSelectionsForDisplay([
    sel({ outcome: "Arsenal F1(-1.5)", canonicalMarketType: "SPREAD", line: "-1.5" }),
  ]);
  assert.equal(result.outcome, "Arsenal F1(-1.5)");
});

test("safety: a selection with no canonical fields at all (pre-H2-shaped data) is completely unaffected", () => {
  const [result] = normalizeSelectionsForDisplay([sel({ outcome: "Arsenal F1(-1.5)" })]);
  assert.equal(result.outcome, "Arsenal F1(-1.5)");
});

test("does not mutate the input selections array/objects", () => {
  const original = [sel({ id: "sel-1" }), sel({ id: "sel-2", outcome: "Draw" })];
  const snapshot = JSON.parse(JSON.stringify(original));

  const result = normalizeSelectionsForDisplay(original);

  assert.deepEqual(original, snapshot);
  assert.notEqual(result, original);
});
