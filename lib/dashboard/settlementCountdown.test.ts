import { test } from "node:test";
import assert from "node:assert/strict";
import { getSettlementCountdown } from "./settlementCountdown";

test("getSettlementCountdown: future date returns 'N days left', upcoming tone", () => {
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-07-28T09:00:00Z"));
  assert.equal(result.daysDiff, 3);
  assert.equal(result.tone, "upcoming");
  assert.equal(result.label, "3 days left");
});

test("getSettlementCountdown: singular day uses 'day left', not 'days left'", () => {
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-07-30T09:00:00Z"));
  assert.equal(result.daysDiff, 1);
  assert.equal(result.label, "1 day left");
});

test("getSettlementCountdown: same Zurich calendar day is 'due today'", () => {
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-07-31T21:00:00Z"));
  assert.equal(result.daysDiff, 0);
  assert.equal(result.tone, "due-today");
  assert.equal(result.label, "Settlement due today");
});

test("getSettlementCountdown: past date returns 'overdue by N days', overdue tone", () => {
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-08-02T09:00:00Z"));
  assert.equal(result.daysDiff, -2);
  assert.equal(result.tone, "overdue");
  assert.equal(result.label, "Settlement overdue by 2 days");
});

test("getSettlementCountdown: overdue by exactly 1 day uses singular wording", () => {
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-08-01T09:00:00Z"));
  assert.equal(result.daysDiff, -1);
  assert.equal(result.label, "Settlement overdue by 1 day");
});

test("getSettlementCountdown: does not misjudge a Zurich-late-evening UTC instant as tomorrow", () => {
  // 2026-07-30T22:30:00Z is 2026-07-31T00:30 in Zurich (CEST, UTC+2) — the
  // settlement day has already begun locally.
  const result = getSettlementCountdown("2026-07-31T00:00:00.000Z", new Date("2026-07-30T22:30:00Z"));
  assert.equal(result.daysDiff, 0);
  assert.equal(result.tone, "due-today");
});
