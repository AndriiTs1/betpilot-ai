import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { computeTotalOdds, computePotentialWin, ExpressMathError } from "./expressMath";

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function assertCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ExpressMathError, "expected an ExpressMathError");
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown, but nothing was thrown`);
}

test("expressMath: computeTotalOdds for 2 selections", () => {
  const result = computeTotalOdds([d("1.80"), d("1.70")]);
  // 1.80 * 1.70 = 3.06 exactly
  assert.equal(result.toString(), "3.06");
});

test("expressMath: computeTotalOdds for 3 selections", () => {
  const result = computeTotalOdds([d("1.50"), d("2.00"), d("1.25")]);
  // 1.50 * 2.00 * 1.25 = 3.75 exactly
  assert.equal(result.toString(), "3.75");
});

test("expressMath: computeTotalOdds for 10 selections", () => {
  const odds = Array.from({ length: 10 }, () => d("1.10"));
  const result = computeTotalOdds(odds);
  // 1.10^10 = 2.59374246... -> rounded HALF_UP to 2dp = 2.59
  assert.equal(result.toString(), "2.59");
});

test("expressMath: Decimal does not accumulate floating-point error (1.1 * 1.1 * 1.1)", () => {
  // Native JS floats visibly misbehave here: 1.1 * 1.1 * 1.1 === 1.3310000000000004
  // (verified: Math.abs(1.1 * 1.1 * 1.1 - 1.331) > 0). Decimal must not
  // reproduce that error before rounding.
  assert.notEqual(1.1 * 1.1 * 1.1, 1.331);

  const exact = new Prisma.Decimal(1).times(d("1.1")).times(d("1.1")).times(d("1.1"));
  assert.equal(exact.toString(), "1.331");

  // computeTotalOdds itself, rounded to 2dp per its documented strategy.
  const result = computeTotalOdds([d("1.1"), d("1.1"), d("1.1")]);
  assert.equal(result.toString(), "1.33");
});

test("expressMath: computeTotalOdds rounds HALF_UP at a tie (not banker's rounding)", () => {
  // 1.25 * 0.804 = 1.005 exactly -> HALF_UP rounds to 1.01;
  // HALF_EVEN (banker's rounding) would instead give 1.00. This pins down
  // which strategy is actually in effect, not just that rounding happens.
  const result = computeTotalOdds([d("1.25"), d("0.804")]);
  assert.equal(result.toString(), "1.01");
});

test("expressMath: computeTotalOdds rejects an empty selection list", () => {
  assertCode(() => computeTotalOdds([]), "NO_SELECTIONS");
});

test("expressMath: computeTotalOdds rejects a null odds value", () => {
  assertCode(() => computeTotalOdds([d("1.5"), null]), "MISSING_ODDS");
});

test("expressMath: computeTotalOdds rejects zero odds", () => {
  assertCode(() => computeTotalOdds([d("1.5"), d("0")]), "ZERO_OR_NEGATIVE_ODDS");
});

test("expressMath: computeTotalOdds rejects negative odds", () => {
  assertCode(() => computeTotalOdds([d("1.5"), d("-1.2")]), "ZERO_OR_NEGATIVE_ODDS");
});

test("expressMath: computePotentialWin for a normal SINGLE-equivalent case", () => {
  const result = computePotentialWin(d("75"), d("1.95"));
  assert.equal(result.toString(), "146.25");
});

test("expressMath: computePotentialWin for an EXPRESS totalOdds", () => {
  const result = computePotentialWin(d("50"), d("3.06"));
  assert.equal(result.toString(), "153");
});

test("expressMath: computePotentialWin rejects zero stake", () => {
  assertCode(() => computePotentialWin(d("0"), d("1.95")), "ZERO_OR_NEGATIVE_STAKE");
});

test("expressMath: computePotentialWin rejects negative stake", () => {
  assertCode(() => computePotentialWin(d("-10"), d("1.95")), "ZERO_OR_NEGATIVE_STAKE");
});

test("expressMath: computePotentialWin rejects zero/negative totalOdds", () => {
  assertCode(() => computePotentialWin(d("50"), d("0")), "ZERO_OR_NEGATIVE_ODDS");
  assertCode(() => computePotentialWin(d("50"), d("-1")), "ZERO_OR_NEGATIVE_ODDS");
});
