import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPendingBet } from "./hasPendingBet";

test("hasPendingBet: empty list has no pending bet", () => {
  assert.equal(hasPendingBet([]), false);
});

test("hasPendingBet: true when at least one bet is PENDING", () => {
  assert.equal(hasPendingBet([{ status: "CONFIRMED" }, { status: "PENDING" }]), true);
});

test("hasPendingBet: false when no bet is PENDING", () => {
  assert.equal(
    hasPendingBet([{ status: "CONFIRMED" }, { status: "REJECTED" }, { status: "SETTLED_WIN" }]),
    false,
  );
});

test("hasPendingBet: false for a single CONFIRMED bet", () => {
  assert.equal(hasPendingBet([{ status: "CONFIRMED" }]), false);
});

test("hasPendingBet: true when multiple bets are PENDING", () => {
  assert.equal(hasPendingBet([{ status: "PENDING" }, { status: "PENDING" }]), true);
});

test("hasPendingBet: true when a mix of settled and PENDING bets is present", () => {
  assert.equal(
    hasPendingBet([{ status: "SETTLED_WIN" }, { status: "VOID" }, { status: "PENDING" }]),
    true,
  );
});
