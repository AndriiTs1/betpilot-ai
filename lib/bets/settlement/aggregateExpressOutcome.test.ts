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

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds.toString(), "3"); // 2.00 * 1.50
  assert.deepEqual([...result.winningSelectionIds].sort(), ["l1", "l2"]);
  assert.deepEqual(result.voidedSelectionIds, []);
});

test("all WIN: single leg -> WIN, effectiveOdds equals that leg's own odds", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: new Prisma.Decimal("2.10") })];
  const results = lookup([["e1", eventResult()]]);

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds.toString(), "2.1");
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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds.toString(), "2"); // NOT 2.00 * 3.00 = 6.00
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

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  assert.equal(result.effectiveOdds.toString(), "3"); // 2.00 * 1.50, VOID legs excluded entirely
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

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WAITING");
  if (result.kind !== "WAITING") return;
  assert.deepEqual(result.waitingSelectionIds, ["l2"]);
  assert.deepEqual(result.missingProviderEventIds, []); // a result WAS supplied, just not resolved
});

test("WAITING: missing provider result entirely -> WAITING, missingProviderEventIds populated", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([]); // nothing supplied at all

  const result = aggregateExpressOutcome(legs, results);

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

    const result = aggregateExpressOutcome(legs, results);
    assert.equal(result.kind, "WAITING");
  });
}

test("CANCELLED status leg with no LOSS elsewhere -> overall VOID (evaluator's own CANCELLED->VOID rule, aggregated as all-VOID)", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult({ status: "CANCELLED", homeScore: null, awayScore: null })]]);

  const result = aggregateExpressOutcome(legs, results);
  assert.deepEqual(result, { kind: "VOID" });
});

/* -------------------------------------------------------------------------- */
/* UNSUPPORTED / INVALID_DATA                                                 */
/* -------------------------------------------------------------------------- */

test("UNSUPPORTED: no LOSS, one leg's market is unsupported -> overall UNSUPPORTED", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1" }),
    leg({ id: "l2", providerEventId: "e2", selection: { ...selection("HOME"), marketType: "TOTALS", selectionType: "OVER" } }),
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);
  assert.equal(result.kind, "INVALID_DATA");
});

/* -------------------------------------------------------------------------- */
/* Odds edge cases                                                            */
/* -------------------------------------------------------------------------- */

test("WIN with a null BetSelection.odds on the winning leg -> INVALID_DATA, not a crash or a fabricated price", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", odds: null })];
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results);

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

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "WIN");
  if (result.kind !== "WIN") return;
  // 1.111 * 1.111 = 1.234321 -> HALF_UP to 2dp = 1.23
  assert.equal(result.effectiveOdds.toString(), "1.23");
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

test("purity: input legs array and lookup are not mutated", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult()]]);
  const legsCopy = JSON.parse(JSON.stringify(legs.map((l) => ({ ...l, odds: l.odds?.toString() }))));

  aggregateExpressOutcome(legs, results);

  const legsAfter = JSON.parse(JSON.stringify(legs.map((l) => ({ ...l, odds: l.odds?.toString() }))));
  assert.deepEqual(legsAfter, legsCopy);
  assert.equal(results.size, 1);
});

test("purity: identical input always returns a deep-equal result", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1" })];
  const results = lookup([["e1", eventResult()]]);

  const r1 = aggregateExpressOutcome(legs, results);
  const r2 = aggregateExpressOutcome(legs, results);
  assert.deepEqual(r1, r2);
});

/* -------------------------------------------------------------------------- */
/* H4-B2 — SPREAD is evaluator-only, deferred in EXPRESS aggregation         */
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

test("SPREAD leg (full-margin WIN if evaluated) is deferred to UNSUPPORTED, never silently interpreted as WIN — proves EXPRESS behavior is unchanged from before H4-B2", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: spreadSelection("Home", "-1") })];
  // Home wins by 2 — a real SPREAD evaluation of -1 would be a full WIN,
  // but this must never reach that conclusion in B2.
  const results = lookup([["e1", eventResult({ homeScore: 2, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "UNSUPPORTED");
  if (result.kind !== "UNSUPPORTED") return;
  assert.deepEqual(result.affectedSelectionIds, ["l1"]);
  assert.equal(result.reasonCodes["l1"], "SPREAD_AUTO_SETTLEMENT_DEFERRED");
});

test("SPREAD leg with a quarter line (would be HALF_WIN if evaluated) is deferred to UNSUPPORTED, never interpreted as WIN or LOSS", () => {
  const legs = [leg({ id: "l1", providerEventId: "e1", selection: spreadSelection("Home", "-0.75") })];
  // Home wins by 1: -0.75 splits into [-1, -0.5] -> PUSH + WIN -> HALF_WIN
  // if this leg were evaluated for real. It must not be.
  const results = lookup([["e1", eventResult({ homeScore: 1, awayScore: 0 })]]);

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "UNSUPPORTED");
  if (result.kind !== "UNSUPPORTED") return;
  assert.deepEqual(result.affectedSelectionIds, ["l1"]);
  assert.equal(result.reasonCodes["l1"], "SPREAD_AUTO_SETTLEMENT_DEFERRED");
});

test("a SPREAD leg deferred to UNSUPPORTED masks an otherwise-winning MONEYLINE leg, same priority behavior as any other UNSUPPORTED leg", () => {
  const legs = [
    leg({ id: "l1", providerEventId: "e1", selection: selection("HOME") }), // will WIN
    leg({ id: "l2", providerEventId: "e2", selection: spreadSelection("Home", "-1") }), // deferred
  ];
  const results = lookup([
    ["e1", eventResult({ homeScore: 2, awayScore: 0 })],
    ["e2", eventResult({ homeScore: 2, awayScore: 0 })],
  ]);

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "UNSUPPORTED");
  if (result.kind !== "UNSUPPORTED") return;
  assert.deepEqual(result.affectedSelectionIds, ["l2"]);
});

test("a SPREAD leg never reaches evaluateSelectionOutcome's WAITING/event-lookup path either — deferred even when providerEventId has no matching result", () => {
  const legs = [leg({ id: "l1", providerEventId: "missing-event", selection: spreadSelection("Home", "-1") })];
  const results = lookup([]);

  const result = aggregateExpressOutcome(legs, results);

  assert.equal(result.kind, "UNSUPPORTED");
  if (result.kind !== "UNSUPPORTED") return;
  assert.equal(result.reasonCodes["l1"], "SPREAD_AUTO_SETTLEMENT_DEFERRED");
});
