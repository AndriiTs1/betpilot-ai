import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@/lib/generated/prisma/client";
import { splitAsianHandicapLine, type AsianLineSplit } from "./asianHandicapLine";

function line(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function assertNoSplit(value: string): void {
  const result = splitAsianHandicapLine(line(value));
  assert.equal(result.kind, "NO_SPLIT", `expected ${value} to be NO_SPLIT, got ${result.kind}`);
}

function assertSplit(value: string, expectedLower: string, expectedUpper: string): void {
  const result: AsianLineSplit = splitAsianHandicapLine(line(value));
  assert.equal(result.kind, "SPLIT", `expected ${value} to be SPLIT, got ${result.kind}`);
  if (result.kind !== "SPLIT") return;
  const [lower, upper] = result.components;
  assert.equal(lower.toString(), expectedLower, `${value}'s lower component`);
  assert.equal(upper.toString(), expectedUpper, `${value}'s upper component`);
  assert.ok(lower.lessThan(upper), "components must be in ascending order");
}

function assertInvalidGrid(value: string): void {
  const result = splitAsianHandicapLine(line(value));
  assert.equal(result.kind, "INVALID_GRID", `expected ${value} to be INVALID_GRID, got ${result.kind}`);
}

// ---------------------------------------------------------------------
// Whole/half lines — NO_SPLIT, exactly the required set.
// ---------------------------------------------------------------------

for (const value of ["0", "-0.5", "0.5", "-1", "1", "-1.5", "1.5", "-2", "2"]) {
  test(`splitAsianHandicapLine: whole/half line ${value} is NO_SPLIT`, () => {
    assertNoSplit(value);
  });
}

// ---------------------------------------------------------------------
// Quarter lines — SPLIT, exact ascending components per the task's own
// worked examples.
// ---------------------------------------------------------------------

test("splitAsianHandicapLine: -0.25 -> [-0.5, 0]", () => {
  assertSplit("-0.25", "-0.5", "0");
});
test("splitAsianHandicapLine: -0.75 -> [-1, -0.5]", () => {
  assertSplit("-0.75", "-1", "-0.5");
});
test("splitAsianHandicapLine: -1.25 -> [-1.5, -1]", () => {
  assertSplit("-1.25", "-1.5", "-1");
});
test("splitAsianHandicapLine: -1.75 -> [-2, -1.5]", () => {
  assertSplit("-1.75", "-2", "-1.5");
});
test("splitAsianHandicapLine: +0.25 -> [0, 0.5]", () => {
  assertSplit("0.25", "0", "0.5");
});
test("splitAsianHandicapLine: +0.75 -> [0.5, 1]", () => {
  assertSplit("0.75", "0.5", "1");
});
test("splitAsianHandicapLine: +1.25 -> [1, 1.5]", () => {
  assertSplit("1.25", "1", "1.5");
});
test("splitAsianHandicapLine: +1.75 -> [1.5, 2]", () => {
  assertSplit("1.75", "1.5", "2");
});

// ---------------------------------------------------------------------
// Invalid grid — anything not on .00/.25/.50/.75 must fail safely, never
// silently round.
// ---------------------------------------------------------------------

for (const value of ["-1.33", "0.10", "1.1", "-0.9", "2.6", "0.333"]) {
  test(`splitAsianHandicapLine: off-grid line ${value} is INVALID_GRID, never silently rounded`, () => {
    assertInvalidGrid(value);
  });
}

// ---------------------------------------------------------------------
// Critical invariant A — a quarter line is never rounded to its
// neighboring whole/half line before (or instead of) being split.
// ---------------------------------------------------------------------

test("splitAsianHandicapLine: -1.25 is never rounded to -1 or -1.5 before splitting — its components are exactly -1.5 and -1, not a NO_SPLIT of the rounded neighbor", () => {
  const result = splitAsianHandicapLine(line("-1.25"));
  // If -1.25 had been rounded to -1 or -1.5 first, this would incorrectly
  // report NO_SPLIT instead of SPLIT.
  assert.equal(result.kind, "SPLIT");
  if (result.kind !== "SPLIT") return;
  assert.equal(result.components[0].toString(), "-1.5");
  assert.equal(result.components[1].toString(), "-1");
});

// ---------------------------------------------------------------------
// No native floating point — Decimal identity is exact, not
// approximately-equal.
// ---------------------------------------------------------------------

test("splitAsianHandicapLine: -0.75's components are exact Prisma.Decimal instances, not floating-point approximations", () => {
  const result = splitAsianHandicapLine(line("-0.75"));
  assert.equal(result.kind, "SPLIT");
  if (result.kind !== "SPLIT") return;
  assert.ok(result.components[0] instanceof Prisma.Decimal);
  assert.ok(result.components[1] instanceof Prisma.Decimal);
  assert.equal(result.components[0].plus("0.25").toString(), "-0.75");
});

test("splitAsianHandicapLine is pure: same input always produces an equal, freshly-constructed result", () => {
  const first = splitAsianHandicapLine(line("-1.25"));
  const second = splitAsianHandicapLine(line("-1.25"));
  assert.deepEqual(
    first.kind === "SPLIT" ? first.components.map((c) => c.toString()) : first.kind,
    second.kind === "SPLIT" ? second.components.map((c) => c.toString()) : second.kind,
  );
});
