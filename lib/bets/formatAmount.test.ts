import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAmount } from "./formatAmount";

test("formatAmount: always renders exactly two decimal places", () => {
  assert.equal(formatAmount(100), "100.00");
  assert.equal(formatAmount(1.5), "1.50");
  assert.equal(formatAmount(2.005), "2.00");
});

test("formatAmount: preserves the sign of negative values", () => {
  assert.equal(formatAmount(-40.1), "-40.10");
});
