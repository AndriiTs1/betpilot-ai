import { test } from "node:test";
import assert from "node:assert/strict";
import type { BetStatus } from "@/lib/generated/prisma/client";
import {
  decideSettlementTransition,
  isSettlementTarget,
  SETTLEMENT_TARGET_STATUSES,
  InvalidSettlementTargetError,
  BetNotConfirmedForSettlementError,
  BetAlreadyRejectedError,
  SettlementConflictError,
  type SettlementDecision,
  type SettlementTarget,
} from "./settlementRules";

// Same manual try/catch convention as lib/bets/betSlipRules.test.ts's
// assertCode — unambiguous pass/fail, not dependent on how node:assert
// treats an inner assertion throwing from inside a validator function.
// Returns the caught error so callers can assert further structured
// fields on it.
function assertThrowsAs<T extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => T,
  code: string,
): T {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ctor, `expected ${ctor.name}, got ${(err as Error)?.constructor?.name}`);
    assert.equal((err as unknown as { code: string }).code, code);
    return err as T;
  }
  assert.fail(`expected ${ctor.name} (${code}) to be thrown, but nothing was thrown`);
}

const TARGETS: readonly SettlementTarget[] = ["SETTLED_WIN", "SETTLED_LOSS", "VOID"];

// ---------------------------------------------------------------------
// Allowed: CONFIRMED -> each settlement target returns APPLY
// ---------------------------------------------------------------------

for (const target of TARGETS) {
  test(`decideSettlementTransition: CONFIRMED -> ${target} returns APPLY`, () => {
    const decision = decideSettlementTransition("CONFIRMED", target);
    const expected: SettlementDecision = { kind: "APPLY", fromStatus: "CONFIRMED", targetStatus: target };
    assert.deepEqual(decision, expected);
  });
}

// ---------------------------------------------------------------------
// Idempotent: already-settled -> the same result returns IDEMPOTENT,
// no mutation implied
// ---------------------------------------------------------------------

for (const target of TARGETS) {
  test(`decideSettlementTransition: ${target} -> ${target} (repeat) returns IDEMPOTENT`, () => {
    const decision = decideSettlementTransition(target, target);
    const expected: SettlementDecision = { kind: "IDEMPOTENT", currentStatus: target, targetStatus: target };
    assert.deepEqual(decision, expected);
  });
}

// ---------------------------------------------------------------------
// Conflicting: a final settlement -> a DIFFERENT final settlement is
// always a SettlementConflictError, never silently overwritten
// ---------------------------------------------------------------------

const CONFLICT_PAIRS: readonly [SettlementTarget, SettlementTarget][] = [
  ["SETTLED_WIN", "SETTLED_LOSS"],
  ["SETTLED_WIN", "VOID"],
  ["SETTLED_LOSS", "SETTLED_WIN"],
  ["SETTLED_LOSS", "VOID"],
  ["VOID", "SETTLED_WIN"],
  ["VOID", "SETTLED_LOSS"],
];

for (const [from, to] of CONFLICT_PAIRS) {
  test(`decideSettlementTransition: ${from} -> ${to} is a SettlementConflictError, never overwritten`, () => {
    const err = assertThrowsAs(
      () => decideSettlementTransition(from, to),
      SettlementConflictError,
      "SETTLEMENT_CONFLICT",
    );
    assert.equal(err.currentStatus, from);
    assert.equal(err.requestedStatus, to);
  });
}

// ---------------------------------------------------------------------
// Invalid source: PENDING and REJECTED can never be settled directly
// ---------------------------------------------------------------------

for (const target of TARGETS) {
  test(`decideSettlementTransition: PENDING -> ${target} is a BetNotConfirmedForSettlementError`, () => {
    const err = assertThrowsAs(
      () => decideSettlementTransition("PENDING", target),
      BetNotConfirmedForSettlementError,
      "BET_NOT_CONFIRMED_FOR_SETTLEMENT",
    );
    assert.equal(err.currentStatus, "PENDING");
    assert.equal(err.requestedStatus, target);
  });
}

for (const target of TARGETS) {
  test(`decideSettlementTransition: REJECTED -> ${target} is a BetAlreadyRejectedError (REJECTED is terminal)`, () => {
    const err = assertThrowsAs(
      () => decideSettlementTransition("REJECTED", target),
      BetAlreadyRejectedError,
      "BET_ALREADY_REJECTED",
    );
    assert.equal(err.currentStatus, "REJECTED");
    assert.equal(err.requestedStatus, target);
  });
}

// ---------------------------------------------------------------------
// Invalid target: CONFIRMED -> a non-settlement-target status, and
// arbitrary garbage requestedStatus values
// ---------------------------------------------------------------------

const NON_SETTLEMENT_BET_STATUSES: readonly BetStatus[] = ["PENDING", "CONFIRMED", "REJECTED"];

for (const badTarget of NON_SETTLEMENT_BET_STATUSES) {
  test(`decideSettlementTransition: CONFIRMED -> ${badTarget} is an InvalidSettlementTargetError (not a settlement target)`, () => {
    const err = assertThrowsAs(
      () => decideSettlementTransition("CONFIRMED", badTarget),
      InvalidSettlementTargetError,
      "INVALID_SETTLEMENT_TARGET",
    );
    assert.equal(err.currentStatus, "CONFIRMED");
    assert.equal(err.requestedStatus, badTarget);
  });
}

const GARBAGE_TARGETS: readonly unknown[] = [null, undefined, "", "SETTLED_DRAW", { status: "SETTLED_WIN" }, 42];

for (const garbage of GARBAGE_TARGETS) {
  test(`decideSettlementTransition: CONFIRMED -> ${JSON.stringify(garbage)} is an InvalidSettlementTargetError`, () => {
    const err = assertThrowsAs(
      () => decideSettlementTransition("CONFIRMED", garbage),
      InvalidSettlementTargetError,
      "INVALID_SETTLEMENT_TARGET",
    );
    assert.equal(err.currentStatus, "CONFIRMED");
    assert.deepEqual(err.requestedStatus, garbage);
  });
}

// Explicit case from the task's own list: CONFIRMED -> REJECTED is not
// part of settlement at all (a separate, unrelated lifecycle path), and
// must be rejected the same way as any other invalid target — not
// silently treated as a rejection.
test("decideSettlementTransition: CONFIRMED -> REJECTED is explicitly unsupported (settlement is not the reject lifecycle)", () => {
  assertThrowsAs(
    () => decideSettlementTransition("CONFIRMED", "REJECTED"),
    InvalidSettlementTargetError,
    "INVALID_SETTLEMENT_TARGET",
  );
});

// ---------------------------------------------------------------------
// isSettlementTarget
// ---------------------------------------------------------------------

test("isSettlementTarget: true for exactly the three settlement targets", () => {
  for (const target of TARGETS) {
    assert.equal(isSettlementTarget(target), true);
  }
});

test("isSettlementTarget: false for every non-target BetStatus and arbitrary garbage", () => {
  for (const value of [...NON_SETTLEMENT_BET_STATUSES, ...GARBAGE_TARGETS]) {
    assert.equal(isSettlementTarget(value), false);
  }
});

// ---------------------------------------------------------------------
// Purity / no side effects / no mutation
// ---------------------------------------------------------------------

test("SETTLEMENT_TARGET_STATUSES cannot be mutated by a consumer", () => {
  assert.deepEqual(SETTLEMENT_TARGET_STATUSES, ["SETTLED_WIN", "SETTLED_LOSS", "VOID"]);
  assert.throws(() => {
    // @ts-expect-error deliberately attempting a mutation the readonly
    // type already forbids at compile time, to prove it's also blocked
    // at runtime (Object.freeze), not just by the type system.
    SETTLEMENT_TARGET_STATUSES.push("SETTLED_DRAW");
  }, TypeError);
  // Unchanged after the attempted (and rejected) mutation.
  assert.deepEqual(SETTLEMENT_TARGET_STATUSES, ["SETTLED_WIN", "SETTLED_LOSS", "VOID"]);
});

test("decideSettlementTransition does not mutate an object passed as requestedStatus", () => {
  const garbage = { status: "SETTLED_WIN", extra: [1, 2, 3] };
  const snapshot = JSON.parse(JSON.stringify(garbage));

  assert.throws(() => decideSettlementTransition("CONFIRMED", garbage));

  assert.deepEqual(garbage, snapshot);
});

test("decideSettlementTransition is a pure function: same inputs always produce an equal decision, no hidden state between calls", () => {
  const first = decideSettlementTransition("CONFIRMED", "SETTLED_WIN");
  const second = decideSettlementTransition("CONFIRMED", "SETTLED_WIN");
  assert.deepEqual(first, second);
  // Distinct object instances — no shared/cached mutable state handed back.
  assert.notEqual(first, second);
});

test("decideSettlementTransition never throws for the three APPLY cases and the three IDEMPOTENT cases", () => {
  for (const target of TARGETS) {
    assert.doesNotThrow(() => decideSettlementTransition("CONFIRMED", target));
    assert.doesNotThrow(() => decideSettlementTransition(target, target));
  }
});
