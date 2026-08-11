import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { computeExpressBranchExactDelta, type BranchSettlementLeg } from "./expressBranchSettlement";
import { MAX_EXPRESS_SELECTIONS } from "@/lib/bets/betSlipRules";

function d(v: string | number): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — SINGLE equivalence. An EXPRESS with exactly one split leg and    */
/* every other component VOID must be cent-for-cent identical to the real    */
/* SINGLE SETTLED_HALF_WIN/SETTLED_HALF_LOSS formulas in settleBet.ts. These  */
/* expected values are computed by hand from that exact, unmodified code:    */
/* halfStake = stake/2; grossPayout = round(halfStake * odds); netProfit =   */
/* round(grossPayout - halfStake) for HALF_WIN; delta = round(-halfStake)    */
/* for HALF_LOSS.                                                            */
/* -------------------------------------------------------------------------- */

test("Phase 3 HALF_WIN equivalence: stake 100 @ 2.00 -> +50 (matches SINGLE SETTLED_HALF_WIN)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("2.00") }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "50");
});

test("Phase 3 HALF_WIN equivalence: stake 66.67 @ 1.63 -> +21.01 (matches SINGLE SETTLED_HALF_WIN)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.63") }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "21.01");
});

test("Phase 3 HALF_WIN equivalence: stake 10 @ 2.49 -> +7.45 (matches SINGLE SETTLED_HALF_WIN)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("2.49") }];
  assert.equal(computeExpressBranchExactDelta(d(10), legs).toString(), "7.45");
});

test("Phase 3 HALF_WIN equivalence: stake 99 @ 1.91 -> +45.05 (matches SINGLE SETTLED_HALF_WIN)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.91") }];
  assert.equal(computeExpressBranchExactDelta(d(99), legs).toString(), "45.05");
});

test("Phase 3 HALF_LOSS equivalence: stake 100 -> -50 (matches SINGLE SETTLED_HALF_LOSS)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "-50");
});

test("Phase 3 HALF_LOSS equivalence: stake 66.67 -> -33.34 (matches SINGLE SETTLED_HALF_LOSS)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "-33.34");
});

test("Phase 3 HALF_LOSS equivalence: stake 10 -> -5 (matches SINGLE SETTLED_HALF_LOSS)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(10), legs).toString(), "-5");
});

test("Phase 3 HALF_LOSS equivalence: stake 99 -> -49.5 (matches SINGLE SETTLED_HALF_LOSS)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(99), legs).toString(), "-49.5");
});

test("Phase 3 HALF_LOSS equivalence: stake 0.29 -> -0.15 (matches SINGLE SETTLED_HALF_LOSS)", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d("0.29"), legs).toString(), "-0.15");
});

/* -------------------------------------------------------------------------- */
/* Phase 4 — X3C regression matrix. These values supersede X3C's own         */
/* imperfect reference figures; they come from the reviewed X3D branch       */
/* algorithm and are the mathematically correct cent-exact answers.          */
/* -------------------------------------------------------------------------- */

test("Phase 4 X3C (1): stake 10, HALF_WIN@1.63 + WIN@2.49 -> +22.74", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.63") }, { kind: "WIN", odds: d("2.49") }];
  assert.equal(computeExpressBranchExactDelta(d(10), legs).toString(), "22.74");
});

test("Phase 4 X3C (2): stake 66.67, HALF_WIN@1.63 + WIN@2.49 -> +151.64", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.63") }, { kind: "WIN", odds: d("2.49") }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "151.64");
});

test("Phase 4 X3C (3): stake 66.67, HALF_LOSS + WIN@1.91 -> -3.00", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }, { kind: "WIN", odds: d("1.91") }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "-3");
});

test("Phase 4 X3C (4): stake 99, HALF_WIN@1.91 + WIN@1.63 -> +135.80", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.91") }, { kind: "WIN", odds: d("1.63") }];
  assert.equal(computeExpressBranchExactDelta(d(99), legs).toString(), "135.8");
});

test("Phase 4 X3C (5): stake 33, HALF_WIN@2.05 + WIN@2.49 -> +92.31", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("2.05") }, { kind: "WIN", odds: d("2.49") }];
  assert.equal(computeExpressBranchExactDelta(d(33), legs).toString(), "92.31");
});

/* -------------------------------------------------------------------------- */
/* Phase 5 — multiple partial legs                                           */
/* -------------------------------------------------------------------------- */

test("Phase 5 (A): stake 100, HALF_WIN@2 + HALF_WIN@3 -> +200", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d(2) }, { kind: "HALF_WIN", odds: d(3) }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "200");
});

test("Phase 5 (B): stake 100, HALF_WIN@2 + HALF_LOSS -> -25", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d(2) }, { kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "-25");
});

test("Phase 5 (C): stake 100, HALF_LOSS + HALF_LOSS -> -75", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }, { kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "-75");
});

test("Phase 5 (D): stake 100, HALF_WIN@2 + HALF_WIN@3 + HALF_LOSS -> +50", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d(2) }, { kind: "HALF_WIN", odds: d(3) }, { kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "50");
});

test("Phase 5 (E): stake 100, HALF_WIN@2 + HALF_LOSS + HALF_LOSS -> -62.50", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d(2) }, { kind: "HALF_LOSS" }, { kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "-62.5");
});

test("Phase 5 (F): stake 66.67, HALF_WIN@1.63 + HALF_WIN@2.49 -> +86.31", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d("1.63") }, { kind: "HALF_WIN", odds: d("2.49") }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "86.31");
});

/* -------------------------------------------------------------------------- */
/* Phase 6 — max EXPRESS safety. MAX_EXPRESS_SELECTIONS read from the real   */
/* source (lib/bets/betSlipRules.ts), never hardcoded a second time.         */
/* -------------------------------------------------------------------------- */

test(`Phase 6: MAX_EXPRESS_SELECTIONS legs, all HALF_WIN (worst case, 2^${MAX_EXPRESS_SELECTIONS} branches) -> deterministic, exact, no timeout`, () => {
  const legs: BranchSettlementLeg[] = Array.from({ length: MAX_EXPRESS_SELECTIONS }, (_, i) => ({
    kind: "HALF_WIN" as const,
    odds: d((1.5 + i * 0.1).toFixed(2)),
  }));

  const start = Date.now();
  const result1 = computeExpressBranchExactDelta(d("123.45"), legs);
  const elapsedMs = Date.now() - start;

  assert.ok(result1 instanceof Prisma.Decimal);
  assert.ok(result1.isFinite());
  assert.ok(elapsedMs < 5000, `expected well under 5s, took ${elapsedMs}ms`);

  // Deterministic: identical input always returns a deep-equal result.
  const result2 = computeExpressBranchExactDelta(d("123.45"), legs);
  assert.ok(result1.equals(result2));
});

test("Phase 6: MAX_EXPRESS_SELECTIONS legs, mixed HALF_WIN/HALF_LOSS -> deterministic, exact, no timeout", () => {
  const legs: BranchSettlementLeg[] = Array.from({ length: MAX_EXPRESS_SELECTIONS }, (_, i) =>
    i % 2 === 0 ? { kind: "HALF_WIN" as const, odds: d((1.8 + i * 0.05).toFixed(2)) } : { kind: "HALF_LOSS" as const },
  );

  const start = Date.now();
  const result = computeExpressBranchExactDelta(d("1000"), legs);
  const elapsedMs = Date.now() - start;

  assert.ok(result instanceof Prisma.Decimal);
  assert.ok(result.isFinite());
  assert.ok(elapsedMs < 5000, `expected well under 5s, took ${elapsedMs}ms`);
});

/* -------------------------------------------------------------------------- */
/* No-Decimal-drift / VOID-branch safety                                     */
/* -------------------------------------------------------------------------- */

test("a true breakeven branch (combinedOdds exactly 1) never manufactures a spurious cent from an odd branchStake", () => {
  // stake 66.67, HALF_LOSS only, degenerate k=1: the surviving branch
  // (split leg voided, nothing else active) must contribute EXACTLY 0, not
  // round(33.335) - 33.335 = 0.01 (the exact bug this module's VOID-branch
  // guard exists to prevent).
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_LOSS" }];
  assert.equal(computeExpressBranchExactDelta(d("66.67"), legs).toString(), "-33.34");
});

test("all-VOID (a=0, b=0, only VOID legs) -> delta 0", () => {
  const legs: BranchSettlementLeg[] = [{ kind: "VOID" }, { kind: "VOID" }];
  assert.equal(computeExpressBranchExactDelta(d(100), legs).toString(), "0");
});

test("purity: does not mutate its inputs", () => {
  const stake = d(100);
  const legs: BranchSettlementLeg[] = [{ kind: "HALF_WIN", odds: d(2) }, { kind: "HALF_LOSS" }];
  const stakeBefore = stake.toString();
  const legsBefore = JSON.stringify(legs.map((l) => ({ ...l, odds: "odds" in l ? l.odds.toString() : undefined })));

  computeExpressBranchExactDelta(stake, legs);

  assert.equal(stake.toString(), stakeBefore);
  assert.equal(JSON.stringify(legs.map((l) => ({ ...l, odds: "odds" in l ? l.odds.toString() : undefined }))), legsBefore);
});
