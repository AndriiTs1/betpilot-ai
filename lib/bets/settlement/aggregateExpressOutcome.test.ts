import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import type { CanonicalSelection } from "@/lib/odds/domain";
import { aggregateExpressOutcome, type ExpressLeg } from "./aggregateExpressOutcome";
import type { CanonicalEventResult, EventResultStatus } from "./eventResultDomain";

/* -------------------------------------------------------------------------- */
/* Fixture builders                                                           */
/* -------------------------------------------------------------------------- */

function selection(selectionType: CanonicalSelection["selectionType"] = "HOME"): CanonicalSelection {
  return {
    sport: "UNKNOWN",
    event: { sport: "UNKNOWN", name: "", participants: [], period: "FULL_GAME" },
    marketType: "MONEYLINE_3WAY",
    period: "FULL_GAME",
    selectionType,
  };
}

function leg(overrides: Partial<ExpressLeg> = {}): ExpressLeg {
  return {
    id: "leg-1",
    providerEventId: "evt-1",
    selection: selection("HOME"),
    odds: new Prisma.Decimal("2.00"),
    ...overrides,
  };
}

function eventResult(overrides: Partial<CanonicalEventResult> = {}): CanonicalEventResult {
  return {
    status: "COMPLETED",
    homeParticipant: { name: "Home" },
    awayParticipant: { name: "Away" },
    homeScore: 2,
    awayScore: 0,
    ...overrides,
  };
}

function lookup(entries: ReadonlyArray<readonly [string, CanonicalEventResult]>): ReadonlyMap<string, CanonicalEventResult> {
  return new Map(entries);
}

// X3E — aggregateExpressOutcome() now requires the bet's stake (needed only
// for the branch-exact settlement path). A fixed 100 is used throughout
// this file except where a test specifically exercises a different stake
// value (see the dedicated X3E sections further down).
const DEFAULT_STAKE = new Prisma.Decimal(100);

/* -------------------------------------------------------------------------- */
/* ALL WIN                                                                    */
/* -------------------------------------------------------------------------- */

test("all WIN: 2 legs -> WIN, effectiveOdds is the product of both legs' odds", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: selection("HOME") }),
    leg({ id: "l2", providerEventId: "e2", odds: new Prisma.Decimal("1.50"), selection: selection("HOME") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 3, awayScore: 1 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "3"); // 2.00 * 1.50
  assert.deepEqual([...result.winningSelectionIds].sort(), ["l1", "l2"]);
  assert.deepEqual(result.voidedSelectionIds, []);
});

test("all WIN: single leg -> WIN, effectiveOdds equals that leg's own odds", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.10") })];
  const results = lookup([["e1", eventResult()]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "2.1");
});

/* -------------------------------------------------------------------------- */
/* LOSS                                                                       */
/* -------------------------------------------------------------------------- */

test("LOSS: one losing leg among winning legs -> overall LOSS", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: selection("HOME") }), // will WIN
    leg({ id: "l2", providerEventId: "e2", selection: selection("AWAY") }), // will LOSE
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })], // AWAY loses
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["l2"]);
});

test("LOSS: one losing leg while another is still WAITING -> LOSS finalizes immediately", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: selection("AWAY") }), // LOSS
    leg({ id: "l2", providerEventId: "e2", selection: selection("HOME") }), // no result yet
  ];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]); // e2 missing entirely

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["l1"]);
});

/* -------------------------------------------------------------------------- */
/* ALL VOID                                                                   */
/* -------------------------------------------------------------------------- */

test("all VOID: every leg voids (2-way draw) -> overall VOID", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: { ...selection("HOME"), marketType: "MONEYLINE_2WAY" } }),
    leg({ id: "l2", providerEventId: "e2", selection: { ...selection("AWAY"), marketType: "MONEYLINE_2WAY" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 1 })],
    ["e2", eventResult({ homeScore: 3, awayScore: 3 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.deepEqual(result, { kind: "VOID" });
});

/* -------------------------------------------------------------------------- */
/* WIN + VOID mix (the Stage 3.4A-unblocked case)                            */
/* -------------------------------------------------------------------------- */

test("WIN + VOID: exact worked example — leg A odds 2.00 WIN, leg B odds 3.00 VOID -> effectiveOdds 2.00", () => {
  const legs = [
    leg({ id: "A", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: { ...selection("HOME"), marketType: "MONEYLINE_3WAY" } }),
    leg({ id: "B", providerEventId: "e2", odds: new Prisma.Decimal("3.00"), selection: { ...selection("HOME"), marketType: "MONEYLINE_2WAY" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })], // 3-way HOME win
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // 2-way draw -> VOID
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "2"); // NOT 2.00 * 3.00 = 6.00
  assert.deepEqual(result.winningSelectionIds, ["A"]);
  assert.deepEqual(result.voidedSelectionIds, ["B"]);
});

test("WIN + VOID: multiple WIN legs and multiple VOID legs -> effectiveOdds is the product of WIN legs only", () => {
  const legs = [
    leg({ id: "w1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: { ...selection("HOME"), marketType: "MONEYLINE_3WAY" } }),
    leg({ id: "w2", providerEventId: "e2", odds: new Prisma.Decimal("1.50"), selection: { ...selection("HOME"), marketType: "MONEYLINE_3WAY" } }),
    leg({ id: "v1", providerEventId: "e3", odds: new Prisma.Decimal("5.00"), selection: { ...selection("HOME"), marketType: "MONEYLINE_2WAY" } }),
    leg({ id: "v2", providerEventId: "e4", odds: new Prisma.Decimal("9.00"), selection: { ...selection("HOME"), marketType: "MONEYLINE_2WAY" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 3, awayScore: 1 })],
    ["e3", eventResult({ homeScore: 1, awayScore: 1 })],
    ["e4", eventResult({ homeScore: 2, awayScore: 2 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "3"); // 2.00 * 1.50, VOID legs excluded entirely
  assert.deepEqual([...result.winningSelectionIds].sort(), ["w1", "w2"]);
  assert.deepEqual([...result.voidedSelectionIds].sort(), ["v1", "v2"]);
});

/* -------------------------------------------------------------------------- */
/* WAITING                                                                    */
/* -------------------------------------------------------------------------- */

test("WAITING: no LOSS, one leg's event not yet completed -> overall WAITING", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1" }),
    leg({ id: "l2", providerEventId: "e2" }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })], // WIN
    ["e2", eventResult({ status: "IN_PROGRESS", homeScore: null, awayScore: null })], // WAITING
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WAITING");
  if (result.kind !== "WAITING") return;
  assert.deepEqual(result.waitingSelectionIds, ["l2"]);
  assert.deepEqual(result.missingProviderEventIds, []); // a result WAS supplied, just not resolved
});

test("WAITING: missing provider result entirely -> WAITING, missingProviderEventIds populated", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([]); // nothing supplied at all

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WAITING");
  if (result.kind !== "WAITING") return;
  assert.deepEqual(result.waitingSelectionIds, ["l1"]);
  assert.deepEqual(result.missingProviderEventIds, ["e1"]);
});

const NO_LOSS_STATUS_CASES: Array<[string, EventResultStatus]> = [
  ["POSTPONED", "POSTPONED"],
  ["ABANDONED", "ABANDONED"],
  ["NOT_STARTED", "NOT_STARTED"],
];

for (const [label, status] of NO_LOSS_STATUS_CASES) {
  test(`WAITING: ${label} leg with no LOSS elsewhere -> overall WAITING`, () => {
    const legs = [leg({ id: "l1", providerEventId: "e1" })];
    const results = lookup([["e1", eventResult({ status, homeScore: null, awayScore: null })]]);

    const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
    assert.equal(result.kind, "WAITING");
  });
}

test("CANCELLED status leg with no LOSS elsewhere -> overall VOID (evaluator's own CANCELLED->VOID rule, aggregated as all-VOID)", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult({ status: "CANCELLED", homeScore: null, awayScore: null })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.deepEqual(result, { kind: "VOID" });
});

/* -------------------------------------------------------------------------- */
/* UNSUPPORTED / INVALID_DATA                                                 */
/* -------------------------------------------------------------------------- */

// H5-A2 — TOTALS is no longer a generically-UNSUPPORTED_MARKET example (see
// the dedicated H5-A2 section below for its own explicit deferred-reason
// coverage); BOTH_TEAMS_TO_SCORE (still genuinely out of scope) replaces it
// here so this test still proves what it always proved: a real, unmodeled
// market produces UNSUPPORTED_MARKET.
test("UNSUPPORTED: no LOSS, one leg's market is unsupported -> overall UNSUPPORTED", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1" }),
    leg({ id: "l2", providerEventId: "e2", selection: { ...selection("HOME"), marketType: "BOTH_TEAMS_TO_SCORE", selectionType: "YES" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "UNSUPPORTED");
  if (result.kind !== "UNSUPPORTED") return;
  assert.deepEqual(result.affectedSelectionIds, ["l2"]);
  assert.equal(result.reasonCodes["l2"], "UNSUPPORTED_MARKET");
});

test("INVALID_DATA: no LOSS, one leg's event result has a missing score -> overall INVALID_DATA", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1" }),
    leg({ id: "l2", providerEventId: "e2" }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: null, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "INVALID_DATA");
  if (result.kind !== "INVALID_DATA") return;
  assert.deepEqual(result.affectedSelectionIds, ["l2"]);
  assert.equal(result.reasonCodes["l2"], "MISSING_SCORE");
});

test("combination UNSUPPORTED + LOSS -> LOSS wins (unconditional, per Stage 3.4 audit section 7.G)", () => {
  const legs = [
    leg({ id: "loser", providerEventId: "e1", selection: selection("AWAY") }),
    leg({ id: "unsupported", providerEventId: "e2", selection: { ...selection("HOME"), marketType: "TOTALS", selectionType: "OVER" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })], // AWAY loses
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["loser"]);
});

test("combination INVALID_DATA + LOSS -> LOSS wins (unconditional)", () => {
  const legs = [
    leg({ id: "loser", providerEventId: "e1", selection: selection("AWAY") }),
    leg({ id: "invalid", providerEventId: "e2" }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: null, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["loser"]);
});

test("priority: INVALID_DATA is surfaced before UNSUPPORTED when both co-occur (no LOSS present)", () => {
  const legs = [
    leg({ id: "invalid", providerEventId: "e1" }),
    leg({ id: "unsupported", providerEventId: "e2", selection: { ...selection("HOME"), marketType: "TOTALS", selectionType: "OVER" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: null, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "INVALID_DATA");
});

/* -------------------------------------------------------------------------- */
/* Odds edge cases                                                            */
/* -------------------------------------------------------------------------- */

test("WIN with a null BetSelection.odds on the winning leg -> INVALID_DATA, not a crash or a fabricated price", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: null })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "INVALID_DATA");
  if (result.kind !== "INVALID_DATA") return;
  assert.deepEqual(result.affectedSelectionIds, ["l1"]);
  assert.equal(result.reasonCodes["l1"], "INVALID_SELECTION_ODDS");
});

test("Decimal precision: product uses Prisma.Decimal throughout, HALF_UP rounded to 2 places (matches lib/bets/expressMath.ts's rule)", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("1.111") }),
    leg({ id: "l2", providerEventId: "e2", odds: new Prisma.Decimal("1.111") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  // 1.111 * 1.111 = 1.234321 -> HALF_UP to 2dp = 1.23
  assert.equal(result.effectiveOdds?.toString(), "1.23");
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

test("purity: input legs array and lookup are not mutated", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult()]]);
  const legsCopy = JSON.parse(JSON.stringify(legs.map((l) => ({ ...l, odds: l.odds?.toString() }))));

  aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  const legsAfter = JSON.parse(JSON.stringify(legs.map((l) => ({ ...l, odds: l.odds?.toString() }))));
  assert.deepEqual(legsAfter, legsCopy);
  assert.equal(results.size, 1);
});

test("purity: identical input always returns a deep-equal result", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult()]]);

  const r1 = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  const r2 = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.deepEqual(r1, r2);
});

/* -------------------------------------------------------------------------- */
/* X3B — SPREAD/TOTALS aggregation ENABLED. The SPREAD_AUTO_SETTLEMENT_      */
/* DEFERRED/TOTALS_AUTO_SETTLEMENT_DEFERRED guards (H4-B2/H5-A2) are removed */
/* — both markets now reach real evaluateSelectionOutcome() evaluation and  */
/* the exact per-leg factor model (contributingFactorFor in                 */
/* aggregateExpressOutcome.ts) proven by the X1 audit.                      */
/* -------------------------------------------------------------------------- */

function spreadSelection(participantName: string, line: string): CanonicalSelection {
  return {
    sport: "UNKNOWN",
    event: { sport: "UNKNOWN", name: "", participants: [], period: "FULL_GAME" },
    marketType: "SPREAD",
    period: "FULL_GAME",
    selectionType: "PARTICIPANT",
    participant: { name: participantName },
    line,
  };
}

function totalsSelection(direction: "OVER" | "UNDER", line: string): CanonicalSelection {
  return {
    sport: "UNKNOWN",
    event: { sport: "UNKNOWN", name: "", participants: [], period: "FULL_GAME" },
    marketType: "TOTALS",
    period: "FULL_GAME",
    selectionType: direction,
    line,
  };
}

/* --- Standard-line SPREAD/TOTALS regression: real evaluation, not deferred */

test("X3B standard-line regression: SPREAD -1.5, home wins by 2 -> WIN reaches real aggregation (not deferred)", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: spreadSelection("Home", "-1.5") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
});

test("X3B standard-line regression: SPREAD -1.5, home wins by 1 -> LOSS reaches real aggregation", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: spreadSelection("Home", "-1.5") })];
  const results = lookup([["e1", eventResult({ homeScore: 1, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
});

test("X3B standard-line regression: SPREAD -1, home wins by exactly 1 -> PUSH -> VOID", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: spreadSelection("Home", "-1") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.deepEqual(result, { kind: "VOID" });
});

test("X3B standard-line regression: TOTALS Over 2.5, 3 total goals -> WIN reaches real aggregation", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: totalsSelection("OVER", "2.5") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
});

test("X3B standard-line regression: TOTALS Under 2.5, 3 total goals -> LOSS reaches real aggregation", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: totalsSelection("UNDER", "2.5") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
});

test("X3B standard-line regression: TOTALS 3, exactly 3 total goals -> PUSH -> VOID", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: totalsSelection("OVER", "3") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.deepEqual(result, { kind: "VOID" });
});

/* --- Quarter-line EXPRESS matrix -------------------------------------------
 * X3E — a single split leg (no other WIN legs) is the exact SINGLE
 * HALF_WIN/HALF_LOSS degenerate case proven in expressBranchSettlement.test.ts
 * (Phase 3): stake 100 @ odds 2.00 HALF_WIN -> +50; stake 100 HALF_LOSS ->
 * -50, regardless of which market/line produced that classification.
 * ----------------------------------------------------------------------- */

test("X3E quarter-line: SPREAD -1.25, home wins by exactly 1 -> HALF_LOSS reaches real aggregation, exactDelta -50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1.25") })];
  // components [-1.5, -1]: -1.5+1=-0.5 LOSS, -1+1=0 PUSH -> HALF_LOSS
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.losingSelectionIds.length, 0);
  assert.equal(result.exactDelta?.toString(), "-50");
});

test("X3E quarter-line: SPREAD -0.75, home wins by exactly 1 -> HALF_WIN reaches real aggregation, exactDelta +50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") })];
  // components [-1, -0.5]: -1+1=0 PUSH, -0.5+1=0.5 WIN -> HALF_WIN
  const results = lookup([["e1", eventResult({ homeScore: 1, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "50");
});

test("X3E quarter-line: TOTALS Over 2.25, 2 total goals -> HALF_LOSS reaches real aggregation, exactDelta -50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.25") })];
  const results = lookup([["e1", eventResult({ homeScore: 1, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-50");
});

test("X3E quarter-line: TOTALS Under 2.25, 2 total goals -> HALF_WIN reaches real aggregation, exactDelta +50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: totalsSelection("UNDER", "2.25") })];
  const results = lookup([["e1", eventResult({ homeScore: 1, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "50");
});

test("X3E quarter-line: TOTALS Over 2.75, 3 total goals -> HALF_WIN reaches real aggregation, exactDelta +50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: totalsSelection("OVER", "2.75") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "50");
});

test("X3E quarter-line: TOTALS Under 2.75, 3 total goals -> HALF_LOSS reaches real aggregation, exactDelta -50", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("UNDER", "2.75") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-50");
});

/* --- Math matrix A-I -------------------------------------------------------*/

test("X3B (A): WIN + WIN, odds 2.00 x 1.50 -> E=3.00, SETTLED_WIN-shaped", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: selection("HOME") }),
    leg({ id: "l2", providerEventId: "e2", odds: new Prisma.Decimal("1.50"), selection: selection("HOME") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 3, awayScore: 1 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "3");
});

test("X3B (B): HALF_WIN (odds 2.00) + WIN (odds 1.50) -> E=2.25", () => {
  const legs = [
    leg({ id: "half", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "win", providerEventId: "e2", odds: new Prisma.Decimal("1.50"), selection: selection("HOME") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "125"); // stake 100, X3D branch-exact
  assert.deepEqual([...result.winningSelectionIds].sort(), ["half", "win"]);
});

test("X3B (C): HALF_LOSS (odds-independent) + WIN (odds 1.5) -> partial SETTLED_LOSS, exactDelta -25", () => {
  const legs = [
    leg({ id: "halfloss", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1.25") }),
    leg({ id: "win", providerEventId: "e2", odds: new Prisma.Decimal("1.50"), selection: selection("HOME") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 1 })], // -1.25 -> HALF_LOSS
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.losingSelectionIds.length, 0);
  assert.equal(result.exactDelta?.toString(), "-25"); // stake 100, X3D branch-exact
});

test("X3B (D): HALF_WIN (odds 2.00) + HALF_WIN (odds 3.00) -> exactDelta +200", () => {
  const legs = [
    leg({ id: "h1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "h2", providerEventId: "e2", odds: new Prisma.Decimal("3.00"), selection: totalsSelection("OVER", "2.75") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // Over 2.75, 3 goals -> HALF_WIN
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "200"); // stake 100, X3D branch-exact
});

test("X3B (E): HALF_WIN (odds 2.00) + HALF_LOSS -> partial SETTLED_LOSS, exactDelta -25", () => {
  const legs = [
    leg({ id: "h1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "h2", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // Over 2.25, 2 goals -> HALF_LOSS
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-25"); // stake 100, X3D branch-exact
});

test("X3B (F): HALF_LOSS + HALF_LOSS -> partial SETTLED_LOSS, exactDelta -75", () => {
  const legs = [
    leg({ id: "h1", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1.25") }),
    leg({ id: "h2", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 1 })], // -1.25 -> HALF_LOSS
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // Over 2.25, 2 goals -> HALF_LOSS
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-75"); // stake 100, X3D branch-exact
});

test("X3B (G): HALF_WIN + VOID -> exactDelta equals the single-split-leg value, VOID excluded", () => {
  const legs = [
    leg({ id: "half", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "void", providerEventId: "e2", odds: new Prisma.Decimal("5.00"), selection: spreadSelection("Home", "-1") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // -1, home wins by exactly 1 -> PUSH -> VOID
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "50"); // stake 100, X3D branch-exact
  assert.deepEqual(result.winningSelectionIds, ["half"]);
  assert.deepEqual(result.voidedSelectionIds, ["void"]);
});

test("X3B (H): HALF_LOSS + VOID -> partial SETTLED_LOSS, exactDelta -50, VOID excluded", () => {
  const legs = [
    leg({ id: "half", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1.25") }),
    leg({ id: "void", providerEventId: "e2", odds: new Prisma.Decimal("5.00"), selection: spreadSelection("Home", "-1") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 1 })], // -1.25 -> HALF_LOSS
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // -1, PUSH -> VOID
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-50"); // stake 100, X3D branch-exact
});

test("X3B (I): a HALF_WIN leg alongside a genuine full LOSS leg -> whole bet LOSS, E=0, no effectiveOdds override (unconditional LOSS priority, unchanged)", () => {
  const legs = [
    leg({ id: "half", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "loser", providerEventId: "e2", selection: selection("AWAY") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // would be HALF_WIN
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })], // AWAY loses
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["loser"]);
  assert.equal(result.exactDelta, undefined);
});

/* --- E == 1 breakeven: a genuine coincidental VOID, not "every leg voided" */

test("X3B: HALF_WIN (factor 2.0) + HALF_LOSS (factor 0.5) coincidentally multiply to exactly 1.00 -> VOID, not WIN or LOSS", () => {
  const legs = [
    leg({ id: "h1", providerEventId: "e1", odds: new Prisma.Decimal("3.00"), selection: totalsSelection("OVER", "2.75") }),
    leg({ id: "h2", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 1 })], // Over 2.75, 3 goals -> HALF_WIN, factor 2.0
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // Over 2.25, 2 goals -> HALF_LOSS, factor 0.5
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.deepEqual(result, { kind: "VOID" });
});

/* --- Mixed-market combinations --------------------------------------------*/

test("X3B mixed market: MONEYLINE WIN + SPREAD WIN -> WIN, effectiveOdds is the product", () => {
  const legs = [
    leg({ id: "ml", providerEventId: "e1", odds: new Prisma.Decimal("1.80"), selection: selection("HOME") }),
    leg({ id: "sp", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: spreadSelection("Home", "-1.5") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "3.42"); // 1.80 * 1.90, ordinary path (no split leg)
});

test("X3B mixed market: MONEYLINE WIN + SPREAD HALF_WIN -> WIN, exactDelta +170", () => {
  const legs = [
    leg({ id: "ml", providerEventId: "e1", odds: new Prisma.Decimal("1.80"), selection: selection("HOME") }),
    leg({ id: "sp", providerEventId: "e2", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "170"); // stake 100, X3D branch-exact
});

test("X3B mixed market: MONEYLINE WIN + SPREAD HALF_LOSS -> partial LOSS, exactDelta -10", () => {
  const legs = [
    leg({ id: "ml", providerEventId: "e1", odds: new Prisma.Decimal("1.80"), selection: selection("HOME") }),
    leg({ id: "sp", providerEventId: "e2", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // -1.25 -> HALF_LOSS
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-10"); // stake 100, X3D branch-exact
});

test("X3B mixed market: MONEYLINE WIN + TOTALS HALF_WIN -> WIN, exactDelta +161", () => {
  const legs = [
    leg({ id: "ml", providerEventId: "e1", odds: new Prisma.Decimal("1.80"), selection: selection("HOME") }),
    leg({ id: "tot", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("UNDER", "2.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // Under 2.25, 2 goals -> HALF_WIN
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.exactDelta?.toString(), "161"); // stake 100, X3D branch-exact
});

test("X3B mixed market: SPREAD HALF_WIN + TOTALS HALF_LOSS -> partial LOSS, exactDelta -25", () => {
  const legs = [
    leg({ id: "sp", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "tot", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.25") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN
    ["e2", eventResult({ homeScore: 1, awayScore: 1 })], // Over 2.25, 2 goals -> HALF_LOSS
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.equal(result.exactDelta?.toString(), "-25"); // stake 100, X3D branch-exact
});

test("X3B mixed market: SPREAD VOID + TOTALS WIN -> WIN, VOID leg excluded from the product", () => {
  const legs = [
    leg({ id: "sp", providerEventId: "e1", odds: new Prisma.Decimal("2.00"), selection: spreadSelection("Home", "-1") }),
    leg({ id: "tot", providerEventId: "e2", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.5") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 1 })], // -1, PUSH -> VOID
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // Over 2.5, 3 goals -> WIN
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "1.9"); // ordinary path (no split leg)
  assert.deepEqual(result.winningSelectionIds, ["tot"]);
  assert.deepEqual(result.voidedSelectionIds, ["sp"]);
});

test("X3B: multiple legs on the same provider event settle independently against the same result", () => {
  const legs = [
    leg({ id: "ml", providerEventId: "e1", odds: new Prisma.Decimal("1.80"), selection: selection("HOME") }),
    leg({ id: "tot", providerEventId: "e1", odds: new Prisma.Decimal("1.90"), selection: totalsSelection("OVER", "2.5") }),
  ];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]); // HOME wins, 3 total goals

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds?.toString(), "3.42"); // 1.80 * 1.90, ordinary path (no split leg)
  assert.deepEqual([...result.winningSelectionIds].sort(), ["ml", "tot"]);
});

/* --- Rounding / Decimal safety --------------------------------------------*/

test("X3B rounding: HALF_WIN odds 1.63 combined with a WIN leg odds 2.49, stake 100 -> exact branch-settled result, no float artifact", () => {
  const legs = [
    leg({ id: "half", providerEventId: "e1", odds: new Prisma.Decimal("1.63"), selection: spreadSelection("Home", "-0.75") }),
    leg({ id: "win", providerEventId: "e2", odds: new Prisma.Decimal("2.49"), selection: selection("HOME") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 1, awayScore: 0 })], // -0.75 -> HALF_WIN, odds 1.63
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  // X3D branch-exact: WIN branch (stake/2 @ 1.63*2.49=4.0587) + VOID branch
  // (stake/2 @ 2.49 alone), each independently rounded then summed — see
  // expressBranchSettlement.test.ts's own Phase 4 X3C (1)/(2) proofs for
  // this exact 1.63/2.49 pair at other stakes.
  assert.equal(result.exactDelta?.toString(), "227.44");
});

/* --- Fail-closed: SPREAD/TOTALS structural problems still block settlement */

test("X3B fail-closed: SPREAD leg with no line -> INVALID_DATA MISSING_LINE, never silently settled", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: { ...spreadSelection("Home", "-1"), line: undefined } })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "INVALID_DATA");
  if (result.kind !== "INVALID_DATA") return;
  assert.equal(result.reasonCodes["l1"], "MISSING_LINE");
});

test("X3B fail-closed: TOTALS leg with an off-grid line (2.33) -> INVALID_DATA INVALID_LINE, never rounded to the nearest supported line", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: totalsSelection("OVER", "2.33") })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 1 })]]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "INVALID_DATA");
  if (result.kind !== "INVALID_DATA") return;
  assert.equal(result.reasonCodes["l1"], "INVALID_LINE");
});

test("X3B fail-closed: a real full LOSS leg is still terminal even alongside a co-occurring INVALID_DATA SPREAD leg (unconditional LOSS priority, unchanged policy)", () => {
  const legs = [
    leg({ id: "loser", providerEventId: "e1", selection: selection("AWAY") }),
    leg({ id: "invalid", providerEventId: "e2", selection: { ...spreadSelection("Home", "-1"), line: undefined } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })], // AWAY loses
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);
  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["loser"]);
});

/* ============================================================================
 * Individual Team Totals, Stage 4 — EXPRESS aggregation. No changes were
 * needed to aggregateExpressOutcome.ts itself for this — it already
 * dispatches purely on evaluateSelectionOutcome()'s returned `kind`
 * (WIN/LOSS/VOID/HALF_WIN/HALF_LOSS/...), with zero market-type-specific
 * branching. These tests prove that generic dispatch already correctly
 * carries TEAM_TOTAL legs through EXPRESS settlement, exactly like any
 * other market.
 * ============================================================================ */

function teamTotalSelection(participantName: string, direction: "OVER" | "UNDER", line: string): CanonicalSelection {
  return {
    sport: "UNKNOWN",
    event: { sport: "UNKNOWN", name: "", participants: [], period: "FULL_GAME" },
    marketType: "TEAM_TOTAL",
    period: "FULL_GAME",
    selectionType: direction,
    participant: { name: participantName },
    line,
  };
}

test("Individual Team Totals Stage 4 (18): a winning TEAM_TOTAL leg participates correctly in an all-WIN EXPRESS", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Marseille", "OVER", "1.5"), odds: new Prisma.Decimal("1.9") }),
    leg({ id: "l2", providerEventId: "e2", selection: selection("HOME"), odds: new Prisma.Decimal("2.0") }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 1 })],
    ["e2", eventResult({ homeScore: 1, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.deepEqual([...result.winningSelectionIds].sort(), ["l1", "l2"]);
});

test("Individual Team Totals Stage 4 (19): a losing TEAM_TOTAL leg loses the WHOLE express, even with an otherwise-winning MONEYLINE leg", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Marseille", "OVER", "1.5"), odds: new Prisma.Decimal("1.9") }),
    leg({ id: "l2", providerEventId: "e2", selection: selection("HOME"), odds: new Prisma.Decimal("2.0") }),
  ];
  const results = lookup([
    // Marseille scores only 1 -> LOSS for "OVER 1.5".
    ["e1", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 1, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 1, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["l1"]);
});

test("Individual Team Totals Stage 4 (20): a pushed/void TEAM_TOTAL leg follows existing EXPRESS void-leg rules — voided, never counted as a losing or contributing leg, remaining legs still decide the outcome", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Marseille", "OVER", "2"), odds: new Prisma.Decimal("1.9") }),
    leg({ id: "l2", providerEventId: "e2", selection: selection("HOME"), odds: new Prisma.Decimal("2.0") }),
  ];
  const results = lookup([
    // Marseille scores exactly 2 -> PUSH/VOID for "OVER 2".
    ["e1", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 1, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN", "the express still wins on its one real WIN leg, with the pushed leg simply excluded from the odds product");
  if (result.kind !== "WIN") return;
  assert.deepEqual(result.winningSelectionIds, ["l2"]);
  assert.deepEqual(result.voidedSelectionIds, ["l1"]);
  // Same rule proven elsewhere in this file for SPREAD/TOTALS pushes: the
  // voided leg contributes NOTHING to the odds product (never a 1.0
  // multiplier, never dropped silently without being reported).
  assert.equal(result.effectiveOdds?.toString(), "2");
});

test("Individual Team Totals Stage 4 (20b): an EXPRESS made ENTIRELY of pushed legs (including TEAM_TOTAL) is a whole-bet VOID, same existing rule as an all-push SPREAD/TOTALS express", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Marseille", "OVER", "2"), odds: new Prisma.Decimal("1.9") })];
  const results = lookup([
    ["e1", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "VOID");
});

test("Individual Team Totals Stage 4 (21): mixed EXPRESS — MONEYLINE + TOTALS + TEAM_TOTAL — settles correctly as a WIN when all three legs win independently", () => {
  const legs = [
    leg({ id: "moneyline", providerEventId: "e1", selection: selection("HOME"), odds: new Prisma.Decimal("1.8") }),
    leg({ id: "totals", providerEventId: "e2", selection: totalsSelection("OVER", "2.5"), odds: new Prisma.Decimal("1.9") }),
    leg({
      id: "teamTotal",
      providerEventId: "e3",
      selection: teamTotalSelection("Marseille", "UNDER", "2.5"),
      odds: new Prisma.Decimal("2.0"),
    }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })], // MONEYLINE HOME wins
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })], // TOTALS: 3 goals > 2.5 -> WIN
    ["e3", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 1 })], // Marseille 2 < 2.5 -> WIN
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.deepEqual([...result.winningSelectionIds].sort(), ["moneyline", "teamTotal", "totals"]);
  // 1.8 * 1.9 * 2.0 = 6.84
  assert.equal(result.effectiveOdds?.toString(), "6.84");
});

test("Individual Team Totals Stage 4 (21b): the SAME mixed EXPRESS loses correctly when only the TEAM_TOTAL leg fails", () => {
  const legs = [
    leg({ id: "moneyline", providerEventId: "e1", selection: selection("HOME"), odds: new Prisma.Decimal("1.8") }),
    leg({ id: "totals", providerEventId: "e2", selection: totalsSelection("OVER", "2.5"), odds: new Prisma.Decimal("1.9") }),
    leg({
      id: "teamTotal",
      providerEventId: "e3",
      selection: teamTotalSelection("Marseille", "UNDER", "1.5"),
      odds: new Prisma.Decimal("2.0"),
    }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 1 })],
    // Marseille scores 2, requested UNDER 1.5 -> LOSS.
    ["e3", eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 1 })],
  ]);

  const result = aggregateExpressOutcome(legs, results, DEFAULT_STAKE);

  assert.equal(result.kind, "LOSS");
  if (result.kind !== "LOSS") return;
  assert.deepEqual(result.losingSelectionIds, ["teamTotal"]);
});

test("Individual Team Totals Stage 4: both Marseille and Strasbourg TEAM_TOTAL legs against the SAME final score prove participant attribution inside EXPRESS too, not just in evaluateSelectionOutcome directly", () => {
  const sameResult = eventResult({ homeParticipant: { name: "Marseille" }, awayParticipant: { name: "Strasbourg" }, homeScore: 2, awayScore: 1 });

  const marseilleLegs = [leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Marseille", "OVER", "1.5"), odds: new Prisma.Decimal("1.9") })];
  const strasbourgLegs = [leg({ id: "l1", providerEventId: "e1", selection: teamTotalSelection("Strasbourg", "OVER", "1.5"), odds: new Prisma.Decimal("1.9") })];
  const results = lookup([["e1", sameResult]]);

  const marseilleResult = aggregateExpressOutcome(marseilleLegs, results, DEFAULT_STAKE);
  const strasbourgResult = aggregateExpressOutcome(strasbourgLegs, results, DEFAULT_STAKE);

  assert.equal(marseilleResult.kind, "WIN", "Marseille (2 goals) clears OVER 1.5");
  assert.equal(strasbourgResult.kind, "LOSS", "Strasbourg (1 goal) does not clear OVER 1.5");
});
