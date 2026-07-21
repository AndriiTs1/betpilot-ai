import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateBetSlipType,
  canSubmitBetSlip,
  BetSlipValidationError,
  MIN_EXPRESS_SELECTIONS,
  MAX_EXPRESS_SELECTIONS,
} from "./betSlipRules";

function selections(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}` }));
}

// Manual try/catch rather than assert.throws' validator-function form —
// keeps the pass/fail path unambiguous instead of depending on how
// node:assert treats an inner assertion throwing from inside a validator.
function assertCode(fn: () => void, code: string) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BetSlipValidationError, "expected a BetSlipValidationError");
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown, but nothing was thrown`);
}

test("betSlipRules: constants match the confirmed MVP range (2-10)", () => {
  assert.equal(MIN_EXPRESS_SELECTIONS, 2);
  assert.equal(MAX_EXPRESS_SELECTIONS, 10);
});

test("betSlipRules: SINGLE with exactly 1 selection is valid", () => {
  assert.doesNotThrow(() => validateBetSlipType("SINGLE", selections(1)));
});

test("betSlipRules: SINGLE with 0 selections is rejected", () => {
  assertCode(() => validateBetSlipType("SINGLE", selections(0)), "SINGLE_INVALID_SELECTION_COUNT");
});

test("betSlipRules: SINGLE with 2 selections is rejected", () => {
  assertCode(() => validateBetSlipType("SINGLE", selections(2)), "SINGLE_INVALID_SELECTION_COUNT");
});

test("betSlipRules: EXPRESS with 1 selection is rejected (below minimum)", () => {
  assertCode(() => validateBetSlipType("EXPRESS", selections(1)), "EXPRESS_TOO_FEW_SELECTIONS");
});

test("betSlipRules: EXPRESS with 2 selections is valid (minimum)", () => {
  assert.doesNotThrow(() => validateBetSlipType("EXPRESS", selections(2)));
});

test("betSlipRules: EXPRESS with 10 selections is valid (maximum)", () => {
  assert.doesNotThrow(() => validateBetSlipType("EXPRESS", selections(10)));
});

test("betSlipRules: EXPRESS with 11 selections is rejected (above maximum)", () => {
  assertCode(() => validateBetSlipType("EXPRESS", selections(11)), "EXPRESS_TOO_MANY_SELECTIONS");
});

test("betSlipRules: unknown type is rejected defensively", () => {
  // @ts-expect-error deliberately passing an invalid runtime value, as a
  // caller handing in unvalidated JSON could.
  assertCode(() => validateBetSlipType("PARLAY", selections(2)), "UNKNOWN_BET_SLIP_TYPE");
});

const ALL_STATUSES = ["PENDING", "VERIFIED", "ODDS_CHANGED", "NOT_FOUND", "UNAVAILABLE"] as const;

test("betSlipRules: canSubmitBetSlip allows every individual oddsStatus", () => {
  for (const oddsStatus of ALL_STATUSES) {
    assert.equal(canSubmitBetSlip([{ oddsStatus }]), true, `expected ${oddsStatus} to be submittable`);
  }
});

test("betSlipRules: canSubmitBetSlip allows a mix of every status at once", () => {
  assert.equal(
    canSubmitBetSlip(ALL_STATUSES.map((oddsStatus) => ({ oddsStatus }))),
    true,
  );
});
