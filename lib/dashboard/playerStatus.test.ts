import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlayerStatus, type PlayerStatusInput } from "./playerStatus";

const BASE: PlayerStatusInput = {
  available: "500",
  isSettlementDueOrOverdue: false,
  pendingBetsCount: 0,
  activeBetsCount: 0,
  hasTelegramLinked: true,
};

test("computePlayerStatus: no flags set resolves to Active", () => {
  const status = computePlayerStatus(BASE);
  assert.equal(status.key, "ACTIVE");
  assert.equal(status.tone, "green");
});

test("computePlayerStatus: available exactly 0 is Credit Exhausted", () => {
  const status = computePlayerStatus({ ...BASE, available: "0" });
  assert.equal(status.key, "CREDIT_EXHAUSTED");
});

test("computePlayerStatus: negative available is Credit Exhausted", () => {
  const status = computePlayerStatus({ ...BASE, available: "-50" });
  assert.equal(status.key, "CREDIT_EXHAUSTED");
});

test("computePlayerStatus: Credit Exhausted outranks every other flag", () => {
  const status = computePlayerStatus({
    available: "-1",
    isSettlementDueOrOverdue: true,
    pendingBetsCount: 3,
    activeBetsCount: 2,
    hasTelegramLinked: false,
  });
  assert.equal(status.key, "CREDIT_EXHAUSTED");
});

test("computePlayerStatus: Settlement Due outranks Pending Bets/Exposure/Telegram", () => {
  const status = computePlayerStatus({
    ...BASE,
    isSettlementDueOrOverdue: true,
    pendingBetsCount: 1,
    activeBetsCount: 1,
    hasTelegramLinked: false,
  });
  assert.equal(status.key, "SETTLEMENT_DUE");
});

test("computePlayerStatus: Pending Bets outranks Exposure Active/Telegram", () => {
  const status = computePlayerStatus({
    ...BASE,
    pendingBetsCount: 2,
    activeBetsCount: 1,
    hasTelegramLinked: false,
  });
  assert.equal(status.key, "PENDING_BETS");
  assert.equal(status.description, "2 bets awaiting confirmation.");
});

test("computePlayerStatus: Pending Bets singular wording for exactly 1", () => {
  const status = computePlayerStatus({ ...BASE, pendingBetsCount: 1 });
  assert.equal(status.description, "1 bet awaiting confirmation.");
});

test("computePlayerStatus: Exposure Active outranks Telegram Not Linked", () => {
  const status = computePlayerStatus({ ...BASE, activeBetsCount: 3, hasTelegramLinked: false });
  assert.equal(status.key, "EXPOSURE_ACTIVE");
});

test("computePlayerStatus: Telegram Not Linked is the lowest non-Active flag", () => {
  const status = computePlayerStatus({ ...BASE, hasTelegramLinked: false });
  assert.equal(status.key, "TELEGRAM_NOT_LINKED");
});
